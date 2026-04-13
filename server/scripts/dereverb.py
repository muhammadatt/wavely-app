#!/usr/bin/env python3
"""
Dereverberation stage — removes room reflections from voice audio using
Weighted Prediction Error (WPE) algorithms.

Strength levels:
  light  — NARA-WPE (NumPy, taps=5,  delay=3, iterations=3)  ~2–3s / 60s clip
  medium — NARA-WPE (NumPy, taps=10, delay=3, iterations=5)  ~4–6s / 60s clip
  heavy  — VACE-WPE (4M-param BLSTM + WPE)                   ~8–15s / 60s clip (GPU auto)

Usage:
  python3 dereverb.py --input <path> --output <path>
                      [--strength light|medium|heavy]
                      [--preserve-early]

--preserve-early bumps WPE delay by +2 (light/medium only) to protect early
reflections that contribute room "air". Has no effect for heavy.

Input/output: 32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
NARA-WPE is tuned for speech at 16 kHz; audio is resampled to 16 kHz
internally and resampled back to 44.1 kHz before writing output.
"""

import argparse
import sys
import warnings

warnings.filterwarnings('ignore')

PIPELINE_SR = 44100   # Pipeline internal format
WPE_SR      = 16000   # WPE tuned for speech at 16 kHz

STFT_SIZE  = 512
STFT_SHIFT = 128

WPE_PARAMS = {
    'light':  {'taps': 5,  'delay': 3, 'iterations': 3},
    'medium': {'taps': 10, 'delay': 3, 'iterations': 5},
}

# ── VACE-WPE (heavy path) constants ──────────────────────────────────────────
# STFT options must match the training config from vace_wpe/run.py.
# The model was trained on 16 kHz audio; dereverb.py downsamples to WPE_SR
# before invoking VACE-WPE, so these parameters are correct.
VACE_WPE_STFT_OPTS = dict(
    n_fft=1024, hop_length=256, win_length=1024,
    win_type='hanning', symmetric=True,
)
VACE_WPE_TAPS  = 30  # single-channel NeuralWPE taps (from run.py: taps1=30)
VACE_WPE_DELAY = 3   # WPE delay frames (from run.py)


def main():
    parser = argparse.ArgumentParser(description='Apply WPE dereverberation')
    parser.add_argument('--input',          required=True,          help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output',         required=True,          help='Output WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--strength',       default='medium',       choices=['light', 'medium', 'heavy'])
    parser.add_argument('--preserve-early', action='store_true',    help='Protect early reflections (+2 WPE delay)')
    args = parser.parse_args()

    import numpy as np
    import torchaudio
    import torchaudio.transforms as T

    # Load — pipeline format is 32-bit float 44.1 kHz, shape (channels, samples)
    waveform, sr = torchaudio.load(args.input)
    n_channels   = waveform.shape[0]

    # Mix to mono for WPE (single-channel voice processing)
    if n_channels > 1:
        audio_mono = waveform.mean(dim=0).numpy()
    else:
        audio_mono = waveform[0].numpy()

    # Resample to 16 kHz (WPE parameter defaults tuned for speech at 16k)
    if sr != WPE_SR:
        resampler_down = T.Resample(orig_freq=sr, new_freq=WPE_SR)
        import torch
        audio_16k = resampler_down(torch.tensor(audio_mono, dtype=torch.float32).unsqueeze(0))[0].numpy()
    else:
        audio_16k = audio_mono

    original_len = len(audio_16k)

    if args.strength in ('light', 'medium'):
        result_16k = _run_nara_wpe(audio_16k, args.strength, args.preserve_early)
    elif args.strength == 'heavy':
        result_16k = _run_vace_wpe(audio_16k)
    else:
        print(f'[dereverb] Unknown strength: {args.strength}', file=sys.stderr)
        sys.exit(1)

    # Restore original length (STFT causes minor length drift)
    import librosa
    result_16k = librosa.util.fix_length(result_16k, size=original_len)

    # Resample back to pipeline SR
    if sr != WPE_SR:
        import torch
        resampler_up = T.Resample(orig_freq=WPE_SR, new_freq=sr)
        result = resampler_up(torch.tensor(result_16k, dtype=torch.float32).unsqueeze(0))[0].numpy()
    else:
        result = result_16k

    # Restore original sample count at pipeline SR
    original_pipeline_len = waveform.shape[1]
    result = librosa.util.fix_length(result, size=original_pipeline_len)

    # Write 32-bit float WAV at pipeline SR, mono
    import torch
    out_waveform = torch.tensor(result, dtype=torch.float32).unsqueeze(0)
    torchaudio.save(
        args.output,
        out_waveform,
        sr,
        bits_per_sample=32,
        encoding='PCM_F',
    )
    print(f'[dereverb] Done: strength={args.strength} preserve_early={args.preserve_early}', flush=True)


def _run_nara_wpe(audio: 'np.ndarray', strength: str, preserve_early: bool) -> 'np.ndarray':
    """Apply NARA-WPE single-channel dereverberation."""
    import numpy as np
    from nara_wpe.wpe import wpe
    from nara_wpe.utils import stft, istft

    params = WPE_PARAMS[strength].copy()
    if preserve_early:
        params['delay'] = params['delay'] + 2

    # STFT → (F, T) complex, then add channel dim → (F, 1, T)
    Y = stft(audio, size=STFT_SIZE, shift=STFT_SHIFT).T
    Y_wpe = Y[:, np.newaxis, :]

    Z = wpe(
        Y_wpe,
        taps=params['taps'],
        delay=params['delay'],
        iterations=params['iterations'],
        statistics_mode='full',
    )  # (F, 1, T)

    result = istft(Z[:, 0, :].T, size=STFT_SIZE, shift=STFT_SHIFT)
    print(
        f'[dereverb] NARA-WPE {strength}: taps={params["taps"]} '
        f'delay={params["delay"]} iterations={params["iterations"]}',
        flush=True,
    )
    return result


def _run_vace_wpe(audio: 'np.ndarray') -> 'np.ndarray':
    """Apply VACE-WPE (4M-param BLSTM + WPE) dereverberation."""
    import os
    import torch

    # Ensure vendor/vace_wpe is importable (adds repo root so both
    # `bldnn_4M62` and `torch_custom.*` are resolvable as top-level modules)
    vendor_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        '..', '..', 'vendor', 'vace_wpe',
    )
    vendor_path = os.path.normpath(vendor_path)
    if vendor_path not in sys.path:
        sys.path.insert(0, vendor_path)

    try:
        from torch_custom.torch_utils import to_arr
    except ImportError as e:
        print(
            f'[dereverb] VACE-WPE import failed ({e}). '
            'Ensure vendor/vace_wpe is cloned (git clone https://github.com/dreadbird06/vace_wpe vendor/vace_wpe). '
            'Falling back to NARA-WPE medium.',
            file=sys.stderr,
        )
        return _run_nara_wpe(audio, 'medium', False)

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model  = _get_vace_model(device)

    # NeuralWPE.forward() expects (batch, channels, samples)
    waveform = torch.tensor(audio, dtype=torch.float32).unsqueeze(0).unsqueeze(0).to(device)
    with torch.no_grad():
        result = model(waveform, delay=VACE_WPE_DELAY, taps=VACE_WPE_TAPS)  # (1, 1, T)

    out = to_arr(result.squeeze())  # → 1-D numpy array
    print(f'[dereverb] VACE-WPE heavy: device={device}', flush=True)
    return out


