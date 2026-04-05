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

    import torchaudio
    import torchaudio.transforms as T

    # Load input — pipeline format is 32-bit float 44.1 kHz
    waveform, sr = torchaudio.load(args.input)   # shape: (channels, samples)

    # Resample to 48 kHz for RNNoise
    if sr != RNNOISE_SR:
        resampler_up = T.Resample(orig_freq=sr, new_freq=RNNOISE_SR)
        waveform = resampler_up(waveform)

    # Apply RNNoise to the full file.
    # pyrnnoise.denoise_wav(in_path, out_path) operates on WAV file paths.
    # Write a 16-bit PCM WAV at 48 kHz (RNNoise's expected input format),
    # denoise, then read back and resample to pipeline format.
    try:
        from pyrnnoise import RNNoise
        import tempfile
        import os

        # Mix to mono if stereo (RNNoise is mono-only)
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)

        # Write 16-bit PCM WAV at 48 kHz for RNNoise
        fd_in, tmp_in   = tempfile.mkstemp(suffix='_rnn_in.wav')
        fd_out, tmp_out = tempfile.mkstemp(suffix='_rnn_out.wav')
        os.close(fd_in)
        os.close(fd_out)

        try:
            torchaudio.save(tmp_in, waveform, RNNOISE_SR,
                            bits_per_sample=16, encoding='PCM_S')
            rnn = RNNoise(sample_rate=RNNOISE_SR)
            rnn.denoise_wav(tmp_in, tmp_out)

            if os.path.exists(tmp_out) and os.path.getsize(tmp_out) > 44:
                waveform, _ = torchaudio.load(tmp_out)
            else:
                print('[rnnoise] WARNING: denoise_wav produced no output — '
                      'passing through unchanged.', flush=True)
        finally:
            for f in (tmp_in, tmp_out):
                if os.path.exists(f):
                    os.remove(f)
    except ImportError:
        # Fallback: if pyrnnoise unavailable, pass through with a warning.
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
