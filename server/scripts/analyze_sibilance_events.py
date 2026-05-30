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
  Optional. Two modes:
    • External: pass --f0-contour-json pointing at the file produced by
      estimate_f0_contour.py. Per-frame F0 drives the detector's
      rolling-band update so no autocorrelation pass is needed here.
    • Internal: omit --f0-contour-json and the analyzer runs
      estimate_f0_contour on the already-loaded audio array. Saves one full
      WAV read + one IPC roundtrip when the caller (e.g. clipGainDeEsser)
      has no other use for the contour.

Output JSON shape: see sibilance_detector.build_events_map.
"""

import argparse
import json
import logging
import sys

import numpy as np
from scipy.io import wavfile

from sibilance_detector import analyze_sibilance_events
from estimate_f0_contour import estimate_f0_contour


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description="Sibilance event analyzer")
    parser.add_argument("--input",            required=True)
    parser.add_argument("--output",           required=True,
                        help="Output JSON path for the event map.")
    parser.add_argument("--f0-contour-json",  default=None,
                        help="F0 contour JSON from estimate_f0_contour.py. "
                             "Provides per-frame F0 + median; the detector "
                             "uses these directly instead of re-estimating. "
                             "Omit to have this script compute the contour "
                             "internally on the loaded audio array (saves a "
                             "second WAV read for callers that have no other "
                             "use for the contour).")
    parser.add_argument("--params-json",      default=None,
                        help="Sparse detection parameter overrides (JSON). "
                             "Sourced from the calling stage's "
                             "sibilanceDetection block (e.g. "
                             "preset.airBoost.sibilanceDetection or "
                             "preset.resonanceSuppressor[i].sibilanceDetection).")
    parser.add_argument("--vad-mask-json",    default=None)
    args = parser.parse_args(argv)

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

    # F0 contour: external when provided, internal otherwise. Internal mode
    # reuses the already-loaded audio + VAD mask so the contour pass is a pure
    # numeric add-on (no second WAV read, no IPC trip). Honour the external
    # contour's STFT geometry when present so frame indices align with whatever
    # consumer originally produced it; default to (2048, 512) for the internal
    # path, matching estimate_f0_contour.py's own defaults.
    if args.f0_contour_json:
        with open(args.f0_contour_json) as fh:
            f0_contour = json.load(fh)
        n_fft      = int(f0_contour.get("nFft", 2048))
        hop_length = int(f0_contour.get("hopLength", 512))
    else:
        n_fft      = 2048
        hop_length = 512
        f0_contour = estimate_f0_contour(
            audio, sr,
            vad_voiced_mask=vad_voiced_mask,
            n_fft=n_fft, hop_length=hop_length,
        )

    events = analyze_sibilance_events(
        audio, sr, f0_contour,
        params=params, vad_voiced_mask=vad_voiced_mask,
        n_fft=n_fft, hop_length=hop_length,
    )

    # When the contour was computed here (internal mode) the caller has no
    # other copy of it. Expose the raw contour so the JS caller can seed its
    # F0 cache without spawning estimate_f0_contour.py separately. In external
    # mode the caller already holds the contour and doesn't need it back, so
    # we omit the key to avoid bloating the events file.
    if not args.f0_contour_json:
        events["inputF0Contour"] = f0_contour

    with open(args.output, "w") as fh:
        json.dump(events, fh)

    # Per-event detection diagnostics. Surfaces which detect() condition
    # fired plus the in-band stats so misfires (false positives on /h/,
    # vowel onsets, breath; misses on passage-start sibilants) can be
    # audited from logs. Each line is prefixed [SibilanceAnalyzer] by the
    # Node wrapper (sibilanceEvents.js).
    for ev in events.get("events", []) or []:
        det = ev.get("detection") or {}
        if not det:
            continue
        fired = ",".join(
            f"{c}({det['framesByCondition'][c]})"
            for c in det.get("firedConditions", [])
        ) or "none"
        band = det.get("bandHz") or [None, None]
        logger.info(
            "[sib-event] t=%.3f-%.3fs f=%d-%d %.0fms type=%s class=%s "
            "hfRatio=%s coreP95=%s peak=%s cond=%s "
            "p95=%s mean=%s lf=%s flat=%s "
            "band=%s-%s f0=%s postSil=%s",
            ev.get("startSec", 0.0), ev.get("endSec", 0.0),
            ev.get("startFrame", -1), ev.get("endFrame", -1),
            ev.get("durationMs", 0), ev.get("eventType", "?"),
            ev.get("sibilantClass", "?"),
            ev.get("hfRatioDb"), ev.get("coreMeanP95Db"),
            ev.get("eventPeakDb"), fired,
            det.get("meanP95Db"), det.get("meanMeanDb"), det.get("meanLfDb"),
            det.get("meanFlatness"),
            band[0], band[1], det.get("f0Hz"), det.get("postSilenceOnset"),
        )

        # Per-frame boundary trace. Shows, for the K frames immediately
        # before startFrame (head) and after endFrame (tail), what the
        # per-frame gates measured. Lets us see why the detector did NOT
        # extend the event further -- which gate rejected each boundary
        # frame -- so threshold tuning is data-driven.
        bd = ev.get("boundaryDiag")
        if bd:
            def _fmt(side):
                parts = []
                for f in side:
                    fi = f.get("frame", -1)
                    if f.get("missing"):
                        parts.append(f"f{fi}:--")
                        continue
                    # Single-gate failure label. Frames carry p95Pass/flatPass
                    # booleans from the detector (None when the frame was
                    # rejected upstream by voicing veto, energy gate, or band).
                    # Order: hard gates first, then spectral-shape failures,
                    # then a FIRED marker. p95Fail vs flatFail is now an
                    # accurate label rather than a default fallback.
                    flags = []
                    if f.get("fired"):
                        flags.append("FIRED")
                    elif f.get("veto"):
                        flags.append("veto")
                    elif f.get("nrg"):
                        flags.append("nrg")
                    elif f.get("band"):
                        flags.append("band")
                    else:
                        p95p  = f.get("p95Pass")
                        flatp = f.get("flatPass")
                        if p95p is False:
                            flags.append("p95Fail")
                        elif flatp is False:
                            flags.append("flatFail")
                        else:
                            flags.append("fail")
                    flag_s = "|".join(flags)
                    delta  = f.get("deltaDb")
                    flat   = f.get("flatness")
                    parts.append(
                        f"f{fi}:d{delta if delta is not None else '?'}"
                        f"/flat{flat if flat is not None else '?'}/{flag_s}"
                    )
                return " ".join(parts)
            logger.info(
                "[sib-bound] startF=%d endF=%d  head: %s  tail: %s",
                ev.get("startFrame", -1), ev.get("endFrame", -1),
                _fmt(bd.get("head", [])), _fmt(bd.get("tail", [])),
            )

    return {
        "frameCount":         events["frameCount"],
        "sibilantFrameCount": len(events["sibilantFrameIndices"]),
        "eventCount":         len(events["events"]),
        "f0Median":           events["f0"]["median"],
    }


def run(argv):
    """Entry point used by the persistent worker (_worker.py).

    Returns the summary dict directly via the worker protocol — no
    JSON_RESULT line is emitted in worker mode.
    """
    return main(argv)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    # Legacy CLI / spawnPythonJsonResult contract: progress logs on stdout
    # plus a single trailing JSON_RESULT: line that the JS side parses.
    result = main()
    print("JSON_RESULT:" + json.dumps(result), flush=True)
