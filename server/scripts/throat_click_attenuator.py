"""
throat_click_attenuator.py
Throat / palate click attenuation for voiced speech/narration audio.

Detects and attenuates short resonant throat and palate clicks occurring
mid-sentence inside voiced speech (10-25ms, 1-4kHz dominant, gradual onset).
These are distinct from electrical/lip clicks (handled by click_remover.py)
and mouth rumbles (handled by the mouth noise stage).

Detection:  LPC prediction error. An AR model fitted on pre-event voiced
            context cannot predict an aperiodic throat click, producing a
            sharp spike in normalised prediction error that remains
            discriminating even when the click is embedded in loud voiced
            speech — where spectral-shape features collapse.

Repair:     Smooth gain attenuation with an asymmetric attack/release
            envelope. AR interpolation is not used: the gradual 10-13ms
            onset corrupts the AR training context, and at 10-25ms the
            interpolated signal would be perceptibly wrong.

Pipeline position: After click_remover.py, on audio that has already passed
                   through noise reduction and any upstream EQ.

Shared dependency: AR/Burg utilities are imported from wavely_ar_utils.py.

Usage:
    python throat_click_attenuator.py input.wav output.wav --vad-spans spans.json
    python throat_click_attenuator.py in.wav out.wav --vad-spans spans.json \\
        --nrms-threshold 3.0 --attenuation-db 16

    spans.json — JSON array of [start_sample, end_sample] voiced spans
                 (from Silero VAD).

Output:
    Processed WAV written to output path.
    JSON report printed to stdout.
"""

import argparse
import json
import sys
import numpy as np
import soundfile as sf
from scipy.ndimage import uniform_filter1d, median_filter

from wavely_ar_utils import burg_ar_coeffs, ar_forward_predict

EPS = 1e-12


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clamp_spans(vad_spans, n):
    """Clamp (start, end) spans to [0, n] and drop empty/invalid ones."""
    spans = []
    for span in vad_spans:
        s = max(0, int(span[0]))
        e = min(n, int(span[1]))
        if e > s:
            spans.append((s, e))
    return spans


def _mask_to_regions(mask):
    """Convert a boolean array to a list of (start, end) tuples."""
    regions  = []
    in_region = False
    start     = 0
    for i, flagged in enumerate(mask):
        if flagged and not in_region:
            start     = i
            in_region = True
        elif not flagged and in_region:
            regions.append((start, i))
            in_region = False
    if in_region:
        regions.append((start, len(mask)))
    return regions


