#!/usr/bin/env python3
"""
AP-BWE bandwidth extension script for Instant Polish pipeline (Stage NE-6).

Usage:
  python3 ap_bwe_extend.py --input <path> --output <path> [--device <auto|cuda|cpu>]

Environment variables:
  AP_BWE_REPO        Path to cloned AP-BWE repository.
                     Defaults to vendor/ap_bwe relative to the repo root
                     (two levels up from this script's directory).
  AP_BWE_CHECKPOINT  Path to the AP-BWE .pt checkpoint file (required).
                     The config.json must be in the same directory as the
                     checkpoint.

Reads a 32-bit float WAV at 44.1 kHz, resamples to the model's narrowband
input rate (8 kHz for the 8kto48k config), runs AP-BWE, and writes the
wideband result as a 32-bit float PCM WAV at the model's output rate (48 kHz).
The caller (stages.js) resamples back to 44.1 kHz via decodeToFloat32/FFmpeg.
"""
import argparse
import os
import sys
import warnings

warnings.filterwarnings('ignore')


def resolve_repo_path():
    """Return the AP-BWE repo root, defaulting to vendor/ap_bwe two levels up."""
    env = os.environ.get('AP_BWE_REPO')
    if env:
        return os.path.abspath(env)
    # Script lives at server/scripts/; repo root is two dirs up.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, '..', '..'))
    return os.path.join(repo_root, 'vendor', 'ap_bwe')


def main():
    parser = argparse.ArgumentParser(description='AP-BWE bandwidth extension')
    parser.add_argument('--input',  required=True,  help='Input WAV file (32-bit float, 44.1 kHz)')
    parser.add_argument('--output', required=True,  help='Output WAV file (32-bit float, 48 kHz)')
    parser.add_argument('--device', default='auto', help='Compute device: auto, cuda, or cpu')
    args = parser.parse_args()

    # ── Resolve AP-BWE repo path and add to sys.path ──────────────────────────
    ap_bwe_repo = resolve_repo_path()
    if not os.path.isdir(ap_bwe_repo):
        print(
            f'AP-BWE repo not found at {ap_bwe_repo}.\n'
            'Clone it with:\n'
            '  git clone https://github.com/yxlu-0102/AP-BWE vendor/ap_bwe\n'
            'Or set the AP_BWE_REPO environment variable to its location.',
            file=sys.stderr,
        )
        sys.exit(1)

    sys.path.insert(0, ap_bwe_repo)

    # ── Resolve checkpoint path ───────────────────────────────────────────────
    checkpoint_path = os.environ.get('AP_BWE_CHECKPOINT')
    if not checkpoint_path:
        print(
            'AP_BWE_CHECKPOINT environment variable is not set.\n'
            'Set it to the path of the AP-BWE .pt checkpoint file, e.g.:\n'
            '  export AP_BWE_CHECKPOINT=vendor/ap_bwe/checkpoints/g_8kto48k',
            file=sys.stderr,
        )
        sys.exit(1)

    checkpoint_path = os.path.abspath(checkpoint_path)
    if not os.path.isfile(checkpoint_path):
        print(
            f'AP-BWE checkpoint not found: {checkpoint_path}\n'
            'Download the 8kto48k checkpoint from:\n'
            '  https://drive.google.com/drive/folders/1IIYTf2zbJWzelu4IftKD6ooHloJ8mnZF\n'
            'Place it at the path set in AP_BWE_CHECKPOINT.',
            file=sys.stderr,
        )
        sys.exit(1)

    config_path = os.path.join(os.path.dirname(checkpoint_path), 'config.json')
    if not os.path.isfile(config_path):
        print(
            f'AP-BWE config.json not found at {config_path}.\n'
            'The config file must be in the same directory as the checkpoint.',
            file=sys.stderr,
        )
        sys.exit(1)

    # ── Imports (deferred so arg/env errors print before heavy imports) ───────
    import json
    import torch
    import torchaudio
    import torchaudio.functional as F

    from models.model import APNet_BWE_Model
    from datasets.dataset import amp_pha_stft, amp_pha_istft
    from env import AttrDict

    # ── Device selection ──────────────────────────────────────────────────────
    if args.device == 'auto':
        device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    else:
        device = torch.device(args.device)

    print(f'AP-BWE using device: {device}')

    num_threads = int(os.environ.get('TORCH_NUM_THREADS', os.cpu_count() or 4))
    torch.set_num_threads(num_threads)
    print(f'AP-BWE using {num_threads} CPU threads')

    # ── Load config and model ─────────────────────────────────────────────────
    with open(config_path) as f:
        h = AttrDict(json.load(f))

    model = APNet_BWE_Model(h).to(device)
    checkpoint_dict = torch.load(checkpoint_path, map_location=device)
    model.load_state_dict(checkpoint_dict['generator'])
    model.eval()

    print(
        f'AP-BWE model loaded: {h.lr_sampling_rate} Hz -> {h.hr_sampling_rate} Hz'
    )

    # ── Load and prepare input audio ──────────────────────────────────────────
    audio, sr = torchaudio.load(args.input)  # [C, T] at 44100 Hz

    # Mix to mono — AP-BWE operates on single-channel audio
    if audio.shape[0] > 1:
        audio = audio.mean(dim=0, keepdim=True)

    # Resample to narrowband input rate, then back up to the wideband output rate.
    # This mirrors the training dataset pipeline (dataset.py lines 74-75): the model
    # was trained on narrowband audio that has been downsampled to lr_sampling_rate
    # and then upsampled back to hr_sampling_rate before the STFT.  The STFT/iSTFT
    # parameters (n_fft, hop_size, win_size) are calibrated for hr_sampling_rate, so
    # feeding audio at lr_sampling_rate directly causes the iSTFT output to have
    # lr/hr (e.g. 8k/48k = 1/6) of the expected number of samples, which is then
    # saved with the hr_sampling_rate WAV header — producing audio that plays back
    # at hr/lr (6×) the correct speed.
    if sr != h.lr_sampling_rate:
        audio_lr = F.resample(audio, sr, h.lr_sampling_rate)
    else:
        audio_lr = audio

    # Upsample band-limited signal to the wideband rate so the STFT frame count
    # matches what the model was trained on.
    audio_lr = F.resample(audio_lr, h.lr_sampling_rate, h.hr_sampling_rate)

    audio_lr = audio_lr.to(device)

    # ── Run AP-BWE inference ──────────────────────────────────────────────────
    with torch.no_grad():
        amp_nb, pha_nb, _ = amp_pha_stft(audio_lr, h.n_fft, h.hop_size, h.win_size)
        amp_wb_g, pha_wb_g, _ = model(amp_nb, pha_nb)
        audio_wb = amp_pha_istft(amp_wb_g, pha_wb_g, h.n_fft, h.hop_size, h.win_size)

    # ── Save wideband output at model's output sample rate ────────────────────
    # Output is 48 kHz; the Node.js stage (decodeToFloat32) resamples to 44.1 kHz.
    torchaudio.save(
        args.output,
        audio_wb.cpu(),
        h.hr_sampling_rate,
        encoding='PCM_F',
        bits_per_sample=32,
    )

    print(f'AP-BWE complete: {args.input} -> {args.output} ({h.hr_sampling_rate} Hz)')


if __name__ == '__main__':
    main()
