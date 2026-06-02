"""
air_boost_masked.py — Sibilant-aware air boost blend pass.

STFT-domain implementation — avoids the phase artefacts of time-domain blending.

WHY TIME-DOMAIN BLENDING IS WRONG HERE
---------------------------------------
The Maag EQ chain uses IIR biquad filters (FFmpeg equalizer / highshelf).
IIR filters introduce a frequency-varying phase shift, so the boosted audio
is phase-shifted relative to the original.  A naive time-domain blend:

    output = original * (1-env) + boosted * env

sums two signals that disagree in phase, creating comb-filtering artefacts at
transition frequencies.  These spectral irregularities are then visible to the
resonance suppressor, which reacts to them and produces secondary artefacts.

WHY STFT-DOMAIN BLENDING IS CORRECT
--------------------------------------
In the complex STFT domain, S_boost[frame, bin] = S_orig[frame, bin] × H(f),
where H(f) is the filter's complex transfer function.  The blend formula:

    S_out = S_orig + (S_boost − S_orig) × env
          = S_orig × (1 + (H − 1) × env)

correctly interpolates both the magnitude and phase of the filter response.
env=1 → full boost transfer function applied; env=0 → identity (no boost).
No two out-of-phase signals are ever summed, so there are no comb-filter
artefacts.

The STFT parameters (N_FFT=2048, HOP_LENGTH=512) match analyze_sibilance_events.py
so that sibilant frame indices index directly into STFT frames with no resampling.

CLI:
  python air_boost_masked.py
    --original            <pre-boost.wav>
    --boosted             <post-boost.wav>
    --events              <sibilance_events.json>
    --output              <output.wav>
    [--sibilant-gain-floor  0.0]   # 0.0=no boost on sibilants, 1.0=full (no-op)
    [--attack-ms            5.0]   # ms for boost to drop when a sibilant starts
    [--release-ms          20.0]   # ms for boost to recover after a sibilant ends
    [--frame-offset           0]   # STFT-frame shift applied to sibilant indices
                                   # (chunked-mode: caller supplies the chunk's
                                   #  carve-start expressed in STFT frames so
                                   #  whole-file indices in the events JSON
                                   #  resolve to chunk-local frames)
"""

import argparse
import json
import logging
import os
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import stft, istft

logger = logging.getLogger(__name__)

# Must match analyze_sibilance_events.py so sibilant frame indices align
# 1-to-1 with STFT frames computed here.
N_FFT      = 2048
HOP_LENGTH = 512

# Probe frequencies for the diagnostic spectrum dump. Sampled to cover the
# Maag Air Band model: low (control), midrange (where the user reports a
# spurious +2 dB lump), and the 6–16 kHz shelf region.
PROBE_FREQS_HZ = (200, 500, 1000, 2000, 3100, 4000, 6000, 8000, 10000, 12000, 14000)


def _average_magnitude_db(signal, sample_rate, freqs_hz):
    """
    Return the time-averaged STFT magnitude in dB at each probe frequency.

    Uses the same STFT geometry as the blend so the numbers are directly
    comparable across original / boosted / output signals.
    """
    noverlap = N_FFT - HOP_LENGTH
    _, _, S  = stft(signal, sample_rate, nperseg=N_FFT, noverlap=noverlap, boundary='zeros')
    mag      = np.abs(S).mean(axis=1)
    bin_hz   = sample_rate / N_FFT
    eps      = 1e-12
    out      = []
    for f in freqs_hz:
        k    = int(round(f / bin_hz))
        k    = max(0, min(k, len(mag) - 1))
        out.append(20.0 * float(np.log10(mag[k] + eps)))
    return out


def _format_probe_row(label, db_values):
    parts = " ".join(f"{v:+6.2f}" for v in db_values)
    return f"AirBoostMask probe {label:>10s}: {parts}"


