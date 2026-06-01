#!/usr/bin/env python3
"""
RNNoise pre-separation pass for Noise Eraser pipeline (Stage NE-1).

Applies Mozilla RNNoise to reduce stationary broadband noise before source
separation. Goal is to improve the SNR going into Demucs/ConvTasNet, not to
fully clean the file — RNNoise contributes approximately 5–10 dB of reduction
on stationary noise components.

Usage:
  python3 rnnoise_denoise.py --input <path> --output <path>

Input/output: 32-bit float PCM WAV at 44.1 kHz (pipeline internal format).

RNNoise operates at 48 kHz internally. This script resamples to 48 kHz before
processing and resamples back to 44.1 kHz on output.

Alignment: RNNoise has a 20 ms algorithmic delay (10 ms frame + 10 ms
lookahead). To keep the real audio out of that warmup window the script
internally prepends 20 ms of silence before resampling, then strips 40 ms
(pad + delay) from the output and matches the original input length so the
caller can use the output file directly with no further trim. This absorbs
the historical `padStart` + `decodeToFloat32` ffmpeg passes that the JS
wrapper used to run on either side of this script.

Backend:
  Uses pyrnnoise.RNNoise.denoise_chunk — streams frames in-memory through the
  Mozilla RNNoise model with no disk roundtrip. The cached RNNoise instance
  is kept at module level so the persistent worker reuses it across jobs;
  pyrnnoise automatically resets per-channel state when partial=True is
  passed on the final chunk, so no manual reset is required between jobs.

Model fidelity: the model still sees int16 48 kHz data identical to the
previous file-based denoise_wav path (RNNoise(sample_rate=48000) makes the
in_graph / out_graph aformat filters no-ops, so model input is byte-for-byte
identical to the previous wavfile.write → denoise_wav → wavfile.read flow).
The pad-at-44.1k is bit-equivalent to the previous FFmpeg adelay pad — both
prepend literal zeros at the input sample rate before scipy resampling.

No attenuation ceiling — RNNoise operates at its natural output level.
Artifact assessment is deferred to Stage NE-4 (post-separation validation).
"""
import argparse
import json
import sys
import warnings

warnings.filterwarnings('ignore')

# Hot imports — kept at module level so the persistent worker's first dispatch
# pays the cost once and every subsequent call reuses the cached modules.
import numpy as np
from math import gcd
from scipy.io import wavfile
from scipy.signal import resample_poly

# pyrnnoise is the only optional dependency; missing-package fallback is
# handled in main() (passes audio through unchanged with a warning).
try:
    from pyrnnoise import RNNoise as _RNNoiseClass
except ImportError:  # pragma: no cover
    _RNNoiseClass = None

RNNOISE_SR   = 48000   # RNNoise internal sample rate
PIPELINE_SR  = 44100   # Pipeline internal format

# Module-level RNNoise instance. Created lazily on first use and reused
# across jobs by the persistent worker. Configured at 48 kHz so the
# in/out aformat filters reduce to no-ops on int16 48 kHz frames.
_RNN = None


def _get_rnnoise():
    """Return a cached RNNoise(sample_rate=48000) instance, or None if pyrnnoise is unavailable."""
    global _RNN
    if _RNNoiseClass is None:
        return None
    if _RNN is None:
        _RNN = _RNNoiseClass(sample_rate=RNNOISE_SR)
    return _RNN


def _resample(audio, orig_sr, target_sr):
    """Polyphase resample a (channels, samples) float32 array."""
    if orig_sr == target_sr:
        return audio
    g = gcd(target_sr, orig_sr)
    up, down = target_sr // g, orig_sr // g
    return np.stack([
        resample_poly(ch, up, down).astype(np.float32)
        for ch in audio
    ])


