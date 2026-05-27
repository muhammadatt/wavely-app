#!/usr/bin/env python3
"""
Silero VAD v5 frame classifier for the silence analysis pipeline.

Classifies each 25 ms pipeline frame as voiced or silence using the Silero VAD
neural model. Results are written as JSON and merged with energy-based metrics
in silenceAnalysis.js (hybrid approach).

Usage:
  python3 silero_vad.py --input <path> --output <path.json>
                        [--threshold 0.5] [--device auto|cpu|cuda]

Input:  32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
Output: JSON file with per-frame isSilence classification.

Frame alignment:
  - Pipeline frame duration: 25 ms → 1102 samples @ 44.1 kHz
  - Silero operates at 16 kHz → 25 ms = 400 samples
  - Fast path (get_speech_timestamps): processes the full audio stream in one
    internal pass and returns speech segment timestamps, which are mapped back
    to per-pipeline-frame isSilence labels. A frame is voiced if any returned
    segment overlaps its sample range.
  - Fallback (frame-by-frame loop): one model call per frame (zero-padded to
    512 samples); frame label = max(chunk_probs) >= threshold.

Performance: the fast path uses get_speech_timestamps (torchaudio required)
which avoids per-frame Python loop overhead. Falls back to the original loop
if the import is unavailable. Set SILERO_DEVICE=cuda to reduce latency further.
"""
import argparse
import json
import math
import os
import sys
import warnings

warnings.filterwarnings('ignore')

PIPELINE_SR          = 44100
SILERO_SR            = 16000
SILERO_CHUNK_SAMPLES = 512     # Silero v5 supported chunk size at 16 kHz
DEFAULT_THRESHOLD    = 0.5

# Loaded from the shared config so JS and Python always use the same value.
# To change the pipeline frame duration, edit server/config/frame_config.json.
_config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'config', 'frame_config.json')
with open(_config_path) as _f:
    FRAME_DURATION_S = json.load(_f)['FRAME_DURATION_S']  # 0.025 s = 25 ms


def resolve_device(device_arg):
    if device_arg == 'auto':
        import torch
        return 'cuda' if torch.cuda.is_available() else 'cpu'
    return device_arg


