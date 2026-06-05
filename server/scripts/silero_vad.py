#!/usr/bin/env python3
"""
Silero VAD v5 frame classifier for the silence analysis pipeline.

Classifies each 25 ms pipeline frame as voiced or silence using the Silero VAD
neural model. Results are written as JSON and merged with energy-based metrics
in silenceAnalysis.js (hybrid approach).

Usage:
  python3 silero_vad.py --input <path> --output <path.json>
                        [--threshold 0.5] [--device auto|cpu|cuda]

Input:  Float32 WAV. The fast path is 16 kHz mono (Node pre-resamples with
        FFmpeg so we skip scipy resampling); 44.1 kHz inputs are still accepted
        and resampled internally with scipy.signal.resample_poly.
Output: JSON file with per-frame isSilence classification.

Frame alignment:
  - Pipeline frame duration: 25 ms → 400 samples @ 16 kHz
  - Silero operates at 16 kHz with a 512-sample (32 ms) internal grain
  - Fast path (get_speech_timestamps): processes the full audio stream in one
    internal pass and returns speech segment timestamps, which are mapped back
    to per-pipeline-frame isSilence labels. A frame is voiced if any returned
    segment overlaps its sample range.
  - Fallback (frame-by-frame loop): one model call per frame (zero-padded to
    512 samples); frame label = max(chunk_probs) >= threshold.

Backend:
  ONNX Runtime is preferred (avoids the torch.jit cold start and runs faster
  for single-stream CPU inference). Falls back to the silero-vad package's
  torch JIT model, then to torch.hub if neither is available. The model and
  get_speech_timestamps reference are cached at module level so the persistent
  worker pays the load cost exactly once per server lifetime.
"""
import argparse
import importlib
import importlib.util
import json
import os
import sys
import warnings

warnings.filterwarnings('ignore')

# Hot imports — kept at module level so the persistent worker's first dispatch
# pays the cost once and every subsequent call reuses the cached modules.
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly
from math import gcd

PIPELINE_SR          = 44100
SILERO_SR            = 16000
SILERO_CHUNK_SAMPLES = 512     # Silero v5 supported chunk size at 16 kHz
DEFAULT_THRESHOLD    = 0.5

# Loaded from the shared config so JS and Python always use the same value.
# To change the pipeline frame duration, edit server/config/frame_config.json.
_config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'config', 'frame_config.json')
with open(_config_path) as _f:
    FRAME_DURATION_S = json.load(_f)['FRAME_DURATION_S']  # 0.025 s = 25 ms

# Module-level model cache. Populated by _get_model() on first use; the
# persistent worker keeps this process alive for the server's lifetime, so
# subsequent calls reuse the loaded model and its get_speech_timestamps.
_MODEL = None
_GST   = None


