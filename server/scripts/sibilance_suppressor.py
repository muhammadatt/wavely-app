"""
instant_polish_sibilance_suppressor.py
Stage 4 -- Sibilance Suppressor

Combines the de-esser's F0-derived sibilant event detection with long-term
EMA-based spectral gain reduction. Replaces the separate de-esser stage.

Architecture:
  Detection (de-esser logic):
    F0 estimation -> sibilant band identification -> per-frame P95 energy
    threshold -> binary sibilant event flag. Knows precisely when a sibilant
    event starts and stops, and which frequency band to target.

  Reduction (PATH 2 logic from resonance suppressor):
    Maintains a per-bin EMA of non-sibilant voiced-frame power (long-term
    reference). On sibilant frames, computes per-bin gain reduction where
    the frame's spectrum exceeds the reference by more than `selectivity` dB.
    Applies reduction via STFT/ISTFT with attack/release smoothing.

  EMA gating:
    The long-term reference is updated only on frames classified as non-sibilant
    by the detection stage. Detection drives gating directly -- no secondary
    classifier needed, no circular dependency possible.

Calibration source: 17_airBoost.wav
  Voiced-sibilant contrast in sibilant band: +11.6 dB min, +20.2 dB mean.
  P95 trigger margins validated against de-esser spec thresholds.

Dependencies: numpy, scipy
"""

import time

import numpy as np
from scipy.signal import get_window
from scipy.ndimage import uniform_filter1d
from collections import deque


def build_events_map(
    sibilant_indices: list,
    f0_per_frame:     list,
    f0_median:        float,
    n_frames:         int,
    sample_rate:      int,
    n_fft:            int,
    hop_length:       int,
) -> dict:
    """
    Build the canonical sibilance event-map JSON payload.

    Shared by analyze_sibilance_events.py (detection-only pass) and the
    suppressor's --emit-events side output, so both producers emit byte-
    for-byte identical structures.

    Args:
        sibilant_indices: ascending list of STFT frame indices flagged sibilant.
        f0_per_frame:     per-frame F0 (Hz) used to derive the active sibilant
                          band -- piecewise-constant in the rolling-F0 model.
                          Length must equal n_frames.
        f0_median:        rolling-window median F0 (Hz) for the whole pass.
        n_frames:         total STFT frame count for the audio.
        sample_rate:      sample rate (Hz).
        n_fft:             STFT size.
        hop_length:        STFT hop.

    Returns:
        dict matching the shape consumed by `--events-json` and the
        airBoost sibilant-aware mask.
    """
    events = []
    if sibilant_indices:
        run_start = sibilant_indices[0]
        prev      = sibilant_indices[0]
        for fi in sibilant_indices[1:]:
            if fi == prev + 1:
                prev = fi
                continue
            events.append((run_start, prev))
            run_start = fi
            prev      = fi
        events.append((run_start, prev))

    frame_period_sec = hop_length / sample_rate
    event_objs = [
        {
            "startFrame": int(s),
            "endFrame":   int(e),
            "startSec":   round(s * frame_period_sec, 4),
            "endSec":     round((e + 1) * frame_period_sec, 4),
            "durationMs": round((e + 1 - s) * frame_period_sec * 1000.0, 1),
        }
        for s, e in events
    ]

    return {
        "sampleRate":           sample_rate,
        "nFft":                 n_fft,
        "hopLength":            hop_length,
        "frameCount":           int(n_frames),
        "f0": {
            "median":   round(f0_median, 1) if f0_median is not None else None,
            "perFrame": [round(v, 1) if v is not None else None for v in f0_per_frame],
        },
        "sibilantFrameIndices": [int(i) for i in sibilant_indices],
        "events":               event_objs,
    }
import logging

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Rolling F0 estimation parameters
# ---------------------------------------------------------------------------
# Re-estimate F0 every Nth voiced STFT frame, maintain a rolling window of the
# most recent estimates, and only recompute the sibilant band mask when the
# median shifts beyond a threshold. Calibrated for hop=512, sr=44100
# (~86 STFT frames/sec): every 8th voiced frame -> ~10 estimates/sec; window of
# 10 entries -> ~1 sec history; 20 Hz threshold avoids mask churn from estimator
# noise while still tracking real speaker changes.

F0_ESTIMATE_EVERY_N_VOICED_FRAMES = 8
F0_ROLLING_WINDOW_SIZE            = 10
F0_MASK_RESHIFT_THRESHOLD_HZ      = 20.0


# ---------------------------------------------------------------------------
# Default parameters
# ---------------------------------------------------------------------------
# Single source of truth for every tunable. Per-preset overrides live in
# src/audio/presets.js as sparse `sibilanceSuppressor` blocks and are passed
# in via --params-json. Anything not specified there inherits from this dict.

DEFAULT_PARAMS = {
    # --- Detection (de-esser logic) ---
    # F0-derived sibilant band: F0*8 (or 3 kHz, whichever is greater) to 12 kHz.
    # Condition 1 (P95 spike): sibilant event fires when P95 energy in the
    # sibilant band exceeds the band mean by p95_trigger_db AND in-band
    # spectral flatness >= min_flatness.
    # Condition 2 (broadband elevation): mean sibilant band energy exceeds
    # the long-term EMA reference mean by broadband_trigger_db.
    "p95_trigger_db":        6.0,
    "p95_threshold_db":      3.0,
    "min_flatness":          0.1,    # Wiener entropy gate. Higher = stricter.
    "broadband_trigger_db":  10.0,

    # --- Reduction (EMA reference) ---
    "depth":                 0.7,    # Global reduction scale (0.0-1.0).
    "selectivity":           5.0,    # Per-bin dB threshold above long-term reference 
    "attack_ms":             5.0,    # Fast onset -- sibilants are transient.
    "release_ms":            60.0,   # Slower release -- avoids post-sibilant bleed.
    "max_reduction_db":      9.0,    # Hard ceiling per bin.
    "ema_time_constant_ms":  300.0,  # Long-term reference time constant.
    "warmup_frames":         25,     # Voiced frames before reduction activates (~290 ms at hop=512, sr=44100).

    # --- Sharpness (attenuation curve shape) ---
    "sharpness":             0.3,    # 0.0 = wide gentle cuts, 1.0 = narrow deep notches.
    "mode":                  "soft", # "soft" = gradual knee; "hard" = linear above threshold.
}


