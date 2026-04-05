#!/usr/bin/env python3
"""
RNNoise pre-separation pass for Noise Eraser pipeline (Stage NE-1).

Applies Mozilla RNNoise to reduce stationary broadband noise before source
separation. Goal is to improve the SNR going into Demucs/ConvTasNet, not to
fully clean the file — RNNoise contributes approximately 5–10 dB of reduction
on stationary noise components.

Usage:
  python3 rnnoise_denoise.py --input <path> --output <path>

Input/output: 32-bit float PCM WAV at 44.1 kHz (pipeline internal format).

RNNoise operates at 48 kHz internally. This script resamples to 48 kHz before
processing and resamples back to 44.1 kHz on output.

No attenuation ceiling — RNNoise operates at its natural output level.
Artifact assessment is deferred to Stage NE-4 (post-separation validation).
"""
import argparse
import warnings

warnings.filterwarnings('ignore')

RNNOISE_SR   = 48000   # RNNoise internal sample rate
PIPELINE_SR  = 44100   # Pipeline internal format


def main():
    parser = argparse.ArgumentParser(description='Apply RNNoise pre-separation pass')
    parser.add_argument('--input',  required=True, help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output', required=True, help='Output WAV (32-bit float, 44.1 kHz)')
    args = parser.parse_args()

    import torch
    import torchaudio
    import torchaudio.transforms as T

    # Load input — pipeline format is 32-bit float 44.1 kHz
    waveform, sr = torchaudio.load(args.input)   # shape: (channels, samples)

    # Resample to 48 kHz for RNNoise
    if sr != RNNOISE_SR:
        resampler_up = T.Resample(orig_freq=sr, new_freq=RNNOISE_SR)
        waveform = resampler_up(waveform)

    # Apply RNNoise channel-by-channel (operates on mono chunks)
    try:
        from pyrnnoise import RNNoise
        denoised_channels = []
        for ch in range(waveform.shape[0]):
            channel_np = waveform[ch].numpy()
            rnn = RNNoise(sample_rate=RNNOISE_SR)
            cleaned = rnn.process_wav(channel_np)
            denoised_channels.append(torch.from_numpy(cleaned))
        waveform = torch.stack(denoised_channels, dim=0)
    except ImportError:
        # Fallback: if pyrnnoise unavailable, pass through with a warning.
        # This allows the pipeline to run in dev environments without pyrnnoise
        # installed, at the cost of skipping NE-1. The separation stage (NE-3)
        # can still produce usable output without the pre-pass.
        import sys
        print('[rnnoise] WARNING: pyrnnoise not installed — NE-1 pre-pass skipped, '
              'passing audio through unchanged.', file=sys.stderr)

    # Resample back to 44.1 kHz (pipeline internal format)
    if waveform.shape[-1] > 0:
        resampler_down = T.Resample(orig_freq=RNNOISE_SR, new_freq=PIPELINE_SR)
        waveform = resampler_down(waveform)

    # Write 32-bit float WAV at 44.1 kHz
    torchaudio.save(
        args.output,
        waveform,
        PIPELINE_SR,
        bits_per_sample=32,
        encoding='PCM_F',
    )


if __name__ == '__main__':
    main()
