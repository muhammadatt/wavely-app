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

import numpy as np
from scipy.signal import get_window
from scipy.ndimage import uniform_filter1d
import logging

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Preset parameters
# ---------------------------------------------------------------------------

PRESET_DEFAULTS = {
    "acx_audiobook": {
        # --- Detection (de-esser logic) ---
        # F0-derived sibilant band: F0*8 to min(F0*32, 12000 Hz)
        # P95 trigger: sibilant event fires when P95 energy in sibilant band
        # exceeds mean sibilant-band energy by this margin.
        "p95_trigger_db": 8.0,      # ACX: conservative -- preserve intelligibility.
        "p95_threshold_db": 4.0,    # Gain reduction threshold above mean energy.
        "broadband_trigger_db": 12.0, # Condition 2 threshold: mean sibilant band energy
                                    # above long-term reference mean. Higher than
                                    # selectivity because mean-band comparison compresses
                                    # contrast vs per-bin comparison. Calibrated to
                                    # 17_airBoost.wav: mean contrast +20 dB, min +11.6 dB;
                                    # 12 dB clears voiced EMA noise with >5 dB margin.

        # --- Reduction (EMA reference) ---
        "depth": 0.5,               # Global reduction scale (0.0-1.0).
        "selectivity": 6.0,         # Per-bin dB above long-term reference before reduction fires.
                                    # Calibrated: min sibilant contrast +11.6 dB, voiced
                                    # EMA noise ~2-3 dB -> 6.0 dB gives >5 dB margin.
        "attack_ms": 5.0,           # Fast onset -- sibilants are transient.
        "release_ms": 80.0,         # Slower release -- avoids post-sibilant bleed.
        "max_reduction_db": 10.0,   # Hard ceiling per bin. Conservative for ACX.
        "ema_time_constant_ms": 300.0, # Long-term reference time constant.
        "warmup_frames": 25,        # Voiced frames before reduction activates.
                                    # ~290 ms at hop=512, sr=44100.

        # --- Sharpness (attenuation curve shape) ---
        "sharpness": 0.3,           # 0.0 = wide gentle cuts, 1.0 = narrow deep notches.
        "mode": "soft",
    },
    "podcast_ready": {
        "p95_trigger_db": 6.0,
        "p95_threshold_db": 3.0,
        "broadband_trigger_db": 10.0,
        "depth": 0.7,
        "selectivity": 5.0,
        "attack_ms": 4.0,
        "release_ms": 60.0,
        "max_reduction_db": 9.0,
        "ema_time_constant_ms": 300.0,
        "warmup_frames": 25,
        "sharpness": 0.3,
        "mode": "soft",
    },
    "voice_ready": {
        "p95_trigger_db": 8.0,
        "p95_threshold_db": 4.0,
        "broadband_trigger_db": 11.0,
        "depth": 0.6,
        "selectivity": 5.5,
        "attack_ms": 5.0,
        "release_ms": 70.0,
        "max_reduction_db": 8.0,
        "ema_time_constant_ms": 300.0,
        "warmup_frames": 25,
        "sharpness": 0.3,
        "mode": "soft",
    },
    "general_clean": {
        "p95_trigger_db": 6.0,
        "p95_threshold_db": 3.0,
        "broadband_trigger_db": 9.0,
        "depth": 0.8,
        "selectivity": 4.0,
        "attack_ms": 4.0,
        "release_ms": 50.0,
        "max_reduction_db": 12.0,
        "ema_time_constant_ms": 300.0,
        "warmup_frames": 25,
        "sharpness": 0.2,
        "mode": "soft",
    },
}


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
# Core algorithm
# ---------------------------------------------------------------------------

