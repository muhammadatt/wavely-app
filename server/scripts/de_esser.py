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
from numba import njit
from numpy.lib.stride_tricks import sliding_window_view
from scipy.io import wavfile
from scipy.signal import iirfilter, lfilter, sosfilt

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
    """Causal rolling median (looks at last `window` values incl. self).

    Vectorised via sliding_window_view + np.median(axis=1). Pads the head with
    values[0] so windows[0] = [v[0]]*window, matching the original loop's
    shrinking-window behaviour at index 0. Indices < window-1 differ slightly
    from the original (the original used a strictly shorter window there), but
    F0 is typically stable across the first ~10 frames so the practical effect
    is negligible.
    """
    n = len(values)
    if n == 0:
        return values.astype(np.float64, copy=True)
    half = max(1, window)
    pad     = np.full(half - 1, values[0], dtype=values.dtype)
    padded  = np.concatenate([pad, values])
    windows = sliding_window_view(padded, half)
    return np.median(windows, axis=1)


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
    frames *= window             # in-place windowing avoids a (n_frames, n_fft) temporary
    spec   = np.fft.rfft(frames, axis=1)
    del frames                   # release (n_frames, n_fft) float64 -- no longer needed
    power  = (spec.real ** 2 + spec.imag ** 2)
    del spec                     # release complex (n_frames, n_bins) -- no longer needed

    bin_freq = sample_rate / n_fft
    n_bins   = power.shape[1]
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

    # Per-frame sibilant band edges (vectorised). NaN F0 -> UNCERTAIN_BAND.
    f0_valid = np.isfinite(f0_smooth)
    band_lo  = np.where(
        f0_valid,
        np.clip(SIBILANT_LOW_MIN_HZ + (np.where(f0_valid, f0_smooth, 0.0) - 60.0) * 20.0,
                SIBILANT_LOW_MIN_HZ, SIBILANT_LOW_MAX_HZ),
        UNCERTAIN_BAND[0],
    )
    band_hi = np.where(f0_valid, band_lo + SIBILANT_BAND_WIDTH_HZ, UNCERTAIN_BAND[1])

    sib_lo = np.clip((band_lo / bin_freq).astype(np.int64), 0, n_bins - 1)
    sib_hi = np.clip(np.ceil(band_hi / bin_freq).astype(np.int64), 0, n_bins - 1)
    band_ok    = sib_hi >= sib_lo
    band_count = np.maximum(sib_hi - sib_lo + 1, 1).astype(np.float64)

    # Cumsum-based variable-width band aggregates. A single prefix-sum buffer
    # is allocated once and reused for all three passes (sibilant power,
    # log-power for flatness, weighted power for centroid). The log and
    # weighted passes additionally restrict to the small subset of frames that
    # need them, so their slices of prefix_buf are far smaller in practice:
    #   - presibilant candidates (flatness pass): typically 5-15% of frames
    #   - fricative frames       (centroid pass):  typically 2-8% of frames
    # Peak memory drops from 3 × (n_frames, n_bins+1) to 1 × that shape.
    frame_idx  = np.arange(n_frames)
    prefix_buf = np.empty((n_frames, n_bins + 1), dtype=np.float64)
    prefix_buf[:, 0] = 0.0
    np.cumsum(power, axis=1, out=prefix_buf[:, 1:])
    band_sum = prefix_buf[frame_idx, sib_hi + 1] - prefix_buf[frame_idx, sib_lo]
    avg_sib  = band_sum / band_count
    sibilant_db = np.where(band_ok & (avg_sib > 0),
                           10.0 * np.log10(np.maximum(avg_sib, 1e-30)),
                           -120.0)

    # Mid-band reference (1-3 kHz, fixed across frames).
    if mid_hi < n_bins and mid_hi >= mid_lo:
        avg_mid = power[:, mid_lo:mid_hi + 1].mean(axis=1)
        mid_db  = np.where(avg_mid > 0,
                           10.0 * np.log10(np.maximum(avg_mid, 1e-30)),
                           -120.0)
    else:
        mid_db = np.full(n_frames, -120.0, dtype=np.float64)

    # Flatness (geometric/arithmetic mean ratio) is only needed for frames
    # that pass the sibilant-vs-mid 8 dB gate (presib_mask). These are the
    # only candidates that can become fricatives, so we compute log_power only
    # for that subset and reuse the head rows of prefix_buf for the cumsum.
    presib_mask = (sibilant_db - mid_db > 8.0) & band_ok
    flatness    = np.zeros(n_frames, dtype=np.float64)
    if presib_mask.any():
        cand_idx       = np.where(presib_mask)[0]
        n_cand         = cand_idx.size
        log_power_cand = np.log(np.maximum(power[cand_idx], 1e-30))
        prefix_buf[:n_cand, 0] = 0.0
        np.cumsum(log_power_cand, axis=1, out=prefix_buf[:n_cand, 1:])
        del log_power_cand
        cand_arange = np.arange(n_cand)
        log_sum = (prefix_buf[cand_arange, sib_hi[cand_idx] + 1]
                   - prefix_buf[cand_arange, sib_lo[cand_idx]])
        geo = np.exp(log_sum / band_count[cand_idx])
        flatness[cand_idx] = np.where(
            avg_sib[cand_idx] > 0, geo / np.maximum(avg_sib[cand_idx], 1e-30), 0.0
        )

    # Fricative gate: sibilant >> mid AND band broad/flat. Same thresholds as JS.
    fricative_mask = presib_mask & (flatness > 0.1)

    # Centroid is only needed for fricative frames; target_freq defaults to
    # band_center for all others. Reuse prefix_buf for the weighted cumsum on
    # the fricative-row subset. power[fric_idx] fancy-indexing always returns a
    # copy, so the in-place *= weighting below doesn't mutate power.
    bins_arr    = np.arange(n_bins, dtype=np.float64) * bin_freq
    band_center = (band_lo + band_hi) / 2.0
    target_freq = band_center.copy()
    if fricative_mask.any():
        fric_idx   = np.where(fricative_mask)[0]
        n_fric     = fric_idx.size
        power_fric = power[fric_idx]          # copy via fancy indexing
        power_fric *= bins_arr[None, :]       # in-place frequency-weighting
        prefix_buf[:n_fric, 0] = 0.0
        np.cumsum(power_fric, axis=1, out=prefix_buf[:n_fric, 1:])
        del power_fric
        fric_arange = np.arange(n_fric)
        w_sum = (prefix_buf[fric_arange, sib_hi[fric_idx] + 1]
                 - prefix_buf[fric_arange, sib_lo[fric_idx]])
        target_freq[fric_idx] = np.where(
            band_sum[fric_idx] > 0,
            w_sum / np.maximum(band_sum[fric_idx], 1e-30),
            band_center[fric_idx],
        )

    del prefix_buf  # release before returning

    fricative_centroids = target_freq[fricative_mask]
    fricative_energies  = sibilant_db[fricative_mask]

    # Aggregate stats
    mean_db = float(sibilant_db.mean()) if sibilant_db.size else -120.0
    p95_db  = float(np.percentile(sibilant_db, 95)) if sibilant_db.size else -120.0

    if fricative_centroids.size:
        order   = np.argsort(fricative_energies)[::-1]
        top_n   = max(1, int(np.ceil(order.size * 0.05)))
        target_freq_hz = float(fricative_centroids[order[:top_n]].mean())
    else:
        target_freq_hz = (UNCERTAIN_BAND[0] + UNCERTAIN_BAND[1]) / 2.0

    global_lo = float(band_lo.min()) if band_lo.size else UNCERTAIN_BAND[0]
    global_hi = float(band_hi.max()) if band_hi.size else UNCERTAIN_BAND[1]

    return {
        "frame_target_freq": target_freq,
        "sibilant_db":       sibilant_db,
        "p95_db":            round(p95_db, 2),
        "mean_db":           round(mean_db, 2),
        "target_freq_hz":    int(round(target_freq_hz)),
        "fricative_count":   int(fricative_mask.sum()),
        "global_band":       (global_lo, global_hi),
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
                           frame_target_freq: np.ndarray, hop: int,
                           bandwidth_hz: float) -> np.ndarray:
    """
    Run a piecewise-constant bandpass tracking the per-frame target frequency.
    The filter is recomputed only when the target shifts by more than 100 Hz
    from the current segment's reference; the output is stitched between
    segments without crossfading (transient artefact is negligible because
    (a) target shifts only happen at frame-grid boundaries already smoothed by
    the rolling median, and (b) this signal is used only for envelope
    detection, never directly summed back into the output).

    Operates at frame granularity -- this implementation scans
    `frame_target_freq` once per frame, with each frame covering `hop`
    samples (~13M iterations vs. ~25K for a 5-min file).
    """
    n = len(samples)
    out = np.zeros(n, dtype=np.float64)
    n_fr = len(frame_target_freq)
    if n == 0 or n_fr == 0:
        return out

    THRESH_HZ = 100.0

    # Identify segment boundaries at frame granularity. Same hysteresis logic
    # as before: a new segment starts when the current frame's target shifts
    # more than THRESH_HZ from the *segment's* reference (not the previous
    # frame), so slow drift within tolerance keeps a single segment.
    freqs    = np.asarray(frame_target_freq, dtype=np.float64)
    freqs_py = freqs.tolist()  # Python floats avoid numpy scalar overhead in the loop
    boundaries = [0]
    cur_ref    = freqs_py[0]
    for k in range(1, n_fr):
        v = freqs_py[k]
        if abs(v - cur_ref) > THRESH_HZ:
            boundaries.append(k)
            cur_ref = v
    boundaries.append(n_fr)

    # Apply a single bandpass per segment. SOS designs are cached per quantised
    # frequency: hysteresis-driven segment boundaries can produce hundreds of
    # segments per file, but the unique target frequencies cluster tightly
    # (band centers + a handful of fricative centroids). Quantising to 25 Hz
    # is well below the 100 Hz hysteresis tolerance.
    sos_cache = {}
    bw_min    = max(bandwidth_hz, 100.0)
    for j in range(len(boundaries) - 1):
        fk_start = boundaries[j]
        fk_end   = boundaries[j + 1]
        s_start  = fk_start * hop
        # The last segment extends to the end of the audio buffer (handles the
        # case where n > n_fr * hop, e.g. trailing samples beyond frame grid).
        s_end    = n if fk_end == n_fr else min(fk_end * hop, n)
        if s_end <= s_start:
            continue
        freq    = freqs_py[fk_start]
        freq_q  = round(freq / 25.0) * 25.0
        sos     = sos_cache.get(freq_q)
        if sos is None:
            q   = freq_q / bw_min
            sos = _design_bandpass_sos(freq_q, max(q, 0.5), sample_rate)
            sos_cache[freq_q] = sos
        out[s_start:s_end] = sosfilt(sos, samples[s_start:s_end])
    return out