def _import_silero_pkg():
    """
    Import the installed silero_vad package, working around the fact that
    this script's filename collides with the package name. Python inserts
    the script's own directory at sys.path[0] when spawned, so a plain
    `from silero_vad import ...` would find THIS FILE instead of the
    installed package.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    saved_path = sys.path[:]
    sys.path = [
        p for p in sys.path
        if os.path.normcase(os.path.abspath(p)) != os.path.normcase(script_dir)
    ]
    for _key in [k for k in sys.modules if 'silero_vad' in k]:
        del sys.modules[_key]
    try:
        return importlib.import_module('silero_vad')
    finally:
        sys.path = saved_path


def _get_model():
    """
    Load (once) and return (model, get_speech_timestamps). Cached at module
    level so the persistent worker pays the load cost on first dispatch only.

    Strategy 1 — ONNX Runtime via silero_vad.load_silero_vad(onnx=True).
      Preferred. Avoids the torch.jit cold start and runs faster for
      single-stream CPU inference.
    Strategy 2 — torch JIT via silero_vad.load_silero_vad(onnx=False).
      Fallback when onnxruntime is unavailable.
    Strategy 3 — torch.hub.load (last resort for envs without the package).
      WARNING: makes a GitHub network request even with force_reload=False.
    """
    global _MODEL, _GST
    if _MODEL is not None:
        return _MODEL, _GST

    pkg = None
    if importlib.util.find_spec('onnxruntime') is not None:
        try:
            pkg = _import_silero_pkg()
            _MODEL = pkg.load_silero_vad(onnx=True)
            _GST   = pkg.get_speech_timestamps
            return _MODEL, _GST
        except Exception as exc:
            print(f'[silero_vad] ONNX load failed, falling back: {exc}', file=sys.stderr)
            _MODEL, _GST = None, None

    try:
        if pkg is None:
            pkg = _import_silero_pkg()
        _MODEL = pkg.load_silero_vad(onnx=False)
        _GST   = pkg.get_speech_timestamps
        return _MODEL, _GST
    except Exception as exc:
        print(f'[silero_vad] JIT load failed, falling back: {exc}', file=sys.stderr)
        _MODEL, _GST = None, None

    try:
        import torch
        model, _ = torch.hub.load(
            repo_or_dir='snakers4/silero-vad',
            model='silero_vad',
            force_reload=False,
            onnx=False,
        )
        _MODEL, _GST = model, None
        return _MODEL, _GST
    except Exception as exc:
        print(f'[silero_vad] Failed to load Silero VAD model: {exc}', file=sys.stderr)
        sys.exit(1)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Silero VAD frame classifier')
    parser.add_argument('--input',     required=True,  help='Input WAV (32-bit float)')
    parser.add_argument('--output',    required=True,  help='Output JSON file path')
    parser.add_argument('--threshold', type=float, default=DEFAULT_THRESHOLD,
                        help='Speech probability threshold (default: 0.5)')
    parser.add_argument('--device',    default='auto', choices=['auto', 'cpu', 'cuda'],
                        help='Compute device (default: auto). Honored only by the '
                             'torch.hub fallback; ONNX always runs on CPU.')
    args = parser.parse_args(argv)

    model, get_speech_timestamps = _get_model()

    # The torch.hub fallback returns a torch nn.Module that supports .to/.eval;
    # the ONNX path returns a wrapper with neither. Only call these for torch
    # models. `device` is referenced by the frame-by-frame fallback loop.
    device = 'cpu'
    if hasattr(model, 'to') and hasattr(model, 'eval'):
        try:
            import torch
            if args.device == 'auto':
                device = 'cuda' if torch.cuda.is_available() else 'cpu'
            else:
                device = args.device
            # Respect the per-call thread limit that _worker.py applied before
            # dispatching this script (torch.get_num_threads() reflects it).
            # Do not re-read TORCH_NUM_THREADS from env — that would overwrite
            # the sileroThreads budget set by classifySileroVadParallel's
            # withThreadLimit context on every call after the first model load.
            # (On the very first call the worker has already applied the limit,
            # so torch.get_num_threads() is already correct here too.)
            model = model.to(device)
            model.eval()
        except Exception:
            device = 'cpu'

    # Load input audio. Node-side FFmpeg pre-resamples to 16 kHz mono float32
    # for the fast path; we still handle other rates and channel counts.
    sr, audio_np = wavfile.read(args.input)
    audio_np = audio_np.astype(np.float32)
    if audio_np.ndim > 1:
        audio_np = audio_np.mean(axis=1)  # mix to mono

    if sr != SILERO_SR:
        g = gcd(SILERO_SR, sr)
        audio_np = resample_poly(audio_np, SILERO_SR // g, sr // g).astype(np.float32)

    # Time-based frame boundaries: frame f starts at round(f * FRAME_DURATION_S * SILERO_SR).
    # With the current 25 ms/16 kHz config this remains 400 samples per frame; the formula matches the JS side.
    def frame_boundary(f):
        return round(f * FRAME_DURATION_S * SILERO_SR)

    n_frames = int(len(audio_np) // (FRAME_DURATION_S * SILERO_SR))

    frame_results = []

    if get_speech_timestamps is not None:
        # Fast path: get_speech_timestamps processes the full audio stream
        # internally using the sequential GRU inference at 512-sample chunk
        # boundaries, then returns speech segments as {start, end} sample-index
        # pairs at 16 kHz. Both the ONNX wrapper and the JIT model accept the
        # numpy array directly.
        try:
            speech_segs = get_speech_timestamps(
                audio_np,
                model,
                sampling_rate=SILERO_SR,
                threshold=args.threshold,
                min_speech_duration_ms=0,
                min_silence_duration_ms=0,
                speech_pad_ms=0,
                return_seconds=False,
            )
        except TypeError:
            # Older silero-vad versions may not support all kwargs; retry bare.
            speech_segs = get_speech_timestamps(
                audio_np, model,
                sampling_rate=SILERO_SR,
                threshold=args.threshold,
            )

        # Map segments to pipeline frames using time-based boundaries.
        # Segment boundaries are at 512-sample chunk resolution; a frame is
        # voiced if any segment overlaps its [frame_boundary(f), frame_boundary(f+1)) range.
        samples_per_frame_approx = FRAME_DURATION_S * SILERO_SR

        def frame_at_sample(s):
            """Return the frame index whose boundary range contains sample s."""
            f = int(s / samples_per_frame_approx)
            if f > 0 and frame_boundary(f) > s:
                f -= 1
            elif f + 1 <= n_frames and frame_boundary(f + 1) <= s:
                f += 1
            return min(f, n_frames - 1)

        voiced_frames = set()
        for seg in speech_segs:
            first_frame = frame_at_sample(seg['start'])
            last_frame  = frame_at_sample(seg['end'] - 1)
            for f in range(first_frame, min(last_frame + 1, n_frames)):
                voiced_frames.add(f)

        for f in range(n_frames):
            voiced = f in voiced_frames
            frame_results.append({
                'index':     f,
                'isSilence': not voiced,
                'maxProb':   1.0 if voiced else 0.0,  # approximation; not used by JS
            })

        if hasattr(model, 'reset_states'):
            model.reset_states()

    else:
        # Fallback: frame-by-frame inference loop (torch.hub model path only).
        import torch
        audio_16k = torch.from_numpy(audio_np)
        with torch.no_grad():
            for f in range(n_frames):
                fb_start    = frame_boundary(f)
                fb_end      = frame_boundary(f + 1)
                frame_len   = fb_end - fb_start
                frame_audio = audio_16k[fb_start:fb_end]

                chunk_probs = []
                for chunk_start in range(0, frame_len, SILERO_CHUNK_SAMPLES):
                    chunk = frame_audio[chunk_start : chunk_start + SILERO_CHUNK_SAMPLES]

                    # Zero-pad last chunk if shorter than SILERO_CHUNK_SAMPLES
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

        if hasattr(model, 'reset_states'):
            model.reset_states()

    with open(args.output, 'w') as fh:
        json.dump({'frames': frame_results}, fh)

    print(f'[silero_vad] classified {n_frames} frames '
          f'({sum(1 for f in frame_results if not f["isSilence"])} voiced, '
          f'{sum(1 for f in frame_results if f["isSilence"])} silence)',
          flush=True)


def run(argv):
    """Entry point used by the persistent worker (_worker.py)."""
    return main(argv)


if __name__ == '__main__':
    main()
