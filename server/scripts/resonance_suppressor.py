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
        "depth": 0.5,          # Global reduction scale (0.0–1.0).
        "sharpness": 0.4,      # Smoothing window relative width (0.0–1.0). 0.0 = ultra-broad, targets sibilance.
        "selectivity": 4.0,    # Spike threshold in dB above smoothed floor. Lower = more sensitive.
        "attack_ms": 15.0,     # Gain reduction onset speed.
        "release_ms": 50.0,    # Gain reduction recovery speed.
        "max_reduction_db": 12.0,  # Hard ceiling on any single notch. Conservative for ACX.
        "freq_floor_hz": 800.0,    # Don't process below this (Avoid cutting lower vocal harmonics).
        "freq_ceil_hz": 16000.0,  # Don't process above this.
        "mode": "soft",           # "soft" = gradual knee; "hard" = more aggressive curve.
    },
    "podcast_ready": {
        "depth": 0.85,
        "sharpness": 0.0,
        "selectivity": 1.5,
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
        "attack_ms": 8.0,
        "release_ms": 50.0,
        "max_reduction_db": 12.0,
        "freq_floor_hz": 3000.0,
        "freq_ceil_hz": 12000.0,
        "mode": "soft",
    },
}


# ---------------------------------------------------------------------------
# Core algorithm
# ---------------------------------------------------------------------------

