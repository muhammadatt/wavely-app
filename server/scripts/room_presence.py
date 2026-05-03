#!/usr/bin/env python3
"""
Room Presence stage — adds a subtle sense of acoustic space using convolution
reverb with a synthetically generated impulse response.

IR is constructed at runtime from parameters — no external IR files needed.
Fixed random seed (42) ensures identical settings always produce the same room
character across runs, which is important for consistent batch processing.

Usage:
  python3 room_presence.py --input <path> --output <path>
                           [--wet 0.08]
                           [--rt60-ms 80]
                           [--pre-delay-ms 1.5]
                           [--diffusion 0.7]

Input/output: 32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
"""

import argparse
import sys

import numpy as np
import scipy.signal
from scipy.io import wavfile

PIPELINE_SR = 44100
_RNG_SEED   = 42


def _generate_ir(sr, rt60_ms, pre_delay_ms, diffusion):
    """
    Build a synthetic exponential-decay IR.

    rt60_ms:      -60 dB decay time in milliseconds
    pre_delay_ms: silence before reverb onset (keeps the onset tight)
    diffusion:    0.0 = bright/sparse tail, 1.0 = dark/dense tail
                  (controls low-pass cutoff of the noise tail)
    """
    rng = np.random.default_rng(seed=_RNG_SEED)

    rt60_s        = rt60_ms      / 1000.0
    pre_delay_s   = pre_delay_ms / 1000.0

    # Tail long enough to capture full -60 dB decay
    tail_samples      = int(sr * rt60_s * 2)
    pre_delay_samples = int(sr * pre_delay_s)

    # White noise tail
    noise = rng.standard_normal(tail_samples).astype(np.float64)

    # Low-pass to shape density/warmth: diffusion 0.0 → 8 kHz, 1.0 → 3 kHz
    lp_cutoff = 8000.0 - diffusion * 5000.0
    sos       = scipy.signal.butter(2, lp_cutoff / (sr / 2.0), btype='low', output='sos')
    noise     = scipy.signal.sosfilt(sos, noise)

    # Exponential decay: e^(-6.9 * t / RT60) for exact -60 dB at t = RT60
    t      = np.arange(tail_samples) / sr
    decay  = np.exp(-6.9 * t / rt60_s)
    noise *= decay

    # Assemble IR: pre-delay silence + decaying tail
    ir = np.zeros(pre_delay_samples + tail_samples, dtype=np.float32)
    ir[pre_delay_samples:] = noise.astype(np.float32)

    # Normalise to unit energy so wet mix fraction is predictable
    energy = np.sqrt(np.sum(ir ** 2)) + 1e-12
    ir    /= energy

    return ir


def _apply_room_presence(audio, sr, wet, rt60_ms, pre_delay_ms, diffusion):
    """Convolve audio with synthetic IR and wet/dry mix."""
    ir         = _generate_ir(sr, rt60_ms, pre_delay_ms, diffusion)
    # fftconvolve is O(N log N); trim output to input length
    wet_signal = scipy.signal.fftconvolve(audio, ir)[:len(audio)]
    output     = (1.0 - wet) * audio + wet * wet_signal.astype(np.float32)
    return np.clip(output, -1.0, 1.0).astype(np.float32)


def main():
    parser = argparse.ArgumentParser(description='Apply room presence convolution reverb')
    parser.add_argument('--input',          required=True,              help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output',         required=True,              help='Output WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--wet',            type=float, default=0.08,   help='Wet mix fraction 0.0–0.3 (default 0.08)')
    parser.add_argument('--rt60-ms',        type=float, default=80.0,   help='RT60 decay time in ms, 20–200 (default 80)')
    parser.add_argument('--pre-delay-ms',   type=float, default=1.5,    help='Pre-delay in ms, 0–5 (default 1.5)')
    parser.add_argument('--diffusion',      type=float, default=0.7,    help='Tail density/warmth 0.0–1.0 (default 0.7)')
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    if audio.dtype != np.float32:
        print(f'[room_presence] ERROR: expected float32 audio, got {audio.dtype}', file=sys.stderr)
        sys.exit(1)
    if sr != PIPELINE_SR:
        print(f'[room_presence] ERROR: expected {PIPELINE_SR} Hz, got {sr} Hz', file=sys.stderr)
        sys.exit(1)

    # Guard parameter ranges
    wet        = float(np.clip(args.wet,          0.0,  0.3))
    rt60_ms    = float(np.clip(args.rt60_ms,     20.0, 200.0))
    pre_delay  = float(np.clip(args.pre_delay_ms, 0.0,   5.0))
    diffusion  = float(np.clip(args.diffusion,    0.0,   1.0))

    if audio.ndim == 1:
        result = _apply_room_presence(audio, sr, wet, rt60_ms, pre_delay, diffusion)
    else:
        # Process each channel independently with the same IR
        channels = [
            _apply_room_presence(audio[:, ch], sr, wet, rt60_ms, pre_delay, diffusion)
            for ch in range(audio.shape[1])
        ]
        result = np.stack(channels, axis=1)

    wavfile.write(args.output, sr, result)
    print(
        f'[room_presence] applied wet={wet} rt60={rt60_ms}ms '
        f'pre_delay={pre_delay}ms diffusion={diffusion}',
        file=sys.stderr,
    )


if __name__ == '__main__':
    main()