def log_spectrum_diagnostic(original, boosted, output, sample_rate):
    """Emit a fixed-format spectrum table for original / boosted / output."""
    o_db = _average_magnitude_db(original, sample_rate, PROBE_FREQS_HZ)
    b_db = _average_magnitude_db(boosted,  sample_rate, PROBE_FREQS_HZ)
    y_db = _average_magnitude_db(output,   sample_rate, PROBE_FREQS_HZ)
    boosted_curve = [b - o for b, o in zip(b_db, o_db)]
    output_curve  = [y - o for y, o in zip(y_db, o_db)]
    header = " ".join(f"{f/1000:>6.1f}k" if f >= 1000 else f"{f:>6.0f}" for f in PROBE_FREQS_HZ)
    logger.info(f"AirBoostMask probe freqs (Hz)       : {header}")
    logger.info(_format_probe_row("orig dB",  o_db))
    logger.info(_format_probe_row("boost dB", b_db))
    logger.info(_format_probe_row("out dB",   y_db))
    logger.info(_format_probe_row("boost−orig", boosted_curve))
    logger.info(_format_probe_row("out−orig",   output_curve))


def build_freq_weight(
    n_bins:          int,
    sample_rate:     int,
    cutoff_hz:       float,
    transition_oct:  float,
) -> np.ndarray:
    """
    Return a per-bin attenuation-reach weight, shape (n_bins,).

    Controls how much of the sibilant frame envelope reaches each FFT bin:
      weight = 0    -> envelope has no effect; boost preserved on every frame
      weight = 1    -> envelope applies fully; sibilant frames revert toward
                       the unboosted spectrum at that bin

    Shape: zero below `cutoff_hz`, full above `cutoff_hz * 2^transition_oct`,
    half-cosine taper across the transition span on the log-frequency axis.
    A log-axis taper matches how the EQ shelf rolls in (octave-symmetric) and
    avoids ringing from a hard bin-edge step. transition_oct <= 0 falls back
    to a hard rectangular split at cutoff_hz.

    Bin geometry follows the same STFT used by blend_stft_channel below,
    so bin k maps to frequency k * sample_rate / N_FFT.
    """
    bin_hz = sample_rate / N_FFT
    freqs  = np.arange(n_bins, dtype=np.float32) * bin_hz
    if transition_oct <= 0.0:
        return (freqs >= cutoff_hz).astype(np.float32)

    upper = cutoff_hz * (2.0 ** transition_oct)
    weight = np.empty(n_bins, dtype=np.float32)
    for i, f in enumerate(freqs):
        if f <= cutoff_hz:
            weight[i] = 0.0
        elif f >= upper:
            weight[i] = 1.0
        else:
            # Log-frequency position [0, 1] across the transition span.
            t = np.log2(f / cutoff_hz) / transition_oct
            # Half-cosine ramp 0 -> 1 (smooth at both endpoints).
            weight[i] = 0.5 - 0.5 * np.cos(np.pi * t)
    return weight


def build_frame_envelope(
    sibilant_frame_indices: list,
    n_frames:               int,
    sibilant_gain_floor:    float,
    attack_ms:              float,
    release_ms:             float,
    sample_rate:            int,
) -> np.ndarray:
    """
    Build a per-STFT-frame IIR gain envelope.

    1.0               = full boost (non-sibilant frame)
    sibilant_gain_floor = attenuated boost (sibilant frame)

    Attack  = how fast the gain drops when a sibilant frame starts.
    Release = how fast the gain recovers after a sibilant frame ends.
    Frame rate is ~86 Hz for HOP_LENGTH=512 @ 44.1 kHz — Python loop is fast.
    """
    target = np.ones(n_frames, dtype=np.float32)
    for fi in sibilant_frame_indices:
        if 0 <= fi < n_frames:
            target[fi] = sibilant_gain_floor

    frame_rate    = sample_rate / HOP_LENGTH          # ~86.1 Hz
    attack_coeff  = np.exp(-1.0 / max(1.0, attack_ms  * frame_rate / 1000.0))
    release_coeff = np.exp(-1.0 / max(1.0, release_ms * frame_rate / 1000.0))

    envelope = np.empty(n_frames, dtype=np.float32)
    env = 1.0
    for i, t in enumerate(target):
        coeff = attack_coeff if t < env else release_coeff
        env   = coeff * env + (1.0 - coeff) * float(t)
        envelope[i] = env
    return envelope


