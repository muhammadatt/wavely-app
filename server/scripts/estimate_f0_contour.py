"""
estimate_f0_contour.py
Per-frame F0 contour estimation for pipeline caching.

Produces a per-STFT-frame F0 track consumed by downstream stages that need
accurate harmonic positions (e.g. resonance suppressor harmonic mask). Runs
once and is cached on ctx._f0Contour by f0Analysis.js so subsequent stages
pay zero marginal cost.

Framing convention: center-padded (pad = n_fft // 2), matching the resonance
suppressor's STFT convention so frame indices align exactly.

Output JSON shape:
  {
    "median":    float,          -- median of voiced-frame F0 estimates (Hz)
    "perFrame":  [float, ...],   -- one value per STFT frame, NaN gaps forward-filled
    "nFft":      int,
    "hopLength": int
  }

Dependencies: numpy, scipy
"""

import argparse
import json
import logging
import sys

import numpy as np
from scipy.io import wavfile

logger = logging.getLogger(__name__)

F0_MIN_HZ      = 70.0
F0_MAX_HZ      = 400.0
MIN_CORR_RATIO = 0.10


def _autocorr_f0(frame: np.ndarray, sample_rate: int) -> float | None:
    """Single-frame F0 estimate via autocorrelation. Returns None on failure."""
    n = len(frame)
    if n < 64:
        return None
    f       = frame.astype(np.float64) - frame.mean()
    n_fft   = 2 * n
    corr    = np.fft.irfft(np.abs(np.fft.rfft(f, n=n_fft)) ** 2)
    corr    = corr[:n]
    lag_min = int(sample_rate / F0_MAX_HZ)
    lag_max = int(sample_rate / F0_MIN_HZ)
    if lag_max >= len(corr) or lag_min >= lag_max:
        return None
    i = lag_min + int(np.argmax(corr[lag_min:lag_max]))
    if corr[i] > MIN_CORR_RATIO * corr[0] and i > 0:
        # Parabolic interpolation: fit a parabola through the three points
        # surrounding the integer-lag peak and solve for the continuous maximum.
        # This removes the lag-quantisation error (up to ±0.8 Hz at f0≈188 Hz
        # before interpolation) without introducing any new dependencies.
        #   delta = 0.5 × (y₋₁ − y₊₁) / (y₋₁ − 2y₀ + y₊₁)
        # Guard: skip when i is at a boundary or denominator is zero.
        if 0 < i < len(corr) - 1:
            y0, y1, y2 = corr[i - 1], corr[i], corr[i + 1]
            denom = y0 - 2.0 * y1 + y2
            if denom != 0.0:
                delta = 0.5 * (y0 - y2) / denom
                return float(sample_rate / (i + delta))
        return float(sample_rate / i)
    return None