def _apply_vad_gate(denoised_pcm16, dry_pcm16, speech_probs, silero_per_rnn,
                    rnnoise_threshold, crossfade_ms, algo_delay_samples=0,
                    hangover_frames=0):
    """Replace denoised frames with dry input where Silero says SPEECH but
    RNNoise speech_prob < threshold. Linear crossfades at region boundaries
    keep frame-edge discontinuities below the click threshold.

    Args:
        denoised_pcm16:   np.int16 array (samples,) at 48 kHz — RNNoise output.
        dry_pcm16:        np.int16 array (samples,) at 48 kHz — RNNoise input
                          (silence-padded). Same length as denoised_pcm16 but
                          time-shifted: see algo_delay_samples below.
        speech_probs:     list[float], one entry per yielded RNNoise frame.
        silero_per_rnn:   list[bool], same length as speech_probs.
                          True = Silero says SPEECH for this frame.
        rnnoise_threshold: float, RNNoise speech_prob below which a frame is
                           considered "noise" by RNNoise's internal VAD.
        crossfade_ms:     float, crossfade ramp length in ms.
        algo_delay_samples: int, RNNoise's algorithmic delay in samples at the
                            buffer's sample rate. denoised_pcm16[i] is the
                            cleaned version of dry_pcm16[i - algo_delay_samples];
                            mixing dry into denoised at the same sample index
                            without compensating would splice in audio from
                            algo_delay_samples LATER in original time,
                            producing an audible doubled onset (~20 ms ahead
                            of the true onset) at every override boundary.
        hangover_frames:  int, number of RNNoise frames to extend each
                          override region forward in time before crossfading.
                          RNNoise's causal GRU VAD takes a few frames to lock
                          onto new voicing after an unvoiced→voiced
                          transition; during that ramp-up its speech_prob sits
                          in the 0.3–0.7 range and it partially attenuates the
                          leading edge of the vowel. The hangover keeps the
                          dry signal active through that ramp so the
                          fricative-to-vowel handoff isn't a level dip.

    Returns:
        dict with stats and a '_buffer' key holding the gated np.int16 array.
        Caller is expected to pop('_buffer') before serialising the stats.
    """
    frame_samples = RNNOISE_SR // 100  # 10 ms = 480 samples at 48 kHz
    n_frames = len(speech_probs)

    # Build a per-frame override mask: True = use dry input.
    probs_arr  = np.asarray(speech_probs, dtype=np.float64)
    silero_arr = np.asarray(silero_per_rnn, dtype=bool)
    override_frames = (probs_arr < rnnoise_threshold) & silero_arr

    raw_overrides = int(override_frames.sum())

    # Right-extend each override region by hangover_frames frames. Implemented
    # as an asymmetric binary dilation via a length-(H+1) ones-kernel
    # convolution: conv[k] = sum_{j=k-H..k} override[j], so conv[k] > 0 iff
    # any of the previous H+1 frames (including k) was an override. This
    # extends each True run forward by H frames and also merges adjacent
    # runs separated by gaps of ≤ H frames (which is desirable — back-to-back
    # fricatives shouldn't toggle the gate off in the gap between them).
    if hangover_frames > 0 and raw_overrides > 0:
        kernel = np.ones(hangover_frames + 1, dtype=np.int32)
        conv = np.convolve(override_frames.astype(np.int32), kernel, mode='full')
        override_frames = conv[:n_frames] > 0

    n_overrides = int(override_frames.sum())
    if n_overrides == 0:
        return {
            '_buffer':           denoised_pcm16,
            'overrides':         0,
            'raw_overrides':     raw_overrides,
            'total_frames':      n_frames,
            'threshold':         float(rnnoise_threshold),
            'crossfade_ms':      float(crossfade_ms),
            'hangover_frames':   int(hangover_frames),
        }

    # Per-sample mix array: 1.0 = pure dry, 0.0 = pure denoised. Expand the
    # frame-level mask up to sample resolution, then smooth with a boxcar of
    # length crossfade_ms to get linear ramps at every 0↔1 transition.
    total_samples = n_frames * frame_samples
    sample_mask = np.repeat(override_frames.astype(np.float32), frame_samples)

    # Clip the per-sample mask to the actual buffer length (the last frame
    # may be short if the input wasn't a clean multiple of frame_samples).
    actual_samples = min(total_samples, denoised_pcm16.shape[0], dry_pcm16.shape[0])
    sample_mask = sample_mask[:actual_samples]

    xfade_samples = max(1, int(round(crossfade_ms * RNNOISE_SR / 1000.0)))
    if xfade_samples > 1 and sample_mask.size > xfade_samples:
        # Boxcar convolution = moving average → step becomes linear ramp.
        kernel = np.ones(xfade_samples, dtype=np.float32) / xfade_samples
        sample_mask = np.convolve(sample_mask, kernel, mode='same')

    # Time-align dry against denoised by delaying dry by algo_delay_samples.
    # Without this shift dry_pcm16[i] holds the audio that RNNoise will only
    # emit at denoised_pcm16[i + algo_delay_samples], so a per-sample mix at
    # the same index splices the onset's "future" onto its denoised position.
    # The warmup region (i < algo_delay_samples) gets zero-padded; it sits
    # inside the 40 ms head strip applied to the final output, so its content
    # is discarded regardless.
    if algo_delay_samples > 0 and dry_pcm16.shape[0] >= algo_delay_samples:
        dry_aligned = np.empty(dry_pcm16.shape[0], dtype=dry_pcm16.dtype)
        dry_aligned[:algo_delay_samples] = 0
        dry_aligned[algo_delay_samples:] = dry_pcm16[:dry_pcm16.shape[0] - algo_delay_samples]
        dry_src = dry_aligned
    else:
        dry_src = dry_pcm16

    # Mix: out = dry * mask + denoised * (1 - mask). Float32 multiply to keep
    # intermediates from overflowing int16; clamp back on the way out.
    dry_slice = dry_src[:actual_samples].astype(np.float32)
    den_slice = denoised_pcm16[:actual_samples].astype(np.float32)
    mixed = dry_slice * sample_mask + den_slice * (1.0 - sample_mask)
    mixed = np.clip(mixed, -32768.0, 32767.0).astype(np.int16)

    # Preserve any tail beyond actual_samples unchanged (denoised output).
    if denoised_pcm16.shape[0] > actual_samples:
        out = np.concatenate([mixed, denoised_pcm16[actual_samples:]])
    else:
        out = mixed

    return {
        '_buffer':              out,
        'overrides':            n_overrides,
        'raw_overrides':        raw_overrides,
        'total_frames':         n_frames,
        'threshold':            float(rnnoise_threshold),
        'crossfade_ms':         float(crossfade_ms),
        'algo_delay_samples':   int(algo_delay_samples),
        'hangover_frames':      int(hangover_frames),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description='Apply RNNoise pre-separation pass')
    parser.add_argument('--input',  required=True, help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output', required=True, help='Output WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--speech-prob-out', default=None,
                        help='Optional path to write a JSON sidecar of per-frame VAD speech '
                             'probabilities from pyrnnoise.denoise_chunk. Diagnostic only.')
    parser.add_argument('--silero-mask', default=None,
                        help='Optional path to a JSON sidecar emitted by the JS wrapper '
                             "containing the pipeline's Silero VAD isSilence labels "
                             '(25 ms frames). Used by the speech-prob dump to verify '
                             "alignment and by the VAD-gate to override RNNoise on "
                             'fricative onsets that its internal VAD misclassifies.')
    parser.add_argument('--vad-gate', action='store_true',
                        help='Enable the Silero-vs-RNNoise VAD disagreement gate. On '
                             'frames where Silero says speech but RNNoise speech_prob '
                             "falls below --rnnoise-threshold, the denoiser's output is "
                             'replaced with the original input frame, with a short '
                             "linear crossfade at the boundary. Requires --silero-mask. "
                             'No-op when --silero-mask is absent.')
    parser.add_argument('--rnnoise-threshold', type=float, default=0.30,
                        help="RNNoise speech_prob threshold below which (when Silero "
                             "agrees the frame is speech) the gate replaces the "
                             "denoised frame with the dry input. Default: 0.30.")
    parser.add_argument('--crossfade-ms', type=float, default=1.0,
                        help='Crossfade length (ms) applied at each override-region '
                             'boundary to avoid clicks. Default: 1.0 ms.')
    parser.add_argument('--hangover-frames', type=int, default=2,
                        help="Number of RNNoise frames (10 ms each) to extend "
                             "each override region forward in time. RNNoise's "
                             'causal VAD takes a few frames to lock onto new '
                             "voicing after a fricative→vowel transition, "
                             'and partially attenuates the leading edge of the '
                             'vowel during that ramp; the hangover keeps the dry '
                             'signal active through it. Default: 2 (= 20 ms).')
    args = parser.parse_args(argv)

    # Load the Silero mask (if provided) up front so failures surface before
    # the costly resample/denoise loop runs.
    silero_mask = None  # list[bool], one entry per Silero frame
    if args.silero_mask:
        try:
            with open(args.silero_mask, 'r', encoding='utf-8') as f:
                payload = json.load(f)
            silero_mask = [bool(x) for x in payload.get('isSilence', [])]
        except (OSError, ValueError, KeyError) as e:
            print(f'[rnnoise] WARNING: failed to read silero mask '
                  f'({args.silero_mask}): {e} — proceeding without VAD override.',
                  file=sys.stderr)
            silero_mask = None

    # Load input — pipeline format is 32-bit float 44.1 kHz
    # wavfile returns (samples,) mono or (samples, channels) stereo
    sr, audio_np = wavfile.read(args.input)
    audio_np = audio_np.astype(np.float32)
    if audio_np.ndim == 1:
        waveform = audio_np[np.newaxis, :]   # (1, samples)
    else:
        waveform = audio_np.T                # (channels, samples)

    # Mix to mono if stereo (RNNoise is mono-only)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(axis=0, keepdims=True)

    # Remember the original input length so we can match it exactly on output
    # (so downstream stages see a length-preserving operation).
    original_length = waveform.shape[1]

    # Prepend 20 ms of silence at the input sample rate. RNNoise has a 20 ms
    # algorithmic delay; feeding it silence first means the real audio is
    # processed in steady state instead of through the model's warmup ramp.
    # This is bit-equivalent to the previous FFmpeg adelay pad (literal
    # zeros at 44.1 kHz, then scipy resample to 48 kHz).
    pad_samples_in = int(0.020 * sr)
    waveform = np.concatenate([
        np.zeros((waveform.shape[0], pad_samples_in), dtype=waveform.dtype),
        waveform,
    ], axis=1)

    # Resample to 48 kHz for RNNoise
    waveform = _resample(waveform, sr, RNNOISE_SR)

    # Apply RNNoise via the streaming denoise_chunk API.
    #
    # Model fidelity: clamp to int16 the same way the previous file-based
    # path did (wavfile.write encoded the same clipped scaled values to disk).
    # With RNNoise(sample_rate=48000) the in_graph/out_graph aformat filters
    # are no-ops, so denoise_chunk hands the model the same int16 48 kHz
    # frames it would have read from disk via denoise_wav.
    #
    # The cached RNNoise instance is reused across jobs by the persistent
    # worker. Calling denoise_chunk(..., partial=True) on the final (only)
    # chunk causes pyrnnoise to reset its per-channel C state internally,
    # so the instance is left in a clean state for the next job.

    # Frame alignment constants — used by the speech_prob dump, the Silero
    # mask resolver, and (when enabled) the VAD-disagreement gate.
    head_pad_frames   = 2  # 20 ms input pad
    algo_delay_frames = 2  # RNNoise's internal lookahead
    strip_frames      = head_pad_frames + algo_delay_frames

    rnn = _get_rnnoise()
    speech_probs = None      # np.ndarray[float32] when populated
    silero_per_rnn = None    # np.ndarray[bool], one entry per RNNoise frame
    vad_gate_stats = None
    if rnn is not None:
        pcm16 = np.clip(waveform[0] * 32767, -32768, 32767).astype(np.int16)

        # Pre-allocate the denoised output and speech_prob buffers sized to
        # the expected frame count. pyrnnoise yields one ~480-sample frame per
        # 10 ms of input; we add a few frames of slack to absorb any partial
        # tail frame and a defensive `if write + n > buf.size` resize that
        # should never fire in practice but keeps the script safe if a future
        # pyrnnoise version yields more frames than expected. This replaces a
        # `frames=[]; frames.append(); np.concatenate(frames)` pattern that
        # cost both a 360 k-item Python list build and a full-buffer copy at
        # concatenation time for hour-long files.
        frame_samples = RNNOISE_SR // 100
        max_frames = (pcm16.shape[0] + frame_samples - 1) // frame_samples + 4
        out_buf = np.empty(max_frames * frame_samples, dtype=np.int16)
        sp_arr  = np.empty(max_frames, dtype=np.float32)
        write_offset = 0
        frame_count  = 0
        for speech_prob, denoised_frame in rnn.denoise_chunk(pcm16, partial=True):
            # denoised_frame: (channels, samples) int16 at sample_rate (=48 kHz)
            f = denoised_frame[0] if denoised_frame.ndim == 2 else denoised_frame
            n = f.shape[0]
            if write_offset + n > out_buf.shape[0]:
                # Defensive grow — unreachable with the +4 slack above unless
                # pyrnnoise yields more frames than the input justifies.
                out_buf = np.concatenate([out_buf, np.empty(frame_samples * 8, dtype=np.int16)])
                sp_arr  = np.concatenate([sp_arr,  np.empty(8, dtype=np.float32)])
            out_buf[write_offset:write_offset + n] = f
            write_offset += n
            # pyrnnoise yields speech_prob as a length-1 ndarray (one entry
            # per channel; we run mono). Use .item() to extract a Python
            # float without tripping NumPy 1.25+ scalar-conversion deprecation.
            sp_arr[frame_count] = speech_prob.item() if hasattr(speech_prob, 'item') else speech_prob
            frame_count += 1
        speech_probs = sp_arr[:frame_count]

        # Resolve the Silero (25 ms) mask onto the RNNoise (10 ms) frame grid.
        # Output frame k aligns with original-audio time (k - strip_frames) * 10 ms;
        # the matching Silero frame is floor(t_ms / 25). Pre-roll frames (k <
        # strip_frames) have no original-audio counterpart — leave them as
        # "speech" so the gate never alters warmup output (which is stripped).
        # Tail frames beyond the Silero mask's range also default to "speech";
        # they cover the trailing input pad / model flush region.
        if silero_mask is not None and frame_count > 0:
            silero_full = np.asarray(silero_mask, dtype=bool)
            k = np.arange(frame_count, dtype=np.int64)
            t_orig_ms = (k - strip_frames) * 10
            sf = t_orig_ms // 25
            # Default to True (= speech); flip to ~isSilence on frames that
            # land inside the Silero mask. Pre-roll (t<0) and post-tail
            # (sf >= len) keep the True default.
            silero_per_rnn = np.ones(frame_count, dtype=bool)
            valid = (t_orig_ms >= 0) & (sf < silero_full.shape[0])
            silero_per_rnn[valid] = ~silero_full[sf[valid]]

        if frame_count > 0:
            denoised_pcm16 = out_buf[:write_offset]

            # VAD-disagreement gate: where Silero says SPEECH but RNNoise's
            # internal VAD speech_prob < threshold, swap the denoised frame
            # back to the dry input. RNNoise misclassifies unvoiced fricative
            # onsets (e.g. /tʃ/, /s/, /ʃ/) as noise and aggressively suppresses
            # them; Silero v5's larger context window correctly identifies
            # those frames as speech. A short linear crossfade at each
            # override-region boundary keeps frame-boundary discontinuities
            # below the click threshold.
            # speech_probs / silero_per_rnn are ndarrays at this point — the
            # plain truthy check used to work on lists but raises on ndarrays.
            # frame_count > 0 already gates the outer block, so the size check
            # is implicit.
            if args.vad_gate and silero_per_rnn is not None:
                # Pass the algorithmic delay so the gate can time-align the
                # dry source against the denoised output. RNNoise emits each
                # denoised sample algo_delay_frames * 10 ms after the input
                # sample it cleaned, so a naïve same-index mix would splice
                # the onset's "future" onto its denoised position — audible
                # as a 20 ms doubled onset at every override boundary.
                vad_gate_stats = _apply_vad_gate(
                    denoised_pcm16,
                    pcm16,
                    speech_probs,
                    silero_per_rnn,
                    args.rnnoise_threshold,
                    args.crossfade_ms,
                    algo_delay_samples=algo_delay_frames * (RNNOISE_SR // 100),
                    hangover_frames=args.hangover_frames,
                )
                # _apply_vad_gate returns the gated buffer under '_buffer'
                # alongside the stats; pop it out before reporting.
                denoised_pcm16 = vad_gate_stats.pop('_buffer')

            waveform = denoised_pcm16.astype(np.float32)[np.newaxis, :] / 32767.0
        else:
            print('[rnnoise] WARNING: denoise_chunk produced no output — '
                  'passing through unchanged.', flush=True)
    else:
        # Fallback: pyrnnoise unavailable, pass through with a warning.
        print('[rnnoise] WARNING: pyrnnoise not installed — NE-1 pre-pass skipped, '
              'passing audio through unchanged.', file=sys.stderr)

    # Resample back to 44.1 kHz (pipeline internal format)
    waveform = _resample(waveform, RNNOISE_SR, PIPELINE_SR)

    # Strip 20 ms internal pad + 20 ms RNNoise algorithmic delay = 40 ms total.
    # After the strip the leading edge is the original audio at its correct
    # position; truncate or zero-pad the tail to match the original input
    # length so the caller can use this file directly with no trim pass.
    strip_samples = int(0.040 * PIPELINE_SR)
    if waveform.shape[1] > strip_samples:
        waveform = waveform[:, strip_samples:]
    else:
        waveform = waveform[:, :0]

    if waveform.shape[1] >= original_length:
        waveform = waveform[:, :original_length]
    else:
        pad_needed = original_length - waveform.shape[1]
        waveform = np.concatenate([
            waveform,
            np.zeros((waveform.shape[0], pad_needed), dtype=waveform.dtype),
        ], axis=1)

    # Write 32-bit float WAV at 44.1 kHz, mono
    wavfile.write(args.output, PIPELINE_SR, waveform[0].astype(np.float32))

    # Diagnostic: dump per-frame VAD speech_prob curve from pyrnnoise.
    # Each yielded frame is 10 ms at 48 kHz. Output frame index `i` aligns
    # with original-audio time `(i - strip_frames) * 10` ms. The Silero mask
    # (if any) was already resolved onto the RNNoise frame grid above so the
    # gate and the dump share the same alignment.
    if args.speech_prob_out and speech_probs is not None and speech_probs.size > 0:
        arr = speech_probs.astype(np.float64, copy=False)
        sidecar = {
            'frame_duration_ms':     10,
            'sample_rate':           RNNOISE_SR,
            'frame_count':           int(arr.size),
            'head_pad_frames':       head_pad_frames,
            'algo_delay_frames':     algo_delay_frames,
            'strip_frames':          strip_frames,
            't0_frame_index':        strip_frames,  # frame at original t=0
            'speech_probs':          [round(float(v), 4) for v in arr.tolist()],
            'summary': {
                'min':                round(float(arr.min()), 4),
                'max':                round(float(arr.max()), 4),
                'mean':               round(float(arr.mean()), 4),
                'median':             round(float(np.median(arr)), 4),
                'frames_below_0p10':  int((arr < 0.10).sum()),
                'frames_below_0p30':  int((arr < 0.30).sum()),
                'frames_below_0p50':  int((arr < 0.50).sum()),
                'frames_above_0p50':  int((arr >= 0.50).sum()),
            },
        }
        if silero_per_rnn is not None:
            # silero_per_rnn is already a bool ndarray (vectorised resolver
            # above). Booleans serialise as 0/1 to keep the sidecar compact;
            # the diagnostic reader interprets both consistently.
            sidecar['silero_speech_per_rnn_frame'] = silero_per_rnn.astype(np.int8).tolist()
            sidecar['silero_mask_frame_count'] = int(len(silero_mask) if silero_mask else 0)
            sidecar['silero_mask_frame_duration_ms'] = 25
            disagree = (arr < 0.30) & silero_per_rnn
            sidecar['summary']['silero_speech_frames']     = int(silero_per_rnn.sum())
            sidecar['summary']['silero_silence_frames']    = int((~silero_per_rnn).sum())
            sidecar['summary']['disagree_silero_speech_rnnoise_lt_0p30'] = int(disagree.sum())
        try:
            with open(args.speech_prob_out, 'w', encoding='utf-8') as f:
                json.dump(sidecar, f)
            s = sidecar['summary']
            extra = (f"  disagree={s['disagree_silero_speech_rnnoise_lt_0p30']}"
                     if 'disagree_silero_speech_rnnoise_lt_0p30' in s else '')
            print(f"[rnnoise] speech_prob dump → {args.speech_prob_out} "
                  f"(n={sidecar['frame_count']}  min={s['min']:.2f}  "
                  f"mean={s['mean']:.2f}  <0.30={s['frames_below_0p30']}{extra})",
                  flush=True)
        except OSError as e:
            print(f"[rnnoise] WARNING: failed to write speech_prob sidecar "
                  f"({args.speech_prob_out}): {e}", file=sys.stderr)

    result = {
        'model': 'RNNoise',
        'speech_prob_out': args.speech_prob_out if args.speech_prob_out else None,
    }
    if vad_gate_stats is not None:
        # Strip any internal-only keys before surfacing to the caller.
        vad_gate_stats.pop('_buffer', None)
        result['vad_gate'] = vad_gate_stats
        raw = vad_gate_stats.get('raw_overrides', vad_gate_stats['overrides'])
        print(f"[rnnoise] VAD gate: {vad_gate_stats['overrides']} / "
              f"{vad_gate_stats['total_frames']} frames overridden "
              f"(raw={raw}, "
              f"threshold={vad_gate_stats['threshold']:.2f}, "
              f"hangover={vad_gate_stats.get('hangover_frames', 0)} fr, "
              f"crossfade={vad_gate_stats['crossfade_ms']:.1f} ms)",
              flush=True)
    return result


def run(argv):
    """Entry point used by the persistent worker (_worker.py)."""
    return main(argv)


if __name__ == '__main__':
    # Legacy spawn path: emit the result dict as a JSON_RESULT: line so
    # spawnPythonJsonResult on the JS side can read it back. Progress logs
    # printed to stdout above are filtered out by the legacy reader.
    _result = main()
    print('JSON_RESULT:' + json.dumps(_result), flush=True)
