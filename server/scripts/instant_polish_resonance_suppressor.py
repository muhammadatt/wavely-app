"""
instant_polish_resonance_suppressor.py
Stage 3b — Dynamic Resonance Suppressor

Soothe2-inspired spectral spike detection and dynamic attenuation.
Operates on 32-bit float PCM at 44.1 kHz (Instant Polish internal format).

Dependencies: numpy, scipy, soundfile (for standalone testing)
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
        "depth": 0.5,          # Global reduction scale (0.0–1.0). Conservative for ACX.
        "sharpness": 0.4,      # Smoothing window relative width (0.0–1.0). Lower = broader context.
        "selectivity": 4.0,    # Spike threshold in dB above smoothed floor. Higher = fewer cuts.
        "attack_ms": 15.0,     # Gain reduction onset speed.
        "release_ms": 80.0,    # Gain reduction recovery speed.
        "max_reduction_db": 6.0,  # Hard ceiling on any single notch. Conservative for ACX.
        "freq_floor_hz": 80.0,    # Don't process below this (HPF already handled sub-vocals).
        "freq_ceil_hz": 16000.0,  # Don't process above this.
        "mode": "soft",           # "soft" = gradual knee; "hard" = more aggressive curve.
    },
    "podcast_ready": {
        "depth": 0.65,
        "sharpness": 0.5,
        "selectivity": 3.0,
        "attack_ms": 8.0,
        "release_ms": 60.0,
        "max_reduction_db": 9.0,
        "freq_floor_hz": 80.0,
        "freq_ceil_hz": 16000.0,
        "mode": "soft",
    },
    "voice_ready": {
        "depth": 0.55,
        "sharpness": 0.45,
        "selectivity": 3.5,
        "attack_ms": 12.0,
        "release_ms": 70.0,
        "max_reduction_db": 7.0,
        "freq_floor_hz": 80.0,
        "freq_ceil_hz": 16000.0,
        "mode": "soft",
    },
    "general_clean": {
        "depth": 0.7,
        "sharpness": 0.55,
        "selectivity": 2.5,
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
        **override_params,
    ):
        self.sr = sample_rate
        self.n_fft = n_fft
        self.hop_length = hop_length

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
        min_window = 5    # bins — minimum meaningful context
        max_window = 120  # bins — very broad spectral context
        sharpness = params["sharpness"]
        # Invert: high sharpness = small smoothing window
        self.smooth_window_bins = max(
            min_window,
            int(max_window * (1.0 - sharpness)),
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
        # uniform_filter1d applies a causal average across the frequency axis.
        # mode='reflect' handles edges cleanly without zero-padding artifacts.
        smoothed = uniform_filter1d(
            magnitude_db,
            size=self.smooth_window_bins,
            mode="reflect",
        )
        return smoothed

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

    def process(self, audio: np.ndarray) -> dict:
        """
        Apply dynamic resonance suppression to a mono audio array.

        Args:
            audio: 1D float32 numpy array at self.sr sample rate.

        Returns:
            dict with keys:
              'audio'           : processed audio (float32 ndarray, same length as input)
              'max_reduction_db': peak reduction applied at any single bin/frame
              'mean_reduction_db': mean reduction across all active bins and frames
              'spike_frames'    : number of frames where any reduction was applied
              'artifact_risk'   : bool — True if mean_reduction_db > 3 dB (advisory flag trigger)
        """
        if audio.ndim != 1:
            raise ValueError("ResonanceSuppressor expects mono input (1D array).")

        n_fft = self.n_fft
        hop = self.hop_length
        window = get_window("hann", n_fft, fftbins=True)

        # --- STFT ---
        # Pad signal so all samples are covered
        pad = n_fft // 2
        audio_padded = np.pad(audio, pad, mode="reflect")

        frames = []
        pos = 0
        while pos + n_fft <= len(audio_padded):
            frame = audio_padded[pos : pos + n_fft] * window
            frames.append(frame)
            pos += hop

        if not frames:
            logger.warning("ResonanceSuppressor: audio too short, returning unmodified.")
            return {
                "audio": audio,
                "max_reduction_db": 0.0,
                "mean_reduction_db": 0.0,
                "spike_frames": 0,
                "artifact_risk": False,
            }

        # FFT of all frames → complex spectra
        spectra = np.array([np.fft.rfft(f) for f in frames])  # shape: (n_frames, n_bins)
        magnitudes = np.abs(spectra)                           # linear magnitude
        phases = np.angle(spectra)                              # phase (preserved throughout)

        # Convert to dB (small epsilon to avoid log(0))
        eps = 1e-10
        magnitudes_db = 20.0 * np.log10(magnitudes + eps)

        # --- Per-frame resonance detection and gain reduction ---
        n_frames = len(frames)
        gain_reduction_db = np.zeros_like(magnitudes_db)  # shape: (n_frames, n_bins)

        # Smoothed gain reduction state for attack/release (per bin)
        smoothed_gr = np.zeros(self.n_bins)

        for i in range(n_frames):
            mag_db_frame = magnitudes_db[i]
            smoothed_env = self._compute_smoothed_envelope(mag_db_frame)
            target_gr = self._compute_gain_reduction(mag_db_frame, smoothed_env)

            # Attack/release time smoothing (per-bin IIR)
            # When target_gr > smoothed_gr → attack (gain reducing faster)
            # When target_gr < smoothed_gr → release (gain recovering)
            increasing = target_gr >= smoothed_gr
            coeff = np.where(increasing, self.attack_coeff, self.release_coeff)
            smoothed_gr = coeff * smoothed_gr + (1.0 - coeff) * target_gr
            gain_reduction_db[i] = smoothed_gr.copy()

        # --- Apply gain reduction to linear magnitudes ---
        gain_linear = 10.0 ** (-gain_reduction_db / 20.0)
        modified_magnitudes = magnitudes * gain_linear

        # --- Reconstruct complex spectra (original phase, modified magnitude) ---
        modified_spectra = modified_magnitudes * np.exp(1j * phases)

        # --- ISTFT with overlap-add reconstruction ---
        output_length = len(audio_padded)
        output_buffer = np.zeros(output_length, dtype=np.float64)
        window_accumulator = np.zeros(output_length, dtype=np.float64)

        window_squared = window ** 2  # for normalization in OLA

        for i, spectrum in enumerate(modified_spectra):
            time_frame = np.fft.irfft(spectrum, n=n_fft) * window
            start = i * hop
            end = start + n_fft
            if end > output_length:
                trim = output_length - start
                output_buffer[start:output_length] += time_frame[:trim]
                window_accumulator[start:output_length] += window_squared[:trim]
            else:
                output_buffer[start:end] += time_frame
                window_accumulator[start:end] += window_squared

        # Normalize by window accumulator to correct OLA gain
        safe_acc = np.where(window_accumulator > 1e-8, window_accumulator, 1.0)
        output_buffer /= safe_acc

        # Remove padding and cast back to float32
        output_audio = output_buffer[pad : pad + len(audio)].astype(np.float32)

        # --- Telemetry for processing report ---
        max_reduction = float(np.max(gain_reduction_db))
        mean_reduction = float(np.mean(gain_reduction_db[gain_reduction_db > 0.01]))
        if np.isnan(mean_reduction):
            mean_reduction = 0.0
        spike_frames = int(np.sum(np.any(gain_reduction_db > 0.5, axis=1)))

        # Artifact risk: if mean reduction is high, flag for advisory system
        artifact_risk = mean_reduction > 3.0

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
        }


# ---------------------------------------------------------------------------
# Pipeline integration helper
# ---------------------------------------------------------------------------

def apply_resonance_suppression(
    audio: np.ndarray,
    sample_rate: int,
    preset: str,
    vad_voiced_mask: np.ndarray = None,
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
                "mean_reduction_db": 0.0, "spike_frames": 0, "artifact_risk": False}

    suppressor = ResonanceSuppressor(sample_rate=sample_rate, preset=preset)

    if vad_voiced_mask is not None and len(vad_voiced_mask) == len(audio):
        # Process only voiced segments; splice results back in
        # Simple approach: process full audio, then blend with original on silence frames
        result = suppressor.process(audio)
        processed = result["audio"]
        # On silence frames (not voiced), restore original
        silence_mask = ~vad_voiced_mask
        processed[silence_mask] = audio[silence_mask]
        result["audio"] = processed
    else:
        result = suppressor.process(audio)

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
    }


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    import argparse
    import json
    from scipy.io import wavfile

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

    result = apply_resonance_suppression(audio, sr, args.preset, vad_voiced_mask)
    wavfile.write(args.output, sr, result['audio'].astype(np.float32))
    report = resonance_suppressor_report_entry(result)
    print('JSON_RESULT:' + json.dumps(report), flush=True)