class SibilanceSuppressor:
    """
    Sibilance suppressor combining F0-derived detection with EMA gain reduction.

    Per-frame processing:
      1. Detection: measure P95 energy in sibilant band vs. mean energy.
         Fire sibilant flag when P95 > mean + p95_trigger_db.
      2. EMA update: on non-sibilant voiced frames, update per-bin long-term
         power reference. Detection drives the gate directly.
      3. Reduction: on sibilant frames (after warmup), compute per-bin gain
         reduction where frame spectrum exceeds long-term reference by
         more than `selectivity` dB.
      4. Apply: attack/release IIR smoothing -> STFT gain application -> ISTFT.
    """

    def __init__(
        self,
        sample_rate: int = 44100,
        n_fft: int = 2048,
        hop_length: int = 512,
        preset: str = "acx_audiobook",
        f0: float = None,
        **override_params,
    ):
        self.sr         = sample_rate
        self.n_fft      = n_fft
        self.hop_length = hop_length

        params = PRESET_DEFAULTS.get(preset, PRESET_DEFAULTS["acx_audiobook"]).copy()
        params.update(override_params)
        self.params = params

        self.freqs  = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)
        self.n_bins = len(self.freqs)

        # F0 is set later if not provided at init (estimated from audio in process())
        self.f0             = f0
        self.sibilant_low   = None
        self.sibilant_high  = None
        self.sibilant_mask  = None

        if f0 is not None:
            self._set_sibilant_band(f0)

        # --- EMA state ---
        frame_period_ms       = (hop_length / sample_rate) * 1000.0
        self.ema_alpha        = self._time_to_coeff(
            params["ema_time_constant_ms"], frame_period_ms
        )
        self.long_term_power  = None
        self.voiced_frame_count = 0

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
        self.attack_coeff  = self._time_to_coeff(params["attack_ms"],  frame_period_ms)
        self.release_coeff = self._time_to_coeff(params["release_ms"], frame_period_ms)

    def _set_sibilant_band(self, f0: float) -> None:
        """Compute sibilant band mask from F0."""
        self.f0            = f0
        low, high          = get_sibilant_band(f0, self.sr)
        self.sibilant_low  = low
        self.sibilant_high = high
        self.sibilant_mask = (self.freqs >= low) & (self.freqs <= high)
        logger.info(
            f"SibilanceSuppressor: F0={f0:.1f} Hz -> "
            f"sibilant band {low:.0f}-{high:.0f} Hz "
            f"({self.sibilant_mask.sum()} bins)"
        )

    @staticmethod
    def _time_to_coeff(time_ms: float, frame_period_ms: float) -> float:
        if time_ms <= 0 or frame_period_ms <= 0:
            return 1.0
        return np.exp(-frame_period_ms / time_ms)

    def _detect_sibilant(self, magnitude: np.ndarray) -> bool:
        """
        Detect whether a frame contains a sibilant event.

        Two independent conditions — either triggers detection:

        Condition 1 — P95 local spike (de-esser logic from processing spec):
          Fires when P95 energy in the sibilant band exceeds the band mean
          by p95_trigger_db. Catches narrow sibilant spikes. Works without
          a long-term reference so it fires from frame zero.

        Condition 2 — Broad elevation above long-term reference:
          Fires when the mean sibilant band energy exceeds the long-term
          reference mean sibilant band energy by selectivity_db. Catches
          broad sibilant plateaus (flat energy across the whole band) that
          Condition 1 misses because P95 ~ mean within a flat plateau.
          Only active after EMA warmup.

        Args:
            magnitude: linear magnitude spectrum, shape (n_bins,)

        Returns:
            True if sibilant event detected by either condition.
        """
        if self.sibilant_mask is None or not self.sibilant_mask.any():
            return False

        sib_energy  = magnitude[self.sibilant_mask] ** 2
        mean_energy = np.mean(sib_energy)
        p95_energy  = np.percentile(sib_energy, 95)

        mean_db = 10.0 * np.log10(mean_energy + 1e-10)
        p95_db  = 10.0 * np.log10(p95_energy  + 1e-10)

        # Condition 1: local spike within sibilant band
        if (p95_db - mean_db) > self.params["p95_trigger_db"]:
            return True

        # Condition 2: broad elevation above long-term reference
        if (self.long_term_power is not None and
                self.voiced_frame_count >= self.params["warmup_frames"]):
            ref_mean_db = 10.0 * np.log10(
                np.mean(self.long_term_power[self.sibilant_mask]) + 1e-10
            )
            if (mean_db - ref_mean_db) > self.params["broadband_trigger_db"]:
                return True

        return False

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

    def process(self, audio: np.ndarray, voiced_frame_indices=None) -> dict:
        """
        Apply sibilance suppression to a mono audio array.

        If F0 was not provided at init, estimates it from the audio before
        processing. Estimation adds negligible time relative to the main loop.

        Args:
            audio: 1D float32 array at self.sr.
            voiced_frame_indices: set of STFT frame indices where voice is present.
                Silence frames receive target_gr=0; IIR decays smoothly.
                None = process all frames.

        Returns:
            dict: audio, max_reduction_db, mean_reduction_db, sibilant_frames_detected,
                  sibilant_frames_processed, artifact_risk, band_summary, f0,
                  sibilant_band_hz
        """
        if audio.ndim != 1:
            raise ValueError("SibilanceSuppressor expects mono input (1D array).")

        # Estimate F0 if not already set
        if self.f0 is None:
            f0 = estimate_f0(audio, self.sr)
            self._set_sibilant_band(f0)

        if self.sibilant_mask is None:
            logger.error("SibilanceSuppressor: sibilant band not set, returning unmodified.")
            return {"audio": audio, "skipped": True}

        n_fft          = self.n_fft
        hop            = self.hop_length
        window         = get_window("hann", n_fft, fftbins=True)
        window_squared = window ** 2
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

        for i in range(n_frames):
            start = i * hop
            end   = start + n_fft

            frame        = audio_padded[start:end] * window
            spectrum     = np.fft.rfft(frame)
            magnitude    = np.abs(spectrum)
            phase        = np.angle(spectrum)
            magnitude_db = 20.0 * np.log10(magnitude + eps)
            frame_power  = magnitude ** 2

            is_voiced   = (voiced_frame_indices is None) or (i in voiced_frame_indices)
            is_sibilant = self._detect_sibilant(magnitude) if is_voiced else False

            if is_sibilant:
                sibilant_frames_detected += 1

            # Update EMA on voiced, non-sibilant frames only.
            # Detection drives the gate -- no secondary classifier needed.
            if is_voiced and not is_sibilant:
                if self.long_term_power is None:
                    self.long_term_power = frame_power.copy()
                else:
                    self.long_term_power = (
                        self.ema_alpha         * self.long_term_power +
                        (1.0 - self.ema_alpha) * frame_power
                    )
                self.voiced_frame_count += 1

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
            gain_linear       = 10.0 ** (-smoothed_gr / 20.0)
            modified_spectrum = magnitude * gain_linear * np.exp(1j * phase)
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

        logger.info(
            f"SibilanceSuppressor: f0={self.f0:.1f} Hz | "
            f"band={self.sibilant_low:.0f}-{self.sibilant_high:.0f} Hz | "
            f"detected={sibilant_frames_detected} | "
            f"processed={sibilant_frames_processed} | "
            f"lt_frames={self.voiced_frame_count} | "
            f"max={max_reduction:.2f} dB | mean={mean_reduction:.2f} dB | "
            f"artifact_risk={artifact_risk}"
        )

        return {
            "audio":                    output_audio,
            "max_reduction_db":         max_reduction,
            "mean_reduction_db":        mean_reduction,
            "sibilant_frames_detected": sibilant_frames_detected,
            "sibilant_frames_processed": sibilant_frames_processed,
            "artifact_risk":            artifact_risk,
            "band_summary":             band_summary,
            "f0":                       self.f0,
            "sibilant_band_hz":         (self.sibilant_low, self.sibilant_high),
        }


