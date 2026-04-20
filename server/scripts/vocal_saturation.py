#!/usr/bin/env python3
"""
Vocal Saturation — parallel tanh soft-saturation mixed with the dry signal.

Input/output: 32-bit float WAV at 44.1 kHz.
"""

import argparse

import numpy as np
from scipy.io import wavfile


def vocal_saturation(audio, drive=2.0, wet_dry=0.3):
    """
    Parallel tanh saturation blended with the dry signal.

    drive:   tanh saturation factor — higher adds more harmonic content
    wet_dry: mix ratio (0.0 = fully dry, 1.0 = fully wet)
    """
    # 1. Generate wet (saturated) signal
    wet = np.tanh(audio * drive)

    # 2. RMS-match wet to dry so the blend is level-neutral at any mix ratio.
    #    np.tanh compresses energy at drive > 1 — without matching the wet track
    #    would be quieter than dry, making wet_dry=1.0 sound like a gain cut.
    dry_rms = np.sqrt(np.mean(audio ** 2)) + 1e-8
    wet_rms = np.sqrt(np.mean(wet ** 2)) + 1e-8
    wet = wet * (dry_rms / wet_rms)

    # 3. Parallel blend
    output = (1.0 - wet_dry) * audio + wet_dry * wet

    # 4. Safety clip — guards against rare over-ceiling values at high wet_dry + high drive
    output = np.clip(output, -1.0, 1.0)

    return output


def main():
    parser = argparse.ArgumentParser(description='Parallel tanh vocal saturation')
    parser.add_argument('--input',   required=True, help='Input WAV path (32-bit float, 44.1 kHz)')
    parser.add_argument('--output',  required=True, help='Output WAV path (32-bit float, 44.1 kHz)')
    parser.add_argument('--drive',   type=float, default=2.0,
                        help='Tanh saturation drive factor (default: 2.0)')
    parser.add_argument('--wet-dry', type=float, default=0.3,
                        help='Wet/dry mix ratio: 0.0=dry, 1.0=wet (default: 0.3)')
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    audio = audio.astype(np.float32)

    # Handle multichannel: process each channel independently
    if audio.ndim == 1:
        processed = vocal_saturation(audio, args.drive, args.wet_dry)
    else:
        channels = [
            vocal_saturation(audio[:, ch], args.drive, args.wet_dry)
            for ch in range(audio.shape[1])
        ]
        processed = np.stack(channels, axis=1)

    wavfile.write(args.output, sr, processed.astype(np.float32))
    print(
        f'Vocal saturation applied: '
        f'drive={args.drive}  wet_dry={args.wet_dry}'
    )


if __name__ == '__main__':
    main()
