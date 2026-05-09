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
    peak_lag = lag_min + int(np.argmax(corr[lag_min:lag_max]))
    if corr[peak_lag] > MIN_CORR_RATIO * corr[0] and peak_lag > 0:
        return float(sample_rate / peak_lag)
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
    F0 is estimated on every 3rd frame (matching the de-esser's subsampling
    cadence) and forward-filled across skipped/unvoiced gaps.

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
    pad            = n_fft // 2
    padded         = np.pad(audio.astype(np.float32), pad, mode="reflect")
    n_samples      = len(audio)
    n_frames       = max(0, (len(padded) - n_fft) // hop_length + 1)
    f0_arr         = np.full(n_frames, np.nan, dtype=np.float64)

    for k in range(n_frames):
        start = k * hop_length
        end   = start + n_fft
        if end > len(padded):
            break

        # Skip silence frames — their slots are forward-filled below.
        if vad_voiced_mask is not None:
            mid = k * hop_length          # centre in original-audio coordinates
            if 0 <= mid < n_samples and not vad_voiced_mask[mid]:
                continue

        # Subsample: estimate every 3rd frame; forward-fill the rest.
        # Matches the de-esser's cadence; keeps cost O(n/3).
        if k % 3 != 0:
            continue

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