def estimate_f0_contour(
    audio: np.ndarray,
    sample_rate: int,
    vad_voiced_mask: np.ndarray | None = None,
    n_fft: int = 2048,
    hop_length: int = 512,
) -> dict:
    """
    Compute a per-STFT-frame F0 contour via autocorrelation.

    Uses center-padded framing (pad = n_fft // 2) to match the resonance
    suppressor's STFT convention so frame k here is frame k there.
    F0 is estimated on every voiced frame; unvoiced gaps are forward-filled
    from the last voiced estimate. Leading gaps before the first voiced
    estimate have no prior value and are seeded with the contour median.

    Args:
        audio:           Mono float32 audio array.
        sample_rate:     Sample rate in Hz.
        vad_voiced_mask: Optional per-sample bool array; silence frames are
                         skipped (their gaps are forward-filled from the last
                         voiced estimate).
        n_fft:           STFT frame length. Must match the consumer's n_fft.
        hop_length:      STFT hop. Must match the consumer's hop_length.

    Returns:
        dict with keys: median (float), perFrame (list[float]),
                        nFft (int), hopLength (int).
    """
    pad       = n_fft // 2
    n_samples = len(audio)

    # Short-audio guard: np.pad mode='reflect' requires pad < len(audio)
    # (strictly less than). Clips shorter than n_fft // 2 samples (~23 ms at
    # 44.1 kHz for the default n_fft=2048) would raise a ValueError.
    # • Empty input  → return a one-frame contour seeded by the default median
    #   so downstream stages always receive a non-empty perFrame list.
    # • Short input  → fall back to 'edge' padding (repeats the boundary
    #   sample) which is valid for any non-empty array and avoids the
    #   step-discontinuity artefact that 'constant' (zero) padding introduces.
    if n_samples == 0:
        logger.warning("estimate_f0_contour: empty audio — returning default contour")
        default_f0 = 120.0
        return {"median": default_f0, "perFrame": [default_f0], "nFft": n_fft, "hopLength": hop_length}

    pad_mode = "reflect" if n_samples > pad else "edge"
    if pad_mode == "edge":
        logger.warning(
            f"estimate_f0_contour: audio ({n_samples} samples) shorter than "
            f"pad ({pad} samples) — using 'edge' padding instead of 'reflect'"
        )

    padded   = np.pad(audio.astype(np.float32), pad, mode=pad_mode)
    n_frames = max(0, (len(padded) - n_fft) // hop_length + 1)
    f0_arr   = np.full(n_frames, np.nan, dtype=np.float64)

    for k in range(n_frames):
        start = k * hop_length
        end   = start + n_fft
        if end > len(padded):
            break

        # Skip silence frames — their slots are forward-filled below.
        # Vote across the frame window rather than probing a single center
        # sample; a frame that straddles a voiced/silence boundary at its
        # center would be misclassified by a single-sample probe.
        if vad_voiced_mask is not None:
            # Frame center in original-audio coordinates (center padding means
            # frame k's center aligns to k * hop_length in the source signal).
            frame_center = k * hop_length
            half         = n_fft // 4   # vote window: ±25 % of frame length
            lo = max(0, frame_center - half)
            hi = min(n_samples, frame_center + half)
            if lo >= hi or not vad_voiced_mask[lo:hi].any():
                continue

        # Estimate F0 on every voiced frame. The autocorrelation is a single
        # FFT over n_fft samples — cheap enough that per-frame estimation adds
        # negligible cost, and it removes the forward-fill staircase a
        # subsampled contour produces at phoneme-boundary pitch jumps (which
        # otherwise leaves the resonance suppressor's harmonic mask stale for
        # up to ~2 frames after the pitch moves).
        est = _autocorr_f0(padded[start:end], sample_rate)
        if est is not None:
            f0_arr[k] = est

    # Forward-fill NaN gaps; use median as seed for any leading NaNs.
    valid = f0_arr[~np.isnan(f0_arr)]
    median_f0 = float(np.median(valid)) if valid.size > 0 else 120.0
    last = median_f0
    for k in range(n_frames):
        if np.isnan(f0_arr[k]):
            f0_arr[k] = last
        else:
            last = float(f0_arr[k])

    logger.info(
        f"F0 contour: frames={n_frames} median={median_f0:.1f} Hz "
        f"voiced_estimates={valid.size}"
    )

    return {
        "median":    round(median_f0, 2),
        "perFrame":  [round(float(v), 2) for v in f0_arr],
        "nFft":      n_fft,
        "hopLength": hop_length,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    parser = argparse.ArgumentParser(description="Per-frame F0 contour estimator")
    parser.add_argument("--input",         required=True,  help="Input WAV (float32, 44.1 kHz)")
    parser.add_argument("--output",        required=True,  help="Output JSON path")
    parser.add_argument("--vad-mask-json", default=None,   help="VAD frame list JSON")
    parser.add_argument("--n-fft",         type=int, default=2048)
    parser.add_argument("--hop-length",    type=int, default=512)
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    # Normalize integer PCM to [-1, 1] so autocorrelation ratios are correct
    # for silent passages (corr[0] ≈ 0 for a silent frame; without normalization
    # int16 silence at 0 makes the ratio check vacuously pass).
    # float32/float64 WAV is already in [-1, 1] — np.iinfo raises for float
    # dtypes, so check first.
    if np.issubdtype(audio.dtype, np.integer):
        audio = audio.astype(np.float32) / np.iinfo(audio.dtype).max
    else:
        audio = audio.astype(np.float32)

    vad_voiced_mask = None
    if args.vad_mask_json:
        with open(args.vad_mask_json) as fh:
            frame_list = json.load(fh)
        vad_voiced_mask = np.zeros(len(audio), dtype=bool)
        for frame in frame_list:
            if not frame["isSilence"]:
                s = frame["offsetSamples"]
                e = s + frame["lengthSamples"]
                vad_voiced_mask[s : min(e, len(audio))] = True

    result = estimate_f0_contour(audio, sr, vad_voiced_mask, args.n_fft, args.hop_length)
    with open(args.output, "w") as fh:
        json.dump(result, fh)
    print(
        f"F0Contour: median={result['median']}Hz frames={len(result['perFrame'])}",
        flush=True,
    )