# ---------------------------------------------------------------------------
# Pipeline integration
# ---------------------------------------------------------------------------

def apply_sibilance_suppression(
    audio: np.ndarray,
    sample_rate: int,
    preset: str,
    vad_voiced_mask: np.ndarray = None,
    f0: float = None,
) -> dict:
    """
    Stage 4 pipeline entry point.

    F0 can be passed in from the pipeline's Pre-4 F0 estimation step.
    If None, it will be estimated from the audio before processing.

    Args:
        audio:           Mono float32 audio at sample_rate.
        sample_rate:     Sample rate (44100 in the Instant Polish pipeline).
        preset:          acx_audiobook | podcast_ready | voice_ready | general_clean
        vad_voiced_mask: Optional boolean array (same length as audio), True = voiced.
        f0:              Fundamental frequency in Hz. Estimated if not provided.

    Returns:
        dict: audio, max_reduction_db, mean_reduction_db, sibilant_frames_detected,
              sibilant_frames_processed, artifact_risk, band_summary, f0,
              sibilant_band_hz, skipped
    """
    if preset == "noise_eraser":
        logger.info("SibilanceSuppressor: skipping for noise_eraser preset.")
        return {
            "audio": audio, "skipped": True, "max_reduction_db": 0.0,
            "mean_reduction_db": 0.0, "sibilant_frames_detected": 0,
            "sibilant_frames_processed": 0, "artifact_risk": False,
            "band_summary": [], "f0": f0, "sibilant_band_hz": None,
        }

    suppressor = SibilanceSuppressor(
        sample_rate=sample_rate, preset=preset, f0=f0
    )

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

    result            = suppressor.process(audio, voiced_frame_indices=voiced_frame_indices)
    result["skipped"] = False
    return result


def sibilance_suppressor_report_entry(result: dict) -> dict:
    """Format result for the Stage 7 processing report JSON."""
    if result.get("skipped"):
        return {"applied": False}
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
    parser.add_argument("--preset",        default="acx_audiobook")
    parser.add_argument("--vad-mask-json", default=None)
    parser.add_argument("--f0",            type=float, default=None)
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
                vad_voiced_mask[s:min(e, len(audio))] = True

    result = apply_sibilance_suppression(audio, sr, args.preset, vad_voiced_mask, args.f0)
    wavfile.write(args.output, sr, result["audio"])
    print("JSON_RESULT:" + json.dumps(sibilance_suppressor_report_entry(result)), flush=True)