def resolve_params(overrides: dict = None) -> dict:
    """Merge sparse overrides over DEFAULT_PARAMS. None or empty -> defaults."""
    params = DEFAULT_PARAMS.copy()
    if overrides:
        params.update(overrides)
    return params


# ---------------------------------------------------------------------------
# F0 estimation
# ---------------------------------------------------------------------------

def estimate_f0(audio: np.ndarray, sample_rate: int) -> float:
    """
    Estimate the fundamental frequency of the voice using autocorrelation.

    Operates on the first 2 seconds of voiced audio (above -40 dBFS RMS).
    Falls back to 120 Hz (typical mid-range narrator) if estimation fails.

    Args:
        audio:       Mono float32 audio.
        sample_rate: Sample rate in Hz.

    Returns:
        Estimated F0 in Hz.
    """
    FALLBACK_F0  = 120.0
    F0_MIN_HZ    = 70.0
    F0_MAX_HZ    = 400.0
    ANALYSIS_SEC = 2.0
    FRAME_LEN    = 2048
    HOP          = 512

    analysis_samples = int(ANALYSIS_SEC * sample_rate)
    audio_segment    = audio[:analysis_samples]

    f0_estimates = []
    for start in range(0, len(audio_segment) - FRAME_LEN, HOP):
        frame = audio_segment[start : start + FRAME_LEN].astype(np.float64)
        rms   = np.sqrt(np.mean(frame ** 2))
        if 20 * np.log10(rms + 1e-10) < -40:
            continue

        # Autocorrelation via FFT
        frame  -= frame.mean()
        n_fft   = 2 * FRAME_LEN
        corr    = np.fft.irfft(np.abs(np.fft.rfft(frame, n=n_fft)) ** 2)
        corr    = corr[:FRAME_LEN]

        lag_min = int(sample_rate / F0_MAX_HZ)
        lag_max = int(sample_rate / F0_MIN_HZ)
        if lag_max >= len(corr):
            continue

        peak_lag = lag_min + np.argmax(corr[lag_min:lag_max])
        if corr[peak_lag] > 0.1 * corr[0] and peak_lag > 0:
            f0_estimates.append(sample_rate / peak_lag)

    if not f0_estimates:
        logger.warning(f"F0 estimation failed, using fallback {FALLBACK_F0} Hz")
        return FALLBACK_F0

    # Use median to reject outliers
    f0 = float(np.median(f0_estimates))
    logger.info(f"F0 estimate: {f0:.1f} Hz ({len(f0_estimates)} frames)")
    return f0


def _autocorrelate_f0_frame(
    frame: np.ndarray,
    sample_rate: int,
    f0_min_hz: float = 70.0,
    f0_max_hz: float = 400.0,
    min_corr_ratio: float = 0.1,
) -> float:
    """
    Single-frame autocorrelation F0 estimate.

    Reuses the same FFT-based autocorrelation math as estimate_f0() but
    operates on a pre-extracted time-domain frame. Returns None when the
    autocorrelation peak fails the correlation strength gate. Caller is
    responsible for restricting input to voiced frames (no internal RMS gate).

    Args:
        frame:          1D float array — time-domain audio (unwindowed preferred).
        sample_rate:    Sample rate in Hz.
        f0_min_hz:      Lower F0 search bound.
        f0_max_hz:      Upper F0 search bound.
        min_corr_ratio: Required peak correlation as fraction of zero-lag value.

    Returns:
        F0 in Hz, or None on failure.
    """
    n = len(frame)
    if n < 64:
        return None

    f     = frame.astype(np.float64) - frame.mean()
    n_fft = 2 * n
    corr  = np.fft.irfft(np.abs(np.fft.rfft(f, n=n_fft)) ** 2)
    corr  = corr[:n]

    lag_min = int(sample_rate / f0_max_hz)
    lag_max = int(sample_rate / f0_min_hz)
    if lag_max >= len(corr) or lag_min >= lag_max:
        return None

    peak_lag = lag_min + int(np.argmax(corr[lag_min:lag_max]))
    if corr[peak_lag] > min_corr_ratio * corr[0] and peak_lag > 0:
        return float(sample_rate / peak_lag)
    return None


# ---------------------------------------------------------------------------
# Sibilant band identification
# ---------------------------------------------------------------------------

def get_sibilant_band(f0: float, sample_rate: int) -> tuple:
    """
    Derive the sibilant band from F0.

    The lower bound is F0-derived: fricative energy begins around the 8th
    harmonic, but never below 3 kHz (avoids voice body for high-F0 voices).
    The upper bound is fixed at 12 kHz -- fricative turbulence is broadband
    noise whose extent is determined by vocal tract acoustics, not F0. Using
    F0 * 32 as the upper limit was wrong: for a 157 Hz voice it caps at 5 kHz,
    missing the bulk of sibilant energy which extends to 8-10 kHz.

    Args:
        f0:          Fundamental frequency in Hz.
        sample_rate: Sample rate in Hz (used for Nyquist cap).

    Returns:
        (low_hz, high_hz) tuple defining the sibilant band.
    """
    nyquist = sample_rate / 2.0
    low_hz  = max(f0 * 8.0, 3000.0)   # F0-derived floor, minimum 3 kHz
    high_hz = min(12000.0, nyquist)    # Fixed upper limit -- turbulence, not harmonics
    return float(low_hz), float(high_hz)


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

