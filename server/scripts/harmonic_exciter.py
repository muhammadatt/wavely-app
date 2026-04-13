#!/usr/bin/env python3
"""
Harmonic Exciter — adds subtle harmonic content in the presence/air region.

Input/output: 32-bit float WAV at 44.1 kHz.
"""

import argparse
import sys

import numpy as np
import scipy.signal
from scipy.io import wavfile


def harmonic_exciter(audio, sr=44100,
                     hp_freq=3000,
                     blend=0.06,
                     drive=1.8,
                     even_harmonic_weight=0.4):
    """
    Adds subtle harmonic content in the presence/air region.

    hp_freq: frequency above which excitation is applied
    blend: mix level of excited signal (0.06 = 6%)
    drive: amount of nonlinear saturation (higher = more harmonics,
           but more obvious effect)
    even_harmonic_weight: tanh produces odd harmonics, x^2 produces even.
                          Real tube/transformer exciters have both.
    """

    # 1. High-pass filter to isolate high-frequency content
    sos = scipy.signal.butter(
        4, hp_freq / (sr / 2), btype='high', output='sos'
    )
    hf_signal = scipy.signal.sosfilt(sos, audio)

    # 2. Normalize HF signal for consistent drive behavior
    hf_rms = np.sqrt(np.mean(hf_signal ** 2)) + 1e-8
    hf_normalized = hf_signal / hf_rms

    # 3. Waveshaping — generate harmonics
    # tanh: soft saturation, primarily odd harmonics (3rd, 5th...)
    # x^2: even harmonics (2nd, 4th...) — these sound "warmer"
    odd_harmonics = np.tanh(hf_normalized * drive)
    even_harmonics = np.sign(hf_normalized) * (hf_normalized ** 2)

    # Blend odd and even harmonic content
    excited = ((1 - even_harmonic_weight) * odd_harmonics +
                even_harmonic_weight * even_harmonics)

    # 4. High-pass the excited signal again to remove any
    #    low-frequency content introduced by waveshaping
    excited = scipy.signal.sosfilt(sos, excited)

    # 5. Rescale excited signal to match original HF level
    excited_rms = np.sqrt(np.mean(excited ** 2)) + 1e-8
    excited = excited * (hf_rms / excited_rms)

    # 6. Blend into original at conservative level
    output = audio + (excited * blend)

    # 7. Normalize output to prevent level increase
    # (excited content can add a small amount of overall energy)
    output_rms = np.sqrt(np.mean(output ** 2)) + 1e-8
    input_rms = np.sqrt(np.mean(audio ** 2)) + 1e-8
    output = output * (input_rms / output_rms)

    return output


def main():
    parser = argparse.ArgumentParser(description='Harmonic exciter for voice audio')
    parser.add_argument('--input',  required=True, help='Input WAV path (32-bit float, 44.1 kHz)')
    parser.add_argument('--output', required=True, help='Output WAV path (32-bit float, 44.1 kHz)')
    parser.add_argument('--hp-freq', type=float, default=3000.0,
                        help='High-pass cutoff frequency in Hz (default: 3000)')
    parser.add_argument('--blend', type=float, default=0.06,
                        help='Excited signal mix level (default: 0.06 = 6%%)')
    parser.add_argument('--drive', type=float, default=1.8,
                        help='Nonlinear saturation drive amount (default: 1.8)')
    parser.add_argument('--even-harmonic-weight', type=float, default=0.4,
                        help='Even-harmonic blend (0=odd only, 1=even only; default: 0.4)')
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    audio = audio.astype(np.float32)

    # Handle multichannel: process each channel independently
    if audio.ndim == 1:
        processed = harmonic_exciter(
            audio, sr, args.hp_freq, args.blend, args.drive, args.even_harmonic_weight
        )
    else:
        channels = [
            harmonic_exciter(
                audio[:, ch], sr, args.hp_freq, args.blend, args.drive, args.even_harmonic_weight
            )
            for ch in range(audio.shape[1])
        ]
        processed = np.stack(channels, axis=1)

    wavfile.write(args.output, sr, processed.astype(np.float32))
    print(
        f'Harmonic exciter applied: '
        f'hp_freq={args.hp_freq}Hz  blend={args.blend}  '
        f'drive={args.drive}  even_weight={args.even_harmonic_weight}'
    )


if __name__ == '__main__':
    main()
