#!/usr/bin/env python3
"""
Vocal Saturation — parallel tube-style saturation mixed with the dry signal.
Band crossovers are set explicitly per preset; no pitch detection is performed.

Input/output: 32-bit float WAV at any sample rate.
"""

import argparse

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, resample_poly, sosfilt


# ---------------------------------------------------------------------------
# Saturation core
# ---------------------------------------------------------------------------

def tube_saturate(
    x: np.ndarray,
    drive: float = 1.0,
    bias: float = 0.1,
    softness: float = 0.3,
) -> np.ndarray:
    """
    Analog-warm asymmetric saturation with 2× oversampling.

    Two improvements over a bare tanh make this better suited for vocals:

    1. 2× oversampling — the nonlinearity runs at twice the source sample rate.
       Intermodulation products that would alias back into the audible band are
       attenuated by resample_poly's built-in anti-alias filter before decimation.
       This removes the "digital edge" that naive tanh saturation has on
       harmonically rich content like a consonant cluster or plosive.

    2. Blended transfer function — pure tanh accumulates odd harmonics (3rd, 5th…)
       that can sound brittle on voices.  Blending toward arctan (same asymptotic
       shape, but a softer 3rd-harmonic rolloff due to the π/2 ceiling) reduces
       that edge while the asymmetric bias continues to supply even-harmonic warmth.

       softness=0.0 → pure tanh (hardest knee, strongest 3rd harmonic)
       softness=1.0 → pure arctan (softest knee, most 2nd-harmonic character)
       softness=0.3 → default: noticeably warmer than bare tanh, still present
    """
    # Upsample 2× (built-in Kaiser anti-alias filter)
    x_up = resample_poly(x, 2, 1)

    x_biased = x_up + bias
    pre = x_biased * drive

    y_tanh = np.tanh(pre)
    y_atan = (2.0 / np.pi) * np.arctan(pre)
    y_up = (1.0 - softness) * y_tanh + softness * y_atan

    # Remove DC offset introduced by the asymmetric bias
    bias_ref = (1.0 - softness) * np.tanh(bias * drive) + softness * (2.0 / np.pi) * np.arctan(bias * drive)
    y_up -= bias_ref

    # Downsample 2× with built-in anti-alias filtering
    y = resample_poly(y_up, 1, 2)

    # resample_poly may produce one extra sample at the tail due to filter delay
    return y[:len(x)]


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
    low_crossover: float = 500.0,
    mid_crossover: float = 3500.0,
    softness: float = 0.3,
    sr: int = 44100,
) -> tuple[np.ndarray, dict]:
    """
    Parallel tube-style saturation with preset-defined frequency bands.

    Band layout:
      low  band : DC  → low_crossover   (body / chest warmth)
      mid  band : low_crossover → mid_crossover  (presence / formants)
      high band : mid_crossover → Nyquist        (air / sibilance)

    Drive allocation:
      low  × 5.0  — emphasises chest warmth and second-harmonic density
      mid  × 0.1  — neutral; avoids adding grit to the vowel character
      high × 0.1  — gentle rollback; avoids amplifying sibilance

    Returns (processed_audio, info_dict).
    """
    # --- Band split ---------------------------------------------------------
    sos_lp = make_lp_filter(low_crossover, sr)
    sos_hp = make_hp_filter(mid_crossover, sr)

    low  = sosfilt(sos_lp, audio)
    high = sosfilt(sos_hp, audio)
    mid  = audio - low - high   # complementary split — sums back to audio exactly

    # --- Per-band saturation ------------------------------------------------
    low_sat  = tube_saturate(low,  drive * 5,   bias, softness)
    mid_sat  = tube_saturate(mid,  drive * 0.1, bias, softness)
    high_sat = tube_saturate(high, drive * 0.1, bias, softness)

    wet = low_sat + mid_sat + high_sat

    # --- RMS-match wet to dry -----------------------------------------------
    # Saturation compresses energy; without matching, a high wet_dry setting
    # sounds like a gain cut rather than a tonal change.
    dry_rms = np.sqrt(np.mean(audio ** 2)) + 1e-8
    wet_rms = np.sqrt(np.mean(wet ** 2)) + 1e-8
    wet = wet * (dry_rms / wet_rms)

    # --- Parallel blend -----------------------------------------------------
    output = (1.0 - wet_dry) * audio + wet_dry * wet

    # Safety clip
    output = np.clip(output, -1.0, 1.0)

    info = {
        'low_crossover_hz': round(low_crossover, 1),
        'mid_crossover_hz': round(mid_crossover, 1),
        'softness':         round(softness, 3),
    }
    return output, info


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Parallel tube-style vocal saturation with preset-defined band crossovers'
    )
    parser.add_argument('--input',          required=True,  help='Input WAV path (32-bit float)')
    parser.add_argument('--output',         required=True,  help='Output WAV path (32-bit float)')
    parser.add_argument('--drive',          type=float, default=1.8,
                        help='Base saturation drive factor (default: 1.8)')
    parser.add_argument('--wet-dry',        type=float, default=0.22,
                        help='Wet/dry mix ratio: 0.0=dry, 1.0=wet (default: 0.22)')
    parser.add_argument('--bias',           type=float, default=0.08,
                        help='Asymmetric bias for even-harmonic warmth (default: 0.08)')
    parser.add_argument('--low-crossover',  type=float, default=500.0,
                        help='Low band upper boundary Hz (default: 500)')
    parser.add_argument('--mid-crossover',  type=float, default=3500.0,
                        help='Mid band upper boundary Hz (default: 3500)')
    parser.add_argument('--softness',       type=float, default=0.3,
                        help='Transfer function softness 0=tanh, 1=arctan (default: 0.3)')
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    audio = audio.astype(np.float32)

    if audio.ndim == 1:
        processed, info = vocal_saturation(
            audio, args.drive, args.wet_dry, args.bias,
            args.low_crossover, args.mid_crossover, args.softness, sr,
        )
    else:
        results = [
            vocal_saturation(
                audio[:, ch], args.drive, args.wet_dry, args.bias,
                args.low_crossover, args.mid_crossover, args.softness, sr,
            )
            for ch in range(audio.shape[1])
        ]
        processed = np.stack([r[0] for r in results], axis=1)
        info = results[0][1]  # bands are identical across channels

    wavfile.write(args.output, sr, processed.astype(np.float32))

    print(
        f'Vocal saturation applied\n'
        f'  low crossover    : {info["low_crossover_hz"]} Hz\n'
        f'  mid crossover    : {info["mid_crossover_hz"]} Hz\n'
        f'  softness         : {info["softness"]}\n'
        f'  drive={args.drive}  wet_dry={args.wet_dry}  bias={args.bias}'
    )


if __name__ == '__main__':
    main()