class SibilanceDetector:
    """
    Per-frame sibilance detector.

    Encapsulates the detection-only half of the suppressor pipeline so it can
    be reused by other stages (e.g. a sibilant-aware airBoost) and by the
    standalone analyzer that produces a cached event map.

    Responsibilities:
      - Rolling per-frame F0 estimation (autocorrelation on time-domain
        frames, median over a windowed buffer, mask rebuild only when the
        median shifts beyond F0_MASK_RESHIFT_THRESHOLD_HZ).
      - Sibilant frequency band derivation (via get_sibilant_band).
      - Per-frame detection: P95 spike inside the band gated on spectral
        flatness (Condition 1) + broadband elevation above the long-term
        EMA reference (Condition 2).
      - EMA reference update on voiced, non-sibilant frames only.

    State surfaced to consumers (read-only by convention):
      sibilant_mask        -- current frequency-bin mask (n_bins boolean).
      sibilant_low/high    -- band edges in Hz.
      long_term_power      -- per-bin EMA reference (None until first voiced
                              non-sibilant frame).
      voiced_frame_count   -- voiced non-sibilant frames contributing to EMA.
      f0                   -- F0 from which the current band was derived.
      f0_rolling           -- deque of recent per-frame F0 estimates.
    """

    def __init__(
        self,
        sample_rate: int,
        n_fft: int,
        hop_length: int,
        params: dict,
        f0: float = None,
    ):
        self.sr         = sample_rate
        self.n_fft      = n_fft
        self.hop_length = hop_length
        self.params     = params

        self.freqs  = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)
        self.n_bins = len(self.freqs)

        # --- F0 / band state ---
        self.f0            = f0
        self.sibilant_low  = None
        self.sibilant_high = None
        self.sibilant_mask = None

        self.f0_rolling           = deque(maxlen=F0_ROLLING_WINDOW_SIZE)
        self._voiced_since_last_f0 = 0
        self._current_band_f0     = None

        if f0 is not None:
            self._set_sibilant_band(f0)
            self._current_band_f0 = f0
            self.f0_rolling.append(f0)

        # --- EMA state ---
        frame_period_ms      = (hop_length / sample_rate) * 1000.0
        self.ema_alpha       = self._time_to_coeff(
            params["ema_time_constant_ms"], frame_period_ms
        )
        self.long_term_power   = None
        self.voiced_frame_count = 0

    @staticmethod
    def _time_to_coeff(time_ms: float, frame_period_ms: float) -> float:
        if time_ms <= 0 or frame_period_ms <= 0:
            return 1.0
        return np.exp(-frame_period_ms / time_ms)

    def seed_f0(self, f0: float) -> None:
        """Set the initial F0/band before processing begins."""
        self._set_sibilant_band(f0)
        self._current_band_f0 = f0
        self.f0_rolling.append(f0)

    def _set_sibilant_band(self, f0: float) -> None:
        self.f0            = f0
        low, high          = get_sibilant_band(f0, self.sr)
        self.sibilant_low  = low
        self.sibilant_high = high
        self.sibilant_mask = (self.freqs >= low) & (self.freqs <= high)
        logger.info(
            f"SibilanceDetector: F0={f0:.1f} Hz -> "
            f"sibilant band {low:.0f}-{high:.0f} Hz "
            f"({self.sibilant_mask.sum()} bins)"
        )

    def update_rolling_f0(self, frame_raw: np.ndarray, is_voiced: bool) -> None:
        """Re-estimate F0 every Nth voiced frame; rebuild mask on shift."""
        if not is_voiced:
            return
        self._voiced_since_last_f0 += 1
        if self._voiced_since_last_f0 < F0_ESTIMATE_EVERY_N_VOICED_FRAMES:
            return
        self._voiced_since_last_f0 = 0
        f0_frame = _autocorrelate_f0_frame(frame_raw, self.sr)
        if f0_frame is None:
            return
        self.f0_rolling.append(f0_frame)
        if len(self.f0_rolling) >= 3:
            median_f0 = float(np.median(self.f0_rolling))
            if (self._current_band_f0 is None or
                    abs(median_f0 - self._current_band_f0)
                    > F0_MASK_RESHIFT_THRESHOLD_HZ):
                self._set_sibilant_band(median_f0)
                self._current_band_f0 = median_f0

    def detect(self, magnitude: np.ndarray) -> bool:
        """
        Detect whether a frame contains a sibilant event.

        Two independent conditions — either triggers detection:

        Condition 1 — P95 local spike (de-esser logic from processing spec):
          Fires when P95 energy in the sibilant band exceeds the band mean
          by p95_trigger_db AND the in-band spectral flatness (Wiener entropy)
          exceeds min_flatness. The flatness gate rejects tonal false
          positives (vowel harmonics, formant peaks) that produce a P95 spike
          without the broadband turbulent character of an actual fricative.
          Works without a long-term reference so it fires from frame zero.

        Condition 2 — Broad elevation above long-term reference:
          Fires when the mean sibilant band energy exceeds the long-term
          reference mean sibilant band energy by selectivity_db. Catches
          broad sibilant plateaus (flat energy across the whole band) that
          Condition 1 misses because P95 ~ mean within a flat plateau.
          Only active after EMA warmup. No flatness gate — the long-term
          reference already differentiates sibilants from voiced energy by
          historical context.
        """
        if self.sibilant_mask is None or not self.sibilant_mask.any():
            return False

        sib_energy  = magnitude[self.sibilant_mask] ** 2
        mean_energy = np.mean(sib_energy)
        p95_energy  = np.percentile(sib_energy, 95)

        mean_db = 10.0 * np.log10(mean_energy + 1e-10)
        p95_db  = 10.0 * np.log10(p95_energy  + 1e-10)

        if (p95_db - mean_db) > self.params["p95_trigger_db"]:
            valid = sib_energy > 0
            if valid.any():
                geo_mean = np.exp(np.mean(np.log(sib_energy[valid])))
                arith    = np.mean(sib_energy[valid])
                flatness = geo_mean / arith if arith > 0 else 0.0
            else:
                flatness = 0.0
            if flatness >= self.params["min_flatness"]:
                return True

        if (self.long_term_power is not None and
                self.voiced_frame_count >= self.params["warmup_frames"]):
            ref_mean_db = 10.0 * np.log10(
                np.mean(self.long_term_power[self.sibilant_mask]) + 1e-10
            )
            if (mean_db - ref_mean_db) > self.params["broadband_trigger_db"]:
                return True

        return False

    def update_ema(
        self,
        frame_power: np.ndarray,
        is_voiced:   bool,
        is_sibilant: bool,
    ) -> None:
        """Update the long-term reference on voiced, non-sibilant frames."""
        if not (is_voiced and not is_sibilant):
            return
        if self.long_term_power is None:
            self.long_term_power = frame_power.copy()
        else:
            self.long_term_power = (
                self.ema_alpha         * self.long_term_power +
                (1.0 - self.ema_alpha) * frame_power
            )
        self.voiced_frame_count += 1

    def process_frame(
        self,
        frame_raw: np.ndarray,
        magnitude: np.ndarray,
        is_voiced: bool,
    ) -> bool:
        """
        Full per-frame pipeline: rolling F0 update -> detection -> EMA update.

        Args:
            frame_raw: Time-domain frame (unwindowed) for autocorrelation.
            magnitude: Linear magnitude spectrum, shape (n_bins,).
            is_voiced: Whether VAD classifies this frame as voiced.

        Returns:
            True if the frame is sibilant.
        """
        self.update_rolling_f0(frame_raw, is_voiced)
        is_sibilant = self.detect(magnitude) if is_voiced else False
        frame_power = magnitude ** 2
        self.update_ema(frame_power, is_voiced, is_sibilant)
        return is_sibilant

    def apply_event(
        self,
        magnitude:       np.ndarray,
        is_voiced:       bool,
        is_sibilant_pre: bool,
        f0_pre:          float,
    ) -> bool:
        """
        Per-frame update from a precomputed event map (no internal detection).

        Used when the analyzer has already run a detection pass and stored
        the result on the pipeline context. Skips rolling F0 estimation and
        the dual-condition detection, but still:
          - rebuilds the sibilant band mask when the precomputed F0 changes
            (so the suppressor's reduction step targets the correct band),
          - updates the long-term EMA reference on voiced non-sibilant frames
            (so the reference is in sync with what the suppressor sees).

        Args:
            magnitude:       Linear magnitude spectrum, shape (n_bins,).
            is_voiced:       Whether VAD classifies this frame as voiced.
            is_sibilant_pre: Precomputed sibilant flag from the event map.
            f0_pre:          Precomputed F0 for this frame from the event map.

        Returns:
            Effective is_sibilant (precomputed flag, gated on is_voiced).
        """
        if f0_pre is not None and (
            self._current_band_f0 is None
            or abs(f0_pre - self._current_band_f0) > 1e-3
        ):
            self._set_sibilant_band(f0_pre)
            self._current_band_f0 = f0_pre

        is_sibilant = bool(is_sibilant_pre) and is_voiced
        frame_power = magnitude ** 2
        self.update_ema(frame_power, is_voiced, is_sibilant)
        return is_sibilant


