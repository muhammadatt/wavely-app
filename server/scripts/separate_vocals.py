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

    Output scaling note: ConvTasNet is trained with SI-SNR loss (scale-invariant),
    so its output amplitude is arbitrary relative to the input — it can be orders of
    magnitude louder or quieter. Without rescaling, the speech stem routinely arrives
    at near 0 dBFS peak even when the input was -25 dBFS, causing heavy clipping and
    distortion in every subsequent stage. We measure input RMS before separation and
    rescale the output stem to match, which preserves the noise-reduction effect while
    restoring a sane loudness level.
    """
    import torch
    import numpy as np
    from math import gcd
    from scipy.signal import resample_poly
    from asteroid.models import ConvTasNet

    # WHAM! speech+noise model: source 0 = speech, source 1 = noise
    CONVTASNET_SR = 16000
    MODEL_ID = 'JorisCos/ConvTasNet_Libri1Mix_enhsingle_16k'

    print(f'[convtasnet] Model: {MODEL_ID}  device={device}', flush=True)
    model = ConvTasNet.from_pretrained(MODEL_ID).to(device)
    model.eval()

    # Mix to mono for processing
    mono = waveform.mean(dim=0, keepdim=True)   # (1, samples)

    # Capture input RMS at pipeline SR before resampling — used to rescale output.
    input_rms = mono.pow(2).mean().sqrt().clamp(min=1e-8)

    # Resample to model SR using scipy polyphase (no torchaudio needed)
    def _resample(t, orig_sr, target_sr):
        g = gcd(target_sr, orig_sr)
        arr = resample_poly(t.squeeze(0).numpy(), target_sr // g, orig_sr // g)
        return torch.from_numpy(arr.astype(np.float32)).unsqueeze(0)

    mono_16k = _resample(mono, PIPELINE_SR, CONVTASNET_SR)

    with torch.no_grad():
        est_sources = model(mono_16k.to(device))   # (1, n_src, samples)
        speech = est_sources[0, 0:1, :].cpu()      # take speech source

    # Resample back to pipeline SR
    speech_44k = _resample(speech, CONVTASNET_SR, PIPELINE_SR)

    # Rescale to match input RMS — ConvTasNet SI-SNR output gain is unconstrained.
    output_rms = speech_44k.pow(2).mean().sqrt().clamp(min=1e-8)
    speech_44k = speech_44k * (input_rms / output_rms)

    return speech_44k


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
    import numpy as np
    from scipy.io import wavfile

    device = resolve_device(args.device)

    # Load — scipy returns (samples,) mono or (samples, channels) stereo
    sr, audio_np = wavfile.read(args.input)
    audio_np = audio_np.astype(np.float32)
    if audio_np.ndim == 1:
        waveform = torch.from_numpy(audio_np).unsqueeze(0)   # (1, samples)
    else:
        waveform = torch.from_numpy(audio_np.T)              # (channels, samples)

    if args.model == 'demucs':
        vocals = separate_demucs(waveform, sr, device)
    else:
        vocals = separate_convtasnet(waveform, device)

    # Save — convert (channels, samples) tensor back to numpy for wavfile
    result_np = vocals.numpy()
    if result_np.shape[0] == 1:
        result_np = result_np[0]   # mono: (samples,)
    else:
        result_np = result_np.T    # stereo: (samples, channels)
    wavfile.write(args.output, PIPELINE_SR, result_np.astype(np.float32))


if __name__ == '__main__':
    main()
