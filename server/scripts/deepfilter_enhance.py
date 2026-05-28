#!/usr/bin/env python3
"""
DeepFilterNet3 enhancement script for Instant Polish pipeline.

Usage:
  python3 deepfilter_enhance.py --input <path> --output <path> [--atten-lim-db <float>]

Reads a WAV file, resamples to 48 kHz for DeepFilterNet3, applies noise
reduction, then writes the result as 32-bit float PCM WAV at 48 kHz.
The caller (noiseReduce.js) resamples back to 44.1 kHz via FFmpeg.

Alignment: DeepFilterNet3 introduces ~10 ms of algorithmic fade-in delay
(480 samples at 48 kHz). The script internally prepends `hop_size + 480`
samples of silence — `hop_size` ensures the first STFT window is fully
reconstructed, and the extra 480 absorbs the algorithmic delay (the same
correction the JS wrapper used to apply via padStart before invoking this
script). After enhancement the same number of samples is stripped from the
front, so the output length at 48 kHz matches the input length at 48 kHz
and the caller no longer needs a separate `trimStartMs` pass when
resampling back to 44.1 kHz.

Worker integration: when invoked through the persistent worker (_worker.py),
the model is loaded once on the first call and cached in module state for
every subsequent call. The standalone CLI path re-loads it each invocation,
matching pre-worker behavior.
"""
import argparse
import os
import warnings

warnings.filterwarnings('ignore')


# Module-level model cache. Populated lazily on the first call; reused by
# every subsequent run() inside the persistent worker.
_DF_STATE = None


def _get_model():
    """Load DeepFilterNet3 once per process. Returns (model, df_state, model_sr)."""
    global _DF_STATE
    if _DF_STATE is not None:
        return _DF_STATE

    import torch
    from df.enhance import init_df

    num_threads = int(os.environ.get('TORCH_NUM_THREADS', os.cpu_count() or 4))
    torch.set_num_threads(num_threads)

    # Weights cached at ~/.cache/DeepFilterNet/DeepFilterNet3
    model, df_state, _ = init_df()
    model_sr = df_state.sr()  # 48000
    print(f'[deepfilter] model=DeepFilterNet3 sr={model_sr} loaded', flush=True)

    _DF_STATE = (model, df_state, model_sr)
    return _DF_STATE


def main(argv=None):
    parser = argparse.ArgumentParser(description='Apply DeepFilterNet3 noise reduction')
    parser.add_argument('--input', required=True, help='Input WAV file path')
    parser.add_argument('--output', required=True, help='Output WAV file path')
    parser.add_argument(
        '--atten-lim-db', type=float, default=None,
        help='Maximum noise attenuation in dB (omit for no limit)',
    )
    args = parser.parse_args(argv)

    import torch
    import torch.nn.functional as F
    from df.enhance import enhance, load_audio, save_audio

    model, df_state, model_sr = _get_model()
    print(f'[deepfilter] atten_lim_db={args.atten_lim_db}', flush=True)

    # Load input and resample to 48 kHz for the model
    audio, _ = load_audio(args.input, sr=model_sr)
    duration_s = audio.shape[-1] / model_sr
    print(f'[deepfilter] input duration={duration_s:.2f}s', flush=True)

    # Pre-pad: hop_size for STFT overlap-add fade-in + 10 ms for the
    # algorithmic delay that the JS wrapper used to compensate for via a
    # separate padStart pass. Both portions are stripped after enhance so
    # the output is length-equivalent to the input at 48 kHz.
    hop_size = df_state.hop_size()
    delay_pad = int(0.010 * model_sr)  # 480 at 48 kHz; absorbs DF3 delay
    total_pad = hop_size + delay_pad
    audio_padded = F.pad(audio, (total_pad, 0))

    # Apply DeepFilterNet3; atten_lim_db=None means no attenuation limit (Tier 5)
    enhanced = enhance(model, df_state, audio_padded, atten_lim_db=args.atten_lim_db)

    # Strip the pre-padding from the output
    enhanced = enhanced[..., total_pad:]

    # Write 32-bit float WAV at 48 kHz — caller resamples to 44.1 kHz
    save_audio(args.output, enhanced, sr=model_sr, dtype=torch.float32)
    print('[deepfilter] done', flush=True)

    return {
        'model': 'DeepFilterNet3',
        'model_sr': model_sr,
        'atten_lim_db': args.atten_lim_db,
        'duration_s': duration_s,
    }


def run(argv):
    """Entry point used by the persistent worker (_worker.py)."""
    return main(argv)


if __name__ == '__main__':
    main()
