#!/usr/bin/env python3
"""
Silero VAD v5 frame classifier for the silence analysis pipeline.

Classifies each 100 ms pipeline frame as voiced or silence using the Silero VAD
neural model. Results are written as JSON and merged with energy-based metrics
in silenceAnalysis.js (hybrid approach).

Usage:
  python3 silero_vad.py --input <path> --output <path.json>
                        [--threshold 0.5] [--device auto|cpu|cuda]

Input:  32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
Output: JSON file with per-frame isSilence classification.

Frame alignment:
  - Pipeline frame duration: 100 ms → 4410 samples @ 44.1 kHz
  - Silero operates at 16 kHz → 100 ms = 1600 samples (clean integer, no drift)
  - Silero v5 chunk size: 512 samples
  - Chunks per pipeline frame: ceil(1600 / 512) = 4 (last chunk zero-padded to 512)
  - Frame label: max(chunk_probs) >= threshold → voiced; else silence
  Using max (not mean) avoids penalizing frames where speech occupies only part
  of the window, which is common at phrase onsets and offsets.

Performance (CPU): ~50–100x real-time. A 10-minute file takes ~6–12 seconds.
The pipeline calls analyzeAudioFrames 3–4 times per job, adding ~30–50 s total
latency on CPU. Set SILERO_DEVICE=cuda to reduce this significantly.
"""
import argparse
import json
import math
import sys
import warnings

warnings.filterwarnings('ignore')

PIPELINE_SR          = 44100
SILERO_SR            = 16000
FRAME_DURATION_S     = 0.100   # Must match FRAME_DURATION_S in silenceAnalysis.js
SILERO_CHUNK_SAMPLES = 512     # Silero v5 supported chunk size at 16 kHz
DEFAULT_THRESHOLD    = 0.5


def resolve_device(device_arg):
    if device_arg == 'auto':
        import torch
        return 'cuda' if torch.cuda.is_available() else 'cpu'
    return device_arg


def main():
    parser = argparse.ArgumentParser(description='Silero VAD frame classifier')
    parser.add_argument('--input',     required=True,  help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output',    required=True,  help='Output JSON file path')
    parser.add_argument('--threshold', type=float, default=DEFAULT_THRESHOLD,
                        help='Speech probability threshold (default: 0.5)')
    parser.add_argument('--device',    default='auto', choices=['auto', 'cpu', 'cuda'],
                        help='Compute device (default: auto)')
    args = parser.parse_args()

    import torch
    import torchaudio
    import torchaudio.transforms as T

    device = resolve_device(args.device)

    # Load Silero VAD model from torch hub.
    # Weights (~10 MB) are cached at: ~/.cache/torch/hub/snakers4_silero-vad_master/
    try:
        model, _ = torch.hub.load(
            repo_or_dir='snakers4/silero-vad',
            model='silero_vad',
            force_reload=False,
            onnx=False,   # PyTorch model — consistent with torch==2.0.0 in requirements
        )
        model = model.to(device)
        model.eval()
    except Exception as exc:
        print(f'[silero_vad] Failed to load Silero VAD model: {exc}', file=sys.stderr)
        sys.exit(1)

    # Load input audio — pipeline format is 32-bit float 44.1 kHz
    waveform, sr = torchaudio.load(args.input)   # shape: (channels, samples)

    # Mix to mono (Silero is mono-only)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)   # (1, samples)

    # Resample from 44.1 kHz to 16 kHz
    if sr != SILERO_SR:
        resampler = T.Resample(orig_freq=sr, new_freq=SILERO_SR)
        waveform = resampler(waveform)

    audio_16k = waveform[0]   # 1D tensor of float32 samples at 16 kHz

    # Frame alignment:
    #   100 ms * 16000 Hz = 1600 samples per pipeline frame (exact integer)
    samples_per_frame = round(FRAME_DURATION_S * SILERO_SR)  # 1600
    n_frames = len(audio_16k) // samples_per_frame

    frame_results = []

    with torch.no_grad():
        for f in range(n_frames):
            frame_start = f * samples_per_frame
            frame_end   = frame_start + samples_per_frame
            frame_audio = audio_16k[frame_start:frame_end]   # 1600 samples

            chunk_probs = []
            for chunk_start in range(0, samples_per_frame, SILERO_CHUNK_SAMPLES):
                chunk = frame_audio[chunk_start : chunk_start + SILERO_CHUNK_SAMPLES]

                # Zero-pad last chunk if shorter than SILERO_CHUNK_SAMPLES (64 → 512)
                if len(chunk) < SILERO_CHUNK_SAMPLES:
                    pad = torch.zeros(SILERO_CHUNK_SAMPLES - len(chunk), dtype=chunk.dtype)
                    chunk = torch.cat([chunk, pad])

                chunk = chunk.to(device)
                prob  = model(chunk.unsqueeze(0), SILERO_SR).item()
                chunk_probs.append(prob)

            max_prob   = max(chunk_probs)
            is_silence = max_prob < args.threshold

            frame_results.append({
                'index':     f,
                'isSilence': is_silence,
                'maxProb':   round(max_prob, 4),
            })

    # Reset GRU state — defensive hygiene (fresh process per spawn, but good practice)
    model.reset_states()

    with open(args.output, 'w') as fh:
        json.dump({'frames': frame_results}, fh)

    print(f'[silero_vad] classified {n_frames} frames '
          f'({sum(1 for f in frame_results if not f["isSilence"])} voiced, '
          f'{sum(1 for f in frame_results if f["isSilence"])} silence)',
          flush=True)


if __name__ == '__main__':
    main()
