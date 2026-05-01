"""
instant_polish_resonance_suppressor.py
Stage 3b — Dynamic Resonance Suppressor

Soothe2-inspired spectral spike detection and dynamic attenuation.
Operates on 32-bit float PCM at 44.1 kHz (Instant Polish internal format).

Scope: narrow resonant spike detection via within-frame mel-domain spectral
smoothing. Catches room modes, microphone resonances, and isolated harmonic
buildups anywhere in the active frequency range.

Sibilant detection and suppression is handled by a separate stage:
  instant_polish_sibilance_suppressor.py (Stage 4)

Dependencies: numpy, scipy
All processing is frame-based via STFT/ISTFT with overlap-add reconstruction.
"""

import time

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import get_window
from scipy.ndimage import uniform_filter1d, convolve1d
import logging

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Preset-calibrated default parameters
# ---------------------------------------------------------------------------

PRESET_DEFAULTS = {
    "acx_audiobook": {
        "depth": 0.5,           # Global reduction scale (0.0-1.0).
        "sharpness": 0.5,       # Attenuation curve shape.
                                # 0.0 = wide gentle cuts (broad energy build-ups).
                                # 1.0 = deep narrow notches (precise resonances).
        "selectivity": 2.0,     # Spike threshold in dB above smoothed floor.
                                # Higher = fewer cuts, only the most prominent spikes.
        "attack_ms": 15.0,      # Gain reduction onset speed.
        "release_ms": 80.0,     # Gain reduction recovery speed.
        "max_reduction_db": 9.0,# Hard ceiling on reduction at any bin. Conservative
                                # for ACX -- overprocessing artifacts cause rejection.
        "freq_floor_hz": 80.0,  # Don't process below this (HPF already handles sub-vocals).
        "freq_ceil_hz": 16000.0,# Don't process above this.
        "mode": "soft",         # "soft" = gradual knee; "hard" = linear above threshold.
    },
    "podcast_ready": {
        "depth": 0.65,
        "sharpness": 0.5,
        "selectivity": 1.5,
        "attack_ms": 8.0,
        "release_ms": 60.0,
        "max_reduction_db": 9.0,
        "freq_floor_hz": 80.0,
        "freq_ceil_hz": 16000.0,
        "mode": "soft",
    },
    "voice_ready": {
        "depth": 0.55,
        "sharpness": 0.5,
        "selectivity": 2.0,
        "attack_ms": 12.0,
        "release_ms": 70.0,
        "max_reduction_db": 7.0,
        "freq_floor_hz": 80.0,
        "freq_ceil_hz": 16000.0,
        "mode": "soft",
    },
    "general_clean": {
        "depth": 0.7,
        "sharpness": 0.4,
        "selectivity": 1.5,
        "attack_ms": 8.0,
        "release_ms": 50.0,
        "max_reduction_db": 12.0,
        "freq_floor_hz": 60.0,
        "freq_ceil_hz": 18000.0,
        "mode": "soft",
    },
}


# ---------------------------------------------------------------------------
# Core algorithm
# ---------------------------------------------------------------------------