def blend_stft_channel(orig_ch, boost_ch, envelope, sample_rate, freq_weight=None):
    """
    STFT-domain blend for a single mono float32 channel.
    Returns a float32 array of the same length as orig_ch.

    `freq_weight` (shape (n_bins,), values in [0,1]) controls per-bin reach
    of the sibilant envelope. None or all-ones reproduces the legacy uniform
    broadcast behaviour. See build_freq_weight() for shape semantics.
    """
    n_samples = len(orig_ch)
    noverlap  = N_FFT - HOP_LENGTH

    _, _, S_orig  = stft(orig_ch,  sample_rate, nperseg=N_FFT, noverlap=noverlap, boundary='zeros')
    _, _, S_boost = stft(boost_ch, sample_rate, nperseg=N_FFT, noverlap=noverlap, boundary='zeros')

    # Align envelope to the actual STFT frame count (may differ by 1–2 frames
    # from the estimate used when building it)
    n_bins, n_frames = S_orig.shape
    env_frame = np.ones(n_frames, dtype=np.float32)
    copy_len  = min(len(envelope), n_frames)
    env_frame[:copy_len] = envelope[:copy_len]

    # 2D bin/frame mask. env_frame controls TIME attenuation (sibilant frames
    # pull toward env=floor); freq_weight controls FREQUENCY reach of that
    # attenuation (only bins above the shelf-region cutoff see it). Outside
    # those bins env_2d stays at 1.0 so the boost passes through every frame
    # untouched. Builds:
    #     env_2d = 1 - (1 - env_frame) * freq_weight
    # which equals env_frame where freq_weight==1 (legacy broadband behaviour)
    # and equals 1.0 where freq_weight==0 (boost fully preserved).
    if freq_weight is None:
        fw = np.ones(n_bins, dtype=np.float32)
    else:
        fw = np.asarray(freq_weight, dtype=np.float32)
        if fw.shape[0] != n_bins:
            raise ValueError(
                f"freq_weight length {fw.shape[0]} does not match n_bins {n_bins}"
            )
    env_2d = 1.0 - (1.0 - env_frame[np.newaxis, :]) * fw[:, np.newaxis]

    # Complex STFT blend — shape (n_bins, n_frames)
    # S_out = S_orig + (S_boost - S_orig) * env_2d  →  no phase mismatch
    S_out = S_orig + (S_boost - S_orig) * env_2d

    _, out = istft(S_out, sample_rate, nperseg=N_FFT, noverlap=noverlap, boundary=True)

    # Trim or pad to match original length exactly
    if len(out) > n_samples:
        out = out[:n_samples]
    elif len(out) < n_samples:
        out = np.pad(out, (0, n_samples - len(out)))

    return out.astype(np.float32)


