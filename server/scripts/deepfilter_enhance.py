#!/usr/bin/env python3
"""
DeepFilterNet3 enhancement script for Instant Polish pipeline.

Usage:
  python3 deepfilter_enhance.py --input <path> --output <path> [--atten-lim-db <float>]

Reads a WAV file, resamples to 48 kHz for DeepFilterNet3, applies noise
reduction, then writes the result as 32-bit float PCM WAV at 48 kHz.
The caller (noiseReduce.js) resamples back to 44.1 kHz via FFmpeg.
"""
import argparse
import os
import warnings

warnings.filterwarnings('ignore')


def main():
    parser = argparse.ArgumentParser(description='Apply DeepFilterNet3 noise reduction')
    parser.add_argument('--input', required=True, help='Input WAV file path')
    parser.add_argument('--output', required=True, help='Output WAV file path')
    parser.add_argument(
        '--atten-lim-db', type=float, default=None,
        help='Maximum noise attenuation in dB (omit for no limit)',
    )
    args = parser.parse_args()

    import torch
    from df.enhance import enhance, init_df, load_audio, save_audio

    num_threads = int(os.environ.get('TORCH_NUM_THREADS', os.cpu_count() or 4))
    torch.set_num_threads(num_threads)

    # Load model — weights cached at ~/.cache/DeepFilterNet/DeepFilterNet3
    model, df_state, _ = init_df()
    model_sr = df_state.sr()  # 48000
    print(f'[deepfilter] model=DeepFilterNet3 sr={model_sr} atten_lim_db={args.atten_lim_db}', flush=True)

    # Load input and resample to 48 kHz for the model
    audio, _ = load_audio(args.input, sr=model_sr)
    duration_s = audio.shape[-1] / model_sr
    print(f'[deepfilter] input duration={duration_s:.2f}s', flush=True)

    # Apply DeepFilterNet3; atten_lim_db=None means no attenuation limit (Tier 5)
    enhanced = enhance(model, df_state, audio, atten_lim_db=args.atten_lim_db)

    # Write 32-bit float WAV at 48 kHz — caller resamples to 44.1 kHz
    save_audio(args.output, enhanced, sr=model_sr, dtype=torch.float32)
    print(f'[deepfilter] done', flush=True)


if __name__ == '__main__':
    main()
