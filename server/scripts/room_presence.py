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


def generate_room_presence_ir(
    sample_rate=44100,
    rt60_ms=150.0,
    pre_delay_ms=10.0,
    early_reflection_count=2
):
    pre_delay_samples = int(pre_delay_ms * sample_rate / 1000)
    tail_samples      = int(rt60_ms * 3 * sample_rate / 1000)
    total_samples     = pre_delay_samples + tail_samples

    ir = np.zeros(total_samples, dtype=np.float32)

    # NO direct impulse — wet-only IR.
    # The dry signal is handled entirely by the mix formula.

    early_delays_ms = [13.4, 29.7]
    early_gains     = [0.09, 0.05]
    for delay_ms, gain in zip(early_delays_ms[:early_reflection_count], early_gains):
        idx = int(delay_ms * sample_rate / 1000)
        if idx < total_samples:
            ir[idx] += gain

    N         = tail_samples
    freqs_ir  = np.fft.rfftfreq(N, d=1.0 / sample_rate)
    magnitude = np.ones(len(freqs_ir), dtype=np.float32)
    magnitude *= np.clip(freqs_ir / 120.0, 0.0, 1.0)
    fc        = 2800.0
    hf_mask   = freqs_ir > fc
    magnitude[hf_mask] *= np.exp(
        -((freqs_ir[hf_mask] - fc) / (fc * 0.4)) ** 2
    ).astype(np.float32)

    rng   = np.random.default_rng(seed=42)
    phase = rng.uniform(-np.pi, np.pi, len(freqs_ir)).astype(np.float32)
    tail  = np.fft.irfft(magnitude * np.exp(1j * phase), n=N).astype(np.float32)

    ramp_samples               = int(0.015 * sample_rate)
    density_ramp               = np.ones(N, dtype=np.float32)
    density_ramp[:ramp_samples] = np.linspace(0.0, 1.0, ramp_samples)
    tail *= density_ramp

    t              = np.arange(N) / sample_rate
    rt60_s         = rt60_ms / 1000.0
    decay_envelope = np.exp(-3.0 * np.log(10) * t / rt60_s).astype(np.float32)
    tail          *= decay_envelope

    ir[pre_delay_samples:] = tail

    # L2 normalize — gives the IR unit energy so wet mix is intuitive.
    # At wet=0.08 the reverb sits ~22 dB below dry, which is the right
    # level for a bloom effect.
    energy = np.sqrt(np.sum(ir ** 2))
    if energy > 0:
        ir /= energy

    return ir


def _apply_room_presence(audio, sr, wet, rt60_ms, pre_delay_ms, early_reflections):
    ir      = generate_room_presence_ir(sr, rt60_ms, pre_delay_ms, early_reflections)
    reverb  = scipy.signal.fftconvolve(audio, ir)[:len(audio)].astype(np.float32)
    # Dry stays at full level. wet is a reverb send — how much bloom to add.
    output  = audio + wet * reverb
    return np.clip(output, -1.0, 1.0).astype(np.float32)


def main():
    parser = argparse.ArgumentParser(description='Apply room presence convolution reverb')
    parser.add_argument('--input',          required=True,              help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output',         required=True,              help='Output WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--wet',            type=float, default=0.08,   help='Wet mix fraction 0.0–0.3 (default 0.08)')
    parser.add_argument('--rt60-ms',        type=float, default=80.0,   help='RT60 decay time in ms, 20–200 (default 80)')
    parser.add_argument('--pre-delay-ms',   type=float, default=1.5,    help='Pre-delay in ms, 0–5 (default 1.5)')
    parser.add_argument('--early-reflections', type=int,   default=2,      help='Number of early reflections 0–2 (default 2)')
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    if audio.dtype != np.float32:
        print(f'[room_presence] ERROR: expected float32 audio, got {audio.dtype}', file=sys.stderr)
        sys.exit(1)
    if sr != PIPELINE_SR:
        print(f'[room_presence] ERROR: expected {PIPELINE_SR} Hz, got {sr} Hz', file=sys.stderr)
        sys.exit(1)

    # Guard parameter ranges
    wet               = float(np.clip(args.wet,          0.0,  0.3))
    rt60_ms           = float(np.clip(args.rt60_ms,     20.0, 200.0))
    pre_delay         = float(np.clip(args.pre_delay_ms, 0.0,   5.0))
    early_reflections = int(np.clip(args.early_reflections, 0, 2))

    if audio.ndim == 1:
        result = _apply_room_presence(audio, sr, wet, rt60_ms, pre_delay, early_reflections)
    else:
        # Process each channel independently with the same IR
        channels = [
            _apply_room_presence(audio[:, ch], sr, wet, rt60_ms, pre_delay, early_reflections)
            for ch in range(audio.shape[1])
        ]
        result = np.stack(channels, axis=1)

    wavfile.write(args.output, sr, result)
    print(
        f'[room_presence] applied wet={wet} rt60={rt60_ms}ms '
        f'pre_delay={pre_delay}ms early_reflections={early_reflections}',
        file=sys.stderr,
    )


if __name__ == '__main__':
    main()
