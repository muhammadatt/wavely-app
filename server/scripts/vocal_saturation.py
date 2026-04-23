#!/usr/bin/env python3
"""
Vocal Saturation — parallel tube-style saturation mixed with the dry signal.

Input/output: 32-bit float WAV at 44.1 kHz.
"""

import argparse

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt


def tube_saturate(x, drive=1.0, bias=0.1):
    # Bias shifts the operating point, creating asymmetry (even harmonics).
    # DC offset introduced by the bias is removed after.
    x_biased = x + bias
    y = np.tanh(x_biased * drive)
    y -= np.tanh(bias * drive)
    return y


def make_hp_filter(fc, sr):
    sos = butter(4, fc / (sr / 2.0), btype='high', output='sos')
    return sos


def vocal_saturation(audio, drive=2.0, wet_dry=0.3, bias=0.1, fc=3000, sr=44100):
    """
    Parallel tube-style saturation with frequency-dependent drive.

    drive:   base saturation factor
    wet_dry: mix ratio (0.0 = fully dry, 1.0 = fully wet)
    bias:    asymmetric operating point shift (tube character)
    fc:      crossover frequency — high band receives 1.5x drive
    sr:      sample rate of the input signal
    """
    # Complementary band split: low + high = audio exactly
    sos_hp = make_hp_filter(fc, sr)
    high = sosfilt(sos_hp, audio)
    low = audio - high

    # High band gets 1.5x drive for frequency-dependent saturation character
    low_sat  = tube_saturate(low,  drive,       bias)
    high_sat = tube_saturate(high, drive * 1.5, bias)
    wet = low_sat + high_sat

    # RMS-match wet to dry so the blend is level-neutral at any mix ratio.
    # tube_saturate compresses energy — without matching, high wet_dry sounds
    # like a gain cut.
    dry_rms = np.sqrt(np.mean(audio ** 2)) + 1e-8
    wet_rms = np.sqrt(np.mean(wet ** 2)) + 1e-8
    wet = wet * (dry_rms / wet_rms)

    # Parallel blend
    output = (1.0 - wet_dry) * audio + wet_dry * wet

    # Safety clip — guards against rare over-ceiling values at high wet_dry + high drive
    output = np.clip(output, -1.0, 1.0)

    return output


def main():
    parser = argparse.ArgumentParser(description='Parallel tube-style vocal saturation')
    parser.add_argument('--input',   required=True, help='Input WAV path (32-bit float, 44.1 kHz)')
    parser.add_argument('--output',  required=True, help='Output WAV path (32-bit float, 44.1 kHz)')
    parser.add_argument('--drive',   type=float, default=2.0,
                        help='Base saturation drive factor (default: 2.0)')
    parser.add_argument('--wet-dry', type=float, default=0.3,
                        help='Wet/dry mix ratio: 0.0=dry, 1.0=wet (default: 0.3)')
    parser.add_argument('--bias',    type=float, default=0.1,
                        help='Asymmetric bias for tube character (default: 0.1)')
    parser.add_argument('--fc',      type=float, default=3000,
                        help='Crossover frequency in Hz — above this, drive is 1.5x (default: 3000)')
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    audio = audio.astype(np.float32)

    # Handle multichannel: process each channel independently
    if audio.ndim == 1:
        processed = vocal_saturation(audio, args.drive, args.wet_dry, args.bias, args.fc, sr)
    else:
        channels = [
            vocal_saturation(audio[:, ch], args.drive, args.wet_dry, args.bias, args.fc, sr)
            for ch in range(audio.shape[1])
        ]
        processed = np.stack(channels, axis=1)

    wavfile.write(args.output, sr, processed.astype(np.float32))
    print(
        f'Vocal saturation applied: '
        f'drive={args.drive}  wet_dry={args.wet_dry}  bias={args.bias}  fc={args.fc}'
    )


if __name__ == '__main__':
    main()
