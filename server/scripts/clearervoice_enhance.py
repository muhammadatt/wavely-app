#!/usr/bin/env python3
"""
ClearerVoice speech enhancement for ClearerVoice Eraser pipeline (Stage CE-3).

Uses ClearerVoice-Studio (github.com/modelscope/ClearerVoice-Studio) to perform
neural speech enhancement, replacing Demucs source separation with a single-model
enhancement pass.

Supports two enhancement models selectable via --model:

  mossformer2_48k (default)
    Model:   MossFormer2_SE_48K
    Quality: Excellent — full-band 48 kHz speech enhancement.
             Handles broadband, tonal, and non-stationary noise.
    Speed:   ~2–5× real-time CPU, much faster on GPU.
    VRAM:    ~1–2 GB GPU.

  frcrn_16k
    Model:   FRCRN_SE_16K
    Quality: Good — frequency-recurrent CRN, efficient 16 kHz processing.
             Handles moderate noise levels well.
    Speed:   ~10–20× real-time CPU.
    VRAM:    ~500 MB GPU.

Usage:
  python3 clearervoice_enhance.py --input <path> --output <path>
                                  [--model mossformer2_48k|frcrn_16k]
                                  [--device auto|cpu|cuda]

Input:  32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
        Mono or stereo — mixed to mono before processing (ClearerVoice SE
        models operate on single-channel audio).
Output: 32-bit float PCM WAV at 44.1 kHz, mono.
"""
import argparse
import warnings

warnings.filterwarnings('ignore')

PIPELINE_SR = 44100

# Map CLI model names → ClearerVoice model identifiers and native sample rates.
# Models are downloaded from HuggingFace on first use.
MODEL_CONFIG = {
    'mossformer2_48k': {'name': 'MossFormer2_SE_48K', 'sr': 48000},
    'frcrn_16k':       {'name': 'FRCRN_SE_16K',       'sr': 16000},
}


def resolve_device(device_arg):
    if device_arg == 'auto':
        try:
            import torch
            return 'cuda' if torch.cuda.is_available() else 'cpu'
        except ImportError:
            return 'cpu'
    return device_arg


def main():
    parser = argparse.ArgumentParser(description='ClearerVoice speech enhancement')
    parser.add_argument('--input',  required=True,
                        help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output', required=True,
                        help='Output WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--model',  default='mossformer2_48k',
                        choices=list(MODEL_CONFIG.keys()),
                        help='ClearerVoice model (default: mossformer2_48k)')
    parser.add_argument('--device', default='auto',
                        help='Compute device: auto, cpu, or cuda (default: auto)')
    args = parser.parse_args()

    import numpy as np
    import soundfile as sf
    import librosa
    from clearvoice import ClearVoice

    config = MODEL_CONFIG[args.model]
    model_name = config['name']
    model_sr = config['sr']

    device = resolve_device(args.device)
    print(f'[ClearerVoice] model={model_name}  device={device}')

    # Read pipeline-format input: 32-bit float WAV at 44.1 kHz.
    # always_2d=True gives shape (samples, channels) regardless of channel count.
    audio, sr = sf.read(args.input, dtype='float32', always_2d=True)

    # Mix to mono — ClearerVoice SE models operate on single-channel audio.
    audio_mono = audio.mean(axis=1) if audio.shape[1] > 1 else audio[:, 0]

    # Resample to the model's native sample rate.
    if sr != model_sr:
        audio_model = librosa.resample(audio_mono, orig_sr=sr, target_sr=model_sr)
    else:
        audio_model = audio_mono.copy()

    # ClearerVoice numpy API expects [batch, length].
    audio_input = audio_model.reshape(1, -1).astype(np.float32)

    # Run ClearerVoice enhancement.
    # online_write=False → returns processed numpy array [batch, length]
    # rather than writing to disk itself.
    cv = ClearVoice(task='speech_enhancement', model_names=[model_name])
    output_wav = cv(audio_input, online_write=False)

    # Extract mono output from the single-item batch.
    enhanced = np.asarray(output_wav[0], dtype=np.float32)
    # Flatten any residual leading dimension (defensive — should already be 1D)
    if enhanced.ndim > 1:
        enhanced = enhanced[0]

    # Resample back to pipeline sample rate (44.1 kHz).
    if model_sr != PIPELINE_SR:
        enhanced = librosa.resample(enhanced, orig_sr=model_sr, target_sr=PIPELINE_SR)

    # Save as 32-bit float PCM WAV at 44.1 kHz mono (pipeline internal format).
    sf.write(args.output, enhanced, PIPELINE_SR, subtype='FLOAT')
    print(f'[ClearerVoice] Done — output length {len(enhanced) / PIPELINE_SR:.2f}s')


if __name__ == '__main__':
    main()
