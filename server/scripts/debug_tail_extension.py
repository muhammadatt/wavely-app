"""
Diagnostic: replicate the live pipeline's clipGainDeEsser sibilance pass on
the fixture file and compare event boundaries with tail extension OFF vs ON.

Use this to determine whether the 17.30s F-event truncation is caused by
Silero VAD cutting off the fricative tail (in which case enabling tail
extension extends the event) or by detection thresholds failing in the tail
region (in which case tail extension has no effect on its own and we need
relaxed-threshold detection inside the extension window).

Usage:
  cd server
  .venv/Scripts/python scripts/debug_tail_extension.py
"""
import json
import pathlib
import subprocess
import sys
import tempfile

import numpy as np
from scipy.io import wavfile

ROOT       = pathlib.Path(__file__).parent.parent
FIXTURE    = ROOT / "tests" / "fixtures" / "sibilance_sample.wav"
SILERO     = ROOT / "scripts" / "silero_vad.py"
PY         = sys.executable

TARGET_SEC = 17.30      # event of interest
WINDOW_SEC = 0.30       # report events within ± this around target

# Ensure script-dir is importable so analyze_sibilance_events resolves.
sys.path.insert(0, str(ROOT / "scripts"))
from sibilance_detector import (                          # noqa: E402
    analyze_sibilance_events,
    SibilanceDetector,
    resolve_params,
)
from estimate_f0_contour import estimate_f0_contour      # noqa: E402
from scipy.signal.windows import hann                    # noqa: E402

