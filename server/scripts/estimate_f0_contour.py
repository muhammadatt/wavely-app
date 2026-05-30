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

# Batch size for the vectorized FFT autocorrelation. Peak memory is
# batch_size * 2 * frame_len * 8 bytes for the irfft output; 4096 frames at
# frame_len=2048 → ~270 MB peak, which fits comfortably within the worker's
# budget and amortises FFT planning over many frames per call.
_AUTOCORR_BATCH_SIZE = 4096


def _autocorr_f0_batch(
    frames:      np.ndarray,
    sample_rate: int,
) -> np.ndarray:
    """
    Vectorized F0 estimate via FFT-autocorrelation for a batch of frames.

    Single batched rfft/irfft over all rows replaces the per-frame Python loop
    in the previous _autocorr_f0 implementation. Results match the scalar
    function bit-for-bit (same float64 arithmetic, same parabolic interpolation,
    same MIN_CORR_RATIO gate, same boundary fallbacks).

    Args:
        frames:      (n_frames, frame_len) array. Each row is one frame.
        sample_rate: Sample rate in Hz.

    Returns:
        (n_frames,) float64 array of F0 estimates in Hz. NaN where no valid
        estimate could be produced (frame too short, ratio below threshold,
        or lag range empty).
    """
    n_frames, n = frames.shape
    if n < 64:
        return np.full(n_frames, np.nan, dtype=np.float64)

    # Zero-mean per frame (matches scalar `frame - frame.mean()` semantics).
    f64    = frames.astype(np.float64, copy=False)
    f64    = f64 - f64.mean(axis=1, keepdims=True)
    n_fft  = 2 * n
    spec   = np.fft.rfft(f64, n=n_fft, axis=1)
    corr   = np.fft.irfft(np.abs(spec) ** 2, n=n_fft, axis=1)
    # Scalar version trimmed corr to corr[:n]; preserve that for the
    # boundary check on parabolic interpolation (i < n - 1).

    lag_min = int(sample_rate / F0_MAX_HZ)
    lag_max = int(sample_rate / F0_MIN_HZ)
    if lag_max >= n or lag_min >= lag_max:
        return np.full(n_frames, np.nan, dtype=np.float64)

    corr0 = corr[:, 0]
    win   = corr[:, lag_min:lag_max]
    rel   = np.argmax(win, axis=1)
    peak  = win[np.arange(n_frames), rel]
    i_arr = lag_min + rel

    # Validity: ratio gate + i > 0 (matches scalar guard).
    valid = (peak > MIN_CORR_RATIO * corr0) & (i_arr > 0)

    f0 = np.full(n_frames, np.nan, dtype=np.float64)
    if not valid.any():
        return f0

    # Default branch (no parabolic interp): f0 = sr / i.
    f0[valid] = sample_rate / i_arr[valid]

    # Parabolic interpolation where possible (0 < i < n - 1 and denom != 0).
    # Matches scalar branch exactly.
    can_interp = valid & (i_arr > 0) & (i_arr < n - 1)
    rows = np.flatnonzero(can_interp)
    if rows.size > 0:
        ii    = i_arr[rows]
        y0    = corr[rows, ii - 1]
        y1    = corr[rows, ii]
        y2    = corr[rows, ii + 1]
        denom = y0 - 2.0 * y1 + y2
        nz    = denom != 0.0
        if nz.any():
            interp_rows = rows[nz]
            ii_nz       = ii[nz]
            delta       = 0.5 * (y0[nz] - y2[nz]) / denom[nz]
            f0[interp_rows] = sample_rate / (ii_nz + delta)

    return f0


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

    if n_frames == 0:
        logger.warning("estimate_f0_contour: zero frames — returning default contour")
        default_f0 = 120.0
        return {"median": default_f0, "perFrame": [default_f0], "nFft": n_fft, "hopLength": hop_length}

    # Per-frame voicing mask derived from the per-sample VAD. Vote across the
    # frame window rather than probing the centre sample: a frame straddling
    # a voiced/silence boundary at its centre would otherwise be misclassified
    # by a single-sample probe.
    voiced_frames = None
    if vad_voiced_mask is not None:
        voiced_frames = np.zeros(n_frames, dtype=bool)
        half          = n_fft // 4   # vote window: ±25 % of frame length
        for k in range(n_frames):
            frame_center = k * hop_length
            lo = max(0, frame_center - half)
            hi = min(n_samples, frame_center + half)
            if lo < hi and vad_voiced_mask[lo:hi].any():
                voiced_frames[k] = True
        process_idx = np.flatnonzero(voiced_frames)
    else:
        process_idx = np.arange(n_frames)

    # Vectorized batched autocorrelation. Build the (n_frames, n_fft) view via
    # sliding_window_view (zero-copy) then materialise only the voiced rows in
    # bounded-size batches. Replaces the original per-frame Python loop calling
    # _autocorr_f0 — identical numerics, ~5–10× faster on long files.
    if process_idx.size > 0:
        windows = np.lib.stride_tricks.sliding_window_view(padded, n_fft)[::hop_length]
        for start in range(0, process_idx.size, _AUTOCORR_BATCH_SIZE):
            batch_idx       = process_idx[start : start + _AUTOCORR_BATCH_SIZE]
            batch           = windows[batch_idx]
            est             = _autocorr_f0_batch(batch, sample_rate)
            f0_arr[batch_idx] = est

    # Forward-fill NaN gaps; use median as seed for any leading NaNs.
    # Vectorised equivalent of the previous scalar loop: build a "last valid
    # index up to here" array via maximum.accumulate, then gather; leading
    # positions with no prior valid index are replaced with the median seed.
    valid_mask = ~np.isnan(f0_arr)
    voiced_est = f0_arr[valid_mask]
    median_f0  = float(np.median(voiced_est)) if voiced_est.size > 0 else 120.0

    if valid_mask.any():
        idx       = np.where(valid_mask, np.arange(n_frames), -1)
        np.maximum.accumulate(idx, out=idx)
        gathered  = f0_arr[np.maximum(idx, 0)]
        f0_arr    = np.where(idx < 0, median_f0, gathered)
    else:
        f0_arr.fill(median_f0)

    logger.info(
        f"F0 contour: frames={n_frames} median={median_f0:.1f} Hz "
        f"voiced_estimates={voiced_est.size}"
    )

    return {
        "median":    round(median_f0, 2),
        "perFrame":  np.round(f0_arr, 2).tolist(),
        "nFft":      n_fft,
        "hopLength": hop_length,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(message)s")
    parser = argparse.ArgumentParser(description="Per-frame F0 contour estimator")
    parser.add_argument("--input",         required=True,  help="Input WAV (float32, 44.1 kHz)")
    parser.add_argument("--output",        required=True,  help="Output JSON path")
    parser.add_argument("--vad-mask-json", default=None,   help="VAD frame list JSON")
    parser.add_argument("--n-fft",         type=int, default=2048)
    parser.add_argument("--hop-length",    type=int, default=512)
    args = parser.parse_args(argv)

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

    return {
        'median': result['median'],
        'frames': len(result['perFrame']),
    }


def run(argv):
    """Entry point used by the persistent worker (_worker.py)."""
    return main(argv)


if __name__ == "__main__":
    main()
