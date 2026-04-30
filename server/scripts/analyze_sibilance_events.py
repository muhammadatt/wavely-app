"""
analyze_sibilance_events.py
Sibilance event analyzer (detection only; no audio modification).

Walks the same STFT loop as sibilance_suppressor.py but uses the shared
SibilanceDetector to perform detection only -- no gain reduction, no ISTFT,
no audio output. Emits a JSON event map that downstream stages can consume
to share detection results without re-running the heavy pass:

  - sibilance_suppressor.py reads `sibilantFrameIndices` + `f0.perFrame` to
    skip its own detection (via --events-json) and run reduction only.
  - A future sibilant-aware airBoost reads `events` to skip boosting frames
    that contain sibilants.

Output JSON shape:
  {
    "sampleRate":           44100,
    "nFft":                 2048,
    "hopLength":            512,
    "frameCount":           8421,
    "f0":                   { "median": 152.4, "perFrame": [148.2, ...] },
    "sibilantFrameIndices": [421, 422, ...],
    "events": [{ "startFrame": 421, "endFrame": 432,
                 "startSec":   1.2500, "endSec": 1.3486,
                 "durationMs": 98.6 }]
  }

The `f0.perFrame` array tracks the F0 from which the active sibilant band
was derived at each frame (mostly piecewise-constant -- the detector only
rebuilds the mask when the rolling median shifts beyond a threshold).
"""

import argparse
import json
import logging
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import get_window

from sibilance_suppressor import (
    PRESET_DEFAULTS,
    SibilanceDetector,
    build_events_map,
    estimate_f0,
)

logger = logging.getLogger(__name__)


def analyze_sibilance_events(
    audio: np.ndarray,
    sample_rate: int,
    preset: str = "acx_audiobook",
    vad_voiced_mask: np.ndarray = None,
    f0: float = None,
    n_fft: int = 2048,
    hop_length: int = 512,
) -> dict:
    """
    Detection-only STFT pass over `audio`. Returns a serializable event map.

    Args:
        audio:           Mono float32 audio at sample_rate.
        sample_rate:     Sample rate in Hz (44100 in the IP pipeline).
        preset:          Preset id. Falls back to acx_audiobook for unknown
                         presets (including noise_eraser, which uses the
                         analyzer's detection thresholds for cache parity).
        vad_voiced_mask: Optional boolean array (same length as audio).
                         Frames with any voiced sample are classified voiced.
        f0:              Optional seed F0; estimated from audio if omitted.
        n_fft:           STFT size (must match the suppressor's setting).
        hop_length:      STFT hop (must match the suppressor's setting).

    Returns:
        Event map dict (see module docstring for shape).
    """
    if audio.ndim != 1:
        raise ValueError("analyze_sibilance_events expects mono input (1D array).")

    params   = PRESET_DEFAULTS.get(preset, PRESET_DEFAULTS["acx_audiobook"]).copy()
    detector = SibilanceDetector(sample_rate, n_fft, hop_length, params, f0=f0)

    if detector.f0 is None:
        detector.seed_f0(estimate_f0(audio, sample_rate))

    pad          = n_fft // 2
    audio_padded = np.pad(audio, pad, mode="reflect")
    n_frames     = max(0, (len(audio_padded) - n_fft) // hop_length + 1)

    voiced_frame_indices = None
    if vad_voiced_mask is not None and len(vad_voiced_mask) == len(audio):
        voiced_frame_indices = set()
        for fi in range(n_frames):
            o_start = max(0, fi * hop_length - pad)
            o_end   = min(len(audio), fi * hop_length - pad + n_fft)
            if o_start < o_end and vad_voiced_mask[o_start:o_end].any():
                voiced_frame_indices.add(fi)

    window           = get_window("hann", n_fft, fftbins=True)
    sibilant_indices = []
    f0_per_frame     = []

    for i in range(n_frames):
        start     = i * hop_length
        end       = start + n_fft
        frame_raw = audio_padded[start:end]
        magnitude = np.abs(np.fft.rfft(frame_raw * window))
        is_voiced = (voiced_frame_indices is None) or (i in voiced_frame_indices)
        if detector.process_frame(frame_raw, magnitude, is_voiced):
            sibilant_indices.append(i)
        f0_per_frame.append(detector.f0)

    rolling = detector.f0_rolling
    f0_median = float(np.median(rolling)) if len(rolling) > 0 else detector.f0

    events_map = build_events_map(
        sibilant_indices = sibilant_indices,
        f0_per_frame     = f0_per_frame,
        f0_median        = f0_median,
        n_frames         = n_frames,
        sample_rate      = sample_rate,
        n_fft            = n_fft,
        hop_length       = hop_length,
    )

    logger.info(
        f"SibilanceAnalyzer: frames={n_frames} sibilant={len(sibilant_indices)} "
        f"events={len(events_map['events'])} "
        f"f0_median={f0_median:.1f} Hz"
    )

    return events_map



# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    parser = argparse.ArgumentParser(description="Sibilance event analyzer")
    parser.add_argument("--input",         required=True)
    parser.add_argument("--output",        required=True,
                        help="Output JSON path for the event map.")
    parser.add_argument("--preset",        default="acx_audiobook")
    parser.add_argument("--vad-mask-json", default=None)
    parser.add_argument("--f0",            type=float, default=None)
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    audio     = audio.astype(np.float32)

    vad_voiced_mask = None
    if args.vad_mask_json:
        with open(args.vad_mask_json) as fh:
            frame_list = json.load(fh)
        vad_voiced_mask = np.zeros(len(audio), dtype=bool)
        for frame in frame_list:
            if not frame["isSilence"]:
                s = frame["offsetSamples"]
                e = s + frame["lengthSamples"]
                vad_voiced_mask[s:min(e, len(audio))] = True

    events = analyze_sibilance_events(audio, sr, args.preset, vad_voiced_mask, args.f0)

    with open(args.output, "w") as fh:
        json.dump(events, fh)

    print("JSON_RESULT:" + json.dumps({
        "frameCount":            events["frameCount"],
        "sibilantFrameCount":    len(events["sibilantFrameIndices"]),
        "eventCount":            len(events["events"]),
        "f0Median":              events["f0"]["median"],
    }), flush=True)