def run_silero_vad(wav_path):
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as fh:
        out = fh.name
    try:
        subprocess.run(
            [PY, str(SILERO), "--input", str(wav_path), "--output", out],
            check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        with open(out) as fh:
            return json.load(fh)
    finally:
        pathlib.Path(out).unlink(missing_ok=True)

FRAME_LEN_SAMPLES = round(0.025 * 44100)  # 25 ms @ 44.1 kHz = 1102 smp

def build_voiced_mask(frames, n_samples, sr):
    mask = np.zeros(n_samples, dtype=bool)
    for fr in frames:
        if fr.get("isSilence"):
            continue
        s = int(fr.get("offsetSamples", fr["index"] * FRAME_LEN_SAMPLES))
        ln = int(fr.get("lengthSamples", FRAME_LEN_SAMPLES))
        e = min(n_samples, s + ln)
        if e > s:
            mask[s:e] = True
    return mask

def report(label, events):
    print(f"\n=== {label} ===")
    for ev in events.get("events", []) or []:
        if abs(ev["startSec"] - TARGET_SEC) > WINDOW_SEC:
            continue
        det = ev.get("detection") or {}
        fired = ",".join(
            f"{c}({det.get('framesByCondition', {}).get(c, '?')})"
            for c in det.get("firedConditions", [])
        ) or "none"
        print(
            f"  {ev['startSec']:.4f}-{ev['endSec']:.4f}  "
            f"({ev['durationMs']:.1f}ms) type={ev['eventType']} cond={fired} "
            f"p95={det.get('meanP95Db')} mean={det.get('meanMeanDb')} "
            f"lf={det.get('meanLfDb')} flat={det.get('meanFlatness')} "
            f"bbExc={det.get('meanBroadbandExcessDb')} c3={det.get('meanContextualBinFraction')} "
            f"band={(det.get('bandHz') or [None, None])} postSil={det.get('postSilenceOnset')}"
        )

def main():
    sr, audio = wavfile.read(FIXTURE)
    if audio.dtype != np.float32:
        audio = audio.astype(np.float32)
        if audio.dtype.kind == "i":
            audio /= np.iinfo(audio.dtype).max
    print(f"Loaded {FIXTURE.name}: {len(audio)} samples @ {sr} Hz "
          f"({len(audio)/sr:.2f}s)")

    print("Running Silero VAD ...")
    raw      = run_silero_vad(FIXTURE)
    frames   = raw["frames"]
    voiced   = build_voiced_mask(frames, len(audio), sr)

    # Report VAD state around the target
    fl_samples = FRAME_LEN_SAMPLES
    fr_at = lambda t: int(t * sr / fl_samples)
    print(f"\nVAD frames around {TARGET_SEC}s "
          f"(frame={fl_samples}smp ~{fl_samples/sr*1000:.1f}ms):")
    for fi in range(fr_at(TARGET_SEC - 0.1), fr_at(TARGET_SEC + 0.3)):
        if 0 <= fi < len(frames):
            f = frames[fi]
            t = fi * fl_samples / sr
            print(f"  f{fi:4d}  t={t:.4f}s  isSilence={f['isSilence']}  "
                  f"maxProb={f.get('maxProb', '?')}")

    print("\nEstimating F0 contour ...")
    f0 = estimate_f0_contour(
        audio, sr,
        n_fft=2048, hop_length=512,
    )

    common = dict(
        audio=audio, sample_rate=sr, f0_contour=f0,
        vad_voiced_mask=voiced, n_fft=2048, hop_length=512,
    )

    print("\nRunning detector (tail extension OFF) ...")
    off = analyze_sibilance_events(
        **common, params={"fricative_tail_extension_ms": 0.0,
                          "min_duration_ms": 15.0},
    )
    report("tail_extension_ms = 0", off)

    print("\nRunning detector (tail extension ON, 80ms) ...")
    on = analyze_sibilance_events(
        **common, params={"fricative_tail_extension_ms": 80.0,
                          "min_duration_ms": 15.0},
    )
    report("tail_extension_ms = 80", on)

    # ----- Per-frame walk across 17.20 - 17.50s -----
    # Step the detector by hand with the same VAD mask + F0 contour the
    # pipeline uses, and print the full per-frame diagnostic for every STFT
    # frame in the window. Shows exactly which condition (or veto) gates
    # each frame so we can see what's keeping detection from firing in the
    # 17.39 - 17.47 loud-body region.
    print("\n=== Per-frame walk 17.20 - 17.50s (pipeline VAD path) ===")
    n_fft, hop = 2048, 512
    pad        = n_fft // 2
    padded     = np.pad(audio, pad, mode="reflect")
    win        = hann(n_fft, sym=False)
    n_frames   = max(0, (len(padded) - n_fft) // hop + 1)

    # Build voiced_frame_indices the same way analyze_sibilance_events does.
    vfi = set()
    for fi in range(n_frames):
        o_start = max(0, fi * hop - pad)
        o_end   = min(len(audio), fi * hop - pad + n_fft)
        if o_start < o_end and voiced[o_start:o_end].any():
            vfi.add(fi)

    params   = resolve_params({"fricative_tail_extension_ms": 0.0,
                               "min_duration_ms": 15.0})
    detector = SibilanceDetector(sr, n_fft, hop, params)
    contour  = f0["perFrame"]
    silence_reset_frames = max(1, int(params["silence_gap_reset_ms"] /
                                      ((hop / sr) * 1000.0)))
    silence_run = silence_reset_frames

    f_lo = int(17.20 * sr / hop)
    f_hi = int(17.55 * sr / hop)
    print(f"{'fi':>5} {'t':>7} {'V':>2} {'mean':>7} {'p95':>7} {'lf':>7} "
          f"{'flat':>5} veto gate cond")
    for i in range(n_frames):
        s = i * hop
        frame_raw = padded[s:s + n_fft]
        magnitude = np.abs(np.fft.rfft(frame_raw * win))
        is_voiced = i in vfi
        f0_for_frame = contour[i] if i < len(contour) else None
        if is_voiced and silence_run >= silence_reset_frames:
            detector.mark_passage_onset(f0_for_frame)
        if is_voiced:
            silence_run = 0
        else:
            silence_run += 1
        fired = detector.process_frame(magnitude, is_voiced, f0_for_frame)
        if f_lo <= i <= f_hi:
            d = detector.last_diag or {}
            t = i * hop / sr
            print(
                f"{i:>5} {t:>7.4f} {'Y' if is_voiced else '.':>2} "
                f"{d.get('meanDb', float('nan')):>7.2f} "
                f"{d.get('p95Db', float('nan')) if d.get('p95Db') is not None else float('nan'):>7.2f} "
                f"{d.get('lfDb', float('nan')) if d.get('lfDb') is not None else float('nan'):>7.2f} "
                f"{d.get('flatness') if d.get('flatness') is not None else float('nan'):>5.2f} "
                f"{'V' if d.get('voicingVetoed') else '.':>4} "
                f"{'G' if d.get('energyGated') else '.':>4} "
                f"{(d.get('condition') or '-'):<10} "
                f"{'FIRE' if fired else ''}"
            )

if __name__ == "__main__":
    main()