@njit(cache=True)
def _envelope_follower_jit(rms_arr, attack_coeff, release_coeff):
    """
    Attack/release envelope follower compiled to native code via Numba.

    The conditional coefficient choice (attack when rising, release when
    falling) makes this a non-linear recurrence that can't be expressed as a
    linear IIR filter -- the loop is intrinsically sequential. @njit gives
    C-speed iteration; cache=True writes the compiled artifact to __pycache__
    so de_esser.py subprocesses skip recompilation after the first run.
    """
    n = len(rms_arr)
    out = np.empty(n, np.float64)
    one_minus_a = 1.0 - attack_coeff
    one_minus_r = 1.0 - release_coeff
    env = 0.0
    for i in range(n):
        r = rms_arr[i]
        if r > env:
            env = attack_coeff * env + one_minus_a * r
        else:
            env = release_coeff * env + one_minus_r * r
        out[i] = env
    return out


def build_gain_curve(detection: np.ndarray, sample_rate: int,
                     threshold_offset_db: float, max_reduction_db: float,
                     attack_ms: float, release_ms: float,
                     slope: float = 0.85):
    """
    Envelope follower + soft-knee gain reduction on the detection signal.
    Returns (gain_curve, max_reduction_observed_db, treated_events).

    Three steps -- the first and third are fully vectorised; only the second
    is intrinsically sequential because the attack/release coefficient choice
    depends on the previous envelope value.

      1. Detection power -> 2 ms RMS smoothing via scipy.signal.lfilter
         (vectorised one-pole IIR).
      2. Attack/release envelope follower -- sequential loop executed by
         the Numba-compiled _envelope_follower_jit; cache=True stores the
         compiled artifact in __pycache__ so later subprocesses can skip
         recompilation after the first run.
      3. Threshold compare, soft-knee gain curve, treated-event extraction --
         all vectorised numpy ops on the resulting envelope array.
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
    threshold_lin     = rms_lin * (10.0 ** (threshold_offset_db / 20.0))
    max_reduction_lin = 10.0 ** (-max_reduction_db / 20.0)

    # Step 1: vectorised RMS smoothing (one-pole IIR on detection^2).
    #   y[n] = env_coeff * y[n-1] + (1 - env_coeff) * x[n]
    # As scipy lfilter coefficients: b = [1 - env_coeff], a = [1, -env_coeff].
    power_env = lfilter([1.0 - env_coeff], [1.0, -env_coeff],
                        detection.astype(np.float64) ** 2)
    rms_arr   = np.sqrt(np.maximum(power_env, 0.0))

    # Step 2: attack/release envelope follower -- JIT-compiled (see above).
    envelope_arr = _envelope_follower_jit(rms_arr, attack_coeff, release_coeff)

    # Step 3: vectorised soft-knee gain reduction.
    if threshold_lin > 0.0:
        above   = envelope_arr > threshold_lin
        ratio   = np.where(above, envelope_arr / threshold_lin, 1.0)
        over_db = 20.0 * np.log10(np.maximum(ratio, 1.0))
        red_db  = np.minimum(over_db * slope, max_reduction_db)
        red_db  = np.where(above, red_db, 0.0)
    else:
        above  = np.zeros(n, dtype=bool)
        red_db = np.zeros(n, dtype=np.float64)

    gain = np.where(above,
                    np.maximum(10.0 ** (-red_db / 20.0), max_reduction_lin),
                    1.0).astype(np.float32)
    max_red_observed = float(red_db.max()) if n > 0 else 0.0

    # Treated events: contiguous runs of red_db > 0. Run-length extraction via
    # np.diff on a False-padded boolean (one numpy pass).
    active = red_db > 0.0
    if not active.any():
        return gain, max_red_observed, []
    edges  = np.diff(np.concatenate([[False], active, [False]]).astype(np.int8))
    starts = np.nonzero(edges == 1)[0]
    ends   = np.nonzero(edges == -1)[0]
    inv_sr = 1.0 / sample_rate
    treated = []
    for s, e in zip(starts.tolist(), ends.tolist()):
        avg_red = float(red_db[s:e].mean())
        treated.append({
            "startSec":       round(s * inv_sr, 2),
            "endSec":         round(e * inv_sr, 2),
            "durationMs":     int(round((e - s) * inv_sr * 1000.0)),
            "avgReductionDb": round(avg_red, 2),
        })

    return gain, max_red_observed, treated


# ---------------------------------------------------------------------------
# Split-band processing (the actual fix for the loudness-loss problem)
# ---------------------------------------------------------------------------

def apply_split_band(channels: np.ndarray, sample_rate: int,
                     fc_low_hz: float, fc_high_hz: float,
                     gain_curve: np.ndarray) -> np.ndarray:
    """
    Apply true 3-band split-band gain reduction to a (n_channels, n_samples) array.

      high1  = HPF(input, fc_low)              # everything above fc_low
      low    = input - high1                   # vocal body — untouched
      air    = HPF(input, fc_high)             # air strip above fc_high — untouched
      mid    = high1 - air                     # sibilant band [fc_low, fc_high]
      out    = low + gain_curve * mid + air

    At idle (gain_curve == 1), out == input exactly (perfect reconstruction by
    complementary subtraction). Only the sibilant mid band is attenuated when
    the gain curve dips below 1, leaving both the vocal body and the air strip
    above fc_high untouched.
    """
    sos_low  = iirfilter(2, fc_low_hz,  btype="highpass", ftype="butter",
                         fs=sample_rate, output="sos")
    sos_high = iirfilter(2, fc_high_hz, btype="highpass", ftype="butter",
                         fs=sample_rate, output="sos")
    out = np.empty_like(channels, dtype=np.float32)
    for ci in range(channels.shape[0]):
        x     = channels[ci].astype(np.float64)
        high1 = sosfilt(sos_low, x)            # everything above fc_low
        low   = x - high1                      # vocal body
        air   = sosfilt(sos_high, x)           # air strip above fc_high
        mid   = high1 - air                    # sibilant band
        out[ci] = (low + gain_curve.astype(np.float64) * mid + air).astype(np.float32)
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
                       ratio: float = 6.7) -> dict:
    """
    Run the full de-esser on a (n_channels, n_samples) float32 array and
    return both the processed audio and the JS-compatible result dict.

    ratio controls how steeply gain reduction grows once an event exceeds the
    threshold. Expressed as a compressor-style ratio (e.g. 4 = 4:1). Converted
    internally to a slope via slope = 1 - 1/ratio. The default of 6.7 matches
    the previous hardcoded slope of 0.85 (1 - 1/6.7 ≈ 0.851).
    """
    samples = channels[0]

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

    # Detection bandpass (dynamic) + envelope follower / gain curve. The
    # detection signal generator works at frame granularity directly -- no need
    # to expand frame_target_freq to a per-sample array.
    global_band = metrics["global_band"]
    bandwidth   = global_band[1] - global_band[0]
    detection   = build_detection_signal(samples, sample_rate,
                                         metrics["frame_target_freq"], hop, bandwidth)

    threshold_offset_db = 3.0 if sensitivity == "high" else 4.0
    slope = 1.0 - 1.0 / max(ratio, 1.01)  # clamp ratio > 1 to keep slope in (0, 1)
    gain_curve, max_red_observed, treated = build_gain_curve(
        detection, sample_rate, threshold_offset_db, max_reduction_db,
        attack_ms=2.0, release_ms=50.0, slope=slope,
    )

    # Split-band crossover: derived from this file's sibilant frequency
    # distribution. The center is the median of frame_target_freq (the
    # per-frame detection centroid), giving a file-specific band anchored to
    # the actual voice rather than a preset constant. fc_low and fc_high are
    # offset by half the sibilant band width from that center, clamped to
    # keep the band within a sensible range (3 kHz floor, 12 kHz ceiling).
    center  = float(np.median(metrics["frame_target_freq"]))
    half    = SIBILANT_BAND_WIDTH_HZ / 2.0
    fc_low  = max(3000.0, center - half)
    fc_high = min(12000.0, center + half)

    out_channels = apply_split_band(channels, sample_rate, fc_low, fc_high, gain_curve)

    return {
        "audio":            out_channels,
        "applied":          True,
        "f0Hz":             f0_median,
        "targetFreqHz":     metrics["target_freq_hz"],
        "maxReductionDb":   round(max_red_observed, 2),
        "p95EnergyDb":      metrics["p95_db"],
        "meanEnergyDb":     metrics["mean_db"],
        "triggerReason":    f"P95-mean delta {round(delta, 2)} dB > trigger {trigger_db} dB",
        "treatedEvents":    treated,
        "crossoverLowHz":   int(round(fc_low)),
        "crossoverHighHz":  int(round(fc_high)),
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
    parser.add_argument("--ratio",           type=float, default=6.7,
                        help="Compressor-style ratio controlling how steeply gain "
                             "reduction grows above the threshold (e.g. 4 = 4:1). "
                             "Converted to slope via slope = 1 - 1/ratio. "
                             "Default 6.7 preserves the previous hardcoded slope of 0.85.")
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
        ratio=args.ratio,
    )

    out_audio = result.pop("audio")
    _write_wav_float32(args.output, sr, out_audio)

    print("JSON_RESULT:" + json.dumps(result), flush=True)


if __name__ == "__main__":
    main()