class ResonanceSuppressor:
    """
    Dynamic resonance suppressor using STFT-based spectral spike detection.

    For each frame:
      1. Compute magnitude spectrum via STFT.
      2. Compute a spectrally-smoothed version of the magnitude (the "expected" envelope).
      3. Find bins where actual magnitude exceeds smoothed by more than `selectivity` dB.
      4. Compute per-bin gain reduction proportional to spike depth * `depth` scale.
      5. Smooth gain reduction in time (attack/release envelope).
      6. Apply reduction to complex STFT bins (magnitude only; phase preserved).
      7. Reconstruct via ISTFT with overlap-add.
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

        # Load preset defaults, then apply any overrides
        params = PRESET_DEFAULTS.get(preset, PRESET_DEFAULTS["acx_audiobook"]).copy()
        params.update(override_params)
        self.params = params

        # Frequency bin mask — only process bins within [freq_floor, freq_ceil]
        freqs = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)
        self.active_bins = (freqs >= params["freq_floor_hz"]) & (freqs <= params["freq_ceil_hz"])
        self.n_bins = len(freqs)

        # Smoothing window width in bins (derived from sharpness)
        # sharpness=0.0 → very wide context window (catches only very broad peaks)
        # sharpness=1.0 → very narrow context window (catches tight resonant spikes)
        # Soothe behavior: higher sharpness → narrower smoothing → sharper notches
        # For broad sibilance detection, max_window must be very large (>3000 Hz)
        min_window = 5    # bins — minimum meaningful context
        max_window = 300  # bins — very broad spectral context (~6.4 kHz)
        sharpness = params["sharpness"]

        # Exponential scaling so high sharpness remains narrow, while low sharpness
        # opens up extremely broadly (needed for sibilance/de-essing).
        self.smooth_window_bins = max(
            min_window,
            int(max_window * ((1.0 - sharpness) ** 2)),
        )

        # Attack/release time constants as frame-domain coefficients
        # Convert ms → per-frame coefficient using hop_length/sample_rate as frame period
        frame_period_ms = (hop_length / sample_rate) * 1000.0
        self.attack_coeff = self._time_to_coeff(params["attack_ms"], frame_period_ms)
        self.release_coeff = self._time_to_coeff(params["release_ms"], frame_period_ms)

        logger.info(
            f"ResonanceSuppressor init | preset={preset} | "
            f"n_fft={n_fft} | hop={hop_length} | "
            f"smooth_window={self.smooth_window_bins} bins | "
            f"selectivity={params['selectivity']} dB | "
            f"depth={params['depth']} | max_cut={params['max_reduction_db']} dB"
        )

    @staticmethod
    def _time_to_coeff(time_ms: float, frame_period_ms: float) -> float:
        """Convert a time constant in ms to a per-frame IIR smoothing coefficient."""
        if time_ms <= 0 or frame_period_ms <= 0:
            return 1.0
        return np.exp(-frame_period_ms / time_ms)

    def _compute_smoothed_envelope(self, magnitude_db: np.ndarray) -> np.ndarray:
        """
        Compute the spectrally-smoothed reference envelope for one frame.
        Uses a uniform moving average across frequency bins.
        The smoothed envelope represents the 'expected' spectral shape
        without sharp resonant peaks.

        Args:
            magnitude_db: 1D array of magnitude in dB for all freq bins, shape (n_bins,)

        Returns:
            smoothed: 1D array of smoothed magnitude in dB, shape (n_bins,)
        """
        # Convert dB to linear power domain before averaging.
        # Averaging directly in the log (dB) domain causes deep valleys between voice
        # harmonics to disproportionately pull down the smoothed envelope. This results
        # in natural voice harmonics registering as massive spikes (e.g. 30dB+), which
        # causes the algorithm to aggressively attenuate them, reducing overall volume
        # and creating comb-filtering artifacts.
        power = 10.0 ** (magnitude_db / 10.0)

        # uniform_filter1d applies a causal average across the frequency axis.
        # mode='reflect' handles edges cleanly without zero-padding artifacts.
        smoothed_power = uniform_filter1d(
            power,
            size=self.smooth_window_bins,
            mode="reflect",
        )

        # Convert back to dB domain
        return 10.0 * np.log10(smoothed_power + 1e-10)

    def _compute_gain_reduction(
        self,
        magnitude_db: np.ndarray,
        smoothed_db: np.ndarray,
    ) -> np.ndarray:
        """
        Compute per-bin gain reduction in dB for one frame.

        Bins where actual > smoothed + selectivity_threshold are identified as spikes.
        Reduction = (spike_amount - threshold) * depth_scale, clipped to max_reduction.

        Args:
            magnitude_db: actual magnitude (dB), shape (n_bins,)
            smoothed_db:  smoothed envelope (dB), shape (n_bins,)

        Returns:
            reduction_db: gain reduction to apply (positive = cut), shape (n_bins,)
        """
        p = self.params
        selectivity_db = p["selectivity"]
        depth = p["depth"]
        max_reduction = p["max_reduction_db"]
        mode = p["mode"]

        spike_db = magnitude_db - smoothed_db  # positive where peaks stick out

        # Only process active frequency range
        spike_db_masked = np.where(self.active_bins, spike_db, 0.0)

        # Amount above the selectivity threshold
        above_threshold = np.maximum(0.0, spike_db_masked - selectivity_db)

        if mode == "soft":
            # Soft knee: smooth onset using a quadratic curve below 2x threshold
            knee_width = selectivity_db * 0.5
            in_knee = above_threshold < knee_width
            soft_curve = np.where(
                in_knee,
                above_threshold ** 2 / (2.0 * max(knee_width, 1e-6)),
                above_threshold,
            )
            raw_reduction = soft_curve * depth
        else:
            # Hard mode: linear reduction above threshold
            raw_reduction = above_threshold * depth

        # Clip to hard ceiling
        reduction_db = np.clip(raw_reduction, 0.0, max_reduction)
        return reduction_db

    def process(self, audio: np.ndarray, voiced_frame_indices=None) -> dict:
        """
        Apply dynamic resonance suppression to a mono audio array.

        Processes one STFT frame at a time (streaming) to keep memory proportional
        to the audio length plus one FFT window — not to n_frames × n_bins. This
        avoids multi-GB intermediate matrix allocations for long files.

        VAD gating is applied at the STFT frame level: frames whose index is not in
        voiced_frame_indices receive target_gr=0, letting the attack/release IIR
        decay smoothed_gr naturally. This prevents hard per-sample splicing, which
        causes discontinuities at overlap-add boundaries.

        Args:
            audio: 1D float32 numpy array at self.sr sample rate.
            voiced_frame_indices: set of int STFT frame indices where voice is
                present. Frames outside this set are gated (target_gr=0).
                None means all frames are processed (no VAD gating).

        Returns:
            dict with keys:
              'audio'            : processed audio (float32 ndarray, same length as input)
              'max_reduction_db' : peak gain reduction at any bin across all frames (dB)
              'mean_reduction_db': mean reduction over bins with > 0.01 dB reduction
              'spike_frames'     : frames where any bin exceeded 0.01 dB reduction
              'artifact_risk'    : True when mean_reduction_db > 3 dB
        """
        if audio.ndim != 1:
            raise ValueError("ResonanceSuppressor expects mono input (1D array).")

        n_fft = self.n_fft
        hop = self.hop_length
        window = get_window("hann", n_fft, fftbins=True)
        window_squared = window ** 2

        pad = n_fft // 2
        audio_padded = np.pad(audio, pad, mode="reflect")
        n_padded = len(audio_padded)

        n_frames = max(0, (n_padded - n_fft) // hop + 1)

        if n_frames == 0:
            logger.warning("ResonanceSuppressor: audio too short, returning unmodified.")
            return {
                "audio": audio,
                "max_reduction_db": 0.0,
                "mean_reduction_db": 0.0,
                "spike_frames": 0,
                "artifact_risk": False,
            }

        # Output buffers scale with audio length, not n_frames × n_bins
        output_buffer      = np.zeros(n_padded, dtype=np.float64)
        window_accumulator = np.zeros(n_padded, dtype=np.float64)

        # Per-bin attack/release state (the only O(n_bins) persistent allocation)
        smoothed_gr = np.zeros(self.n_bins)

        # Telemetry accumulators
        max_reduction       = 0.0
        sum_reduction       = 0.0
        n_active_bins_total = 0
        spike_frames        = 0
        active_threshold    = 0.01  # dB — consistent floor for mean and spike counting

        bin_sum_reduction   = np.zeros(self.n_bins)
        bin_max_reduction   = np.zeros(self.n_bins)
        voiced_frame_count  = 0

        eps = 1e-10

        for i in range(n_frames):
            start = i * hop
            end   = start + n_fft

            # --- FFT ---
            frame       = audio_padded[start:end] * window
            spectrum    = np.fft.rfft(frame)
            magnitude   = np.abs(spectrum)
            phase       = np.angle(spectrum)
            magnitude_db = 20.0 * np.log10(magnitude + eps)

            # --- Resonance detection ---
            smoothed_env = self._compute_smoothed_envelope(magnitude_db)
            target_gr    = self._compute_gain_reduction(magnitude_db, smoothed_env)

            # VAD gating at STFT-frame level: silence frames receive no gain
            # reduction target. The IIR below decays smoothed_gr toward 0,
            # providing smooth gain recovery without hard per-sample splicing.
            is_voiced = True
            if voiced_frame_indices is not None and i not in voiced_frame_indices:
                target_gr = np.zeros(self.n_bins)
                is_voiced = False

            # --- Attack/release IIR ---
            increasing  = target_gr >= smoothed_gr
            coeff       = np.where(increasing, self.attack_coeff, self.release_coeff)
            smoothed_gr = coeff * smoothed_gr + (1.0 - coeff) * target_gr

            if i % 100 == 0:
                logger.info(
                    f"Frame {i:04d} | voiced={is_voiced} | max_mag={np.max(magnitude_db):.1f}dB | "
                    f"max_target_gr={np.max(target_gr):.1f}dB | max_smoothed_gr={np.max(smoothed_gr):.1f}dB | "
                    f"bins_active={(smoothed_gr > 0.1).sum()}"
                )

            # --- Per-frame telemetry ---
            if is_voiced:
                bin_sum_reduction += smoothed_gr
                bin_max_reduction = np.maximum(bin_max_reduction, smoothed_gr)
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
            gain_linear      = 10.0 ** (-smoothed_gr / 20.0)
            modified_spectrum = magnitude * gain_linear * np.exp(1j * phase)
            time_frame        = np.fft.irfft(modified_spectrum, n=n_fft) * window

            frame_end = min(end, n_padded)
            trim      = frame_end - start
            output_buffer[start:frame_end]      += time_frame[:trim]
            window_accumulator[start:frame_end] += window_squared[:trim]

        # OLA normalization
        safe_acc = np.where(window_accumulator > 1e-8, window_accumulator, 1.0)
        output_buffer /= safe_acc

        output_audio = output_buffer[pad : pad + len(audio)].astype(np.float32)

        mean_reduction = (sum_reduction / n_active_bins_total) if n_active_bins_total > 0 else 0.0
        artifact_risk  = mean_reduction > 3.0

        # --- Band summary ---
        band_summary = []
        if voiced_frame_count > 0:
            bin_mean_reduction = bin_sum_reduction / voiced_frame_count
            BAND_CENTERS = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000]
            freqs = np.fft.rfftfreq(n_fft, d=1.0 / self.sr)

            for center in BAND_CENTERS:
                low = center / (2.0 ** (1.0/6.0))
                high = center * (2.0 ** (1.0/6.0))
                mask = (freqs >= low) & (freqs < high)
                if not mask.any():
                    continue

                # Report both mean and max gain reduction achieved anywhere in this band
                mean_red = float(np.mean(bin_mean_reduction[mask]))
                max_red = float(np.max(bin_max_reduction[mask]))

                if max_red > 0.05:  # skip bands with virtually zero reduction
                    band_info = {"center": center, "mean_reduction_db": round(mean_red, 2), "peak_reduction_db": round(max_red, 2)}

                    if self.f0 and self.f0 > 0:
                        band_freqs = freqs[mask]
                        band_reds = bin_max_reduction[mask]
                        peak_freq = band_freqs[np.argmax(band_reds)]

                        h = int(round(peak_freq / self.f0))
                        # Limit to the first 20 harmonics to avoid dense high-frequency
                        # false positives matching against sibilance noise
                        if 0 < h <= 20 and abs(peak_freq - h * self.f0) / (h * self.f0) <= 0.03:
                            band_info["harmonic"] = f"H{h}={int(round(self.f0))} Hz"
                            band_info["is_harmonic"] = True
                        else:
                            band_info["is_harmonic"] = False

                    band_summary.append(band_info)

            if band_summary:
                logger.info("Band gain reduction summary (1/3-octave, voiced frames only):")
                for b in band_summary:
                    c = b["center"]
                    mean_r = b["mean_reduction_db"]
                    peak_r = b["peak_reduction_db"]
                    bars = "#" * min(20, int(round(peak_r / 0.5)))
                    harm_str = f"  [!] harmonic ({b['harmonic']})" if b.get("is_harmonic") else ""
                    logger.info(f"{c:4.0f} Hz: Mean {-mean_r:5.2f} dB | Peak {-peak_r:5.2f} dB  {bars}{harm_str}")

        logger.info(
            f"ResonanceSuppressor: max_reduction={max_reduction:.2f} dB | "
            f"mean_reduction={mean_reduction:.2f} dB | "
            f"spike_frames={spike_frames}/{n_frames} | "
            f"artifact_risk={artifact_risk}"
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

    If a VAD voiced_mask is provided (same shape as audio, boolean), processing
    is applied only to voiced frames. Silence frames pass through unmodified.
    This prevents the suppressor from processing noise-floor-only segments,
    which would introduce artifacts.

    Args:
        audio:           Mono float32 audio at sample_rate.
        sample_rate:     Sample rate (should be 44100 in the Instant Polish pipeline).
        preset:          One of: acx_audiobook, podcast_ready, voice_ready, general_clean.
        vad_voiced_mask: Optional boolean array, True where voice is present.

    Returns:
        dict: same structure as ResonanceSuppressor.process(), plus 'skipped' bool.
    """
    # Skip for noise_eraser — caller should enforce this, but guard here too
    if preset == "noise_eraser":
        logger.info("ResonanceSuppressor: skipping for noise_eraser preset.")
        return {"audio": audio, "skipped": True, "max_reduction_db": 0.0,
                "mean_reduction_db": 0.0, "spike_frames": 0, "artifact_risk": False, "band_summary": []}

    suppressor = ResonanceSuppressor(sample_rate=sample_rate, preset=preset, f0=f0)

    voiced_frame_indices = None
    if vad_voiced_mask is not None and len(vad_voiced_mask) == len(audio):
        # Convert per-sample VAD mask to a set of STFT frame indices.
        # Frame i is "voiced" when any sample in its analysis window overlaps
        # with voiced audio. Gating at the STFT frame level (not per-sample)
        # avoids discontinuities at voiced/silence boundaries — the attack/release
        # IIR in process() decays gain reduction smoothly toward zero on silence
        # frames instead of hard-splicing original samples post-OLA.
        pad           = suppressor.n_fft // 2
        n_padded      = len(audio) + 2 * pad
        n_stft_frames = max(0, (n_padded - suppressor.n_fft) // suppressor.hop_length + 1)
        voiced_frame_indices = set()
        for fi in range(n_stft_frames):
            orig_start = max(0, fi * suppressor.hop_length - pad)
            orig_end   = min(len(audio), fi * suppressor.hop_length - pad + suppressor.n_fft)
            if orig_start < orig_end and vad_voiced_mask[orig_start:orig_end].any():
                voiced_frame_indices.add(fi)

    result = suppressor.process(audio, voiced_frame_indices=voiced_frame_indices)
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
        "max_reduction_db": round(result["max_reduction_db"], 1),
        "mean_reduction_db": round(result["mean_reduction_db"], 1),
        "spike_frames": result["spike_frames"],
        "artifact_risk": result["artifact_risk"],
        "band_summary": result.get("band_summary", []),
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
                        help='Fundamental frequency of the voice (for harmonic false-positive detection)')
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
