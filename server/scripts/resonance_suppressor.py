"""
instant_polish_resonance_suppressor.py
Stage 3b — Dynamic Resonance Suppressor

Soothe2-inspired spectral spike detection and dynamic attenuation.
Operates on 32-bit float PCM at 44.1 kHz (Instant Polish internal format).

Dependencies: numpy, scipy
All processing is frame-based via STFT/ISTFT with overlap-add reconstruction.
"""

import numpy as np
from scipy.signal import get_window
from scipy.ndimage import uniform_filter1d
import logging

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Preset-calibrated default parameters
# ---------------------------------------------------------------------------

PRESET_DEFAULTS = {
    "acx_audiobook": {
        "depth": 0.5,                   # Global reduction scale (0.0–1.0).
        "sharpness": 0.0,               # Controls depth/narrowness of attenuation curve post-detection.
                                        # 0.0 = wide gentle cuts (good for broad energy build-ups like sibilance).
                                        # 1.0 = deep narrow notches (good for sharp resonances).
        "selectivity": 1.5,             # Spike threshold for per-bin peak detection in dB above smoothed floor.
        "sibilant_selectivity": 8.0,    # Spike threshold for time-based detection -- 8dB mean significant delta
                                        # from frame-to-frame noise (~2–3 dB EMA std) 
        "attack_ms": 15.0,              # Gain reduction onset speed.
        "release_ms": 50.0,             # Gain reduction recovery speed.
        "max_reduction_db": 12.0,       # Hard ceiling on reduction at any bin.
        "freq_floor_hz": 800.0,         # Don't process below this.
        "freq_ceil_hz": 16000.0,        # Don't process above this.
        "mode": "soft",                 # "soft" = gradual knee; "hard" = linear above threshold.
    },
    "podcast_ready": {
        "depth": 0.85,
        "sharpness": 0.0,
        "selectivity": 1.5,
        "sibilant_selectivity": 5.0,
        "attack_ms": 8.0,
        "release_ms": 60.0,
        "max_reduction_db": 9.0,
        "freq_floor_hz": 3000.0,
        "freq_ceil_hz": 12000.0,
        "mode": "soft",
    },
    "voice_ready": {
        "depth": 0.75,
        "sharpness": 0.1,
        "selectivity": 2.0,
        "sibilant_selectivity": 5.5,
        "attack_ms": 12.0,
        "release_ms": 70.0,
        "max_reduction_db": 7.0,
        "freq_floor_hz": 3000.0,
        "freq_ceil_hz": 10000.0,
        "mode": "soft",
    },
    "general_clean": {
        "depth": 0.9,
        "sharpness": 0.0,
        "selectivity": 1.0,
        "sibilant_selectivity": 4.0,
        "attack_ms": 8.0,
        "release_ms": 50.0,
        "max_reduction_db": 12.0,
        "freq_floor_hz": 3000.0,
        "freq_ceil_hz": 12000.0,
        "mode": "soft",
    },
}

# Frequency above which the long-term sibilant reference is active.
# Below this, the within-frame passes are sufficient for resonant spike
# detection and the long-term reference would risk false positives on
# voiced harmonics that vary frame-to-frame.

# MT - Was set at 2500.0 to keep PATH2 exclusively it to the sibilant range (above 2500hz)
# and avoid touching potentially desirable resonances in the body of the lower voice harmonics

SIBILANT_BAND_FLOOR_HZ = 2500 

# Minimum voiced frames before the long-term reference is used for detection.
# At hop=512, sr=44100 (11.6 ms/frame), 25 frames ≈ 290 ms of voiced speech —
# enough for the EMA to converge away from its initialization value.
SIBILANT_WARMUP_FRAMES = 25

# EMA time constant for the long-term voiced reference (ms).
# 300 ms gives a reference that tracks slow room/voice changes across a session
# while remaining stable enough to distinguish transient sibilant events.
LONG_TERM_REF_TIME_CONSTANT_MS = 300.0

# If PATH 2 detects a sibilant event this strongly (dB), skip updating the
# long-term reference for this frame. Prevents sibilant energy from pulling
# the reference upward and masking future detections. The gate fires after
# warmup only — during warmup all voiced frames contribute to the reference.
SIBILANT_UPDATE_GATE_DB = 0.5


# ---------------------------------------------------------------------------
# Core algorithm
# ---------------------------------------------------------------------------

