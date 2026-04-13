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

    import numpy as np
    from math import gcd
    from scipy.io import wavfile
    from scipy.signal import resample_poly

    def _resample(audio, orig_sr, target_sr):
        """Polyphase resample a (channels, samples) float32 array."""
        if orig_sr == target_sr:
            return audio
        g = gcd(target_sr, orig_sr)
        up, down = target_sr // g, orig_sr // g
        return np.stack([
            resample_poly(ch, up, down).astype(np.float32)
            for ch in audio
        ])

    # Load input — pipeline format is 32-bit float 44.1 kHz
    # wavfile returns (samples,) mono or (samples, channels) stereo
    sr, audio_np = wavfile.read(args.input)
    audio_np = audio_np.astype(np.float32)
    if audio_np.ndim == 1:
        waveform = audio_np[np.newaxis, :]   # (1, samples)
    else:
        waveform = audio_np.T                # (channels, samples)

    # Resample to 48 kHz for RNNoise
    waveform = _resample(waveform, sr, RNNOISE_SR)

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
            waveform = waveform.mean(axis=0, keepdims=True)

        # Write 16-bit PCM WAV at 48 kHz for RNNoise (clamp to prevent overflow)
        fd_in, tmp_in   = tempfile.mkstemp(suffix='_rnn_in.wav')
        fd_out, tmp_out = tempfile.mkstemp(suffix='_rnn_out.wav')
        os.close(fd_in)
        os.close(fd_out)

        try:
            pcm16 = np.clip(waveform[0] * 32767, -32768, 32767).astype(np.int16)
            wavfile.write(tmp_in, RNNOISE_SR, pcm16)
            rnn = RNNoise(sample_rate=RNNOISE_SR)
            # denoise_wav is a generator — must be fully consumed to produce output
            for _ in rnn.denoise_wav(tmp_in, tmp_out):
                pass

            if os.path.exists(tmp_out) and os.path.getsize(tmp_out) > 44:
                _, rnn_out = wavfile.read(tmp_out)
                waveform = rnn_out.astype(np.float32)[np.newaxis, :] / 32767.0
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
    waveform = _resample(waveform, RNNOISE_SR, PIPELINE_SR)

    # Write 32-bit float WAV at 44.1 kHz, mono
    wavfile.write(args.output, PIPELINE_SR, waveform[0].astype(np.float32))


if __name__ == '__main__':
    main()