def _sliding_median_floor(env, window_samp, sr):
    """
    Adaptive floor: sliding median of the envelope.

    The median is computed on a decimated copy of the envelope (~1ms
    resolution) and interpolated back to full resolution. The floor is
    slowly varying, so decimation keeps the cost bounded on long spans
    without changing the result meaningfully.
    """
    window_samp = max(1, window_samp | 1)  # force odd
    if len(env) <= window_samp:
        return np.full_like(env, float(np.median(env)))

    decim = max(1, int(sr) // 1000)
    if decim == 1:
        return median_filter(env, size=window_samp, mode='reflect')

    dec_env   = env[::decim]
    dec_win   = max(1, (window_samp // decim) | 1)
    dec_floor = median_filter(dec_env, size=dec_win, mode='reflect')

    full_idx = np.arange(len(env))
    dec_idx  = np.arange(len(dec_env)) * decim
    return np.interp(full_idx, dec_idx, dec_floor)


def _merge_intervals(intervals):
    """Merge a list of [start, end] intervals; returns sorted, merged list."""
    if not intervals:
        return []
    intervals = sorted([list(iv) for iv in intervals])
    merged = [intervals[0]]
    for s, e in intervals[1:]:
        if s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

def detect_throat_clicks(
    signal,
    sr,
    vad_spans,               # list of (start_sample, end_sample) from Silero VAD
    sensitivity_db  = 10.0,  # dB above voiced floor to nominate candidate
    min_event_ms    = 8.0,   # Minimum candidate duration
    max_event_ms    = 30.0,  # Maximum candidate duration
    context_ms      = 25.0,  # Pre-event voiced context for AR model fitting
    ar_order        = None,  # Defaults to 2 + sr // 1000
    nrms_threshold  = 2.5,   # Normalised prediction error to confirm detection
    env_window_ms   = 5.0,   # RMS envelope smoothing for nomination
    floor_window_ms = 150.0, # Adaptive floor window (voiced samples only)
):
    """
    Detect throat clicks in a mono float signal.

    Returns
    -------
    detected    : list of (start_sample, end_sample) confirmed regions
    diagnostics : dict with candidate counts and per-candidate skip reasons
    """
    sig = np.asarray(signal, dtype=np.float64)
    n   = len(sig)

    if ar_order is None:
        ar_order = 2 + int(sr) // 1000
    ar_order = int(ar_order)

    context_samp      = int(round(sr * context_ms      / 1000.0))
    min_event_samp    = int(round(sr * min_event_ms    / 1000.0))
    max_event_samp    = int(round(sr * max_event_ms    / 1000.0))
    env_window_samp   = max(1, int(round(sr * env_window_ms   / 1000.0)))
    floor_window_samp = max(1, int(round(sr * floor_window_ms / 1000.0)))

    spans = _clamp_spans(vad_spans, n)

    detected      = []
    candidates    = 0
    nominated     = 0
    skipped_dur   = 0
    skipped_ctx   = 0
    confirmed     = 0

    for span_start, span_end in spans:
        span = sig[span_start:span_end]
        if len(span) < env_window_samp + 2:
            continue

        # ── Step 2: candidate nomination ────────────────────────────────
        # 5ms RMS envelope. All samples in a voiced span are voiced, so a
        # plain sliding median over the span satisfies the "voiced samples
        # only" requirement for the adaptive floor.
        env   = np.sqrt(uniform_filter1d(span ** 2, size=env_window_samp,
                                         mode='nearest'))
        floor = _sliding_median_floor(env, floor_window_samp, sr)
        thresh = floor * (10.0 ** (sensitivity_db / 20.0))

        for c0, c1 in _mask_to_regions(env > thresh):
            candidates += 1
            cand_len = c1 - c0

            # Duration filter — rejects electrical clicks and
            # consonant-length events.
            if cand_len < min_event_samp or cand_len > max_event_samp:
                skipped_dur += 1
                continue
            nominated += 1

            abs_start = span_start + c0
            abs_end   = span_start + c1

            # ── Step 3: LPC prediction error gate ───────────────────────
            # Require context_ms of voiced context immediately before the
            # candidate, entirely inside the same voiced span.
            if abs_start - context_samp < span_start:
                skipped_ctx += 1
                continue

            context = sig[abs_start - context_samp:abs_start]
            if len(context) <= ar_order:
                skipped_ctx += 1
                continue

            coeffs     = burg_ar_coeffs(context, ar_order)
            prediction = ar_forward_predict(context, coeffs, cand_len)
            error      = sig[abs_start:abs_end] - prediction

            ctx_rms = np.sqrt(np.mean(context ** 2))
            err_rms = np.sqrt(np.mean(error ** 2))
            nrms    = err_rms / (ctx_rms + EPS)

            if nrms > nrms_threshold:
                detected.append((abs_start, abs_end))
                confirmed += 1

    diagnostics = {
        "voiced_spans":          len(spans),
        "candidate_regions":     candidates,
        "nominated_in_range":    nominated,
        "skipped_duration":      skipped_dur,
        "skipped_no_context":    skipped_ctx,
        "confirmed":             confirmed,
    }
    return detected, diagnostics


# ---------------------------------------------------------------------------
# Attenuation
# ---------------------------------------------------------------------------

def apply_attenuation(
    signal,
    detected_regions,        # list of (start_sample, end_sample)
    sr,
    attenuation_db  = 20.0,
    attack_ms       = 12.0,
    release_ms      = 25.0,
    pad_ms          = 4.0,
):
    """
    Attenuate detected regions with a smooth asymmetric gain envelope.
    Returns a new float32 array; the input is not modified.
    """
    sig = np.array(signal, dtype=np.float64, copy=True)
    n   = len(sig)
    if n == 0 or not detected_regions:
        return sig.astype(np.float32)

    pad        = int(round(sr * pad_ms / 1000.0))
    atten_gain = 10.0 ** (-attenuation_db / 20.0)

    # Padded + merged target regions.
    padded = [[max(0, s - pad), min(n, e + pad)] for s, e in detected_regions]
    merged = _merge_intervals(padded)

    # Target gain: 1.0 outside detected regions, atten_gain inside.
    target = np.ones(n, dtype=np.float64)
    for s, e in merged:
        target[s:e] = atten_gain

    attack_coef  = np.exp(-1.0 / (sr * attack_ms  / 1000.0))
    release_coef = np.exp(-1.0 / (sr * release_ms / 1000.0))

    # The envelope follower is run only in windows around each region.
    # Outside those windows the gain is saturated at 1.0, so a local pass is
    # exact and far cheaper than a full-signal sample loop. Each window is
    # padded by ~6 time constants so the gain has fully settled to 1.0 at
    # the window edges.
    settle  = max(1, int(round(6.0 * max(attack_ms, release_ms) / 1000.0 * sr)))
    windows = _merge_intervals([[max(0, s - settle), min(n, e + settle)]
                                for s, e in merged])

    gain = np.ones(n, dtype=np.float64)
    for ws, we in windows:
        current = 1.0
        for i in range(ws, we):
            tgt  = target[i]
            coef = attack_coef if tgt < current else release_coef
            current   = tgt + coef * (current - tgt)
            gain[i]   = current

    sig *= gain
    return sig.astype(np.float32)


# ---------------------------------------------------------------------------
# Multi-channel file wrapper
# ---------------------------------------------------------------------------

def process_file(input_path, output_path, vad_spans,
                  detect_params=None, attenuate_params=None):
    """
    Read input file, attenuate throat clicks in each channel independently
    (using the same VAD spans), write output. Returns the combined report.
    """
    detect_params    = detect_params    or {}
    attenuate_params = attenuate_params or {}

    audio, sr = sf.read(input_path, dtype='float32', always_2d=True)

    channels_out = []
    combined_report = {
        "sample_rate":       sr,
        "channels":          [],
        "clicks_detected":   0,
        "clicks_attenuated": 0,
    }

    for ch in range(audio.shape[1]):
        detected, diag = detect_throat_clicks(
            audio[:, ch], sr, vad_spans, **detect_params
        )
        processed = apply_attenuation(
            audio[:, ch], detected, sr, **attenuate_params
        )
        channels_out.append(processed)

        regions = [
            {
                "start_ms":    round(s / sr * 1000, 2),
                "end_ms":      round(e / sr * 1000, 2),
                "duration_ms": round((e - s) / sr * 1000, 2),
            }
            for s, e in detected
        ]
        combined_report["channels"].append({
            f"channel_{ch}": {
                "clicks_detected":   len(detected),
                "detected_regions":  regions,
                "diagnostics":       diag,
            }
        })
        combined_report["clicks_detected"]   += len(detected)
        combined_report["clicks_attenuated"] += len(detected)

    sf.write(output_path, np.stack(channels_out, axis=1), sr, subtype='FLOAT')
    return combined_report


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Throat / palate click attenuator for voiced speech"
    )
    parser.add_argument("input",  help="Input WAV path")
    parser.add_argument("output", help="Output WAV path")
    parser.add_argument("--vad-spans", required=True,
        help="JSON file: array of [start_sample, end_sample] voiced spans")
    # Detection
    parser.add_argument("--sensitivity-db", type=float, default=None,
        help="dB above voiced floor to nominate a candidate (default: 10).")
    parser.add_argument("--min-event-ms",   type=float, default=None,
        help="Minimum candidate duration in ms (default: 8).")
    parser.add_argument("--max-event-ms",   type=float, default=None,
        help="Maximum candidate duration in ms (default: 30).")
    parser.add_argument("--context-ms",     type=float, default=None,
        help="Pre-event voiced context for AR fitting in ms (default: 25).")
    parser.add_argument("--ar-order",       type=int,   default=None,
        help="AR model order (default: 2 + sr // 1000).")
    parser.add_argument("--nrms-threshold", type=float, default=None,
        help="Normalised prediction error to confirm detection (default: 2.5).")
    parser.add_argument("--env-window-ms",  type=float, default=None,
        help="RMS envelope smoothing window for nomination in ms (default: 5).")
    parser.add_argument("--floor-window-ms", type=float, default=None,
        help="Adaptive floor median window in ms (default: 150).")
    # Attenuation
    parser.add_argument("--attenuation-db", type=float, default=None,
        help="Attenuation depth in dB (default: 20).")
    parser.add_argument("--attack-ms",      type=float, default=None,
        help="Gain attack time in ms (default: 12).")
    parser.add_argument("--release-ms",     type=float, default=None,
        help="Gain release time in ms (default: 25).")
    parser.add_argument("--pad-ms",         type=float, default=None,
        help="Attenuation window padding in ms (default: 4).")
    args = parser.parse_args()

    with open(args.vad_spans) as fh:
        vad_spans = json.load(fh)

    detect_params = {
        k: v for k, v in {
            "sensitivity_db":  args.sensitivity_db,
            "min_event_ms":    args.min_event_ms,
            "max_event_ms":    args.max_event_ms,
            "context_ms":      args.context_ms,
            "ar_order":        args.ar_order,
            "nrms_threshold":  args.nrms_threshold,
            "env_window_ms":   args.env_window_ms,
            "floor_window_ms": args.floor_window_ms,
        }.items() if v is not None
    }
    attenuate_params = {
        k: v for k, v in {
            "attenuation_db": args.attenuation_db,
            "attack_ms":      args.attack_ms,
            "release_ms":     args.release_ms,
            "pad_ms":         args.pad_ms,
        }.items() if v is not None
    }

    report = process_file(
        args.input,
        args.output,
        vad_spans,
        detect_params=detect_params,
        attenuate_params=attenuate_params,
    )

    print(json.dumps(report, indent=2))
    sys.exit(0)
