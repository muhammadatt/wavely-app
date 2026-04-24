#!/usr/bin/env python3
"""
LavaSR bandwidth extension script for Instant Polish pipeline (Stage NE-6).

Usage:
  python3 lavasr_extend.py --input <path> --output <path> [--device <auto|cuda|cpu>]
                           [--denoise] [--cutoff <hz>]

Environment variables:
  LAVASR_MODEL_PATH  HuggingFace Hub model ID or local path to cached model weights.
                     Defaults to 'YatharthS/LavaSR' (auto-downloaded on first run).

Reads a 32-bit float WAV at 44.1 kHz, runs LavaSR bandwidth extension, and writes
the result as a 32-bit float PCM WAV at 48 kHz.
The caller (stages.js) resamples back to 44.1 kHz via decodeToFloat32/FFmpeg.

LavaSR is a lightweight Vocos-based super-resolution model (~50 MB, ~500 MB VRAM).
Runs at ~5000x realtime on GPU and ~50x realtime on CPU.
Repo: https://github.com/ysharma3501/LavaSR
"""
import argparse
import os
import sys
import warnings

warnings.filterwarnings('ignore')


def main():
    parser = argparse.ArgumentParser(description='LavaSR bandwidth extension')
    parser.add_argument('--input',   required=True,        help='Input WAV file (32-bit float, 44.1 kHz)')
    parser.add_argument('--output',  required=True,        help='Output WAV file (32-bit float, 48 kHz)')
    parser.add_argument('--device',  default='auto',       help='Compute device: auto, cuda, or cpu')
    parser.add_argument('--denoise', action='store_true',  help='Enable LavaSR internal denoising pass (default: off — noise reduction runs upstream in stage 2)')
    parser.add_argument('--cutoff',  type=int, default=None, help='Linkwitz-Riley filter cutoff Hz (default: half input SR). Lower values reduce metallic artefacts.')
    args = parser.parse_args()

    # ── Imports (deferred so arg errors print before heavy imports) ───────────
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio.functional as F

    # ── Device selection ──────────────────────────────────────────────────────
    if args.device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    else:
        device = args.device

    print(f'LavaSR using device: {device}')

    num_threads = int(os.environ.get('TORCH_NUM_THREADS', os.cpu_count() or 4))
    torch.set_num_threads(num_threads)
    print(f'LavaSR using {num_threads} CPU threads')

    # ── Load model ────────────────────────────────────────────────────────────
    model_path = os.environ.get('LAVASR_MODEL_PATH', 'YatharthS/LavaSR')
    print(f'LavaSR loading model from: {model_path}')

    try:
        from LavaSR.model import LavaEnhance2
    except ImportError:
        print(
            'LavaSR package not found.\n'
            'Install it with:\n'
            '  pip install git+https://github.com/ysharma3501/LavaSR.git\n'
            'Or set LAVASR_MODEL_PATH to a local cached model directory.',
            file=sys.stderr,
        )
        sys.exit(1)

    model = LavaEnhance2(model_path, device=device)

    # ── Load input audio ──────────────────────────────────────────────────────
    # Read the 32-bit float WAV produced by the upstream pipeline stage.
    audio_np, sr = sf.read(args.input, dtype='float32', always_2d=True)  # [samples, channels]
    audio_np = audio_np.T  # → [channels, samples]

    # Mix to mono — LavaSR operates on single-channel audio
    if audio_np.shape[0] > 1:
        audio_np = audio_np.mean(axis=0, keepdims=True)

    # Convert to torch tensor [1, samples] and resample to the 16 kHz rate that
    # the LavaSR denoiser expects. LavaEnhance2.enhance() accepts a [1, samples]
    # tensor at 16 kHz.
    audio_t = torch.from_numpy(audio_np)  # [1, samples] at input sr
    if sr != 16000:
        audio_t = F.resample(audio_t, sr, 16000)

    # ── Run LavaSR inference ──────────────────────────────────────────────────
    # denoise=False by default: noise reduction runs upstream in stage 2 (DF3).
    # Setting batch=True handles long files safely by processing in 1.28 s chunks.
    kwargs = dict(
        enhance=True,
        denoise=args.denoise,
        batch=True,
    )
    if args.cutoff is not None:
        # load_audio exposes cutoff; here we reach into the model to set it.
        # FastLRMerge (the Linkwitz-Riley refiner) uses this cutoff frequency.
        kwargs['cutoff'] = args.cutoff

    print(f'LavaSR running inference (denoise={args.denoise}, cutoff={args.cutoff})')
    with torch.no_grad():
        output_t = model.enhance(audio_t, **kwargs)

    # Output is a tensor at 48 kHz; shape may be [1, samples] or [samples].
    output_t = output_t.cpu()
    if output_t.dim() == 1:
        output_t = output_t.unsqueeze(0)

    # ── Save wideband output at 48 kHz ────────────────────────────────────────
    # The Node.js stage (decodeToFloat32) resamples back to 44.1 kHz.
    output_np = output_t.numpy().T  # [samples, 1] for soundfile
    sf.write(args.output, output_np, 48000, subtype='FLOAT')

    print(f'LavaSR complete: {args.input} -> {args.output} (48000 Hz)')


if __name__ == '__main__':
    main()
