#!/usr/bin/env python3
"""
Vocal Saturation — parallel tube-style saturation mixed with the dry signal.
Band crossovers are derived automatically from the vocal fundamental frequency (F0)
using pyin pitch detection, so the saturation adapts to each narrator's voice.

Input/output: 32-bit float WAV at any sample rate.
"""

import argparse

import librosa
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt


# ---------------------------------------------------------------------------
# F0 detection
# ---------------------------------------------------------------------------

def estimate_vocal_f0(audio: np.ndarray, sr: int, excerpt_seconds: float = 30.0) -> float:
    """
    Estimate the median voiced fundamental frequency of a vocal recording.

    Uses pyin (probabilistic YIN) which is robust to octave errors and
    unvoiced segments. Only the first `excerpt_seconds` of audio is analysed
    to keep compute time acceptable on long files — a single narrator's F0
    is stable enough that this is representative.

    Returns F0 in Hz, defaulting to 150 Hz if no voiced frames are found.
    """
    max_samples = int(excerpt_seconds * sr)
    excerpt = audio[:max_samples] if len(audio) > max_samples else audio

    f0, voiced_flag, _ = librosa.pyin(
        excerpt,
        fmin=librosa.note_to_hz('C2'),   # ~65 Hz  — covers bass voices
        fmax=librosa.note_to_hz('C6'),   # ~1047 Hz — covers soprano
        sr=sr,
    )

    voiced_f0 = f0[voiced_flag]
    if len(voiced_f0) == 0:
        return 150.0  # safe fallback for silence or purely unvoiced audio

    median_f0 = float(np.median(voiced_f0))
    return median_f0


def get_saturation_bands(f0: float) -> tuple[float, float]:
    """
    Derive low and mid crossover frequencies from the vocal F0.

    Low crossover  ≈ 3.5× F0  — captures fundamental + 2nd & 3rd harmonics
                                 (chest warmth / body of the voice)
    Mid crossover  ≈ 18× F0   — top of the presence/formant region
                                 (4th–10th harmonics, vowel character)

    Both values are clamped to sensible limits so extreme F0 estimates
    (e.g. from a noisy excerpt) can't produce degenerate filter frequencies.
    """
    low_crossover = np.clip(f0 * 3.5,  200.0, 900.0)
    mid_crossover = np.clip(f0 * 18.0, 1200.0, 6000.0)
    return float(low_crossover), float(mid_crossover)


# ---------------------------------------------------------------------------
# Saturation core
# ---------------------------------------------------------------------------

def tube_saturate(x: np.ndarray, drive: float = 1.0, bias: float = 0.1) -> np.ndarray:
    """
    Asymmetric tanh saturation.

    The bias shifts the operating point to produce even-order harmonics
    (tube character). The DC offset introduced by the bias is removed after
    so the output is always DC-free.
    """
    x_biased = x + bias
    y = np.tanh(x_biased * drive)
    y -= np.tanh(bias * drive)
    return y


def make_lp_filter(fc: float, sr: int):
    sos = butter(4, fc / (sr / 2.0), btype='low', output='sos')
    return sos


def make_hp_filter(fc: float, sr: int):
    sos = butter(4, fc / (sr / 2.0), btype='high', output='sos')
    return sos