# ── VACE-WPE model cache (one load per process) ───────────────────────────────

_vace_model_cache = None


def _get_vace_model(device):
    """Load VACE-WPE model once and cache for the process lifetime.

    The vendor/vace_wpe repo stores checkpoints in dated subdirectories as
    extension-less files named `ckpt-ep60`, e.g.:
        vendor/vace_wpe/models/20210129-140530/ckpt-ep60
    Override the default path with the VACE_WPE_CHECKPOINT environment variable.
    """
    global _vace_model_cache
    if _vace_model_cache is not None:
        return _vace_model_cache

    import os
    # bldnn_4M62 and torch_custom are top-level modules in vendor/vace_wpe
    from bldnn_4M62 import LstmDnnNet as LPSEstimator
    from torch_custom.neural_wpe import NeuralWPE
    from torch_custom.torch_utils import load_checkpoint

    checkpoint_path = os.environ.get(
        'VACE_WPE_CHECKPOINT',
        os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            '..', '..', 'vendor', 'vace_wpe',
            'models', '20210129-140530', 'ckpt-ep60',
        ),
    )
    checkpoint_path = os.path.normpath(checkpoint_path)

    # LPSEstimator (LPSNet) provides the neural PSD estimator used by NeuralWPE.
    # STFT opts and scope must match the training configuration in vace_wpe/run.py.
    fft_bins = VACE_WPE_STFT_OPTS['n_fft'] // 2 + 1
    lpsnet = LPSEstimator(
        input_dim=fft_bins,
        stft_opts=VACE_WPE_STFT_OPTS,
        input_norm='globalmvn',
        scope='ldnn_lpseir_ns',
    )

    model = NeuralWPE(stft_opts=VACE_WPE_STFT_OPTS, lpsnet=lpsnet)
    # load_checkpoint signature: (model, optimizer=None, checkpoint=..., strict=True)
    # Returns (model, learning_rate, iteration) — we only need the model.
    # strict=False: the checkpoint is a full VACE-WPE save that also contains
    # vacenet.* and melfeatext.* weights — NeuralWPE only needs the lpsnet.*
    # subset, so we let load_state_dict silently skip the unexpected keys.
    # This matches how run.py loads NeuralWPE from these same checkpoints.
    model, *_ = load_checkpoint(model, checkpoint=checkpoint_path, strict=False)
    # NeuralWPE.eval() overrides nn.Module.eval() without returning self,
    # so chaining .eval().to(device) would crash. Call separately.
    model.eval()
    model.to(device)

    _vace_model_cache = model
    return _vace_model_cache


if __name__ == '__main__':
    main()
