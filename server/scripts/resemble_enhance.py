#!/usr/bin/env python3
"""
Resemble Enhance denoising and enhancement script.

Wraps the resemble-enhance Python package (MIT) with a file I/O interface
compatible with the Instant Polish pipeline (32-bit float WAV at 44.1 kHz).

Two operation modes:

  denoise (default for safe/ACX use):
    Runs only the UNet denoiser. Analogous to a high-quality neural NR pass.
    Deterministic. Voice transparency risk is low.

  enhance:
    Runs denoise first, then the CFM-based diffusion enhancer.
    Adds bandwidth extension and perceptual quality restoration.
    Replaces the combined NR + AudioSR BWE pass in a single model call.
    Non-deterministic. May alter voice timbre at high lambd values.
    Use lambd closer to 0.0 to reduce enhancement aggressiveness.

Key parameters (enhance mode only):
  --nfe     Number of CFM function evaluations (default: 64; higher = better, slower)
  --solver  ODE solver: euler, midpoint, rk4 (default: midpoint)
  --lambd   Blend between enhancement (0.0) and denoising (1.0) character (default: 0.1)
  --tau     CFM conditioning noise level — lower = more faithful to input (default: 0.5)

Usage:
  python3 resemble_enhance.py --input <path> --output <path>
                              [--mode denoise|enhance]
                              [--nfe 64] [--solver midpoint]
                              [--lambd 0.1] [--tau 0.5]
                              [--device auto|cpu|cuda]

Input/output: 32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
"""
import argparse
import warnings

warnings.filterwarnings('ignore')

PIPELINE_SR = 44100


def resolve_device(device_arg):
    if device_arg == 'auto':
        import torch
        return 'cuda' if torch.cuda.is_available() else 'cpu'
    return device_arg


def main():
    parser = argparse.ArgumentParser(description='Resemble Enhance denoising/enhancement')
    parser.add_argument('--input',  required=True,
                        help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output', required=True,
                        help='Output WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--mode', default='enhance', choices=['denoise', 'enhance'],
                        help='Operation mode (default: enhance)')
    parser.add_argument('--nfe', type=int, default=64,
                        help='CFM function evaluations — enhance mode only (default: 64)')
    parser.add_argument('--solver', default='midpoint', choices=['euler', 'midpoint', 'rk4'],
                        help='ODE solver — enhance mode only (default: midpoint)')
    parser.add_argument('--lambd', type=float, default=0.1,
                        help='Enhance/denoise blend 0.0–1.0 — enhance mode only (default: 0.1)')
    parser.add_argument('--tau', type=float, default=0.5,
                        help='CFM conditioning noise level — enhance mode only (default: 0.5)')
    parser.add_argument('--device', default='auto',
                        help='Compute device: auto, cpu, or cuda (default: auto)')
    args = parser.parse_args()

    import torch
    import torchaudio
    import torchaudio.transforms as T

    try:
        from resemble_enhance.enhancer.inference import denoise, enhance
    except ImportError as e:
        print(f'ERROR: resemble-enhance import failed: {e}', flush=True)
        raise

    device = resolve_device(args.device)

    waveform, sr = torchaudio.load(args.input)  # (channels, samples)

    # resemble-enhance operates on 1-D mono tensors.
    # Caller is responsible for stereo handling (mono mixdown if needed).
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0)  # (channels, samples) → (samples,)
    else:
        waveform = waveform.squeeze(0)   # (1, samples) → (samples,)

    # Guard against unexpected sample rate (pipeline always delivers 44.1 kHz)
    if sr != PIPELINE_SR:
        waveform = T.Resample(orig_freq=sr, new_freq=PIPELINE_SR)(waveform)
        sr = PIPELINE_SR

    if args.mode == 'denoise':
        out_wav, out_sr = denoise(waveform, sr, device)
    else:
        out_wav, out_sr = enhance(
            waveform, sr, device,
            nfe=args.nfe,
            solver=args.solver,
            lambd=args.lambd,
            tau=args.tau,
        )

    # Resample output if model returns a different rate (resemble-enhance is 44.1 kHz native)
    if out_sr != PIPELINE_SR:
        out_wav = T.Resample(orig_freq=out_sr, new_freq=PIPELINE_SR)(out_wav)

    # Ensure (1, samples) shape for torchaudio.save
    if out_wav.dim() == 1:
        out_wav = out_wav.unsqueeze(0)

    torchaudio.save(
        args.output,
        out_wav.cpu(),
        PIPELINE_SR,
        bits_per_sample=32,
        encoding='PCM_F',
    )
    print(f'Resemble Enhance ({args.mode}) complete.', flush=True)


if __name__ == '__main__':
    main()