# ---------------------------------------------------------------------------
# Core algorithm
# ---------------------------------------------------------------------------

class SibilanceSuppressor:
    """
    Sibilance suppressor combining F0-derived detection with EMA gain reduction.

    Per-frame processing:
      1. Rolling F0: re-estimate F0 every Nth voiced frame via autocorrelation.
         Maintain a rolling median over the recent estimates and rebuild the
         sibilant band mask only when the median shifts beyond a threshold.
         Tracks speaker/pitch changes within a file without per-frame churn.
      2. Detection: measure P95 energy in sibilant band vs. mean energy.
         Fire sibilant flag when P95 > mean + p95_trigger_db.
      3. EMA update: on non-sibilant voiced frames, update per-bin long-term
         power reference. Detection drives the gate directly.
      4. Reduction: on sibilant frames (after warmup), compute per-bin gain
         reduction where frame spectrum exceeds long-term reference by
         more than `selectivity` dB.
      5. Apply: attack/release IIR smoothing -> STFT gain application -> ISTFT.
    """

    def __init__(
        self,
        sample_rate: int = 44100,
        n_fft: int = 2048,
        hop_length: int = 512,
        params: dict = None,
        f0: float = None,
    ):
        self.sr         = sample_rate
        self.n_fft      = n_fft
        self.hop_length = hop_length

        self.params = resolve_params(params)
        params = self.params

        self.freqs  = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)
        self.n_bins = len(self.freqs)

        # F0 / mask / EMA state lives in the detector. The suppressor reads
        # it via property accessors (sibilant_mask, long_term_power, etc.)
        # so the rest of process() stays compact.
        self.detector = SibilanceDetector(
            sample_rate=sample_rate,
            n_fft=n_fft,
            hop_length=hop_length,
            params=params,
            f0=f0,
        )

        # --- Sharpness spreading kernel ---
        sharpness   = params["sharpness"]
        spread_bins = int(30 * (1.0 - sharpness))
        if spread_bins >= 2:
            sigma  = spread_bins / 3.0
            half   = spread_bins
            x      = np.arange(-half, half + 1, dtype=float)
            kernel = np.exp(-0.5 * (x / sigma) ** 2)
            self.spread_kernel = kernel / kernel.sum()
        else:
            self.spread_kernel = None

        # --- Attack/release ---
        frame_period_ms    = (hop_length / sample_rate) * 1000.0
        self.attack_coeff  = self._time_to_coeff(params["attack_ms"],  frame_period_ms)
        self.release_coeff = self._time_to_coeff(params["release_ms"], frame_period_ms)

        # --- Cached overlap-add window (computed once per instance) ---
        self._window         = get_window("hann", n_fft, fftbins=True).astype(np.float32)
        self._window_squared = (self._window.astype(np.float64) ** 2)

    # --- Read-only views into detector state, kept for backwards compatibility
    # with existing telemetry / report code that reads these directly. ---
    @property
    def f0(self):                 return self.detector.f0
    @property
    def sibilant_low(self):       return self.detector.sibilant_low
    @property
    def sibilant_high(self):      return self.detector.sibilant_high
    @property
    def sibilant_mask(self):      return self.detector.sibilant_mask
    @property
    def long_term_power(self):    return self.detector.long_term_power
    @property
    def voiced_frame_count(self): return self.detector.voiced_frame_count

    @staticmethod
    def _time_to_coeff(time_ms: float, frame_period_ms: float) -> float:
        if time_ms <= 0 or frame_period_ms <= 0:
            return 1.0
        return np.exp(-frame_period_ms / time_ms)

    def _compute_gain_reduction(
        self,
        magnitude_db:  np.ndarray,
        reference_db:  np.ndarray,
    ) -> np.ndarray:
        """
        Compute per-bin gain reduction against the long-term reference.

        Only fires within the sibilant band. Uses the same soft-knee
        depth/selectivity pattern as the resonance suppressor for consistency.

        Args:
            magnitude_db: current frame magnitude in dB, shape (n_bins,)
            reference_db: long-term EMA reference in dB,   shape (n_bins,)

        Returns:
            reduction_db: gain reduction to apply (positive = cut), shape (n_bins,)
        """
        p             = self.params
        selectivity   = p["selectivity"]
        depth         = p["depth"]
        max_reduction = p["max_reduction_db"]

        spike_db        = magnitude_db - reference_db
        spike_db_masked = np.where(self.sibilant_mask, spike_db, 0.0)
        above_threshold = np.maximum(0.0, spike_db_masked - selectivity)

        if p["mode"] == "soft":
            knee_width = selectivity * 0.5
            in_knee    = above_threshold < knee_width
            soft_curve = np.where(
                in_knee,
                above_threshold ** 2 / (2.0 * max(knee_width, 1e-6)),
                above_threshold,
            )
            raw_reduction = soft_curve * depth
        else:
            raw_reduction = above_threshold * depth

        reduction_db = np.clip(raw_reduction, 0.0, max_reduction)

        if self.spread_kernel is not None and reduction_db.any():
            reduction_db = np.convolve(reduction_db, self.spread_kernel, mode="same")
            reduction_db = np.clip(reduction_db, 0.0, max_reduction)

        return reduction_db

    def process(
        self,
        audio: np.ndarray,
        voiced_frame_indices=None,
        events_map: dict = None,
    ) -> dict:
        """
        Apply sibilance suppression to a mono audio array.

        If F0 was not provided at init, estimates a seed F0 from the audio
        before processing. The seed sets the initial sibilant band and primes
        the rolling F0 buffer. Inside the main loop, F0 is re-estimated every
        Nth voiced frame and the band mask is rebuilt when the rolling median
        shifts beyond F0_MASK_RESHIFT_THRESHOLD_HZ.

        Args:
            audio: 1D float32 array at self.sr.
            voiced_frame_indices: set of STFT frame indices where voice is present.
                Silence frames receive target_gr=0; IIR decays smoothly.
                None = process all frames.
            events_map: Precomputed event map from analyze_sibilance_events.
                When provided, internal detection (rolling F0 + dual-condition
                detect()) is bypassed and the suppressor consumes
                `sibilantFrameIndices` and `f0.perFrame` directly. The
                long-term EMA reference is still tracked from this run's
                spectra so the reduction step has an in-sync reference.

        Returns:
            dict: audio, max_reduction_db, mean_reduction_db, sibilant_frames_detected,
                  sibilant_frames_processed, artifact_risk, band_summary, f0,
                  sibilant_band_hz. The reported `f0` is the median of the
                  rolling per-frame estimates collected during processing.
        """
        if audio.ndim != 1:
            raise ValueError("SibilanceSuppressor expects mono input (1D array).")

        # Unpack the precomputed event map (if any). When present we skip
        # internal detection and seed the band from the map's first F0
        # (or the median) so the initial frames have a workable mask.
        precomputed_sibilant = None
        precomputed_f0       = None
        if events_map is not None:
            precomputed_sibilant = set(events_map.get("sibilantFrameIndices", []))
            precomputed_f0       = events_map.get("f0", {}).get("perFrame", []) or []

        # Estimate F0 if not already set. With an event map we prefer its
        # median F0 (or first per-frame value) over a fresh estimate so the
        # detector's reported F0 matches the analyzer's.
        if self.detector.f0 is None:
            seed = None
            if events_map is not None:
                seed = events_map.get("f0", {}).get("median")
                if seed is None:
                    for v in precomputed_f0:
                        if v is not None:
                            seed = v
                            break
            if seed is None:
                seed = estimate_f0(audio, self.sr)
            self.detector.seed_f0(seed)

        if self.sibilant_mask is None:
            logger.error("SibilanceSuppressor: sibilant band not set, returning unmodified.")
            return {"audio": audio, "skipped": True}

        n_fft          = self.n_fft
        hop            = self.hop_length
        window         = self._window
        window_squared = self._window_squared
        warmup         = self.params["warmup_frames"]

        pad          = n_fft // 2
        audio_padded = np.pad(audio, pad, mode="reflect")
        n_padded     = len(audio_padded)
        n_frames     = max(0, (n_padded - n_fft) // hop + 1)

        if n_frames == 0:
            logger.warning("SibilanceSuppressor: audio too short, returning unmodified.")
            return {
                "audio": audio, "max_reduction_db": 0.0, "mean_reduction_db": 0.0,
                "sibilant_frames_detected": 0, "sibilant_frames_processed": 0,
                "artifact_risk": False, "band_summary": [],
                "f0": self.f0,
                "sibilant_band_hz": (self.sibilant_low, self.sibilant_high),
                "events_map": None,
            }

        output_buffer      = np.zeros(n_padded, dtype=np.float64)
        window_accumulator = np.zeros(n_padded, dtype=np.float64)
        smoothed_gr        = np.zeros(self.n_bins)

        max_reduction              = 0.0
        sum_reduction              = 0.0
        n_active_bins_total        = 0
        sibilant_frames_detected   = 0
        sibilant_frames_processed  = 0
        active_threshold           = 0.01

        bin_sum_reduction  = np.zeros(self.n_bins)
        bin_max_reduction  = np.zeros(self.n_bins)
        voiced_frame_count = 0
        eps                = 1e-10

        # Per-frame detection trace -- only collected when running internal
        # detection so the result can carry an events_map payload for the
        # JS side to cache (sidesteps the analyzer's separate STFT pass).
        emit_sibilant_indices = [] if events_map is None else None
        emit_f0_per_frame     = [] if events_map is None else None

        # Precompute boolean voiced mask once -- avoids per-frame set lookup.
        if voiced_frame_indices is None:
            voiced_mask = np.ones(n_frames, dtype=bool)
        else:
            voiced_mask = np.zeros(n_frames, dtype=bool)
            for fi in voiced_frame_indices:
                if 0 <= fi < n_frames:
                    voiced_mask[fi] = True

        for i in range(n_frames):
            start = i * hop
            end   = start + n_fft

            frame_raw    = audio_padded[start:end]
            frame        = frame_raw * window
            spectrum     = np.fft.rfft(frame).astype(np.complex64, copy=False)
            magnitude    = np.abs(spectrum)
            magnitude_db = 20.0 * np.log10(magnitude + eps)

            is_voiced   = bool(voiced_mask[i])

            # Rolling F0, dual-condition detection, and EMA update are all
            # delegated to the detector. The detector exposes the resulting
            # sibilant_mask / long_term_power / voiced_frame_count for the
            # gain-reduction step that follows.
            #
            # When an event map is provided, detection is bypassed: the
            # detector consumes the precomputed sibilant flag and F0 for
            # this frame and only updates band mask + EMA reference.
            if events_map is None:
                is_sibilant = self.detector.process_frame(frame_raw, magnitude, is_voiced)
                emit_f0_per_frame.append(self.detector.f0)
                if is_sibilant:
                    emit_sibilant_indices.append(i)
            else:
                f0_pre = precomputed_f0[i] if i < len(precomputed_f0) else None
                is_sibilant = self.detector.apply_event(
                    magnitude, is_voiced,
                    is_sibilant_pre=(i in precomputed_sibilant),
                    f0_pre=f0_pre,
                )

            if is_sibilant:
                sibilant_frames_detected += 1

            # --- Gain reduction ---
            target_gr = np.zeros(self.n_bins)

            if (is_sibilant and
                    self.long_term_power is not None and
                    self.voiced_frame_count >= warmup):
                reference_db = 10.0 * np.log10(self.long_term_power + eps)
                target_gr    = self._compute_gain_reduction(magnitude_db, reference_db)
                sibilant_frames_processed += 1

            if not is_voiced:
                target_gr = np.zeros(self.n_bins)

            # --- Attack/release IIR ---
            increasing  = target_gr >= smoothed_gr
            coeff       = np.where(increasing, self.attack_coeff, self.release_coeff)
            smoothed_gr = coeff * smoothed_gr + (1.0 - coeff) * target_gr

            if i % 100 == 0:
                logger.info(
                    f"Frame {i:04d} | voiced={is_voiced} | sibilant={is_sibilant} | "
                    f"lt_frames={self.voiced_frame_count} | "
                    f"max_target={np.max(target_gr):.1f} dB | "
                    f"max_smoothed={np.max(smoothed_gr):.1f} dB"
                )

            # --- Telemetry ---
            if is_voiced:
                bin_sum_reduction += smoothed_gr
                bin_max_reduction  = np.maximum(bin_max_reduction, smoothed_gr)
                voiced_frame_count += 1

            frame_max = float(np.max(smoothed_gr))
            if frame_max > max_reduction:
                max_reduction = frame_max
            active_mask = smoothed_gr > active_threshold
            if active_mask.any():
                sum_reduction       += float(np.sum(smoothed_gr[active_mask]))
                n_active_bins_total += int(active_mask.sum())

            # --- Apply and ISTFT ---
            gain_linear       = (10.0 ** (-smoothed_gr / 20.0)).astype(np.float32, copy=False)
            modified_spectrum = spectrum * gain_linear
            time_frame        = np.fft.irfft(modified_spectrum, n=n_fft) * window

            frame_end = min(end, n_padded)
            trim      = frame_end - start
            output_buffer[start:frame_end]      += time_frame[:trim]
            window_accumulator[start:frame_end] += window_squared[:trim]

        safe_acc      = np.where(window_accumulator > 1e-8, window_accumulator, 1.0)
        output_buffer /= safe_acc
        output_audio   = output_buffer[pad : pad + len(audio)].astype(np.float32)

        mean_reduction = (sum_reduction / n_active_bins_total) if n_active_bins_total > 0 else 0.0
        artifact_risk  = mean_reduction > 3.0

        # --- Band summary ---
        band_summary = []
        if voiced_frame_count > 0:
            bin_mean_reduction = bin_sum_reduction / voiced_frame_count
            BAND_CENTERS = [
                3150, 4000, 5000, 6300, 8000, 10000, 12500,
            ]
            for center in BAND_CENTERS:
                low  = center / (2.0 ** (1.0 / 6.0))
                high = center * (2.0 ** (1.0 / 6.0))
                mask = (self.freqs >= low) & (self.freqs < high)
                if not mask.any():
                    continue
                mean_red = float(np.mean(bin_mean_reduction[mask]))
                max_red  = float(np.max(bin_max_reduction[mask]))
                if max_red > 0.05:
                    band_summary.append({
                        "center":             center,
                        "mean_reduction_db":  round(mean_red, 2),
                        "peak_reduction_db":  round(max_red,  2),
                    })

            if band_summary:
                logger.info("SibilanceSuppressor band summary (sibilant band, voiced frames):")
                for b in band_summary:
                    bars = "#" * min(20, int(round(b["peak_reduction_db"] / 0.5)))
                    logger.info(
                        f"  {b['center']:6.0f} Hz: "
                        f"mean {-b['mean_reduction_db']:5.2f} dB | "
                        f"peak {-b['peak_reduction_db']:5.2f} dB  {bars}"
                    )

        # Reported F0 is the median of all rolling estimates collected during
        # processing — more representative than the last-applied band's F0 on
        # files where the speaker (or pitch) varies. Falls back to self.f0
        # when no rolling estimates were collected (very short or all-silence
        # audio).
        rolling = self.detector.f0_rolling
        f0_reported = (float(np.median(rolling))
                       if len(rolling) > 0 else self.f0)

        logger.info(
            f"SibilanceSuppressor: f0={f0_reported:.1f} Hz "
            f"(rolling n={len(rolling)}) | "
            f"band={self.sibilant_low:.0f}-{self.sibilant_high:.0f} Hz | "
            f"detected={sibilant_frames_detected} | "
            f"processed={sibilant_frames_processed} | "
            f"lt_frames={self.voiced_frame_count} | "
            f"max={max_reduction:.2f} dB | mean={mean_reduction:.2f} dB | "
            f"artifact_risk={artifact_risk}"
        )

        # When detection ran internally, build the canonical event-map
        # payload so the JS wrapper can persist it for downstream consumers
        # (airBoost, etc.) and avoid a second STFT pass via the analyzer.
        emitted_events_map = None
        if emit_sibilant_indices is not None:
            emitted_events_map = build_events_map(
                sibilant_indices = emit_sibilant_indices,
                f0_per_frame     = emit_f0_per_frame,
                f0_median        = f0_reported,
                n_frames         = n_frames,
                sample_rate      = self.sr,
                n_fft            = self.n_fft,
                hop_length       = self.hop_length,
            )

        return {
            "audio":                    output_audio,
            "max_reduction_db":         max_reduction,
            "mean_reduction_db":        mean_reduction,
            "sibilant_frames_detected": sibilant_frames_detected,
            "sibilant_frames_processed": sibilant_frames_processed,
            "artifact_risk":            artifact_risk,
            "band_summary":             band_summary,
            "f0":                       f0_reported,
            "sibilant_band_hz":         (self.sibilant_low, self.sibilant_high),
            "events_map":               emitted_events_map,
        }


# ---------------------------------------------------------------------------
# Pipeline integration
# ---------------------------------------------------------------------------

def apply_sibilance_suppression(
    audio: np.ndarray,
    sample_rate: int,
    params: dict = None,
    vad_voiced_mask: np.ndarray = None,
    f0: float = None,
    events_map: dict = None,
) -> dict:
    """
    Stage 4 pipeline entry point.

    F0 can be passed in from the pipeline's Pre-4 F0 estimation step.
    If None, it will be estimated from the audio before processing.

    Args:
        audio:           Mono float32 audio at sample_rate.
        sample_rate:     Sample rate (44100 in the Instant Polish pipeline).
        params:          Sparse override dict overlaid on DEFAULT_PARAMS. Pass
                         None or {} to use defaults unmodified.
        vad_voiced_mask: Optional boolean array (same length as audio), True = voiced.
        f0:              Fundamental frequency in Hz. Estimated if not provided.
        events_map:      Precomputed sibilance event map from
                         analyze_sibilance_events. When provided the
                         suppressor bypasses its internal detection and
                         drives the gate from `sibilantFrameIndices` /
                         `f0.perFrame`. STFT geometry (nFft, hopLength,
                         sampleRate) must match this run.

    Returns:
        dict: audio, max_reduction_db, mean_reduction_db, sibilant_frames_detected,
              sibilant_frames_processed, artifact_risk, band_summary, f0,
              sibilant_band_hz, skipped
    """
    t0 = time.perf_counter()

    suppressor = SibilanceSuppressor(
        sample_rate=sample_rate, params=params, f0=f0
    )

    if events_map is not None:
        # Sanity check STFT geometry: a mismatched event map would silently
        # misalign sibilant indices. Fall back to internal detection.
        em_sr   = events_map.get("sampleRate")
        em_nfft = events_map.get("nFft")
        em_hop  = events_map.get("hopLength")
        if (em_sr  != sample_rate
                or em_nfft != suppressor.n_fft
                or em_hop  != suppressor.hop_length):
            logger.warning(
                "SibilanceSuppressor: events_map geometry mismatch "
                f"(sr={em_sr} nfft={em_nfft} hop={em_hop}); "
                "discarding map and running internal detection."
            )
            events_map = None

    voiced_frame_indices = None
    if vad_voiced_mask is not None and len(vad_voiced_mask) == len(audio):
        pad           = suppressor.n_fft // 2
        n_padded      = len(audio) + 2 * pad
        n_stft_frames = max(0, (n_padded - suppressor.n_fft) // suppressor.hop_length + 1)
        voiced_frame_indices = set()
        for fi in range(n_stft_frames):
            orig_start = max(0, fi * suppressor.hop_length - pad)
            orig_end   = min(len(audio), fi * suppressor.hop_length - pad + suppressor.n_fft)
            if orig_start < orig_end and vad_voiced_mask[orig_start:orig_end].any():
                voiced_frame_indices.add(fi)

    result = suppressor.process(
        audio,
        voiced_frame_indices=voiced_frame_indices,
        events_map=events_map,
    )
    result["skipped"]         = False
    result["process_seconds"] = time.perf_counter() - t0
    return result


def sibilance_suppressor_report_entry(result: dict) -> dict:
    """Format result for the Stage 7 processing report JSON."""
    if result.get("skipped"):
        return {"applied": False, "process_seconds": round(result.get("process_seconds", 0.0), 3)}
    low, high = result.get("sibilant_band_hz") or (None, None)
    return {
        "applied":                   True,
        "f0_hz":                     round(result["f0"], 1) if result.get("f0") else None,
        "sibilant_band_hz":          {"low": round(low, 0), "high": round(high, 0)}
                                     if low and high else None,
        "sibilant_frames_detected":  result["sibilant_frames_detected"],
        "sibilant_frames_processed": result["sibilant_frames_processed"],
        "max_reduction_db":          round(result["max_reduction_db"],  1),
        "mean_reduction_db":         round(result["mean_reduction_db"], 1),
        "artifact_risk":             result["artifact_risk"],
        "band_summary":              result.get("band_summary", []),
        "process_seconds":           round(result.get("process_seconds", 0.0), 3),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse, json, sys
    from scipy.io import wavfile

    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    parser = argparse.ArgumentParser(description="Stage 4 -- Sibilance Suppressor")
    parser.add_argument("--input",         required=True)
    parser.add_argument("--output",        required=True)
    parser.add_argument("--params-json",   default=None,
                        help="Sparse parameter overrides (JSON). Keys missing "
                             "from the file inherit from DEFAULT_PARAMS. "
                             "Sourced from the preset's sibilanceSuppressor "
                             "block in src/audio/presets.js.")
    parser.add_argument("--vad-mask-json", default=None)
    parser.add_argument("--f0",            type=float, default=None)
    parser.add_argument("--events-json",   default=None,
                        help="Precomputed sibilance event map (JSON) from "
                             "analyze_sibilance_events. Skips internal "
                             "detection and consumes sibilantFrameIndices "
                             "and f0.perFrame from the map.")
    parser.add_argument("--emit-events",   default=None,
                        help="When running internal detection, also write the "
                             "canonical event map JSON to this path. Lets the "
                             "JS pipeline cache the map on ctx without paying "
                             "for a separate analyzer STFT pass. No-op when "
                             "--events-json is also set (consumer mode).")
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    audio = audio.astype(np.float32)

    params = None
    if args.params_json:
        with open(args.params_json) as fh:
            params = json.load(fh)

    vad_voiced_mask = None
    if args.vad_mask_json:
        with open(args.vad_mask_json) as fh:
            frame_list = json.load(fh)
        vad_voiced_mask = np.zeros(len(audio), dtype=bool)
        for frame in frame_list:
            if not frame["isSilence"]:
                s = frame["offsetSamples"]
                e = s + frame["lengthSamples"]
                vad_voiced_mask[s:min(e, len(audio))] = True

    events_map = None
    if args.events_json:
        with open(args.events_json) as fh:
            events_map = json.load(fh)

    result = apply_sibilance_suppression(
        audio, sr, params, vad_voiced_mask, args.f0, events_map=events_map
    )
    wavfile.write(args.output, sr, result["audio"])

    # Side-emit the event map only when internal detection ran (consumer
    # mode produces no new map -- the input already had one).
    if args.emit_events and result.get("events_map") is not None:
        with open(args.emit_events, "w") as fh:
            json.dump(result["events_map"], fh)

    print("JSON_RESULT:" + json.dumps(sibilance_suppressor_report_entry(result)), flush=True)
