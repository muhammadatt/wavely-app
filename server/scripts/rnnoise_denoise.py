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


def main(argv=None):
    parser = argparse.ArgumentParser(description='Apply RNNoise pre-separation pass')
    parser.add_argument('--input',  required=True, help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output', required=True, help='Output WAV (32-bit float, 44.1 kHz)')
    args = parser.parse_args(argv)

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
    rnn = _get_rnnoise()
    if rnn is not None:
        pcm16 = np.clip(waveform[0] * 32767, -32768, 32767).astype(np.int16)

        frames = []
        for _speech_prob, denoised_frame in rnn.denoise_chunk(pcm16, partial=True):
            # denoised_frame: (channels, samples) int16 at sample_rate (=48 kHz)
            frames.append(denoised_frame[0] if denoised_frame.ndim == 2 else denoised_frame)

        if frames:
            denoised_pcm16 = np.concatenate(frames).astype(np.int16)
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

    return {
        'model': 'RNNoise',
        'input_sr': int(sr),
        'output_sr': PIPELINE_SR,
    }


def run(argv):
    """Entry point used by the persistent worker (_worker.py)."""
    return main(argv)


if __name__ == '__main__':
    main()
