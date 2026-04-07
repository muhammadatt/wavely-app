#!/usr/bin/env python3
"""
VoiceFixer speech restoration script.

Wraps the voicefixer Python package (MIT) with a file I/O interface
compatible with the Instant Polish pipeline (32-bit float WAV at 44.1 kHz).

VoiceFixer is a neural-vocoder-based speech restoration model that handles
noise, reverberation, low resolution (2kHz–44.1kHz), and clipping within
a single model pass. Unlike Demucs (source separation) or DeepFilterNet
(spectral filtering), VoiceFixer resynthesizes the clean speech signal via
a vocoder — making it effective for severely degraded audio, especially
reverberant or clipped recordings, at the cost of some voice transparency.

Run modes:
  0 (default)  Original model. Recommended for most recordings.
  1            Adds a preprocessing module that removes high-frequency
               content before restoration — useful for clipping artefacts.
  2            Train mode. May help on extremely degraded speech; results
               are not deterministic.

Usage:
  python3 voicefixer_enhance.py --input <path> --output <path>
                                [--mode 0|1|2]
                                [--device auto|cpu|cuda]

Input:  32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
Output: 32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
        VoiceFixer outputs at 44.1 kHz natively.
"""
import argparse
import os
import tempfile
import warnings

warnings.filterwarnings('ignore')

PIPELINE_SR = 44100


def resolve_device(device_arg):
    if device_arg == 'auto':
        import torch
        return 'cuda' if torch.cuda.is_available() else 'cpu'
    return device_arg


def main():
    parser = argparse.ArgumentParser(description='VoiceFixer speech restoration')
    parser.add_argument('--input',  required=True,
                        help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output', required=True,
                        help='Output WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--mode', type=int, default=0, choices=[0, 1, 2],
                        help='VoiceFixer mode: 0=original, 1=preprocessing, 2=train (default: 0)')
    parser.add_argument('--device', default='auto',
                        help='Compute device: auto, cpu, or cuda (default: auto)')
    args = parser.parse_args()

    import torchaudio
    import torchaudio.transforms as T

    try:
        from voicefixer import VoiceFixer
    except ImportError:
        print('voicefixer is not installed — copying input unchanged.', flush=True)
        import shutil
        shutil.copy(args.input, args.output)
        return

    device_str = resolve_device(args.device)
    use_cuda   = device_str == 'cuda'

    # VoiceFixer.restore() accepts a file path and writes output as FLAC.
    # We use a temp file then re-encode to 32-bit float WAV at 44.1 kHz.
    tmp_fd, tmp_out_path = tempfile.mkstemp(suffix='.flac')
    os.close(tmp_fd)

    try:
        vf = VoiceFixer()
        print(f'Running VoiceFixer mode {args.mode}...', flush=True)
        vf.restore(
            input=args.input,
            output=tmp_out_path,
            cuda=use_cuda,
            mode=args.mode,
        )

        # Load VoiceFixer output and convert to pipeline format
        waveform, sr = torchaudio.load(tmp_out_path)

        if sr != PIPELINE_SR:
            waveform = T.Resample(orig_freq=sr, new_freq=PIPELINE_SR)(waveform)

        # Ensure (1, samples) shape — VoiceFixer output is mono
        if waveform.dim() == 1:
            waveform = waveform.unsqueeze(0)

        torchaudio.save(
            args.output,
            waveform,
            PIPELINE_SR,
            bits_per_sample=32,
            encoding='PCM_F',
        )
        print(f'VoiceFixer mode {args.mode} complete.', flush=True)

    finally:
        if os.path.exists(tmp_out_path):
            os.unlink(tmp_out_path)


if __name__ == '__main__':
    main()