def main(argv=None):
    parser = argparse.ArgumentParser(description='Silero VAD frame classifier')
    parser.add_argument('--input',     required=True,  help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output',    required=True,  help='Output JSON file path')
    parser.add_argument('--threshold', type=float, default=DEFAULT_THRESHOLD,
                        help='Speech probability threshold (default: 0.5)')
    parser.add_argument('--device',    default='auto', choices=['auto', 'cpu', 'cuda'],
                        help='Compute device (default: auto)')
    args = parser.parse_args(argv)

    import torch
    import numpy as np
    from scipy.io import wavfile
    from scipy.signal import resample_poly
    from math import gcd

    device = resolve_device(args.device)

    num_threads = int(os.environ.get('TORCH_NUM_THREADS', os.cpu_count() or 4))
    torch.set_num_threads(num_threads)

    # Load Silero VAD model.
    #
    # Strategy 1 — JIT load from the silero-vad package's bundled data file.
    #   Preferred on all platforms. Requires only `torch` (no torchaudio, no
    #   network access, no GitHub). The silero_vad package must be installed
    #   but its __init__ is NOT imported, so the torchaudio import inside the
    #   package is never reached. Use importlib.util.find_spec to locate the
    #   package directory without executing its code.
    #
    # Strategy 2 — silero-vad package API (load_silero_vad).
    #   Works on platforms with torchaudio installed. The package is named
    #   `silero_vad`, which collides with this script's filename. Python inserts
    #   the script's own directory at sys.path[0] when spawned, so a plain
    #   `from silero_vad import ...` would find THIS FILE instead of the
    #   installed package. We remove the script directory from sys.path for the
    #   duration of the import to force resolution to the installed package.
    #
    # Strategy 3 — torch.hub.load (last resort for envs without the package).
    #   Weights (~10 MB) cached at ~/.cache/torch/hub/snakers4_silero-vad_master/
    #   WARNING: torch.hub.load makes a GitHub network request to check for repo
    #   updates even with force_reload=False. This can hang in environments
    #   without outbound internet access. Strategies 1 and 2 are preferred.
    import os as _os
    import importlib as _il

    model = None
    get_speech_timestamps = None

    # Both Strategy 1 and Strategy 2 need the script's own directory removed
    # from sys.path so that `silero_vad` resolves to the installed package,
    # not this file (silero_vad.py). We do the removal once up front.
    _script_dir = _os.path.dirname(_os.path.abspath(__file__))
    _saved_path = sys.path[:]
    sys.path = [
        p for p in sys.path
        if _os.path.normcase(_os.path.abspath(p)) != _os.path.normcase(_script_dir)
    ]

    # ── Strategy 1: JIT load from package's bundled data file ──────────────
    # find_spec locates the installed silero_vad package directory without
    # executing its __init__.py, so the torchaudio import is never reached.
    try:
        _spec = _il.util.find_spec('silero_vad')
        if _spec is not None:
            _pkg_dir = _os.path.dirname(_spec.origin)
            _jit_path = _os.path.join(_pkg_dir, 'data', 'silero_vad.jit')
            if _os.path.isfile(_jit_path):
                model = torch.jit.load(_jit_path, map_location=device)
    except Exception:
        model = None

    # ── Strategy 2: silero-vad package API ─────────────────────────────────
    if model is None:
        try:
            from silero_vad import load_silero_vad, get_speech_timestamps as _gst
            model = load_silero_vad()
            get_speech_timestamps = _gst
        except Exception:
            pass
        finally:
            # Clear any partial silero_vad entries poisoned by a failed import.
            for _key in [k for k in sys.modules if 'silero_vad' in k]:
                del sys.modules[_key]

    # ── get_speech_timestamps for Strategy 1 (JIT-loaded model) ────────────
    # get_speech_timestamps works with any model object, so try importing it
    # even when the JIT path was used and Strategy 2 was never reached.
    if get_speech_timestamps is None:
        try:
            from silero_vad import get_speech_timestamps as _gst
            get_speech_timestamps = _gst
        except Exception:
            pass
        finally:
            for _key in [k for k in sys.modules if 'silero_vad' in k]:
                del sys.modules[_key]

    sys.path = _saved_path  # restore regardless of which strategy succeeded

    # ── Strategy 3: torch.hub.load ──────────────────────────────────────────
    if model is None:
        try:
            model, _ = torch.hub.load(
                repo_or_dir='snakers4/silero-vad',
                model='silero_vad',
                force_reload=False,
                onnx=False,
            )
        except Exception as exc:
            print(f'[silero_vad] Failed to load Silero VAD model: {exc}', file=sys.stderr)
            sys.exit(1)

    try:
        model = model.to(device)
        model.eval()
    except Exception as exc:
        print(f'[silero_vad] Failed to load Silero VAD model: {exc}', file=sys.stderr)
        sys.exit(1)

    # Load input audio — pipeline format is 32-bit float 44.1 kHz
    # Uses scipy.io.wavfile (no soundfile/torchaudio needed — both lack ARM64 builds).
    sr, audio_np = wavfile.read(args.input)  # mono: (samples,)  stereo: (samples, channels)
    audio_np = audio_np.astype(np.float32)
    if audio_np.ndim == 1:
        audio_np = audio_np[np.newaxis, :]  # → (1, samples)
    else:
        audio_np = audio_np.T  # → (channels, samples)

    # Mix to mono (Silero is mono-only)
    if audio_np.shape[0] > 1:
        audio_np = audio_np.mean(axis=0)  # (samples,)
    else:
        audio_np = audio_np[0]

    # Resample from 44.1 kHz to 16 kHz using polyphase (scipy, no torchaudio needed)
    if sr != SILERO_SR:
        g = gcd(SILERO_SR, sr)
        audio_np = resample_poly(audio_np, SILERO_SR // g, sr // g).astype(np.float32)

    audio_16k = torch.from_numpy(audio_np)   # 1D tensor of float32 samples at 16 kHz

    # Frame alignment: 25 ms * 16000 Hz = 400 samples per pipeline frame
    samples_per_frame = round(FRAME_DURATION_S * SILERO_SR)  # 400
    n_frames          = len(audio_16k) // samples_per_frame

    frame_results = []

    if get_speech_timestamps is not None:
        # Fast path: get_speech_timestamps processes the full audio stream
        # internally using the sequential GRU inference at 512-sample chunk
        # boundaries, then returns speech segments as {start, end} sample-index
        # pairs at 16 kHz. This avoids the per-frame Python loop overhead and
        # the zero-padding work done in the fallback path.
        try:
            speech_segs = get_speech_timestamps(
                audio_16k,
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
                audio_16k, model,
                sampling_rate=SILERO_SR,
                threshold=args.threshold,
            )

        # Map segments to pipeline frames.
        # Segment boundaries are at 512-sample chunk resolution; a frame is
        # voiced if any segment overlaps its [f*400, (f+1)*400) sample range.
        voiced_frames = set()
        for seg in speech_segs:
            first_frame = seg['start'] // samples_per_frame
            last_frame  = (seg['end'] - 1) // samples_per_frame
            for f in range(first_frame, min(last_frame + 1, n_frames)):
                voiced_frames.add(f)

        for f in range(n_frames):
            voiced = f in voiced_frames
            frame_results.append({
                'index':     f,
                'isSilence': not voiced,
                'maxProb':   1.0 if voiced else 0.0,  # approximation; not used by JS
            })

        model.reset_states()

    else:
        # Fallback: original frame-by-frame inference loop.
        with torch.no_grad():
            for f in range(n_frames):
                frame_start = f * samples_per_frame
                frame_end   = frame_start + samples_per_frame
                frame_audio = audio_16k[frame_start:frame_end]   # 400 samples

                chunk_probs = []
                for chunk_start in range(0, samples_per_frame, SILERO_CHUNK_SAMPLES):
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
