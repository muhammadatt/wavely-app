"""
de_esser.py
Stage 4 -- De-esser (split-band dynamic EQ).

Replaces the JS implementation at server/pipeline/deEsser.js. Targets two
problems with the prior broadband-attenuation design:

  1. Loudness loss. The JS de-esser detected sibilant energy with a bandpass
     sidechain but applied the resulting gain curve to the full broadband
     signal. Sibilant-adjacent energy is near-continuous in narration, so the
     compressor triggered constantly and dragged the entire spectrum down.
  2. Runtime. The JS pass measured at ~1x realtime on a 9 s file. F0
     autocorrelation and per-frame Meyda FFTs dominated. Both vectorise
     trivially in numpy/scipy.

Architecture (true split-band, complementary-subtraction):

  high(t) = HPF(input(t), fc)              # Butterworth biquad
  low(t)  = input(t) - high(t)             # perfect reconstruction at unity
  output(t) = low(t) + g(t) * high(t)      # attenuate only the high band

The detection sidechain is a *dynamic* bandpass tracking per-frame F0 (rolling
median); the *processing* crossover fc is static per file, derived from the
lowest sibilant-band edge across the file. Detection moves with the voice;
processing crossover does not -- this avoids dynamic-filter crossfade
artefacts and matches how professional dynamic de-essers (Pro-DS et al.)
handle the same problem.

F0 source priority:
  1. f0.perFrame from --events-json (canonical sibilance event map written by
     sibilance_suppressor.py / analyze_sibilance_events.py). Free reuse, and
     keeps the deEss + sibilanceSuppressor stages locked to the same F0
     trajectory so they map to the same sibilant band per frame.
  2. --f0 scalar (file-level median) -- expanded to a constant per-frame array.
  3. Internal estimation (FFT-based autocorrelation per frame) when neither
     of the above is present.

Note on staleness: the events map's sibilantFrameIndices and energy values
are NOT reused. They become stale after upstream stages (compression, air
boost) mutate the spectrum. The de-esser detects fricative events on the
*current* audio. Only F0 is reused -- voice pitch is invariant under EQ.

Dependencies: numpy, scipy
"""

import argparse
import json
import logging
import sys
from typing import Optional

import numpy as np
from scipy.io import wavfile
from scipy.signal import iirfilter, sosfilt

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Sibilant band as a continuous function of F0
# ---------------------------------------------------------------------------
#
# The de-esser's job, distinct from the upstream broadband sibilance
# suppressor, is to catch the *peaked, voice-specific* portion of fricative
# energy. Empirically this sits in a ~3 kHz-wide window whose lower edge
# tracks linearly with F0 (low ~= 3500 + (F0 - 60) * 20 Hz). Earlier revisions
# bucketed F0 into five discrete archetypes; this produced 1 kHz center jumps
# at bucket boundaries when F0 estimates jittered. The continuous form gives
# identical band edges at the prior bucket centers (60/110/160/210/260/310 Hz)
# and smooth interpolation between them.

UNCERTAIN_BAND = (5000.0, 8000.0)
SIBILANT_BAND_WIDTH_HZ = 3000.0
SIBILANT_LOW_MIN_HZ    = 3500.0
SIBILANT_LOW_MAX_HZ    = 7500.0


def sibilant_band_for_f0(f0: Optional[float]) -> tuple:
    if f0 is None or not np.isfinite(f0):
        return UNCERTAIN_BAND
    low  = SIBILANT_LOW_MIN_HZ + (float(f0) - 60.0) * 20.0
    low  = max(SIBILANT_LOW_MIN_HZ, min(low, SIBILANT_LOW_MAX_HZ))
    high = low + SIBILANT_BAND_WIDTH_HZ
    return (low, high)


# ---------------------------------------------------------------------------
# STFT and F0 conventions (aligned with sibilance_suppressor.py)
# ---------------------------------------------------------------------------

