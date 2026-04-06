#!/usr/bin/env python3
"""
Vocal source separation for Noise Eraser pipeline (Stage NE-3).

Supports two separation backends selectable via --model:

  demucs (default)
    Model:   htdemucs_ft (fine-tuned hybrid transformer, vocals stem)
    Quality: Excellent — handles broadband, tonal, and non-stationary noise.
    Speed:   ~5–10× real-time GPU, ~0.5–1× real-time CPU.
    VRAM:    ~2–4 GB GPU.
    Params:  segment=7.8s, overlap=0.25, shifts=1

  convtasnet
    Model:   ConvTasNet trained on WHAM! (speech + noise separation)
    Quality: Good on stationary noise; faster, lower resource cost.
             Natively mono — stereo input is mixed to mono before processing.
    Speed:   ~20–30× real-time GPU, ~5–10× real-time CPU.
    VRAM:    ~500 MB GPU.

Usage:
  python3 separate_vocals.py --input <path> --output <path>
                             [--model demucs|convtasnet]
                             [--device auto|cpu|cuda]

Input:  32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
        Mono or stereo — channel conversion handled per model (see notes above).
Output: 32-bit float PCM WAV at 44.1 kHz, mono or stereo per input channels.
        Channel output is controlled by the caller (stages.separateVocals).
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


def separate_demucs(waveform, sr, device):
    """
    Run Demucs htdemucs_ft and return the vocals stem.
    waveform: torch.Tensor shape (channels, samples) at PIPELINE_SR.
    Returns: torch.Tensor (channels, samples) at PIPELINE_SR.
    """
    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model

    model = get_model('htdemucs_ft')
    model.to(device)
    model.eval()

    # htdemucs_ft expects stereo input — duplicate mono to stereo if needed
    was_mono = waveform.shape[0] == 1
    if was_mono:
        waveform = waveform.repeat(2, 1)  # (1, samples) → (2, samples)

    # apply_model expects (batch, channels, samples), returns (batch, sources, channels, samples)
    with torch.no_grad():
        sources = apply_model(
            model, waveform.unsqueeze(0).to(device),
            shifts=1, overlap=0.25, device=device, segment=7.8,
        )

    # Extract vocals stem by index — squeeze batch dim
    vocals_idx = model.sources.index('vocals')
    vocals = sources[0, vocals_idx].cpu()  # (channels, samples)

    # If input was mono, collapse stereo output back to mono
    if was_mono:
        vocals = vocals.mean(dim=0, keepdim=True)  # (2, samples) → (1, samples)

    return vocals


def separate_convtasnet(waveform, device):
    """
    Run ConvTasNet (Asteroid WHAM!) and return the speech source.
    Operates at 8 kHz internally; resamples input/output automatically.
    waveform: torch.Tensor shape (channels, samples) at PIPELINE_SR.
    Returns: torch.Tensor (1, samples) at PIPELINE_SR (mono output).
    """
    import torch
    import torchaudio.transforms as T
    from asteroid.models import ConvTasNet

    CONVTASNET_SR = 8000
    # WHAM! speech+noise model: source 0 = speech, source 1 = noise
    MODEL_ID = 'JorisCos/ConvTasNet_Libri2Mix_sepnoisy_8k'

    model = ConvTasNet.from_pretrained(MODEL_ID).to(device)
    model.eval()

    # Mix to mono for processing
    mono = waveform.mean(dim=0, keepdim=True)   # (1, samples)

    # Resample to model SR
    resamp_down = T.Resample(orig_freq=PIPELINE_SR, new_freq=CONVTASNET_SR)
    mono_8k = resamp_down(mono)

    with torch.no_grad():
        # (1, samples) → model expects (batch, samples)
        est_sources = model(mono_8k.to(device))   # (1, n_src, samples)
        speech = est_sources[0, 0:1, :].cpu()     # take speech source

    # Resample back to pipeline SR
    resamp_up = T.Resample(orig_freq=CONVTASNET_SR, new_freq=PIPELINE_SR)
    return resamp_up(speech)


def main():
    parser = argparse.ArgumentParser(description='Vocal source separation')
    parser.add_argument('--input',  required=True, help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output', required=True, help='Output WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--model',  default='demucs',
                        choices=['demucs', 'convtasnet'],
                        help='Separation backend (default: demucs)')
    parser.add_argument('--device', default='auto',
                        help='Compute device: auto, cpu, or cuda (default: auto)')
    args = parser.parse_args()

    import torch
    import torchaudio

    device = resolve_device(args.device)
    waveform, sr = torchaudio.load(args.input)  # (channels, samples)

    if args.model == 'demucs':
        vocals = separate_demucs(waveform, sr, device)
    else:
        vocals = separate_convtasnet(waveform, device)

    torchaudio.save(
        args.output,
        vocals,
        PIPELINE_SR,
        bits_per_sample=32,
        encoding='PCM_F',
    )


if __name__ == '__main__':
    main()
