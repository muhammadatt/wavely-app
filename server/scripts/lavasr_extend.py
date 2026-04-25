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

    # Monkey-patch torch.autocast to avoid CPU float16 error in LavaSR
    # LavaBWE sets dtype=torch.float16 even on CPU with autocast=False, which crashes.
    _orig_autocast = torch.autocast
    class PatchedAutocast(_orig_autocast):
        def __init__(self, device_type, dtype=None, enabled=True, **kwargs):
            if device_type == 'cpu' and dtype == torch.float16:
                dtype = torch.bfloat16
            super().__init__(device_type, dtype=dtype, enabled=enabled, **kwargs)
    torch.autocast = PatchedAutocast

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
    # Setting cutoff for FastLRMerge (Nyquist of 16kHz input is 8000Hz)
    cutoff = args.cutoff if args.cutoff is not None else 8000
    from LavaSR.enhancer.linkwitz_merge import FastLRMerge
    model.bwe_model.lr_refiner = FastLRMerge(device=device, cutoff=cutoff, transition_bins=1024)

    kwargs = dict(
        enhance=True,
        denoise=args.denoise,
        batch=False,
    )

    print(f'LavaSR running inference (denoise={args.denoise}, cutoff={cutoff})')

    # We process in 10-second chunks with 0.5s overlap to avoid boundary clicks
    # and keep memory usage bounded.
    chunk_sec = 10.0
    overlap_sec = 0.5
    chunk_samples = int(chunk_sec * 16000)
    overlap_samples = int(overlap_sec * 16000)
    stride_samples = chunk_samples - overlap_samples

    total_samples = audio_t.shape[-1]
    out_total_samples = total_samples * 3
    output_audio = torch.zeros((1, out_total_samples), dtype=torch.float32, device='cpu')

    out_overlap_samples = overlap_samples * 3
    fade_in = torch.linspace(0, 1, out_overlap_samples, device='cpu')
    fade_out = torch.linspace(1, 0, out_overlap_samples, device='cpu')

    with torch.no_grad():
        start = 0
        while start < total_samples:
            end = min(total_samples, start + chunk_samples)
            chunk = audio_t[:, start:end]

            # LavaSR needs at least 1 second to not crash some internal convolutions
            pad_len = 0
            if chunk.shape[-1] < 16000:
                pad_len = 16000 - chunk.shape[-1]
                chunk = torch.nn.functional.pad(chunk, (0, pad_len))

            out_chunk = model.enhance(chunk, **kwargs).cpu()
            if out_chunk.dim() == 1:
                out_chunk = out_chunk.unsqueeze(0)

            if pad_len > 0:
                out_chunk = out_chunk[:, :-(pad_len * 3)]

            out_start = start * 3
            out_end = out_start + out_chunk.shape[-1]

            # Construct flat-top window
            win = torch.ones(out_chunk.shape[-1], device='cpu')
            if start > 0 and win.shape[0] > out_overlap_samples:
                win[:out_overlap_samples] = fade_in
            if end < total_samples and win.shape[0] > out_overlap_samples:
                win[-out_overlap_samples:] = fade_out

            output_audio[:, out_start:out_end] += out_chunk * win.unsqueeze(0)

            if end == total_samples:
                break

            start += stride_samples

    output_t = output_audio

    # ── Save wideband output at 48 kHz ────────────────────────────────────────
    # The Node.js stage (decodeToFloat32) resamples back to 44.1 kHz.
    output_np = output_t.numpy().T  # [samples, 1] for soundfile
    sf.write(args.output, output_np, 48000, subtype='FLOAT')

    print(f'LavaSR complete: {args.input} -> {args.output} (48000 Hz)')


if __name__ == '__main__':
    main()