class ResonanceSuppressor:
    """
    Dynamic resonance suppressor using STFT-based spectral spike detection.

    Two parallel detection paths whose gain reductions are combined via
    element-wise maximum before the shared attack/release smoothing stage:

    PATH 1 — Within-frame (narrow resonant spikes, full spectrum):
      Computes a mel-scaled smoothed reference from the current frame's own
      spectrum and flags bins that exceed it by more than `selectivity` dB.
      Effective for narrow resonant peaks (room modes, mic resonances) where
      context bins on either side are not elevated. Cannot detect broad
      sibilant plateaus because the smoothed reference follows the plateau.

    PATH 2 — Long-term reference (e.g. broad sibilant elevations):
      Maintains a per-bin exponential moving average of voiced-frame power
      spectra (time constant ~300 ms). Flags bins in the sibilant band (above SIBILANT_BAND_FLOOR_HZ) that
      exceed this long-term reference by more than `sibilant_selectivity` dB.
      Effective for broad sibilant events because the long-term voiced
      reference sits 11–20+ dB below the sibilant plateau; the within-frame
      reference cannot see this contrast.

    Calibration source: 17_airBoost.wav analysis —
      - 321 voiced frames, 52 sibilant frames identified
      - Mean sibilant contrast vs. long-term voiced reference: +20.2 dB (3–10 kHz)
      - Minimum sibilant contrast: +11.6 dB
      - `sibilant_selectivity` = 6.0 dB chosen to clear voiced frame-to-frame
        EMA noise (~2–3 dB) with >5 dB margin below the minimum contrast
    """

    def __init__(
        self,
        sample_rate: int = 44100,
        n_fft: int = 2048,
        hop_length: int = 512,
        preset: str = "acx_audiobook",
        f0: float = 109.4,
        **override_params,
    ):
        self.sr = sample_rate
        self.n_fft = n_fft
        self.hop_length = hop_length
        self.f0 = f0

        params = PRESET_DEFAULTS.get(preset, PRESET_DEFAULTS["acx_audiobook"]).copy()
        params.update(override_params)
        self.params = params

        # FFT bin frequencies — stored as instance attribute for reuse
        self.freqs = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)
        self.n_bins = len(self.freqs)

        # Active bin mask — processing range defined by preset
        self.active_bins = (
            (self.freqs >= params["freq_floor_hz"]) &
            (self.freqs <= params["freq_ceil_hz"])
        )

        # Sibilant band mask — long-term reference path only fires here.
        # Intersected with active_bins so it respects the preset's freq range.
        self.sibilant_band_mask = self.active_bins & (self.freqs >= SIBILANT_BAND_FLOOR_HZ)

        # ------------------------------------------------------------------
        # PATH 1 — Within-frame mel-domain smoothing setup
        # ------------------------------------------------------------------
        mel_of_freq = lambda f: 2595.0 * np.log10(1.0 + np.asarray(f, dtype=float) / 700.0)

        self.mel_freqs = mel_of_freq(np.maximum(self.freqs, 1.0))
        mel_min = float(self.mel_freqs[1])
        mel_max = float(self.mel_freqs[-1])
        self.mel_grid = np.linspace(mel_min, mel_max, self.n_bins)

        # Mel-domain window: fixed at a moderate context width, independent of
        # sharpness (sharpness now controls attenuation shape, not detection width)
        mel_bin_width = (mel_max - mel_min) / self.n_bins
        self.mel_window_bins = max(3, int(120.0 / mel_bin_width))  # ~120 mel units

        # Wide linear window for sibilant-band within-frame smoothing.
        # Kept as a fallback within PATH 1; primary sibilant detection is PATH 2.
        self.sibilant_window_bins = 200  # ~4.3 kHz at n_fft=2048, sr=44100

        # Blend weight: 0.0 below 4 kHz (pure mel), 1.0 above 6 kHz (pure wide linear)
        self.sibilant_blend = np.clip(
            (self.freqs - 4000.0) / (6000.0 - 4000.0),
            0.0, 1.0,
        )

        # ------------------------------------------------------------------
        # PATH 2 — Long-term reference state
        # ------------------------------------------------------------------
        frame_period_ms = (hop_length / sample_rate) * 1000.0
        self.long_term_alpha = self._time_to_coeff(
            LONG_TERM_REF_TIME_CONSTANT_MS, frame_period_ms
        )
        self.long_term_power = None   # per-bin power EMA; None until first voiced frame
        self.long_term_frame_count = 0  # voiced frames seen so far

        # ------------------------------------------------------------------
        # Sharpness — controls attenuation curve shape, not detection
        # 0.0 = wide gentle cuts (broad energy build-ups)
        # 1.0 = deep narrow notches (precise resonances)
        # Implemented as Gaussian spreading of the gain reduction array:
        # high sharpness = narrow kernel, low sharpness = wide kernel
        # ------------------------------------------------------------------
        sharpness = params["sharpness"]
        # Kernel half-width in bins: 0 bins at sharpness=1.0, 30 bins at sharpness=0.0
        spread_bins = int(30 * (1.0 - sharpness))
        if spread_bins >= 2:
            sigma = spread_bins / 3.0
            half = spread_bins
            x = np.arange(-half, half + 1, dtype=float)
            self.spread_kernel = np.exp(-0.5 * (x / sigma) ** 2)
            self.spread_kernel /= self.spread_kernel.sum()
        else:
            self.spread_kernel = None  # no spreading at max sharpness

        # Attack/release time constants
        self.attack_coeff  = self._time_to_coeff(params["attack_ms"],  frame_period_ms)
        self.release_coeff = self._time_to_coeff(params["release_ms"], frame_period_ms)

        logger.info(
            f"ResonanceSuppressor init | preset={preset} | "
            f"n_fft={n_fft} | hop={hop_length} | "
            f"mel_window={self.mel_window_bins} bins | "
            f"sibilant_window={self.sibilant_window_bins} bins | "
            f"long_term_alpha={self.long_term_alpha:.4f} "
            f"(tc={LONG_TERM_REF_TIME_CONSTANT_MS:.0f}ms) | "
            f"selectivity={params['selectivity']} dB | "
            f"sibilant_selectivity={params['sibilant_selectivity']} dB | "
            f"depth={params['depth']} | max_cut={params['max_reduction_db']} dB | "
            f"sharpness={sharpness} | spread_kernel={'yes' if self.spread_kernel is not None else 'none'}"
        )

    @staticmethod
    def _time_to_coeff(time_ms: float, frame_period_ms: float) -> float:
        """Convert a time constant in ms to a per-frame IIR smoothing coefficient."""
        if time_ms <= 0 or frame_period_ms <= 0:
            return 1.0
        return np.exp(-frame_period_ms / time_ms)

    def _compute_smoothed_envelope(self, magnitude_db: np.ndarray) -> np.ndarray:
        """
        Compute the within-frame two-pass smoothed reference envelope (PATH 1).

        Pass 1: mel-domain smoothing — perceptually consistent context width.
        Pass 2: wide linear smoothing — partial fallback for sibilant band.
        Blend:  frequency-dependent interpolation between the two.

        All averaging in power domain to prevent harmonic-valley bias.
        """
        power = 10.0 ** (magnitude_db / 10.0)

        # Pass 1: mel-domain
        mel_power    = np.interp(self.mel_grid,  self.mel_freqs, power)
        mel_smoothed = uniform_filter1d(mel_power, size=self.mel_window_bins, mode="reflect")
        pass1_power  = np.interp(self.mel_freqs, self.mel_grid,  mel_smoothed)

        # Pass 2: wide linear
        pass2_power = uniform_filter1d(power, size=self.sibilant_window_bins, mode="reflect")

        # Blend
        blended_power = (1.0 - self.sibilant_blend) * pass1_power + self.sibilant_blend * pass2_power

        return 10.0 * np.log10(blended_power + 1e-10)

    def _compute_gain_reduction(
        self,
        magnitude_db: np.ndarray,
        smoothed_db: np.ndarray,
        selectivity_db: float,
        band_mask: np.ndarray,
    ) -> np.ndarray:
        """
        Compute per-bin gain reduction for one detection path.

        Args:
            magnitude_db:   actual frame magnitude in dB, shape (n_bins,)
            smoothed_db:    reference envelope in dB, shape (n_bins,)
            selectivity_db: threshold above reference before reduction fires
            band_mask:      boolean mask limiting which bins are processed

        Returns:
            reduction_db: gain reduction to apply (positive = cut), shape (n_bins,)
        """
        p = self.params
        depth         = p["depth"]
        max_reduction = p["max_reduction_db"]
        mode          = p["mode"]

        spike_db        = magnitude_db - smoothed_db
        spike_db_masked = np.where(band_mask, spike_db, 0.0)
        above_threshold = np.maximum(0.0, spike_db_masked - selectivity_db)

        if mode == "soft":
            knee_width = selectivity_db * 0.5
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

        # Sharpness spreading: convolve reduction with kernel to widen or
        # narrow the attenuation around detected peaks.
        # Low sharpness → wide kernel → gentle broad cuts.
        # High sharpness → no spreading → tight notches at detected bins.
        if self.spread_kernel is not None and reduction_db.any():
            reduction_db = np.convolve(reduction_db, self.spread_kernel, mode="same")
            reduction_db = np.clip(reduction_db, 0.0, max_reduction)

        return reduction_db

    def process(self, audio: np.ndarray, voiced_frame_indices=None) -> dict:
        """
        Apply dynamic resonance suppression to a mono audio array.

        Each STFT frame:
          1. PATH 1: within-frame smoothed envelope → gain reduction (full spectrum)
          2. PATH 2: long-term voiced reference → gain reduction (2500 Hz+, after warmup)
          3. target_gr = element-wise maximum of PATH 1 and PATH 2
          4. Attack/release IIR smoothing of target_gr
          5. Apply gain reduction to STFT bins; ISTFT + overlap-add

        Long-term reference update:
          On each voiced frame, update per-bin power EMA with alpha derived from
          the 300 ms time constant. Only used for detection after SIBILANT_WARMUP_FRAMES
          voiced frames to avoid acting on an under-converged reference.

        Args:
            audio: 1D float32 numpy array at self.sr sample rate.
            voiced_frame_indices: set of int STFT frame indices where voice is present.
                Frames outside this set receive target_gr=0 (VAD gating).
                None means all frames are processed.

        Returns:
            dict: audio, max_reduction_db, mean_reduction_db, spike_frames,
                  artifact_risk, band_summary
        """
        if audio.ndim != 1:
            raise ValueError("ResonanceSuppressor expects mono input (1D array).")

        n_fft = self.n_fft
        hop   = self.hop_length
        window         = get_window("hann", n_fft, fftbins=True)
        window_squared = window ** 2

        pad          = n_fft // 2
        audio_padded = np.pad(audio, pad, mode="reflect")
        n_padded     = len(audio_padded)
        n_frames     = max(0, (n_padded - n_fft) // hop + 1)

        if n_frames == 0:
            logger.warning("ResonanceSuppressor: audio too short, returning unmodified.")
            return {
                "audio": audio, "max_reduction_db": 0.0, "mean_reduction_db": 0.0,
                "spike_frames": 0, "artifact_risk": False,
            }

        output_buffer      = np.zeros(n_padded, dtype=np.float64)
        window_accumulator = np.zeros(n_padded, dtype=np.float64)
        smoothed_gr        = np.zeros(self.n_bins)

        max_reduction       = 0.0
        sum_reduction       = 0.0
        n_active_bins_total = 0
        spike_frames        = 0
        active_threshold    = 0.01

        bin_sum_reduction  = np.zeros(self.n_bins)
        bin_max_reduction  = np.zeros(self.n_bins)
        voiced_frame_count = 0

        eps = 1e-10

        for i in range(n_frames):
            start = i * hop
            end   = start + n_fft

            # --- FFT ---
            frame        = audio_padded[start:end] * window
            spectrum     = np.fft.rfft(frame)
            magnitude    = np.abs(spectrum)
            phase        = np.angle(spectrum)
            magnitude_db = 20.0 * np.log10(magnitude + eps)
            frame_power  = magnitude ** 2

            is_voiced = (voiced_frame_indices is None) or (i in voiced_frame_indices)

            # ----------------------------------------------------------
            # PATH 1: within-frame detection
            # ----------------------------------------------------------
            smoothed_env = self._compute_smoothed_envelope(magnitude_db)
            gr_within    = self._compute_gain_reduction(
                magnitude_db, smoothed_env,
                self.params["selectivity"],
                self.active_bins,
            )

            # ----------------------------------------------------------
            # PATH 2: long-term sibilant reference detection
            #
            # Detection runs BEFORE the reference update so the current
            # frame's reduction signal can gate the EMA update. Sibilant
            # frames that fire PATH 2 are excluded from the reference —
            # allowing them in would pull the reference upward and mask
            # subsequent detections.
            # ----------------------------------------------------------
            gr_sibilant = np.zeros(self.n_bins)

            if (self.long_term_power is not None and
                    self.long_term_frame_count >= SIBILANT_WARMUP_FRAMES):
                long_term_db = 10.0 * np.log10(self.long_term_power + eps)
                gr_sibilant  = self._compute_gain_reduction(
                    magnitude_db, long_term_db,
                    self.params["sibilant_selectivity"],
                    self.sibilant_band_mask,
                )

            # Update reference EMA: voiced frames only, and only when PATH 2
            # has not detected a sibilant event this frame (after warmup).
            is_sibilant_frame = (
                self.long_term_frame_count >= SIBILANT_WARMUP_FRAMES and
                np.max(gr_sibilant) > SIBILANT_UPDATE_GATE_DB
            )
            if is_voiced and not is_sibilant_frame:
                if self.long_term_power is None:
                    self.long_term_power = frame_power.copy()
                else:
                    self.long_term_power = (
                        self.long_term_alpha       * self.long_term_power +
                        (1.0 - self.long_term_alpha) * frame_power
                    )
                self.long_term_frame_count += 1

            # ----------------------------------------------------------
            # Combine: take the larger reduction from either path
            # ----------------------------------------------------------
            target_gr = np.maximum(gr_within, gr_sibilant)

            # VAD gating: silence frames get zero target, IIR decays naturally
            if not is_voiced:
                target_gr = np.zeros(self.n_bins)

            # --- Attack/release IIR ---
            increasing  = target_gr >= smoothed_gr
            coeff       = np.where(increasing, self.attack_coeff, self.release_coeff)
            smoothed_gr = coeff * smoothed_gr + (1.0 - coeff) * target_gr

            if i % 100 == 0:
                logger.info(
                    f"Frame {i:04d} | voiced={is_voiced} | "
                    f"lt_frames={self.long_term_frame_count} | "
                    f"max_within={np.max(gr_within):.1f}dB | "
                    f"max_sibilant={np.max(gr_sibilant):.1f}dB | "
                    f"max_smoothed_gr={np.max(smoothed_gr):.1f}dB"
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
                spike_frames        += 1

            # --- Apply gain reduction and ISTFT ---
            gain_linear       = 10.0 ** (-smoothed_gr / 20.0)
            modified_spectrum = magnitude * gain_linear * np.exp(1j * phase)
            time_frame        = np.fft.irfft(modified_spectrum, n=n_fft) * window

            frame_end = min(end, n_padded)
            trim      = frame_end - start
            output_buffer[start:frame_end]      += time_frame[:trim]
            window_accumulator[start:frame_end] += window_squared[:trim]

        # OLA normalization
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
                20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400,
                500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000,
                6300, 8000, 10000, 12500, 16000, 20000,
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
                    band_info = {
                        "center": center,
                        "mean_reduction_db": round(mean_red, 2),
                        "peak_reduction_db": round(max_red, 2),
                    }
                    if self.f0 and self.f0 > 0:
                        band_freqs = self.freqs[mask]
                        band_reds  = bin_max_reduction[mask]
                        peak_freq  = band_freqs[np.argmax(band_reds)]
                        h = int(round(peak_freq / self.f0))
                        if 0 < h <= 20 and abs(peak_freq - h * self.f0) / (h * self.f0) <= 0.03:
                            band_info["harmonic"]    = f"H{h}={int(round(self.f0))} Hz"
                            band_info["is_harmonic"] = True
                        else:
                            band_info["is_harmonic"] = False
                    band_summary.append(band_info)

            if band_summary:
                logger.info("Band gain reduction summary (1/3-octave, voiced frames only):")
                for b in band_summary:
                    c      = b["center"]
                    mean_r = b["mean_reduction_db"]
                    peak_r = b["peak_reduction_db"]
                    bars   = "#" * min(20, int(round(peak_r / 0.5)))
                    harm   = f"  [!] harmonic ({b['harmonic']})" if b.get("is_harmonic") else ""
                    logger.info(
                        f"{c:6.0f} Hz: Mean {-mean_r:5.2f} dB | Peak {-peak_r:5.2f} dB  {bars}{harm}"
                    )

        logger.info(
            f"ResonanceSuppressor: max_reduction={max_reduction:.2f} dB | "
            f"mean_reduction={mean_reduction:.2f} dB | "
            f"spike_frames={spike_frames}/{n_frames} | "
            f"artifact_risk={artifact_risk} | "
            f"lt_voiced_frames={self.long_term_frame_count}"
        )

        return {
            "audio": output_audio,
            "max_reduction_db": max_reduction,
            "mean_reduction_db": mean_reduction,
            "spike_frames": spike_frames,
            "artifact_risk": artifact_risk,
            "band_summary": band_summary,
        }


# ---------------------------------------------------------------------------
# Pipeline integration helper
# ---------------------------------------------------------------------------

def apply_resonance_suppression(
    audio: np.ndarray,
    sample_rate: int,
    preset: str,
    vad_voiced_mask: np.ndarray = None,
    f0: float = None,
) -> dict:
    """
    Pipeline integration entry point for Stage 3b.

    Args:
        audio:           Mono float32 audio at sample_rate.
        sample_rate:     Sample rate (should be 44100 in the Instant Polish pipeline).
        preset:          One of: acx_audiobook, podcast_ready, voice_ready, general_clean.
        vad_voiced_mask: Optional boolean array (same length as audio), True = voiced.
        f0:              Fundamental frequency of the voice (Hz), for harmonic annotation.

    Returns:
        dict: audio, max_reduction_db, mean_reduction_db, spike_frames,
              artifact_risk, band_summary, skipped
    """
    if preset == "noise_eraser":
        logger.info("ResonanceSuppressor: skipping for noise_eraser preset.")
        return {
            "audio": audio, "skipped": True, "max_reduction_db": 0.0,
            "mean_reduction_db": 0.0, "spike_frames": 0,
            "artifact_risk": False, "band_summary": [],
        }

    suppressor = ResonanceSuppressor(sample_rate=sample_rate, preset=preset, f0=f0)

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


# ---------------------------------------------------------------------------
# Processing report integration
# ---------------------------------------------------------------------------

def resonance_suppressor_report_entry(result: dict) -> dict:
    """
    Format the suppressor result for inclusion in the Stage 7 processing report JSON.

    Usage:
        report["processing_applied"]["resonance_suppressor"] = \
            resonance_suppressor_report_entry(result)
    """
    if result.get("skipped"):
        return {"applied": False}
    return {
        "applied": True,
        "max_reduction_db":  round(result["max_reduction_db"],  1),
        "mean_reduction_db": round(result["mean_reduction_db"], 1),
        "spike_frames":      result["spike_frames"],
        "artifact_risk":     result["artifact_risk"],
        "band_summary":      result.get("band_summary", []),
    }


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    import argparse
    import json
    import sys
    from scipy.io import wavfile

    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format='%(message)s')

    parser = argparse.ArgumentParser(
        description='Dynamic resonance suppressor for voice audio (Stage 3b)'
    )
    parser.add_argument('--input',         required=True,
                        help='Input WAV path (32-bit float, 44.1 kHz)')
    parser.add_argument('--output',        required=True,
                        help='Output WAV path (32-bit float, 44.1 kHz)')
    parser.add_argument('--preset',        default='acx_audiobook',
                        help='Preset ID: acx_audiobook | podcast_ready | voice_ready | general_clean')
    parser.add_argument('--vad-mask-json', default=None,
                        help='Path to JSON file with VAD frame metadata '
                             '(array of {isSilence, offsetSamples, lengthSamples, rmsDbfs})')
    parser.add_argument('--f0', type=float, default=None,
                        help='Fundamental frequency of the voice (Hz), for harmonic annotation')
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    audio = audio.astype(np.float32)

    vad_voiced_mask = None
    if args.vad_mask_json:
        with open(args.vad_mask_json, 'r') as fh:
            frame_list = json.load(fh)
        total = len(audio)
        vad_voiced_mask = np.zeros(total, dtype=bool)
        for frame in frame_list:
            if not frame['isSilence']:
                s = frame['offsetSamples']
                e = s + frame['lengthSamples']
                vad_voiced_mask[s:min(e, total)] = True

    result = apply_resonance_suppression(audio, sr, args.preset, vad_voiced_mask, args.f0)
    wavfile.write(args.output, sr, result['audio'].astype(np.float32))
    report = resonance_suppressor_report_entry(result)
    print('JSON_RESULT:' + json.dumps(report), flush=True)