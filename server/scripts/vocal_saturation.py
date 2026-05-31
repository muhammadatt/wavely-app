#!/usr/bin/env python3
"""
Vocal Saturation — parallel tube-style saturation mixed with the dry signal.
Band crossovers are set explicitly per preset; no pitch detection is performed.

Input/output: 32-bit float WAV at any sample rate.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt, upfirdn


# ---------------------------------------------------------------------------
# Half-band FIR for 2× resampling (precomputed once at import time)
# ---------------------------------------------------------------------------
# 15-tap equiripple half-band filter designed for 2× up/down conversion.
# Every other coefficient (except center) is zero by construction, so the
# effective work is ~8 multiplies per sample — much cheaper than
# resample_poly's general-purpose Kaiser FIR (~41 taps for ratio 2).
_HALF_BAND_TAPS = np.array([
    -0.01773725, 0.0, 0.04417345, 0.0, -0.09398545, 0.0,
     0.31327629, 0.5, 0.31327629, 0.0, -0.09398545, 0.0,
     0.04417345, 0.0, -0.01773725,
], dtype=np.float32)

_OVERSAMPLE_DRIVE_THRESHOLD = 0.5


# ---------------------------------------------------------------------------
# Fast 2× resampling via half-band FIR
# ---------------------------------------------------------------------------

def _upsample2(x: np.ndarray) -> np.ndarray:
    """Zero-stuff then filter with the half-band FIR."""
    up = np.zeros(len(x) * 2, dtype=x.dtype)
    up[::2] = x
    return upfirdn(_HALF_BAND_TAPS, up, up=1, down=1) * 2.0


def _downsample2(x: np.ndarray, orig_len: int) -> np.ndarray:
    """Anti-alias filter then decimate by 2."""
    filtered = upfirdn(_HALF_BAND_TAPS, x, up=1, down=2)
    return filtered[:orig_len]


# ---------------------------------------------------------------------------
# Saturation core
# ---------------------------------------------------------------------------

def _apply_transfer(pre: np.ndarray, softness: float, bias: float) -> np.ndarray:
    """Blended tanh/arctan transfer function with DC offset removal."""
    if softness <= 0.0:
        y = np.tanh(pre)
        y -= np.tanh(bias)
    elif softness >= 1.0:
        scale = 2.0 / np.pi
        y = scale * np.arctan(pre)
        y -= scale * np.arctan(bias)
    else:
        y_tanh = np.tanh(pre)
        y_atan = (2.0 / np.pi) * np.arctan(pre)
        y = (1.0 - softness) * y_tanh + softness * y_atan
        bias_ref = (1.0 - softness) * np.tanh(bias) + softness * (2.0 / np.pi) * np.arctan(bias)
        y -= bias_ref
    return y


def tube_saturate(
    x: np.ndarray,
    drive: float = 1.0,
    bias: float = 0.1,
    softness: float = 0.3,
    oversample: bool = True,
) -> np.ndarray:
    """
    Analog-warm asymmetric saturation with optional 2× oversampling.

    Oversampling is skipped when the effective drive is below the aliasing
    threshold (drive < 0.5), since the transfer function is near-linear and
    intermodulation products are negligible.

    Uses a precomputed 15-tap half-band FIR instead of scipy's general-purpose
    resample_poly for ~3× faster 2× conversion.
    """
    if oversample:
        x_up = _upsample2(x)
        pre = x_up * drive + bias
        y_up = _apply_transfer(pre, softness, bias)
        return _downsample2(y_up, len(x))

    pre = x * drive + bias
    return _apply_transfer(pre, softness, bias)


def _rms(x: np.ndarray) -> float:
    return np.sqrt(np.dot(x, x) / len(x)) + 1e-8


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
    bias: float = 0.5,
    low_crossover: float = 500.0,
    mid_crossover: float = 3500.0,
    softness: float = 0.3,
    low_drive_mult: float = 5.0,
    mid_drive_mult: float = 0.1,
    high_drive_mult: float = 0.1,
    sr: int = 44100,
) -> tuple[np.ndarray, dict]:
    """
    Parallel tube-style saturation with band-split drive shaping.

    Band layout:
      low  band : DC  → low_crossover            (body / chest warmth)
      mid  band : low_crossover → mid_crossover  (presence / formants)
      high band : mid_crossover → Nyquist        (air / sibilance)

    Drive allocation (per-band multipliers on the base `drive`):
      low  × low_drive_mult   — default 5.0, emphasises chest warmth
      mid  × mid_drive_mult   — default 0.1, neutral on vowel character
      high × high_drive_mult  — default 0.1, avoids amplifying sibilance

    Returns (processed_audio, info_dict).
    """
    # --- Band split ---------------------------------------------------------
    sos_lp = make_lp_filter(low_crossover, sr)
    sos_hp = make_hp_filter(mid_crossover, sr)

    low  = sosfilt(sos_lp, audio)
    high = sosfilt(sos_hp, audio)
    mid  = audio - low - high   # complementary split — sums back to audio exactly

    # --- Per-band saturation ------------------------------------------------
    low_eff  = drive * low_drive_mult
    mid_eff  = drive * mid_drive_mult
    high_eff = drive * high_drive_mult

    low_sat  = tube_saturate(low,  low_eff,  bias, softness, oversample=low_eff  >= _OVERSAMPLE_DRIVE_THRESHOLD)
    mid_sat  = tube_saturate(mid,  mid_eff,  bias, softness, oversample=mid_eff  >= _OVERSAMPLE_DRIVE_THRESHOLD)
    high_sat = tube_saturate(high, high_eff, bias, softness, oversample=high_eff >= _OVERSAMPLE_DRIVE_THRESHOLD)

    wet = low_sat + mid_sat + high_sat

    # --- RMS-match wet to dry -----------------------------------------------
    dry_rms = _rms(audio)
    wet_rms = _rms(wet)
    wet *= (dry_rms / wet_rms)

    # --- Gain-neutral parallel blend ----------------------------------------
    output = audio + wet_dry * wet
    out_rms = _rms(output)
    output *= (dry_rms / out_rms)

    # Safety clip
    np.clip(output, -1.0, 1.0, out=output)

    info = {
        'low_crossover_hz':  round(low_crossover, 1),
        'mid_crossover_hz':  round(mid_crossover, 1),
        'softness':          round(softness, 3),
        'low_drive_mult':    round(low_drive_mult,  3),
        'mid_drive_mult':    round(mid_drive_mult,  3),
        'high_drive_mult':   round(high_drive_mult, 3),
    }
    return output, info


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Parallel tube-style vocal saturation with preset-defined band crossovers'
    )
    parser.add_argument('--input',          required=True,  help='Input WAV path (32-bit float)')
    parser.add_argument('--output',         required=True,  help='Output WAV path (32-bit float)')
    parser.add_argument('--drive',          type=float, default=1.8,
                        help='Base saturation drive factor (default: 1.8)')
    parser.add_argument('--wet-dry',        type=float, default=0.22,
                        help='Wet/dry mix ratio: 0.0=dry, 1.0=wet (default: 0.22)')
    parser.add_argument('--bias',            type=float, default=0.5,
                        help='Absolute operating-point offset on the curve (default: 0.5)')
    parser.add_argument('--low-crossover',   type=float, default=500.0,
                        help='Low band upper boundary Hz (default: 500)')
    parser.add_argument('--mid-crossover',   type=float, default=3500.0,
                        help='Mid band upper boundary Hz (default: 3500)')
    parser.add_argument('--softness',        type=float, default=0.3,
                        help='Transfer function softness 0=tanh, 1=arctan (default: 0.3)')
    parser.add_argument('--low-drive-mult',  type=float, default=5.0,
                        help='Low-band drive multiplier on base drive (default: 5.0)')
    parser.add_argument('--mid-drive-mult',  type=float, default=0.1,
                        help='Mid-band drive multiplier on base drive (default: 0.1)')
    parser.add_argument('--high-drive-mult', type=float, default=0.1,
                        help='High-band drive multiplier on base drive (default: 0.1)')
    args = parser.parse_args(argv)

    sr, audio = wavfile.read(args.input)
    audio = audio.astype(np.float32)

    if audio.ndim == 1:
        processed, info = vocal_saturation(
            audio, args.drive, args.wet_dry, args.bias,
            args.low_crossover, args.mid_crossover, args.softness,
            args.low_drive_mult, args.mid_drive_mult, args.high_drive_mult,
            sr,
        )
    else:
        def _process_channel(ch):
            return vocal_saturation(
                audio[:, ch], args.drive, args.wet_dry, args.bias,
                args.low_crossover, args.mid_crossover, args.softness,
                args.low_drive_mult, args.mid_drive_mult, args.high_drive_mult,
                sr,
            )

        n_ch = audio.shape[1]
        with ThreadPoolExecutor(max_workers=n_ch) as pool:
            results = list(pool.map(_process_channel, range(n_ch)))

        processed = np.stack([r[0] for r in results], axis=1)
        info = results[0][1]

    wavfile.write(args.output, sr, processed.astype(np.float32))

    print(
        f'Vocal saturation applied\n'
        f'  low crossover    : {info["low_crossover_hz"]} Hz\n'
        f'  mid crossover    : {info["mid_crossover_hz"]} Hz\n'
        f'  softness         : {info["softness"]}\n'
        f'  band mults       : low={info["low_drive_mult"]}  mid={info["mid_drive_mult"]}  high={info["high_drive_mult"]}\n'
        f'  drive={args.drive}  wet_dry={args.wet_dry}  bias={args.bias}'
    )

    return info


def run(argv):
    """Entry point used by the persistent worker (_worker.py)."""
    return main(argv)


if __name__ == '__main__':
    main()
