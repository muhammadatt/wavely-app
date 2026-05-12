"""
air_boost_masked.py — Sibilant-aware air boost blend pass.

Reads a boosted WAV (output of the FFmpeg Maag EQ filter chain) and the
original pre-boost WAV, then blends them using a smooth gain envelope derived
from the sibilance event map.  On sibilant frames the boost gain is attenuated
to `sibilant_gain_floor` (default 0.0 = no boost at all on sibilants).  On
non-sibilant frames the gain is 1.0 (full boost passes through).

Envelope behaviour matches a de-esser: fast attack (boost drops quickly when
a sibilant starts) and slower release (boost recovers after the sibilant ends).

IIR smoothing is computed at hop-frame rate (~86 Hz for hop_length=512 @
44.1 kHz) and then linearly interpolated to sample rate.  This is equivalent
in timing accuracy to a per-sample loop but avoids a 1.3 M iteration Python
loop for a 30-second file.

CLI:
  python air_boost_masked.py
    --original            <pre-boost.wav>
    --boosted             <post-boost.wav>
    --events              <sibilance_events.json>
    --output              <output.wav>
    [--sibilant-gain-floor  0.0]   # 0.0=no boost, 1.0=full (no-op)
    [--attack-ms            5.0]   # ms for boost to drop when sibilant starts
    [--release-ms          20.0]   # ms for boost to recover after sibilant ends
"""

import argparse
import json
import logging
import sys

import numpy as np
from scipy.io import wavfile

logger = logging.getLogger(__name__)


def build_gain_envelope(
    sibilant_frame_indices: list,
    hop_length:             int,
    n_samples:              int,
    sibilant_gain_floor:    float,
    attack_ms:              float,
    release_ms:             float,
    sample_rate:            int,
) -> np.ndarray:
    """
    Build a sample-level gain envelope from STFT sibilant frame indices.

    Each sibilant frame index maps to a hop_length-wide window in the audio.
    The IIR smoothing is applied at hop rate then interpolated to sample rate.

    Returns a float32 array of length n_samples with values in
    [sibilant_gain_floor, 1.0].
    """
    n_hops = max(1, (n_samples + hop_length - 1) // hop_length)

    # Target per-hop: 1.0 = full boost (non-sibilant), floor = reduced (sibilant)
    target_hops = np.ones(n_hops, dtype=np.float32)
    for fi in sibilant_frame_indices:
        if 0 <= fi < n_hops:
            target_hops[fi] = sibilant_gain_floor

    # IIR coefficients at hop rate
    hop_rate      = sample_rate / hop_length        # ~86.1 Hz for 512/44100
    attack_coeff  = np.exp(-1.0 / max(1.0, attack_ms  * hop_rate / 1000.0))
    release_coeff = np.exp(-1.0 / max(1.0, release_ms * hop_rate / 1000.0))

    # Per-hop IIR smoothing (~86 iterations for a 1-second file)
    envelope_hops = np.empty(n_hops, dtype=np.float32)
    env = 1.0
    for i, t in enumerate(target_hops):
        coeff = attack_coeff if t < env else release_coeff
        env   = coeff * env + (1.0 - coeff) * float(t)
        envelope_hops[i] = env

    # Interpolate hop-rate envelope to sample rate
    hop_centers      = np.arange(n_hops) * hop_length + hop_length // 2
    sample_positions = np.arange(n_samples)
    envelope         = np.interp(sample_positions, hop_centers, envelope_hops)
    return envelope.astype(np.float32)


def blend(original: np.ndarray, boosted: np.ndarray, envelope: np.ndarray) -> np.ndarray:
    """
    output = original + (boosted - original) * envelope
           = original*(1-env) + boosted*env

    Handles mono (1D) and stereo (2D, shape [samples, channels]).
    """
    if original.ndim == 2:
        envelope = envelope[:, np.newaxis]  # broadcast over channels
    return (original + (boosted - original) * envelope).astype(original.dtype)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")

    parser = argparse.ArgumentParser(description="Sibilant-aware air boost blend")
    parser.add_argument("--original",            required=True)
    parser.add_argument("--boosted",             required=True)
    parser.add_argument("--events",              required=True, help="Sibilance event map JSON")
    parser.add_argument("--output",              required=True)
    parser.add_argument("--sibilant-gain-floor", type=float, default=0.0)
    parser.add_argument("--attack-ms",           type=float, default=5.0)
    parser.add_argument("--release-ms",          type=float, default=20.0)
    args = parser.parse_args()

    sr_o, original = wavfile.read(args.original)
    sr_b, boosted  = wavfile.read(args.boosted)
    original = original.astype(np.float32)
    boosted  = boosted.astype(np.float32)

    if sr_o != sr_b:
        raise ValueError(f"Sample rate mismatch: original={sr_o} boosted={sr_b}")

    with open(args.events) as fh:
        events_map = json.load(fh)

    hop_length             = events_map.get("hopLength", 512)
    sibilant_frame_indices = events_map.get("sibilantFrameIndices", [])
    n_samples              = original.shape[0]

    if not sibilant_frame_indices:
        logger.info("AirBoostMask: no sibilant frames detected — writing boosted as-is")
        wavfile.write(args.output, sr_o, boosted)
        sys.exit(0)

    logger.info(
        f"AirBoostMask: {len(sibilant_frame_indices)} sibilant frames | "
        f"floor={args.sibilant_gain_floor:.2f} "
        f"attack={args.attack_ms}ms release={args.release_ms}ms"
    )

    gain_envelope = build_gain_envelope(
        sibilant_frame_indices, hop_length, n_samples,
        args.sibilant_gain_floor, args.attack_ms, args.release_ms, sr_o,
    )

    output = blend(original, boosted, gain_envelope)
    wavfile.write(args.output, sr_o, output)

    sib_pct = 100.0 * len(sibilant_frame_indices) * hop_length / n_samples
    logger.info(
        f"AirBoostMask: done | sibilant≈{sib_pct:.1f}% of audio | "
        f"envelope min={gain_envelope.min():.3f} max={gain_envelope.max():.3f}"
    )
