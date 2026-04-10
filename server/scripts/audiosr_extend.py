#!/usr/bin/env python3
"""
AudioSR bandwidth extension for Noise Eraser pipeline (Stage NE-6).

Restores high-frequency voice content (air, presence, sibilance) attenuated
during source separation. Demucs and ConvTasNet both tend to suppress HF
content in noisy conditions because broadband noise and voice air/presence
occupy overlapping spectral regions.

AudioSR uses a diffusion-based super-resolution model to synthesise plausible
HF content from the low/mid-frequency voice signal. The guidance_scale parameter
controls the balance between synthesis aggressiveness and conservatism:
  - Lower values (2.0–3.0): more conservative, less synthesis
  - Default (3.5):          recommended balance for speech
  - Higher values (4.0–5.0): more aggressive synthesis, more HF content

Usage:
  python3 audiosr_extend.py --input <path> --output <path>
                            [--guidance-scale <float>]
                            [--device auto|cpu|cuda]

Input/output: 32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
"""
import argparse
import warnings

warnings.filterwarnings('ignore')

PIPELINE_SR      = 44100
DEFAULT_GUIDANCE = 3.5


def resolve_device(device_arg):
    if device_arg == 'auto':
        import torch
        return 'cuda' if torch.cuda.is_available() else 'cpu'
    return device_arg


def main():
    parser = argparse.ArgumentParser(description='AudioSR bandwidth extension')
    parser.add_argument('--input',  required=True,
                        help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output', required=True,
                        help='Output WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--guidance-scale', type=float, default=DEFAULT_GUIDANCE,
                        help=f'Diffusion guidance scale (default: {DEFAULT_GUIDANCE})')
    parser.add_argument('--device', default='auto',
                        help='Compute device: auto, cpu, or cuda (default: auto)')
    args = parser.parse_args()

    import torch
    import torchaudio
    try:
        import audiosr
    except ImportError:
        print('AudioSR is not installed in this environment — NE-6 skipped.', flush=True)
        import shutil
        shutil.copy(args.input, args.output)
        return

    device = resolve_device(args.device)
    print(f'[audiosr] Loading model on device={device} (may download ~1.5 GB on first run)', flush=True)

    # AudioSR expects a file path and returns a super-resolved waveform.
    sr_model = audiosr.build_model(model_name='basic', device=device)
    print('[audiosr] Model loaded — starting super-resolution inference '
          f'(ddim_steps=50, guidance_scale={args.guidance_scale})', flush=True)

    waveform = audiosr.super_resolution(
        sr_model,
        args.input,
        guidance_scale=args.guidance_scale,
        ddim_steps=50,
        latent_t_per_second=12.8,
    )  # returns np.ndarray or torch.Tensor, shape varies
    print('[audiosr] Inference complete — writing output', flush=True)

    # Normalise to torch.Tensor with shape (channels, samples)
    import numpy as np
    if isinstance(waveform, np.ndarray):
        waveform = torch.from_numpy(waveform)
    # Squeeze batch dims: (1, 1, samples) → (1, samples) or (1, ch, samples) → (ch, samples)
    while waveform.dim() > 2:
        waveform = waveform.squeeze(0)
    if waveform.dim() == 1:
        waveform = waveform.unsqueeze(0)  # (samples,) → (1, samples)

    # AudioSR 'basic' model outputs at 48 kHz
    AUDIOSR_OUTPUT_SR = 48000
    if AUDIOSR_OUTPUT_SR != PIPELINE_SR:
        import torchaudio.transforms as T
        resampler = T.Resample(orig_freq=AUDIOSR_OUTPUT_SR, new_freq=PIPELINE_SR)
        waveform  = resampler(waveform)

    torchaudio.save(
        args.output,
        waveform,
        PIPELINE_SR,
        bits_per_sample=32,
        encoding='PCM_F',
    )


if __name__ == '__main__':
    main()
