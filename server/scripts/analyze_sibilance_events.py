"""
analyze_sibilance_events.py
CLI shim for sibilance_detector.analyze_sibilance_events.

Walks a mono WAV with an externally-supplied F0 contour and emits the
canonical sibilance event map JSON that downstream stages consume:

  - airBoost (server/scripts/air_boost_masked.py) reads
    `sibilantFrameIndices` to mask the boost on sibilant frames.
  - resonance_suppressor.py reads the same indices to gate its
    `sibilant_only` passes.

Each calling stage supplies its own detection parameters via --params-json
(sparse overrides over sibilance_detector.DEFAULT_PARAMS) so airBoost,
resonanceSuppressor, etc. can each tighten/loosen detection independently.

F0 contour:
  Required. Pass --f0-contour-json pointing at the file produced by
  estimate_f0_contour.py. Per-frame F0 drives the detector's rolling-band
  update so no second autocorrelation pass is needed at this stage.

Output JSON shape: see sibilance_detector.build_events_map.
"""

import argparse
import json
import logging
import sys

import numpy as np
from scipy.io import wavfile

from sibilance_detector import analyze_sibilance_events


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    parser = argparse.ArgumentParser(description="Sibilance event analyzer")
    parser.add_argument("--input",            required=True)
    parser.add_argument("--output",           required=True,
                        help="Output JSON path for the event map.")
    parser.add_argument("--f0-contour-json",  required=True,
                        help="F0 contour JSON from estimate_f0_contour.py. "
                             "Provides per-frame F0 + median; the detector "
                             "uses these directly instead of re-estimating.")
    parser.add_argument("--params-json",      default=None,
                        help="Sparse detection parameter overrides (JSON). "
                             "Sourced from the calling stage's "
                             "sibilanceDetection block (e.g. "
                             "preset.airBoost.sibilanceDetection or "
                             "preset.resonanceSuppressor[i].sibilanceDetection).")
    parser.add_argument("--vad-mask-json",    default=None)
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    if np.issubdtype(audio.dtype, np.integer):
        audio = audio.astype(np.float32) / np.iinfo(audio.dtype).max
    else:
        audio = audio.astype(np.float32)
    # Detection runs on mono; fold stereo down before handing the array to
    # analyze_sibilance_events (which rejects ndim > 1). Presets whose
    # channelOutput is 'preserve' may legitimately still be stereo at the
    # point a downstream stage runs the detector.
    if audio.ndim == 2:
        audio = audio.mean(axis=1).astype(np.float32)

    with open(args.f0_contour_json) as fh:
        f0_contour = json.load(fh)

    params = None
    if args.params_json:
        with open(args.params_json) as fh:
            params = json.load(fh)

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

    # Honour the contour's STFT geometry so frame indices align with consumers.
    n_fft      = int(f0_contour.get("nFft", 2048))
    hop_length = int(f0_contour.get("hopLength", 512))

    events = analyze_sibilance_events(
        audio, sr, f0_contour,
        params=params, vad_voiced_mask=vad_voiced_mask,
        n_fft=n_fft, hop_length=hop_length,
    )

    with open(args.output, "w") as fh:
        json.dump(events, fh)

    print("JSON_RESULT:" + json.dumps({
        "frameCount":         events["frameCount"],
        "sibilantFrameCount": len(events["sibilantFrameIndices"]),
        "eventCount":         len(events["events"]),
        "f0Median":           events["f0"]["median"],
    }), flush=True)