DEFAULT_N_FFT     = 2048
DEFAULT_HOP       = 512
F0_ROLLING_WINDOW = 10  # ~1 sec at hop=512, sr=44100 (matches JS recentF0s)


def _autocorr_f0(frame: np.ndarray, sample_rate: int,
                 f0_min_hz: float = 70.0, f0_max_hz: float = 400.0,
                 min_corr_ratio: float = 0.1) -> Optional[float]:
    """FFT-based autocorrelation F0 for a single frame. None on failure."""
    n = len(frame)
    if n < 64:
        return None
    f = frame.astype(np.float64) - frame.mean()
    n_fft = 2 * n
    corr  = np.fft.irfft(np.abs(np.fft.rfft(f, n=n_fft)) ** 2)[:n]
    lag_min = int(sample_rate / f0_max_hz)
    lag_max = int(sample_rate / f0_min_hz)
    if lag_max >= len(corr) or lag_min >= lag_max:
        return None
    peak_lag = lag_min + int(np.argmax(corr[lag_min:lag_max]))
    if corr[peak_lag] > min_corr_ratio * corr[0] and peak_lag > 0:
        return float(sample_rate / peak_lag)
    return None



def _f0_per_frame_internal(samples: np.ndarray, sample_rate: int,
                           voiced_mask_per_sample: Optional[np.ndarray],
                           n_fft: int, hop: int) -> np.ndarray:
    """
    Per-STFT-frame F0 estimation. Returns array of length n_frames with NaN
    for frames classified as silence or where autocorrelation rejected.

    Uses center-padded framing (librosa center=True convention) so frame k
    is centered on original-audio sample k*hop -- matches sibilance_suppressor.
    """
    pad           = n_fft // 2
    samples_padded = np.pad(samples, pad, mode="reflect")
    n              = len(samples)
    n_frames       = 1 + max(0, (len(samples_padded) - n_fft) // hop)
    f0 = np.full(n_frames, np.nan, dtype=np.float64)
    for k in range(n_frames):
        start = k * hop
        end   = start + n_fft
        if end > len(samples_padded):
            break
        if voiced_mask_per_sample is not None:
            # Frame center in original-audio coordinates.
            mid = k * hop
            if 0 <= mid < n and not voiced_mask_per_sample[mid]:
                continue
        # Subsample F0 estimation: every 3rd frame, forward-fill (matches the
        # JS rolling-F0 cadence and keeps cost bounded on long files).
        if k % 3 != 0:
            continue
        est = _autocorr_f0(samples_padded[start:end], sample_rate)
        if est is not None:
            f0[k] = est
    # Forward-fill NaN gaps so every frame has a value (median fallback for
    # leading NaNs).
    if np.all(np.isnan(f0)):
        return f0
    last = float(np.nanmedian(f0))
    for k in range(n_frames):
        if np.isnan(f0[k]):
            f0[k] = last
        else:
            last = f0[k]
    return f0


def _rolling_median(values: np.ndarray, window: int) -> np.ndarray:
    """Causal rolling median (looks at last `window` values incl. self)."""
    n = len(values)
    out = np.empty(n, dtype=np.float64)
    half = max(1, window)
    for i in range(n):
        lo = max(0, i - half + 1)
        out[i] = float(np.median(values[lo:i + 1]))
    return out


def _voiced_mask_from_frames(frames: list, total_samples: int) -> np.ndarray:
    """Convert pipeline frame metadata to a per-sample bool mask."""
    mask = np.zeros(total_samples, dtype=bool)
    for fr in frames:
        if fr.get("isSilence"):
            continue
        s = int(fr["offsetSamples"])
        e = min(s + int(fr["lengthSamples"]), total_samples)
        if e > s:
            mask[s:e] = True
    return mask


# ---------------------------------------------------------------------------
# Sibilance analysis (per-frame fricative event detection on current audio)
# ---------------------------------------------------------------------------

def analyze_sibilance(samples: np.ndarray, sample_rate: int,
                      f0_per_frame: np.ndarray, n_fft: int, hop: int):
    """
    Per-STFT-frame sibilant energy and fricative event detection.

    Returns:
        dict with:
          - frame_target_freq  (n_frames,) float -- detection bandpass center per frame
          - sibilant_db        (n_frames,) float -- sibilant-band energy in dB
          - p95_db             scalar
          - mean_db            scalar
          - target_freq_hz     scalar -- centroid of top 5% loudest fricatives
          - fricative_count    scalar
          - global_band        (lo, hi) tuple -- min/max sibilant band edges seen
    """
    n = len(samples)
    pad            = n_fft // 2
    samples_padded = np.pad(samples, pad, mode="reflect")
    n_frames       = 1 + max(0, (len(samples_padded) - n_fft) // hop)
    if n_frames <= 0:
        return {
            "frame_target_freq": np.array([], dtype=np.float64),
            "sibilant_db":       np.array([], dtype=np.float64),
            "p95_db":            -120.0,
            "mean_db":           -120.0,
            "target_freq_hz":    None,
            "fricative_count":   0,
            "global_band":       UNCERTAIN_BAND,
        }

    # Stack frames and compute one batched STFT (vectorised power spectrum).
    # Center-padded framing matches sibilance_suppressor: frame k is centered
    # on original-audio sample k*hop, so f0_per_frame[k] from the upstream
    # events map indexes the same audio window with no offset.
    idx0   = np.arange(n_fft)[None, :]
    starts = (np.arange(n_frames) * hop)[:, None]
    frames = samples_padded[starts + idx0].astype(np.float64)
    window = np.hanning(n_fft)
    spec   = np.fft.rfft(frames * window, axis=1)
    power  = (spec.real ** 2 + spec.imag ** 2)

    bin_freq = sample_rate / n_fft
    mid_lo   = int(np.ceil(1000.0 / bin_freq))
    mid_hi   = int(np.ceil(3000.0 / bin_freq))

    # Defensive resize: with the centered convention plus the events-json
    # geometry check (nFft/hopLength) at CLI level, lengths should match by
    # construction. Resize only as a safety net for version drift.
    if len(f0_per_frame) != n_frames:
        f0_aligned = np.full(n_frames, np.nan, dtype=np.float64)
        common = min(len(f0_per_frame), n_frames)
        f0_aligned[:common] = f0_per_frame[:common]
        if len(f0_per_frame) < n_frames:
            valid = f0_per_frame[~np.isnan(f0_per_frame)]
            if valid.size:
                f0_aligned[common:] = float(np.median(valid))
        f0_per_frame = f0_aligned

    # Smooth F0 with a rolling median to suppress single-frame estimator noise
    f0_smooth = _rolling_median(f0_per_frame, F0_ROLLING_WINDOW)

    sibilant_db   = np.full(n_frames, -120.0, dtype=np.float64)
    target_freq   = np.empty(n_frames, dtype=np.float64)
    fricative_centroids = []
    fricative_energies  = []
    global_lo = float("inf")
    global_hi = float("-inf")

    for k in range(n_frames):
        f0_k = f0_smooth[k]
        band = sibilant_band_for_f0(None if np.isnan(f0_k) else float(f0_k))
        global_lo = min(global_lo, band[0])
        global_hi = max(global_hi, band[1])

        sib_lo = int(band[0] / bin_freq)
        sib_hi = int(np.ceil(band[1] / bin_freq))
        sib_hi = min(sib_hi, power.shape[1] - 1)

        ps = power[k]

        # Sibilant-band average power (dB)
        if sib_hi >= sib_lo:
            avg_sib = float(ps[sib_lo:sib_hi + 1].mean())
            sib_db  = 10.0 * np.log10(avg_sib) if avg_sib > 0 else -120.0
        else:
            sib_db = -120.0
        sibilant_db[k] = sib_db

        # Mid-band reference (1-3 kHz)
        if mid_hi < ps.shape[0] and mid_hi >= mid_lo:
            avg_mid = float(ps[mid_lo:mid_hi + 1].mean())
            mid_db  = 10.0 * np.log10(avg_mid) if avg_mid > 0 else -120.0
        else:
            mid_db = -120.0

        # Within-band spectral flatness (Wiener entropy)
        if sib_hi >= sib_lo:
            band_ps = ps[sib_lo:sib_hi + 1]
            valid   = band_ps[band_ps > 0]
            if valid.size > 0:
                geo  = np.exp(np.mean(np.log(valid)))
                arith = float(band_ps.mean())
                flatness = float(geo / arith) if arith > 0 else 0.0
            else:
                flatness = 0.0
        else:
            flatness = 0.0

        # Fricative gate: sibilant >> mid AND band is broad/flat (vowel formants
        # are tonal, fricatives are noise-like). Same thresholds as JS.
        if (sib_db - mid_db) > 8.0 and flatness > 0.1 and sib_hi >= sib_lo:
            band_ps = ps[sib_lo:sib_hi + 1]
            tot = float(band_ps.sum())
            if tot > 0:
                bins  = np.arange(sib_lo, sib_hi + 1) * bin_freq
                centroid = float((bins * band_ps).sum() / tot)
            else:
                centroid = (band[0] + band[1]) / 2.0
            target_freq[k] = centroid
            fricative_centroids.append(centroid)
            fricative_energies.append(sib_db)
        else:
            target_freq[k] = (band[0] + band[1]) / 2.0

    # Aggregate stats
    mean_db = float(sibilant_db.mean()) if sibilant_db.size else -120.0
    p95_db  = float(np.percentile(sibilant_db, 95)) if sibilant_db.size else -120.0

    if fricative_centroids:
        order = np.argsort(fricative_energies)[::-1]
        top_n = max(1, int(np.ceil(len(order) * 0.05)))
        top_idx = order[:top_n]
        target_freq_hz = float(np.mean([fricative_centroids[i] for i in top_idx]))
    else:
        target_freq_hz = (UNCERTAIN_BAND[0] + UNCERTAIN_BAND[1]) / 2.0

    if not np.isfinite(global_lo):
        global_lo, global_hi = UNCERTAIN_BAND

    return {
        "frame_target_freq": target_freq,
        "sibilant_db":       sibilant_db,
        "p95_db":            round(p95_db, 2),
        "mean_db":           round(mean_db, 2),
        "target_freq_hz":    int(round(target_freq_hz)),
        "fricative_count":   len(fricative_centroids),
        "global_band":       (float(global_lo), float(global_hi)),
    }


# ---------------------------------------------------------------------------
# Detection-bandpass envelope follower + gain curve
# ---------------------------------------------------------------------------

def _design_bandpass_sos(freq: float, q: float, sample_rate: int):
    """Design a 2nd-order constant-skirt-gain bandpass as scipy SOS."""
    # iirfilter with btype='bandpass' returns a 4th-order filter (one section
    # per (low, high) edge). For a single biquad we use butter(2, 'bandpass',
    # output='sos') which yields exactly one SOS section.
    bw = max(freq / max(q, 0.5), 50.0)
    lo = max(20.0, freq - bw / 2.0)
    hi = min(sample_rate / 2.0 - 1.0, freq + bw / 2.0)
    if hi <= lo:
        hi = min(sample_rate / 2.0 - 1.0, lo + 100.0)
    sos = iirfilter(2, [lo, hi], btype="bandpass", ftype="butter",
                    fs=sample_rate, output="sos")
    return sos


def build_detection_signal(samples: np.ndarray, sample_rate: int,
                           target_freq_per_sample: np.ndarray,
                           bandwidth_hz: float) -> np.ndarray:
    """
    Run a piecewise-constant bandpass tracking target_freq_per_sample. The
    filter is recomputed only when the target shifts by more than 100 Hz; the
    output is stitched between segments without crossfading (transient artefact
    is negligible because (a) we change at frame-grid boundaries already
    smoothed by the rolling median, and (b) this signal is used only for
    envelope detection, never directly summed back into the output).
    """
    n = len(samples)
    out = np.zeros(n, dtype=np.float64)
    if n == 0:
        return out

    seg_start = 0
    cur_freq  = float(target_freq_per_sample[0])
    THRESH_HZ = 100.0

    def flush(start: int, end: int, freq: float):
        if end <= start:
            return
        q = freq / max(bandwidth_hz, 100.0)
        sos = _design_bandpass_sos(freq, max(q, 0.5), sample_rate)
        out[start:end] = sosfilt(sos, samples[start:end])

    for i in range(1, n):
        if abs(target_freq_per_sample[i] - cur_freq) > THRESH_HZ:
            flush(seg_start, i, cur_freq)
            seg_start = i
            cur_freq  = float(target_freq_per_sample[i])
    flush(seg_start, n, cur_freq)
    return out


def build_gain_curve(detection: np.ndarray, sample_rate: int,
                     threshold_offset_db: float, max_reduction_db: float,
                     attack_ms: float, release_ms: float):
    """
    Envelope follower + soft-knee gain reduction on the detection signal.
    Returns (gain_curve, max_reduction_observed_db, treated_events).
    """
    n = len(detection)
    if n == 0:
        return np.ones(0, dtype=np.float32), 0.0, []

    # 2 ms RMS smoothing of the detection power (matches JS envCoeff)
    env_coeff     = float(np.exp(-1.0 / (sample_rate * 2.0 / 1000.0)))
    attack_coeff  = float(np.exp(-1.0 / (sample_rate * attack_ms  / 1000.0)))
    release_coeff = float(np.exp(-1.0 / (sample_rate * release_ms / 1000.0)))

    # Threshold derived from the detection signal's own RMS so it tracks the
    # current spectrum (matches JS thresholdLin = rmsLin * 10^(offset/20)).
    rms_lin = float(np.sqrt(np.mean(detection ** 2))) or 1e-10
    threshold_lin = rms_lin * (10.0 ** (threshold_offset_db / 20.0))
    max_reduction_lin = 10.0 ** (-max_reduction_db / 20.0)

    gain = np.ones(n, dtype=np.float32)
    power_env = 0.0
    envelope  = 0.0
    max_red_observed = 0.0

    treated = []
    ev_start = -1
    ev_accum_db = 0.0
    ev_count    = 0

    for i in range(n):
        s = detection[i]
        power_env = env_coeff * power_env + (1.0 - env_coeff) * (s * s)
        rms = power_env ** 0.5
        if rms > envelope:
            envelope = attack_coeff  * envelope + (1.0 - attack_coeff)  * rms
        else:
            envelope = release_coeff * envelope + (1.0 - release_coeff) * rms

        red_db = 0.0
        g = 1.0
        if envelope > threshold_lin > 0.0:
            over_db = 20.0 * np.log10(envelope / threshold_lin)
            red_db  = min(over_db * 0.85, max_reduction_db)
            g       = max(10.0 ** (-red_db / 20.0), max_reduction_lin)
            if red_db > max_red_observed:
                max_red_observed = red_db
        gain[i] = g

        if red_db > 0.0:
            if ev_start < 0:
                ev_start = i
            ev_accum_db += red_db
            ev_count    += 1
        elif ev_start >= 0:
            treated.append({
                "startSec":       round(ev_start / sample_rate, 2),
                "endSec":         round(i / sample_rate, 2),
                "durationMs":     int(round((i - ev_start) / sample_rate * 1000.0)),
                "avgReductionDb": round(ev_accum_db / max(1, ev_count), 2),
            })
            ev_start = -1
            ev_accum_db = 0.0
            ev_count    = 0

    if ev_start >= 0:
        treated.append({
            "startSec":       round(ev_start / sample_rate, 2),
            "endSec":         round(n / sample_rate, 2),
            "durationMs":     int(round((n - ev_start) / sample_rate * 1000.0)),
            "avgReductionDb": round(ev_accum_db / max(1, ev_count), 2),
        })

    return gain, float(max_red_observed), treated


# ---------------------------------------------------------------------------
# Split-band processing (the actual fix for the loudness-loss problem)
# ---------------------------------------------------------------------------

def apply_split_band(channels: np.ndarray, sample_rate: int,
                     fc_hz: float, gain_curve: np.ndarray) -> np.ndarray:
    """
    Apply true split-band gain reduction to a (n_channels, n_samples) array.

      high  = HPF(input, fc)               # Butterworth 2nd order
      low   = input - high                 # complementary by subtraction
      out   = low + gain_curve * high

    At idle (gain_curve == 1), out == input exactly. Only the high band is
    attenuated when the gain curve dips below 1.
    """
    sos = iirfilter(2, fc_hz, btype="highpass", ftype="butter",
                    fs=sample_rate, output="sos")
    out = np.empty_like(channels, dtype=np.float32)
    for ci in range(channels.shape[0]):
        x    = channels[ci].astype(np.float64)
        high = sosfilt(sos, x)
        low  = x - high
        out[ci] = (low + gain_curve.astype(np.float64) * high).astype(np.float32)
    return out


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def analyze_and_de_ess(channels: np.ndarray, sample_rate: int,
                       trigger_db: float, max_reduction_db: float,
                       sensitivity: str,
                       f0_per_frame: Optional[np.ndarray],
                       f0_median: Optional[float],
                       voiced_mask: Optional[np.ndarray],
                       n_fft: int, hop: int,
                       crossover_hz: float = 4000.0) -> dict:
    """
    Run the full de-esser on a (n_channels, n_samples) float32 array and
    return both the processed audio and the JS-compatible result dict.
    """
    samples = channels[0]
    n       = len(samples)

    # F0: prefer caller-supplied per-frame array; else estimate internally.
    if f0_per_frame is None or len(f0_per_frame) == 0:
        f0_per_frame = _f0_per_frame_internal(samples, sample_rate, voiced_mask, n_fft, hop)
        valid = f0_per_frame[~np.isnan(f0_per_frame)]
        f0_median = float(np.median(valid)) if valid.size else None
    else:
        # Caller-provided array may contain None/NaN (analyze_sibilance_events
        # writes None for unvoiced frames). Fill NaNs with the median so the
        # rolling-median classifier always has a value.
        arr = np.array([(np.nan if v is None else float(v)) for v in f0_per_frame], dtype=np.float64)
        valid = arr[~np.isnan(arr)]
        if valid.size:
            fill = float(np.median(valid))
            arr  = np.where(np.isnan(arr), fill, arr)
            if f0_median is None:
                f0_median = fill
        f0_per_frame = arr

    # Voiced-frame count gate (matches JS "Insufficient voiced frames")
    voiced_frames = int((~np.isnan(f0_per_frame)).sum()) if f0_per_frame.size else 0
    if voiced_frames < 5:
        return {
            "audio":          channels,
            "applied":        False,
            "f0Hz":           f0_median,
            "targetFreqHz":   None,
            "maxReductionDb": None,
            "p95EnergyDb":    None,
            "meanEnergyDb":   None,
            "triggerReason":  "Insufficient voiced frames for analysis",
            "treatedEvents":  [],
        }

    metrics = analyze_sibilance(samples, sample_rate, f0_per_frame, n_fft, hop)

    # Trigger gates: too few fricatives or insufficient P95-mean delta
    if metrics["fricative_count"] < 3:
        return {
            "audio":          channels,
            "applied":        False,
            "f0Hz":           f0_median,
            "targetFreqHz":   None,
            "maxReductionDb": None,
            "p95EnergyDb":    metrics["p95_db"],
            "meanEnergyDb":   metrics["mean_db"],
            "triggerReason":  "Too few fricative events detected",
            "treatedEvents":  [],
        }

    delta = metrics["p95_db"] - metrics["mean_db"]
    if delta <= trigger_db:
        return {
            "audio":          channels,
            "applied":        False,
            "f0Hz":           f0_median,
            "targetFreqHz":   metrics["target_freq_hz"],
            "maxReductionDb": None,
            "p95EnergyDb":    metrics["p95_db"],
            "meanEnergyDb":   metrics["mean_db"],
            "triggerReason":  f"P95-mean delta {round(delta, 2)} dB <= trigger {trigger_db} dB",
            "treatedEvents":  [],
        }

    # Expand per-frame target frequency to a per-sample piecewise-constant curve
    target_per_sample = np.empty(n, dtype=np.float64)
    n_frames = len(metrics["frame_target_freq"])
    for k in range(n_frames):
        s0 = k * hop
        s1 = min(s0 + hop, n)
        target_per_sample[s0:s1] = metrics["frame_target_freq"][k]
    if n_frames * hop < n and n_frames > 0:
        target_per_sample[n_frames * hop:] = metrics["frame_target_freq"][-1]

    # Detection bandpass (dynamic) + envelope follower / gain curve
    global_band = metrics["global_band"]
    bandwidth   = global_band[1] - global_band[0]
    detection   = build_detection_signal(samples, sample_rate, target_per_sample, bandwidth)

    threshold_offset_db = 3.0 if sensitivity == "high" else 4.0
    gain_curve, max_red_observed, treated = build_gain_curve(
        detection, sample_rate, threshold_offset_db, max_reduction_db,
        attack_ms=2.0, release_ms=50.0,
    )

    # Split-band processing crossover: preset-defined static frequency.
    # Detection moves with the voice (per-frame F0); the processing crossover
    # does not. Pinned per-file from the preset config (default 4000 Hz)
    # rather than derived from voice type -- avoids F0-misclassification
    # ricochets and matches industry de-esser convention.
    fc_hz = float(crossover_hz)

    out_channels = apply_split_band(channels, sample_rate, fc_hz, gain_curve)

    return {
        "audio":          out_channels,
        "applied":        True,
        "f0Hz":           f0_median,
        "targetFreqHz":   metrics["target_freq_hz"],
        "maxReductionDb": round(max_red_observed, 2),
        "p95EnergyDb":    metrics["p95_db"],
        "meanEnergyDb":   metrics["mean_db"],
        "triggerReason":  f"P95-mean delta {round(delta, 2)} dB > trigger {trigger_db} dB",
        "treatedEvents":  treated,
        "crossoverHz":    int(round(fc_hz)),
    }


# ---------------------------------------------------------------------------
# WAV I/O helpers
# ---------------------------------------------------------------------------

def _read_wav_float32(path: str):
    """Read a WAV file as (n_channels, n_samples) float32."""
    sr, data = wavfile.read(path)
    if data.dtype != np.float32:
        if np.issubdtype(data.dtype, np.integer):
            info = np.iinfo(data.dtype)
            data = data.astype(np.float32) / max(abs(info.min), info.max)
        else:
            data = data.astype(np.float32)
    if data.ndim == 1:
        data = data[None, :]
    else:
        data = data.T  # (n_samples, n_channels) -> (n_channels, n_samples)
    return sr, np.ascontiguousarray(data)


def _write_wav_float32(path: str, sample_rate: int, channels: np.ndarray):
    """Write (n_channels, n_samples) float32 to WAV."""
    if channels.shape[0] == 1:
        out = channels[0]
    else:
        out = channels.T  # (n_samples, n_channels)
    wavfile.write(path, sample_rate, out.astype(np.float32))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    parser = argparse.ArgumentParser(description="Stage 4 -- Split-band de-esser")
    parser.add_argument("--input",          required=True)
    parser.add_argument("--output",         required=True)
    parser.add_argument("--preset",         default="unknown",
                        help="Preset id, used only as a log label.")
    parser.add_argument("--trigger",        type=float, required=True,
                        help="P95-mean delta in dB above which the de-esser engages.")
    parser.add_argument("--max-reduction",  type=float, required=True,
                        help="Maximum gain reduction (dB) applied to the high band.")
    parser.add_argument("--sensitivity",    default="standard",
                        choices=["standard", "medium", "high", "none"],
                        help="'high' uses a tighter threshold offset (3 dB above mean RMS); "
                             "all others use 4 dB. 'none' should not invoke this script.")
    parser.add_argument("--f0",             type=float, default=None,
                        help="File-level median F0 (Hz). Used as the per-frame "
                             "F0 fallback when --events-json is absent.")
    parser.add_argument("--events-json",    default=None,
                        help="Sibilance event map JSON (canonical shape, see "
                             "sibilance_suppressor.build_events_map). When "
                             "present, f0.perFrame and f0.median are reused -- "
                             "the per-frame F0 trajectory drives dynamic "
                             "detection bandpass tracking.")
    parser.add_argument("--vad-mask-json",  default=None,
                        help="Pipeline frame metadata for voiced/silence "
                             "classification. Used by the internal F0 estimator "
                             "fallback only.")
    parser.add_argument("--crossover-hz",   type=float, default=4000.0,
                        help="Static split-band crossover frequency (Hz). "
                             "High band (above this) is attenuated by the gain "
                             "curve; low band passes through.")
    args = parser.parse_args()

    if args.sensitivity == "none" or args.max_reduction <= 0:
        # Pass-through; the JS wrapper should normally avoid spawning us in
        # this case but guard regardless.
        sr, channels = _read_wav_float32(args.input)
        _write_wav_float32(args.output, sr, channels)
        result = {
            "applied": False, "f0Hz": None,
            "targetFreqHz": None, "maxReductionDb": None,
            "p95EnergyDb": None, "meanEnergyDb": None,
            "triggerReason": "Sensitivity 'none' or maxReduction <= 0",
            "treatedEvents": [],
        }
        print("JSON_RESULT:" + json.dumps(result), flush=True)
        return

    sr, channels = _read_wav_float32(args.input)

    f0_per_frame = None
    f0_median    = args.f0
    if args.events_json:
        with open(args.events_json) as fh:
            events = json.load(fh)
        f0_block = events.get("f0", {}) or {}
        f0_per_frame = f0_block.get("perFrame")
        f0_median    = f0_block.get("median", f0_median)
        # Verify STFT grid alignment with the events map; if mismatched, fall
        # back to internal estimation rather than misalign frame indices.
        if events.get("nFft") != DEFAULT_N_FFT or events.get("hopLength") != DEFAULT_HOP:
            logger.info(
                f"[DeEsser] events-json STFT grid (nFft={events.get('nFft')}, "
                f"hop={events.get('hopLength')}) != local "
                f"({DEFAULT_N_FFT}, {DEFAULT_HOP}); ignoring f0.perFrame."
            )
            f0_per_frame = None

    voiced_mask = None
    if args.vad_mask_json:
        with open(args.vad_mask_json) as fh:
            frames = json.load(fh)
        voiced_mask = _voiced_mask_from_frames(frames, channels.shape[1])

    result = analyze_and_de_ess(
        channels, sr,
        trigger_db=args.trigger,
        max_reduction_db=args.max_reduction,
        sensitivity=args.sensitivity,
        f0_per_frame=f0_per_frame,
        f0_median=f0_median,
        voiced_mask=voiced_mask,
        n_fft=DEFAULT_N_FFT,
        hop=DEFAULT_HOP,
        crossover_hz=args.crossover_hz,
    )

    out_audio = result.pop("audio")
    _write_wav_float32(args.output, sr, out_audio)

    print("JSON_RESULT:" + json.dumps(result), flush=True)


if __name__ == "__main__":
    main()