def main(argv=None):
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(message)s")

    parser = argparse.ArgumentParser(description="Sibilant-aware air boost blend (STFT)")
    parser.add_argument("--original",            required=True)
    parser.add_argument("--boosted",             required=True)
    parser.add_argument("--events",              required=True, help="Sibilance event map JSON")
    parser.add_argument("--output",              required=True)
    parser.add_argument("--sibilant-gain-floor", type=float, default=0.0)
    parser.add_argument("--attack-ms",           type=float, default=5.0)
    parser.add_argument("--release-ms",          type=float, default=20.0)
    parser.add_argument("--frame-offset",        type=int,   default=0,
                        help="STFT-frame shift applied to sibilant indices "
                             "from the events JSON. Used in chunked mode so "
                             "whole-file frame indices resolve to chunk-local "
                             "frames (frame_offset = carve_start_samples / "
                             f"HOP_LENGTH={HOP_LENGTH}).")
    parser.add_argument("--mask-cutoff-hz",      type=float, default=4500.0,
                        help="Lower edge of the frequency-selective mask. "
                             "Bins below this frequency are not attenuated on "
                             "sibilant frames; bins above the transition span "
                             "are fully attenuated. Default 4500 sits at the "
                             "Maag shelf's -3 dB knee, so the 600/1200/2400/"
                             "4800 Hz bells are preserved on every frame and "
                             "only the 9.6 kHz bell + 14 kHz shelf are masked.")
    parser.add_argument("--mask-transition-oct", type=float, default=1.0,
                        help="Width of the log-frequency taper between the "
                             "preserved band and the masked band, in octaves. "
                             "Half-cosine ramp. Set <= 0 for a hard split at "
                             "--mask-cutoff-hz.")
    args = parser.parse_args(argv)

    sr_o, original = wavfile.read(args.original)
    sr_b, boosted  = wavfile.read(args.boosted)
    original = original.astype(np.float32)
    boosted  = boosted.astype(np.float32)

    if sr_o != sr_b:
        raise ValueError(f"Sample rate mismatch: original={sr_o} boosted={sr_b}")

    with open(args.events) as fh:
        events_map = json.load(fh)

    # Prefer the pre-expansion (core) frame list when the upstream producer
    # writes it. Core frames are exactly the ones that fired the primary
    # p95+flatness triggers — they exclude both boundary-relaxed promotions
    # and inter-event gap-merge bridges. Boundary halos otherwise pull the
    # time-averaged shelf in the spectrum probe down sharply because
    # boundary-promoted frames sit at the edges of fricatives where HF
    # energy is highest. Falls back to the expanded set on older events
    # files (pre-coreSibilantFrameIndices producers) with a one-line note
    # so the staleness is visible without breaking the run.
    expanded_indices = events_map.get("sibilantFrameIndices", [])
    core_indices     = events_map.get("coreSibilantFrameIndices")
    if core_indices is None:
        raw_sibilant_frame_indices = expanded_indices
        frame_source               = "sibilantFrameIndices (expanded — coreSibilantFrameIndices missing from upstream events file)"
    else:
        raw_sibilant_frame_indices = core_indices
        frame_source               = f"coreSibilantFrameIndices ({len(core_indices)} of {len(expanded_indices)} expanded retained)"

    n_samples = original.shape[0]

    # Prelude line — identifies the events file actually consumed, the STFT
    # geometry, and which frame list (core vs. expanded) drove the mask.
    # hopLength/nFft are logged because air_boost_masked's HOP_LENGTH/N_FFT
    # must match the producer's; any mismatch here would silently misalign
    # the envelope.
    logger.info(
        f"AirBoostMask: events_file={os.path.basename(args.events)} | "
        f"frameCount={events_map.get('frameCount', '?')} | "
        f"events={len(events_map.get('events', []) or [])} | "
        f"frames={len(raw_sibilant_frame_indices)} [{frame_source}] | "
        f"hopLength={events_map.get('hopLength', '?')} (expect {HOP_LENGTH}) | "
        f"nFft={events_map.get('nFft', '?')} (expect {N_FFT})"
    )

    if not raw_sibilant_frame_indices:
        logger.info("AirBoostMask: no sibilant frames — writing boosted as-is")
        wavfile.write(args.output, sr_o, boosted)
        # Probe boosted-vs-orig so the operator still sees what the FFmpeg EQ
        # pass produced on a no-mask run. out==boosted in this branch, so the
        # out−orig and boost−orig curves coincide.
        probe_orig  = original if original.ndim == 1 else original[:, 0]
        probe_boost = boosted  if boosted.ndim  == 1 else boosted[:, 0]
        log_spectrum_diagnostic(probe_orig, probe_boost, probe_boost, sr_o)
        return {'sibilant_frames': 0, 'applied': False}

    # Apply chunk frame offset: events JSON contains whole-file indices but
    # this invocation may be processing a carved chunk. Shift each index into
    # the chunk-local frame coordinate system. Indices that fall before the
    # chunk start become negative and are filtered by build_frame_envelope's
    # 0 <= fi < n_frames gate; indices past chunk end fall above n_frames and
    # are filtered the same way.
    if args.frame_offset != 0:
        sibilant_frame_indices = [fi - args.frame_offset for fi in raw_sibilant_frame_indices]
    else:
        sibilant_frame_indices = raw_sibilant_frame_indices

    logger.info(
        f"AirBoostMask: {len(raw_sibilant_frame_indices)} sibilant frames | "
        f"floor={args.sibilant_gain_floor:.2f} "
        f"attack={args.attack_ms}ms release={args.release_ms}ms | "
        f"mask_cutoff={args.mask_cutoff_hz:.0f}Hz transition={args.mask_transition_oct:.2f}oct"
        + (f" | frame_offset={args.frame_offset}" if args.frame_offset != 0 else "")
    )

    # Estimate frame count for envelope pre-allocation (blend_stft_channel aligns)
    n_frames_est = 1 + n_samples // HOP_LENGTH
    envelope = build_frame_envelope(
        sibilant_frame_indices, n_frames_est,
        args.sibilant_gain_floor, args.attack_ms, args.release_ms, sr_o,
    )

    # Per-bin frequency-selective mask weight. Confines the envelope's reach to
    # the HF region where sibilants live; below the cutoff the boost survives
    # on every frame, sibilant or not.
    n_bins = N_FFT // 2 + 1
    freq_weight = build_freq_weight(
        n_bins, sr_o, args.mask_cutoff_hz, args.mask_transition_oct,
    )

    mono = original.ndim == 1
    if mono:
        output = blend_stft_channel(original, boosted, envelope, sr_o, freq_weight)
    else:
        out_channels = [
            blend_stft_channel(original[:, c], boosted[:, c], envelope, sr_o, freq_weight)
            for c in range(original.shape[1])
        ]
        output = np.stack(out_channels, axis=1)

    wavfile.write(args.output, sr_o, output)

    # Sibilance count / percentage are reported per-call: numerator and
    # denominator are both scoped to the audio actually processed by this
    # invocation. In sequential mode frame_offset is 0 and every index falls
    # in range, so sib_in_range == len(raw_sibilant_frame_indices) and the
    # figure equals the file-wide coverage. In chunked mode only the indices
    # landing inside this chunk count, and the denominator is the chunk's
    # own frame total — both bounded together, ratio ∈ [0, 100%].
    sib_in_range = sum(1 for i in sibilant_frame_indices if 0 <= i < n_frames_est)
    sib_pct      = 100.0 * sib_in_range / n_frames_est if n_frames_est > 0 else 0.0
    logger.info(
        f"AirBoostMask: done | sibilant≈{sib_pct:.1f}% | "
        f"envelope min={envelope.min():.3f}"
    )

    # Spectrum probe — log the average magnitude (dB) of the three signals
    # at a fixed set of frequencies plus the implied EQ curves. Lets the
    # operator confirm whether (a) boostedPath actually carries the air
    # shelf (boost−orig curve), and (b) what the blend did to that shape
    # (out−orig curve). Mono only — chunked-mode runs blend per channel
    # already; the per-call diagnostic uses channel 0 so we have a single
    # representative row in the log without doubling the output.
    probe_orig   = original   if mono else original[:, 0]
    probe_boost  = boosted    if mono else boosted[:, 0]
    probe_output = output     if mono else output[:, 0]
    log_spectrum_diagnostic(probe_orig, probe_boost, probe_output, sr_o)

    return {
        'sibilant_frames': sib_in_range,
        'sibilant_pct': sib_pct,
        'envelope_min': float(envelope.min()),
        'applied': True,
    }


def run(argv):
    """Entry point used by the persistent worker (_worker.py)."""
    return main(argv)


if __name__ == "__main__":
    main()
