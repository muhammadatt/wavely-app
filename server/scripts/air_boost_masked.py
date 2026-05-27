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
"""

import argparse
import json
import logging
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import stft, istft

logger = logging.getLogger(__name__)

# Must match analyze_sibilance_events.py so sibilant frame indices align
# 1-to-1 with STFT frames computed here.
N_FFT      = 2048
HOP_LENGTH = 512


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


def blend_stft_channel(orig_ch, boost_ch, envelope, sample_rate):
    """
    STFT-domain blend for a single mono float32 channel.
    Returns a float32 array of the same length as orig_ch.
    """
    n_samples = len(orig_ch)
    noverlap  = N_FFT - HOP_LENGTH

    _, _, S_orig  = stft(orig_ch,  sample_rate, nperseg=N_FFT, noverlap=noverlap, boundary='zeros')
    _, _, S_boost = stft(boost_ch, sample_rate, nperseg=N_FFT, noverlap=noverlap, boundary='zeros')

    # Align envelope to the actual STFT frame count (may differ by 1–2 frames
    # from the estimate used when building it)
    n_frames = S_orig.shape[1]
    env_frame = np.ones(n_frames, dtype=np.float32)
    copy_len  = min(len(envelope), n_frames)
    env_frame[:copy_len] = envelope[:copy_len]

    # Complex STFT blend — shape (n_bins, n_frames)
    # S_out = S_orig + (S_boost - S_orig) * env  →  no phase mismatch
    S_out = S_orig + (S_boost - S_orig) * env_frame[np.newaxis, :]

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
    args = parser.parse_args(argv)

    sr_o, original = wavfile.read(args.original)
    sr_b, boosted  = wavfile.read(args.boosted)
    original = original.astype(np.float32)
    boosted  = boosted.astype(np.float32)

    if sr_o != sr_b:
        raise ValueError(f"Sample rate mismatch: original={sr_o} boosted={sr_b}")

    with open(args.events) as fh:
        events_map = json.load(fh)

    sibilant_frame_indices = events_map.get("sibilantFrameIndices", [])
    n_samples              = original.shape[0]

    if not sibilant_frame_indices:
        logger.info("AirBoostMask: no sibilant frames — writing boosted as-is")
        wavfile.write(args.output, sr_o, boosted)
        return {'sibilant_frames': 0, 'applied': False}

    logger.info(
        f"AirBoostMask: {len(sibilant_frame_indices)} sibilant frames | "
        f"floor={args.sibilant_gain_floor:.2f} "
        f"attack={args.attack_ms}ms release={args.release_ms}ms"
    )

    # Estimate frame count for envelope pre-allocation (blend_stft_channel aligns)
    n_frames_est = 1 + n_samples // HOP_LENGTH
    envelope = build_frame_envelope(
        sibilant_frame_indices, n_frames_est,
        args.sibilant_gain_floor, args.attack_ms, args.release_ms, sr_o,
    )

    mono = original.ndim == 1
    if mono:
        output = blend_stft_channel(original, boosted, envelope, sr_o)
    else:
        out_channels = [
            blend_stft_channel(original[:, c], boosted[:, c], envelope, sr_o)
            for c in range(original.shape[1])
        ]
        output = np.stack(out_channels, axis=1)

    wavfile.write(args.output, sr_o, output)

    sib_pct = 100.0 * len(sibilant_frame_indices) * HOP_LENGTH / n_samples
    logger.info(
        f"AirBoostMask: done | sibilant≈{sib_pct:.1f}% | "
        f"envelope min={envelope.min():.3f}"
    )

    return {
        'sibilant_frames': len(sibilant_frame_indices),
        'sibilant_pct': sib_pct,
        'envelope_min': float(envelope.min()),
        'applied': True,
    }


def run(argv):
    """Entry point used by the persistent worker (_worker.py)."""
    return main(argv)


if __name__ == "__main__":
    main()