class ResonanceSuppressor:
    """
    Within-frame dynamic resonance suppressor.

    For each STFT frame:
      1. Compute magnitude spectrum.
      2. Compute a mel-domain smoothed reference envelope from the current
         frame's own spectrum -- the expected spectral shape without sharp peaks.
      3. Flag bins where actual magnitude exceeds reference by more than
         `selectivity` dB.
      4. Compute per-bin gain reduction scaled by `depth`, shaped by `sharpness`.
      5. Smooth gain reduction in time via attack/release IIR.
      6. Apply gain reduction to STFT bins (magnitude only, phase preserved).
      7. Reconstruct via ISTFT with overlap-add.

    Detection reference:
      Mel-domain smoothing averages power across a frequency-proportional
      context window. At low frequencies the window is narrow in Hz, giving
      precise spike detection among tightly-packed harmonics. At high
      frequencies the window widens in Hz, providing appropriate context for
      sparser spectral content. All averaging is in the power domain to prevent
      the harmonic-valley bias that occurs when averaging in dB.

    Sharpness:
      Controls the shape of the applied attenuation, not the detection.
      Implemented as Gaussian spreading of the computed gain reduction array.
      Low sharpness -> wide kernel -> gentle broad cuts around detected peaks.
      High sharpness -> narrow kernel -> tight notches at detected bins only.

    Scope limitation:
      Within-frame smoothing cannot detect broad spectral elevations where the
      entire context window is elevated (e.g. sibilant plateaus). Those events
      are handled by the sibilance suppressor (Stage 4), which uses F0-derived
      detection and a long-term EMA reference.
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
        self.sr         = sample_rate
        self.n_fft      = n_fft
        self.hop_length = hop_length
        self.f0         = f0

        params = PRESET_DEFAULTS.get(preset, PRESET_DEFAULTS["acx_audiobook"]).copy()
        params.update(override_params)
        self.params = params

        self.freqs  = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)
        self.n_bins = len(self.freqs)

        self.active_bins = (
            (self.freqs >= params["freq_floor_hz"]) &
            (self.freqs <= params["freq_ceil_hz"])
        )

        # --- Mel-domain smoothing setup ---
        mel_of_freq = lambda f: 2595.0 * np.log10(1.0 + np.asarray(f, dtype=float) / 700.0)

        self.mel_freqs = mel_of_freq(np.maximum(self.freqs, 1.0))
        mel_min        = float(self.mel_freqs[1])
        mel_max        = float(self.mel_freqs[-1])
        self.mel_grid  = np.linspace(mel_min, mel_max, self.n_bins)

        mel_bin_width        = (mel_max - mel_min) / self.n_bins
        self.mel_window_bins = max(3, int(120.0 / mel_bin_width))

        # Precompute interpolation indices/weights for the two mel-mapping
        # passes (linear -> mel grid, mel grid -> linear). Replaces a per-frame
        # np.interp() pair with simple gather + lerp in vectorised form.
        self._fwd_left, self._fwd_right, self._fwd_frac = self._build_interp(
            self.mel_freqs, self.mel_grid,
        )
        self._inv_left, self._inv_right, self._inv_frac = self._build_interp(
            self.mel_grid, self.mel_freqs,
        )

        # --- Sharpness: Gaussian spreading kernel ---
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

        logger.info(
            f"ResonanceSuppressor init | preset={preset} | n_fft={n_fft} | "
            f"mel_window={self.mel_window_bins} bins | "
            f"selectivity={params['selectivity']} dB | depth={params['depth']} | "
            f"sharpness={sharpness} | max_cut={params['max_reduction_db']} dB"
        )

    @staticmethod
    def _time_to_coeff(time_ms: float, frame_period_ms: float) -> float:
        if time_ms <= 0 or frame_period_ms <= 0:
            return 1.0
        return np.exp(-frame_period_ms / time_ms)

    @staticmethod
    def _build_interp(xp: np.ndarray, x: np.ndarray):
        """
        Precompute (left_idx, right_idx, frac) so that
            np.interp(x, xp, fp) == fp[left_idx] * (1 - frac) + fp[right_idx] * frac
        for any monotonically increasing xp. Out-of-range x clamps to xp's
        endpoints (matches np.interp default).
        """
        n = len(xp)
        idx_right = np.searchsorted(xp, x, side="right")
        idx_right = np.clip(idx_right, 1, n - 1).astype(np.int64)
        idx_left  = idx_right - 1
        denom     = xp[idx_right] - xp[idx_left]
        frac      = np.where(denom > 0, (x - xp[idx_left]) / denom, 0.0)
        frac      = np.clip(frac, 0.0, 1.0).astype(np.float32)
        return idx_left, idx_right, frac

    def _smoothed_envelope_matrix(self, magnitude_db: np.ndarray) -> np.ndarray:
        """
        Mel-domain smoothed reference envelope for a batch of frames.

        Args:
            magnitude_db: (n_frames, n_bins) magnitude in dB.

        Returns:
            (n_frames, n_bins) smoothed reference in dB. Power-domain averaging
            prevents harmonic-valley bias.
        """
        power     = np.power(10.0, magnitude_db / 10.0, dtype=np.float32)
        # Forward map: linear-bin power -> mel-grid power via gather + lerp.
        one_minus_fwd = (1.0 - self._fwd_frac).astype(np.float32, copy=False)
        mel_power = (
            power[:, self._fwd_left]  * one_minus_fwd
            + power[:, self._fwd_right] * self._fwd_frac
        )
        mel_smoothed = uniform_filter1d(
            mel_power, size=self.mel_window_bins, mode="reflect", axis=1,
        )
        # Reverse map: mel-grid -> linear bins.
        one_minus_inv = (1.0 - self._inv_frac).astype(np.float32, copy=False)
        pass1_power = (
            mel_smoothed[:, self._inv_left]  * one_minus_inv
            + mel_smoothed[:, self._inv_right] * self._inv_frac
        )
        return 10.0 * np.log10(pass1_power + 1e-10)

    def _compute_gain_reduction_matrix(
        self,
        magnitude_db: np.ndarray,
        smoothed_db:  np.ndarray,
    ) -> np.ndarray:
        """Batched gain-reduction. Inputs/output shape (n_frames, n_bins)."""
        p             = self.params
        selectivity   = p["selectivity"]
        depth         = p["depth"]
        max_reduction = p["max_reduction_db"]

        spike_db        = magnitude_db - smoothed_db
        spike_db_masked = np.where(self.active_bins, spike_db, 0.0)
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

        # Spread kernel applied along the bin axis for every frame at once.
        # Matches np.convolve(reduction_db, kernel, mode='same') per frame.
        if self.spread_kernel is not None:
            reduction_db = convolve1d(
                reduction_db, self.spread_kernel,
                axis=1, mode="constant", cval=0.0,
            )
            reduction_db = np.clip(reduction_db, 0.0, max_reduction)

        return reduction_db

    def process(self, audio: np.ndarray, voiced_frame_indices=None) -> dict:
        """
        Apply resonance suppression to a mono audio array.

        Args:
            audio: 1D float32 array at self.sr.
            voiced_frame_indices: set of STFT frame indices where voice is present.
                Silence frames receive target_gr=0; IIR decays smoothly.
                None = process all frames.

        Returns:
            dict: audio, max_reduction_db, mean_reduction_db, spike_frames,
                  artifact_risk, band_summary
        """
        if audio.ndim != 1:
            raise ValueError("ResonanceSuppressor expects mono input (1D array).")

        n_fft          = self.n_fft
        hop            = self.hop_length
        window         = self._window
        window_squared = self._window_squared

        pad          = n_fft // 2
        audio_padded = np.pad(audio, pad, mode="reflect")
        n_padded     = len(audio_padded)
        n_frames     = max(0, (n_padded - n_fft) // hop + 1)

        if n_frames == 0:
            logger.warning("ResonanceSuppressor: audio too short, returning unmodified.")
            return {
                "audio": audio, "max_reduction_db": 0.0, "mean_reduction_db": 0.0,
                "spike_frames": 0, "artifact_risk": False, "band_summary": [],
            }

        # Float32 for the audio buffer keeps the spectral arrays float32 too.
        if audio_padded.dtype != np.float32:
            audio_padded = audio_padded.astype(np.float32, copy=False)

        output_buffer      = np.zeros(n_padded, dtype=np.float64)
        window_accumulator = np.zeros(n_padded, dtype=np.float64)

        max_reduction       = 0.0
        sum_reduction       = 0.0
        n_active_bins_total = 0
        spike_frames        = 0
        active_threshold    = 0.01

        bin_sum_reduction  = np.zeros(self.n_bins, dtype=np.float64)
        bin_max_reduction  = np.zeros(self.n_bins, dtype=np.float64)
        eps                = 1e-10

        # Precompute boolean voiced mask once -- avoids per-frame set lookup.
        if voiced_frame_indices is None:
            voiced_mask = np.ones(n_frames, dtype=bool)
        else:
            voiced_mask = np.zeros(n_frames, dtype=bool)
            for fi in voiced_frame_indices:
                if 0 <= fi < n_frames:
                    voiced_mask[fi] = True

        # IIR state (carries across chunks so the attack/release behaviour is
        # identical to the per-frame implementation).
        prev_smoothed_gr = np.zeros(self.n_bins, dtype=np.float32)
        attack_coeff     = np.float32(self.attack_coeff)
        release_coeff    = np.float32(self.release_coeff)

        # Chunk size keeps per-chunk peak memory bounded for long files.
        # 2048 frames ≈ 24 s at 44.1 kHz / hop=512.
        CHUNK_FRAMES = 2048

        for chunk_start in range(0, n_frames, CHUNK_FRAMES):
            chunk_end   = min(chunk_start + CHUNK_FRAMES, n_frames)
            chunk_n     = chunk_end - chunk_start
            audio_start = chunk_start * hop
            audio_stop  = (chunk_end - 1) * hop + n_fft  # exclusive

            # Batched framing: sliding_window_view + stride hop produces a
            # (chunk_n, n_fft) view with no copy. The window multiply is the
            # only allocation here.
            chunk_audio = audio_padded[audio_start:audio_stop]
            frame_view  = sliding_window_view(chunk_audio, n_fft)[::hop][:chunk_n]
            frames      = frame_view * window  # (chunk_n, n_fft) float32

            # Batched STFT.
            spectra      = np.fft.rfft(frames, axis=1).astype(np.complex64, copy=False)
            magnitude    = np.abs(spectra)                         # (chunk_n, n_bins) float32
            magnitude_db = 20.0 * np.log10(magnitude + eps)

            # Reference envelope + gain reduction in matrix form.
            smoothed_db = self._smoothed_envelope_matrix(magnitude_db)
            target_gr   = self._compute_gain_reduction_matrix(magnitude_db, smoothed_db)
            target_gr   = target_gr.astype(np.float32, copy=False)

            # Zero out non-voiced frames so the IIR releases through silence
            # rather than holding gain reduction over it.
            chunk_voiced = voiced_mask[chunk_start:chunk_end]
            if not chunk_voiced.all():
                target_gr[~chunk_voiced, :] = 0.0

            # Attack/release IIR -- vectorised across bins, serial across
            # frames. The per-frame body is two numpy ops over n_bins; the
            # Python overhead at chunk_n=2048 is negligible.
            smoothed_gr_matrix = np.empty_like(target_gr)
            prev = prev_smoothed_gr
            for j in range(chunk_n):
                tgt   = target_gr[j]
                coeff = np.where(tgt >= prev, attack_coeff, release_coeff)
                prev  = coeff * prev + (np.float32(1.0) - coeff) * tgt
                smoothed_gr_matrix[j] = prev
            prev_smoothed_gr = prev

            # Apply gain to spectra and inverse-FFT in one batch.
            gain_linear      = np.power(10.0, -smoothed_gr_matrix / 20.0, dtype=np.float32)
            modified_spectra = spectra * gain_linear
            time_frames      = np.fft.irfft(modified_spectra, n=n_fft, axis=1).astype(
                np.float64, copy=False
            )
            time_frames *= window  # broadcast

            # Overlap-add into the global buffer. The accumulation loop is
            # the only remaining per-frame loop and is just two slice-adds.
            for j in range(chunk_n):
                s   = (chunk_start + j) * hop
                e   = min(s + n_fft, n_padded)
                trim = e - s
                output_buffer[s:e]      += time_frames[j, :trim]
                window_accumulator[s:e] += window_squared[:trim]

            # Telemetry accumulation.
            chunk_max = float(smoothed_gr_matrix.max()) if smoothed_gr_matrix.size else 0.0
            if chunk_max > max_reduction:
                max_reduction = chunk_max

            chunk_active = smoothed_gr_matrix > active_threshold
            n_active = int(chunk_active.sum())
            if n_active > 0:
                sum_reduction       += float(smoothed_gr_matrix[chunk_active].sum())
                n_active_bins_total += n_active
                spike_frames        += int(chunk_active.any(axis=1).sum())

            if chunk_voiced.any():
                voiced_smoothed = smoothed_gr_matrix[chunk_voiced]
                bin_sum_reduction += voiced_smoothed.sum(axis=0, dtype=np.float64)
                bin_max_reduction  = np.maximum(
                    bin_max_reduction, voiced_smoothed.max(axis=0),
                )

        voiced_frame_count = int(voiced_mask.sum())

        safe_acc      = np.where(window_accumulator > 1e-8, window_accumulator, 1.0)
        output_buffer /= safe_acc
        output_audio   = output_buffer[pad : pad + len(audio)].astype(np.float32)

        mean_reduction = (sum_reduction / n_active_bins_total) if n_active_bins_total > 0 else 0.0
        artifact_risk  = mean_reduction > 3.0

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
                        peak_freq  = band_freqs[np.argmax(bin_max_reduction[mask])]
                        h          = int(round(peak_freq / self.f0))
                        if 0 < h <= 20 and abs(peak_freq - h * self.f0) / (h * self.f0) <= 0.03:
                            band_info["harmonic"]    = f"H{h}={int(round(self.f0))} Hz"
                            band_info["is_harmonic"] = True
                        else:
                            band_info["is_harmonic"] = False
                    band_summary.append(band_info)

            if band_summary:
                logger.info("ResonanceSuppressor band summary (1/3-oct, voiced frames):")
                for b in band_summary:
                    bars = "#" * min(20, int(round(b["peak_reduction_db"] / 0.5)))
                    harm = f"  [harmonic: {b['harmonic']}]" if b.get("is_harmonic") else ""
                    logger.info(
                        f"  {b['center']:6.0f} Hz: "
                        f"mean {-b['mean_reduction_db']:5.2f} dB | "
                        f"peak {-b['peak_reduction_db']:5.2f} dB  {bars}{harm}"
                    )

        logger.info(
            f"ResonanceSuppressor: max={max_reduction:.2f} dB | "
            f"mean={mean_reduction:.2f} dB | "
            f"spike_frames={spike_frames}/{n_frames} | artifact_risk={artifact_risk}"
        )

        return {
            "audio":             output_audio,
            "max_reduction_db":  max_reduction,
            "mean_reduction_db": mean_reduction,
            "spike_frames":      spike_frames,
            "artifact_risk":     artifact_risk,
            "band_summary":      band_summary,
        }


# ---------------------------------------------------------------------------
# Pipeline integration
# ---------------------------------------------------------------------------

def apply_resonance_suppression(
    audio: np.ndarray,
    sample_rate: int,
    preset: str,
    vad_voiced_mask: np.ndarray = None,
    f0: float = None,
) -> dict:
    """Stage 3b pipeline entry point."""
    if preset == "noise_eraser":
        logger.info("ResonanceSuppressor: skipping for noise_eraser preset.")
        return {
            "audio": audio, "skipped": True, "max_reduction_db": 0.0,
            "mean_reduction_db": 0.0, "spike_frames": 0,
            "artifact_risk": False, "band_summary": [],
            "process_seconds": 0.0,
        }

    t0 = time.perf_counter()

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

    result                    = suppressor.process(audio, voiced_frame_indices=voiced_frame_indices)
    result["skipped"]         = False
    result["process_seconds"] = time.perf_counter() - t0
    return result


def resonance_suppressor_report_entry(result: dict) -> dict:
    """Format result for the Stage 7 processing report JSON."""
    if result.get("skipped"):
        return {"applied": False, "process_seconds": round(result.get("process_seconds", 0.0), 3)}
    return {
        "applied":           True,
        "max_reduction_db":  round(result["max_reduction_db"],  1),
        "mean_reduction_db": round(result["mean_reduction_db"], 1),
        "spike_frames":      result["spike_frames"],
        "artifact_risk":     result["artifact_risk"],
        "band_summary":      result.get("band_summary", []),
        "process_seconds":   round(result.get("process_seconds", 0.0), 3),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse, json, sys
    from scipy.io import wavfile

    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    parser = argparse.ArgumentParser(description="Stage 3b -- Resonance Suppressor")
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

    result = apply_resonance_suppression(audio, sr, args.preset, vad_voiced_mask, args.f0)
    wavfile.write(args.output, sr, result["audio"])
    print("JSON_RESULT:" + json.dumps(resonance_suppressor_report_entry(result)), flush=True)
