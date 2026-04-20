#!/usr/bin/env python3
"""
DTLN (Dual-signal Transformation LSTM Network) noise reduction.

Usage:
  python3 dtln_denoise.py --input <path> --output <path> [--device <auto|cuda|cpu>]

Environment variables:
  DTLN_REPO        Path to cloned DTLN_pytorch repository.
                   Defaults to vendor/dtln_pytorch relative to the repo root
                   (two levels up from this script's directory).
  DTLN_CHECKPOINT  Path to the .pth checkpoint file.
                   Defaults to <DTLN_REPO>/DTLN_norm_500h.pth.

Input/output: 32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
DTLN operates at 16 kHz internally. This script resamples 44.1 kHz -> 16 kHz
before processing and resamples back to 44.1 kHz on output.

Mono-only: stereo inputs are mixed to mono before processing. The output is
mono regardless of the input channel count.

If DTLN is unavailable (repo or checkpoint not found), the script passes audio
through unchanged with a warning on stderr — it does NOT exit with a non-zero
code, preserving the pipeline fallback contract established by rnnoise_denoise.py.
"""
import argparse
import os
import sys
import warnings

warnings.filterwarnings('ignore')

DTLN_SR     = 16000   # DTLN internal sample rate
PIPELINE_SR = 44100   # Pipeline internal format


def resolve_repo_path():
    """Return the DTLN_pytorch repo root. DTLN_REPO env wins; else vendor/dtln_pytorch
    two directory levels above this script (i.e. <repo_root>/vendor/dtln_pytorch)."""
    env = os.environ.get('DTLN_REPO')
    if env:
        return os.path.abspath(env)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root  = os.path.abspath(os.path.join(script_dir, '..', '..'))
    return os.path.join(repo_root, 'vendor', 'dtln_pytorch')


def main():
    parser = argparse.ArgumentParser(description='Apply DTLN noise reduction')
    parser.add_argument('--input',  required=True, help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output', required=True, help='Output WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--device', default='auto', help='Compute device: auto, cuda, or cpu')
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

    # ── Load input ────────────────────────────────────────────────────────────
    sr, audio_np = wavfile.read(args.input)
    audio_np = audio_np.astype(np.float32)
    if audio_np.ndim == 1:
        waveform = audio_np[np.newaxis, :]   # (1, samples)
    else:
        waveform = audio_np.T                # (channels, samples)

    # Mix to mono — DTLN is mono-only
    if waveform.shape[0] > 1:
        waveform = waveform.mean(axis=0, keepdims=True)

    # ── Resample to 16 kHz for DTLN ───────────────────────────────────────────
    waveform = _resample(waveform, sr, DTLN_SR)

    # ── Resolve repo and checkpoint paths ─────────────────────────────────────
    dtln_repo       = resolve_repo_path()
    checkpoint_path = os.environ.get('DTLN_CHECKPOINT')
    if not checkpoint_path:
        # Try multiple possible model files in order of preference
        possible_models = [
            'DTLN_norm_500h.pth',      # Original expected model
            'pretrained/model.pth',     # Available model in repo
            'model.pth'                 # Fallback
        ]
        checkpoint_path = None
        for model_name in possible_models:
            candidate = os.path.join(dtln_repo, model_name)
            if os.path.isfile(candidate):
                checkpoint_path = candidate
                break

        if not checkpoint_path:
            # Default to the first option for error reporting
            checkpoint_path = os.path.join(dtln_repo, possible_models[0])

    checkpoint_path = os.path.abspath(checkpoint_path)

    repo_missing       = not os.path.isdir(dtln_repo)
    checkpoint_missing = not os.path.isfile(checkpoint_path)

    # ── Graceful fallback ─────────────────────────────────────────────────────
    if repo_missing or checkpoint_missing:
        if repo_missing:
            print(
                f'[dtln] WARNING: DTLN repo not found at {dtln_repo}.\n'
                'Clone it with:\n'
                '  git clone https://github.com/lhwcv/DTLN_pytorch vendor/dtln_pytorch\n'
                'Or set the DTLN_REPO environment variable.',
                file=sys.stderr,
            )
        if checkpoint_missing:
            print(
                f'[dtln] WARNING: DTLN checkpoint not found at {checkpoint_path}.\n'
                'The pretrained model DTLN_norm_500h.pth should be present inside\n'
                'the cloned repo, or set DTLN_CHECKPOINT to the .pth file path.',
                file=sys.stderr,
            )
        print('[dtln] WARNING: DTLN unavailable — passing audio through unchanged.', file=sys.stderr)
        waveform = _resample(waveform, DTLN_SR, PIPELINE_SR)
        wavfile.write(args.output, PIPELINE_SR, waveform[0].astype(np.float32))
        return

    # ── Import DTLN from vendored repo ────────────────────────────────────────
    sys.path.insert(0, dtln_repo)
    try:
        import torch
        from DTLN_model import DTLN
    except ImportError as exc:
        print(
            f'[dtln] WARNING: Failed to import DTLN — {exc}\n'
            'Passing audio through unchanged.',
            file=sys.stderr,
        )
        waveform = _resample(waveform, DTLN_SR, PIPELINE_SR)
        wavfile.write(args.output, PIPELINE_SR, waveform[0].astype(np.float32))
        return

    # ── Device selection ──────────────────────────────────────────────────────
    if args.device == 'auto':
        device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    else:
        device = torch.device(args.device)

    num_threads = int(os.environ.get('TORCH_NUM_THREADS', os.cpu_count() or 4))
    torch.set_num_threads(num_threads)
    print(f'[dtln] device={device}  threads={num_threads}', flush=True)

    # ── Load model ────────────────────────────────────────────────────────────
    model = DTLN()
    state_dict = torch.load(checkpoint_path, map_location=device)
    model.load_state_dict(state_dict)
    model.to(device)
    model.eval()
    print(f'[dtln] Loaded checkpoint: {checkpoint_path}', flush=True)

    # ── Run inference ─────────────────────────────────────────────────────────
    # model(x) expects (batch, time) and returns (batch, time) at 16 kHz
    audio_tensor = torch.from_numpy(waveform[0]).unsqueeze(0).to(device)   # (1, T)
    duration_s   = audio_tensor.shape[-1] / DTLN_SR
    print(f'[dtln] input duration={duration_s:.2f}s', flush=True)

    with torch.no_grad():
        enhanced = model(audio_tensor)   # (1, T)

    enhanced_np = enhanced.squeeze(0).cpu().numpy().astype(np.float32)
    waveform    = enhanced_np[np.newaxis, :]   # (1, T)

    # ── Resample back to 44.1 kHz and write output ────────────────────────────
    waveform = _resample(waveform, DTLN_SR, PIPELINE_SR)
    wavfile.write(args.output, PIPELINE_SR, waveform[0].astype(np.float32))
    print('[dtln] Done', flush=True)


if __name__ == '__main__':
    main()