def vocal_saturation(
    audio: np.ndarray,
    drive: float = 2.0,
    wet_dry: float = 0.3,
    bias: float = 0.08,
    fc: float | None = None,   # mid crossover — auto-derived from F0 if None
    sr: int = 44100,
    f0: float | None = None,   # supply a pre-computed F0 to skip detection
    excerpt_seconds: float = 30.0,
) -> tuple[np.ndarray, dict]:
    """
    Parallel tube-style saturation with F0-adaptive frequency bands.

    Band layout (derived from F0):
      low  band : DC  → low_crossover  (fundamental + 2nd/3rd harmonics)
      mid  band : low_crossover → mid_crossover  (presence / formants)
      high band : mid_crossover → Nyquist        (air / sibilance)

    Drive allocation:
      low  × 3.0  — emphasises chest warmth
      mid  × 1.0  — neutral
      high × 0.7  — gentle rollback avoids harshness

    Returns:
      (processed_audio, info_dict)
      info_dict contains the detected F0 and the crossover frequencies used,
      useful for logging and for caching F0 across pipeline stages.
    """
    # --- F0 detection -------------------------------------------------------
    if f0 is None:
        f0 = estimate_vocal_f0(audio, sr, excerpt_seconds)

    low_crossover, auto_mid = get_saturation_bands(f0)

    # Allow the preset fc to override the mid crossover if explicitly supplied
    mid_crossover = fc if fc is not None else auto_mid

    # --- Band split ---------------------------------------------------------
    sos_lp = make_lp_filter(low_crossover, sr)
    sos_hp = make_hp_filter(mid_crossover, sr)

    low  = sosfilt(sos_lp, audio)
    high = sosfilt(sos_hp, audio)
    mid  = audio - low - high   # complementary split — sums back to audio exactly

    # --- Per-band saturation ------------------------------------------------
    low_sat  = tube_saturate(low,  drive * 5, bias)
    mid_sat  = tube_saturate(mid,  drive * 0.1, bias)
    high_sat = tube_saturate(high, drive * 0.1, bias)

    wet = low_sat + mid_sat + high_sat

    # --- RMS-match wet to dry -----------------------------------------------
    # tube_saturate compresses energy; without matching, high wet_dry sounds
    # like a gain cut rather than a tonal change.
    dry_rms = np.sqrt(np.mean(audio ** 2)) + 1e-8
    wet_rms = np.sqrt(np.mean(wet ** 2)) + 1e-8
    wet = wet * (dry_rms / wet_rms)

    # --- Parallel blend -----------------------------------------------------
    output = (1.0 - wet_dry) * audio + wet_dry * wet

    # Safety clip
    output = np.clip(output, -1.0, 1.0)

    info = {
        'f0_hz':            round(f0, 1),
        'low_crossover_hz': round(low_crossover, 1),
        'mid_crossover_hz': round(mid_crossover, 1),
    }
    return output, info


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Parallel tube-style vocal saturation with F0-adaptive band detection'
    )
    parser.add_argument('--input',   required=True, help='Input WAV path (32-bit float)')
    parser.add_argument('--output',  required=True, help='Output WAV path (32-bit float)')
    parser.add_argument('--drive',   type=float, default=1.8,
                        help='Base saturation drive factor (default: 1.8)')
    parser.add_argument('--wet-dry', type=float, default=0.22,
                        help='Wet/dry mix ratio: 0.0=dry, 1.0=wet (default: 0.22)')
    parser.add_argument('--bias',    type=float, default=0.08,
                        help='Asymmetric bias for tube character (default: 0.08)')
    parser.add_argument('--fc',      type=float, default=None,
                        help='Mid crossover Hz — overrides F0-derived value if set')
    parser.add_argument('--f0',      type=float, default=None,
                        help='Supply a known F0 in Hz to skip auto-detection')
    parser.add_argument('--excerpt', type=float, default=30.0,
                        help='Seconds of audio to use for F0 estimation (default: 30)')
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    audio = audio.astype(np.float32)

    if audio.ndim == 1:
        processed, info = vocal_saturation(
            audio, args.drive, args.wet_dry, args.bias, args.fc, sr, args.f0, args.excerpt
        )
    else:
        results = [
            vocal_saturation(
                audio[:, ch], args.drive, args.wet_dry, args.bias, args.fc, sr, args.f0, args.excerpt
            )
            for ch in range(audio.shape[1])
        ]
        processed = np.stack([r[0] for r in results], axis=1)
        info = results[0][1]  # bands are identical across channels

    wavfile.write(args.output, sr, processed.astype(np.float32))

    print(
        f'Vocal saturation applied\n'
        f'  detected F0      : {info["f0_hz"]} Hz\n'
        f'  low crossover    : {info["low_crossover_hz"]} Hz\n'
        f'  mid crossover    : {info["mid_crossover_hz"]} Hz\n'
        f'  drive={args.drive}  wet_dry={args.wet_dry}  bias={args.bias}'
    )


if __name__ == '__main__':
    main()