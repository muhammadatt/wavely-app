"""
corrective_eq.py
Stage 3a — Corrective EQ analysis.

Detects localised spectral anomalies (narrow-to-moderate humps and dips) in the
whole-file average voiced-frame spectral envelope and computes adaptive
parametric EQ band parameters for FFmpeg's `equalizer` filter.

This script performs analysis only — it emits band parameters as JSON. The
FFmpeg filter is applied by the Node side (correctiveEQ.js).

Pipeline reference: Stage 3a Corrective EQ spec v1.0 (supersedes v3.1 Stage 3).

Output JSON shape — see the spec's Logging section. Written to --output.

Implementation notes (deviations from the spec's reference pseudocode):
  * The cepstral envelope is converted from natural-log power to dB
    (factor 10/ln(10)) so the spec's per-region thresholds, which are stated
    in dB, are meaningful. The spec's reference snippet names the return value
    `envelope_db` but omits this conversion.
  * The tapered lifter keeps the LOW quefrencies (the smooth formant envelope)
    and fades to zero approaching the cutoff, matching the spec's stated intent
    ("zero the high-quefrency components that correspond to harmonic
    structure"). The spec's reference snippet applies the half-Hanning taper in
    the inverted direction.

Dependencies: numpy, scipy
"""

import argparse
import json
import logging
import math
import sys

import numpy as np
from scipy.io import wavfile

logger = logging.getLogger(__name__)

SAMPLE_RATE_EXPECTED = 44100
FRAME_SIZE           = 2048
HOP_SIZE             = 512
N_FFT                = 4096
MIN_VOICED_FRAMES    = 50
CONTEXT_OCTAVES      = 0.4
MERGE_OCTAVES        = 0.33
NATS_TO_DB           = 10.0 / math.log(10.0)

# Region order for reporting / FFmpeg chaining (low frequency -> high).
REGION_ORDER = [
    "sub_bass", "body_warmth", "mud", "boxy_honky", "nasal",
    "lower_presence", "upper_presence", "brilliance", "air",
]

# Detection regions. boost / cut limits use 0.0 for the direction that is not
# applicable to the region (a hump produces only cuts, a dip only boosts).
# Each entry: scan_low, scan_high, direction, threshold, max_boost, max_cut, scale
MALE_REGIONS = {
    "sub_bass":       (60,   130,  "hump", 4.0, 0.0, 4.0, 0.70),
    "body_warmth":    (120,  280,  "dip",  3.0, 4.0, 0.0, 0.70),
    "mud":            (200,  420,  "hump", 2.5, 0.0, 6.0, 0.70),
    "boxy_honky":     (380,  700,  "hump", 2.5, 0.0, 5.0, 0.70),
    "nasal":          (650,  1200, "hump", 2.5, 0.0, 5.0, 0.70),
    "lower_presence": (1200, 2500, "dip",  3.0, 4.0, 0.0, 0.70),
    "upper_presence": (2500, 5000, "hump", 2.5, 0.0, 5.0, 0.60),
    "brilliance":     (5000, 9000, "hump", 3.0, 0.0, 4.0, 0.70),
    "air":            (9000, 16000,"dip",  3.5, 3.0, 0.0, 0.70),
}
FEMALE_REGIONS = {
    "sub_bass":       (60,   130,  "hump", 4.0, 0.0, 4.0, 0.70),
    "body_warmth":    (180,  350,  "dip",  3.0, 4.0, 0.0, 0.70),
    "mud":            (280,  550,  "hump", 2.5, 0.0, 6.0, 0.70),
    "boxy_honky":     (450,  800,  "hump", 2.5, 0.0, 5.0, 0.70),
    "nasal":          (750,  1400, "hump", 2.5, 0.0, 5.0, 0.70),
    "lower_presence": (1500, 3000, "dip",  3.0, 4.0, 0.0, 0.70),
    "upper_presence": (3000, 6000, "hump", 2.5, 0.0, 5.0, 0.60),
    "brilliance":     (5000, 9000, "hump", 3.0, 0.0, 4.0, 0.70),
    "air":            (9000, 16000,"dip",  3.5, 3.0, 0.0, 0.70),
}


# ── Voice type classification ─────────────────────────────────────────────────

def classify_voice(median_f0_hz):
    """Return (voice_type, region_table) for the measured median F0."""
    if median_f0_hz < 165.0:
        return "male", MALE_REGIONS
    if median_f0_hz > 200.0:
        return "female", FEMALE_REGIONS

    # Ambiguous range: linearly interpolate scan boundaries between the male
    # and female region sets. Boundaries rounded to the nearest 10 Hz.
    t = (median_f0_hz - 165.0) / (200.0 - 165.0)
    interp = {}
    for name in MALE_REGIONS:
        m = MALE_REGIONS[name]
        f = FEMALE_REGIONS[name]
        lo = round((m[0] * (1 - t) + f[0] * t) / 10.0) * 10
        hi = round((m[1] * (1 - t) + f[1] * t) / 10.0) * 10
        # direction, threshold, limits and scale are identical across sets.
        interp[name] = (lo, hi, m[2], m[3], m[4], m[5], m[6])
    return "ambiguous", interp


# ── Step 1 — Cepstral spectral envelope ───────────────────────────────────────

def compute_cepstral_envelope(voiced_frames, sr, f0_p5_hz):
    """
    Compute the mean cepstral spectral envelope (in dB) across voiced frames.

    Returns (freqs_hz, envelope_db).
    """
    lifter_cutoff = int(0.85 / f0_p5_hz * sr)
    hann_win      = np.hanning(FRAME_SIZE)
    envelope_sum  = np.zeros(N_FFT // 2 + 1)

    tl = max(1, min(lifter_cutoff, N_FFT // 2))
    # Half-Hanning taper that keeps low quefrencies and fades to zero at the
    # cutoff. np.hanning(2*tl)[tl:] is the falling half (1 -> 0).
    half = np.hanning(2 * tl)[tl:]
    if half.max() > 0:
        half = half / half.max()
    lifter = np.zeros(N_FFT)
    lifter[:tl]  = half          # positive quefrencies 0 .. tl
    lifter[-tl:] = half[::-1]    # mirrored negative quefrencies

    for frame in voiced_frames:
        padded = np.zeros(N_FFT)
        seg    = frame[:FRAME_SIZE]
        padded[:len(seg)] = seg * hann_win[:len(seg)]

        spectrum  = np.fft.rfft(padded)
        log_power = np.log(np.abs(spectrum) ** 2 + 1e-10)
        cepstrum  = np.fft.irfft(log_power, n=N_FFT)
        liftered  = cepstrum * lifter
        envelope_sum += np.real(np.fft.rfft(liftered))

    freqs       = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    envelope_db = (envelope_sum / len(voiced_frames)) * NATS_TO_DB
    return freqs, envelope_db, lifter_cutoff


# ── Step 2 — Baseline estimation (edge anchoring) ─────────────────────────────

def estimate_baseline(freqs, envelope_db, scan_low_hz, scan_high_hz):
    """
    Estimate the expected level across a scan region by anchoring to the
    spectrum just outside it on both sides and interpolating in log-frequency.
    Returns (scan_freqs, scan_env, baseline) or (None, None, None).
    """
    ctx_lo_low  = scan_low_hz  / (2 ** CONTEXT_OCTAVES)
    ctx_lo_high = scan_low_hz
    ctx_hi_low  = scan_high_hz
    ctx_hi_high = scan_high_hz * (2 ** CONTEXT_OCTAVES)

    mask_lo = (freqs >= ctx_lo_low) & (freqs < ctx_lo_high)
    mask_hi = (freqs > ctx_hi_low) & (freqs <= ctx_hi_high)
    if not np.any(mask_lo) or not np.any(mask_hi):
        return None, None, None

    anchor_low  = float(np.median(envelope_db[mask_lo]))
    anchor_high = float(np.median(envelope_db[mask_hi]))

    mask_scan  = (freqs >= scan_low_hz) & (freqs <= scan_high_hz)
    scan_freqs = freqs[mask_scan]
    scan_env   = envelope_db[mask_scan]
    if scan_freqs.size < 2:
        return None, None, None

    log_sf   = np.log2(scan_freqs + 1e-10)
    baseline = np.interp(
        log_sf,
        [np.log2(scan_low_hz), np.log2(scan_high_hz)],
        [anchor_low, anchor_high],
    )
    return scan_freqs, scan_env, baseline


# ── Step 3 — Deviation detection and peak finding ─────────────────────────────

def detect_anomaly(scan_freqs, scan_env, baseline, threshold_db, direction):
    """
    Detect a hump or dip. Returns a dict with peak_deviation always populated:
      { peak_deviation_db, detected, center_hz, deviation_db, width_octaves }
    """
    deviation = scan_env - baseline
    if direction == "dip":
        deviation = -deviation  # always search for a positive peak

    peak_deviation = float(np.max(deviation))
    result = {"peak_deviation_db": peak_deviation, "detected": False}
    if peak_deviation < threshold_db:
        return result

    peak_idx  = int(np.argmax(deviation))
    center_hz = float(scan_freqs[peak_idx])

    above_half = deviation >= (peak_deviation / 2.0)
    if int(above_half.sum()) >= 2:
        width_octaves = float(
            np.log2(scan_freqs[above_half][-1] / scan_freqs[above_half][0])
        )
    else:
        width_octaves = 0.33

    signed_deviation = peak_deviation if direction == "hump" else -peak_deviation
    result.update(
        detected=True,
        center_hz=center_hz,
        deviation_db=signed_deviation,
        width_octaves=width_octaves,
    )
    return result


# ── Step 4 — Band parameter computation ───────────────────────────────────────

def q_from_width(width_octaves):
    """Q from the half-power bandwidth of a peaking EQ filter."""
    if width_octaves > 0:
        q = 1.0 / (2.0 * math.sinh(math.log(2) / 2.0 * width_octaves))
        return float(np.clip(q, 0.8, 8.0))
    return 3.0


def compute_band_params(center_hz, deviation_db, width_octaves,
                         scaling_factor, max_boost_db, max_cut_db):
    """Derive a parametric EQ band from a detection. Gain opposes the deviation."""
    gain_db = -deviation_db * scaling_factor
    gain_db = float(np.clip(gain_db, -max_cut_db, max_boost_db))
    q       = q_from_width(width_octaves)
    return {
        "freq_hz": round(center_hz, 1),
        "gain_db": round(gain_db, 2),
        "q":       round(q, 2),
    }


# ── Step 5 — Band merging ─────────────────────────────────────────────────────

def _band_edges(center_hz, width_octaves):
    half = width_octaves / 2.0
    return center_hz / (2 ** half), center_hz * (2 ** half)


def merge_bands(bands):
    """
    Merge detected bands whose centers are within 1/3 octave. Iterates until no
    further merges are possible. Returns (merged_bands, merge_count).
    """
    merge_count = 0
    changed = True
    while changed and len(bands) > 1:
        changed = False
        for i in range(len(bands)):
            for j in range(i + 1, len(bands)):
                b1, b2 = bands[i], bands[j]
                if abs(math.log2(b1["center_hz"]) - math.log2(b2["center_hz"])) < MERGE_OCTAVES:
                    bands = (
                        [b for k, b in enumerate(bands) if k not in (i, j)]
                        + [_combine(b1, b2)]
                    )
                    merge_count += 1
                    changed = True
                    break
            if changed:
                break
    return bands, merge_count


def _combine(b1, b2):
    center  = math.sqrt(b1["center_hz"] * b2["center_hz"])
    cut_lim = min(b1["cut_limit"], b2["cut_limit"])
    boost_lim = min(b1["boost_limit"], b2["boost_limit"])
    gain = b1["gain_db"] + b2["gain_db"]
    capped_gain = float(np.clip(gain, -cut_lim, boost_lim))
    if abs(capped_gain - gain) > 1e-6:
        logger.info(
            "merge cap: %s+%s summed %.2f dB capped to %.2f dB",
            b1["region"], b2["region"], gain, capped_gain,
        )

    lo1, hi1 = _band_edges(b1["center_hz"], b1["width_octaves"])
    lo2, hi2 = _band_edges(b2["center_hz"], b2["width_octaves"])
    width = math.log2(max(hi1, hi2) / min(lo1, lo2))

    return {
        "region":        b1["region"] + "+" + b2["region"],
        "center_hz":     center,
        "gain_db":       round(capped_gain, 2),
        "q":             round(q_from_width(width), 2),
        "width_octaves": width,
        "cut_limit":     cut_lim,
        "boost_limit":   boost_lim,
    }


# ── Frame collection ──────────────────────────────────────────────────────────

def collect_voiced_frames(audio, voiced_mask):
    """Collect FRAME_SIZE windows at HOP_SIZE whose centre sample is voiced."""
    frames = []
    half   = FRAME_SIZE // 2
    for start in range(0, len(audio) - FRAME_SIZE + 1, HOP_SIZE):
        center = start + half
        if voiced_mask is None or (center < len(voiced_mask) and voiced_mask[center]):
            frames.append(audio[start:start + FRAME_SIZE])
    return frames


# ── Main analysis ─────────────────────────────────────────────────────────────

def analyze(audio, sr, voiced_mask, f0_median_hz, f0_p5_hz):
    voice_type, regions = classify_voice(f0_median_hz)
    voiced_frames = collect_voiced_frames(audio, voiced_mask)

    base = {
        "stage":          "3a_corrective_eq",
        "voice_type":     voice_type,
        "f0_median_hz":   round(f0_median_hz, 2),
        "f0_p5_hz":       round(f0_p5_hz, 2),
        "voiced_frames_used": len(voiced_frames),
    }

    if len(voiced_frames) < MIN_VOICED_FRAMES:
        logger.warning(
            "only %d voiced frames (< %d) — skipping Stage 3a",
            len(voiced_frames), MIN_VOICED_FRAMES,
        )
        return {
            **base, "applied": False, "skipped": True,
            "reason": f"insufficient voiced content ({len(voiced_frames)} frames)",
            "lifter_cutoff_samples": 0, "regions": [], "bands": [],
            "ffmpeg_filter": None, "merged_bands": 0,
        }

    freqs, envelope_db, lifter_cutoff = compute_cepstral_envelope(
        voiced_frames, sr, f0_p5_hz,
    )

    region_logs = []
    detected    = []
    for name in REGION_ORDER:
        scan_low, scan_high, direction, threshold, max_boost, max_cut, scale = regions[name]
        entry = {
            "name": name, "scan_low_hz": scan_low, "scan_high_hz": scan_high,
            "direction": direction, "threshold_db": threshold,
        }

        scan_freqs, scan_env, baseline = estimate_baseline(
            freqs, envelope_db, scan_low, scan_high,
        )
        if scan_freqs is None:
            entry.update(detected=False, peak_deviation_db=None,
                         skip_reason="context window unavailable")
            region_logs.append(entry)
            continue

        det = detect_anomaly(scan_freqs, scan_env, baseline, threshold, direction)
        entry["peak_deviation_db"] = round(det["peak_deviation_db"], 2)
        if not det["detected"]:
            entry["detected"] = False
            region_logs.append(entry)
            continue

        params = compute_band_params(
            det["center_hz"], det["deviation_db"], det["width_octaves"],
            scale, max_boost, max_cut,
        )
        entry.update(
            detected=True,
            center_hz=params["freq_hz"],
            deviation_db=round(det["deviation_db"], 2),
            gain_db=params["gain_db"],
            q=params["q"],
            width_octaves=round(det["width_octaves"], 2),
        )
        region_logs.append(entry)

        # A clipped gain below the perception floor is treated as no correction.
        if abs(params["gain_db"]) < 0.1:
            continue

        detected.append({
            "region":        name,
            "center_hz":     params["freq_hz"],
            "gain_db":       params["gain_db"],
            "q":             params["q"],
            "width_octaves": det["width_octaves"],
            "cut_limit":     max_cut,
            "boost_limit":   max_boost,
        })

    merged, merge_count = merge_bands(detected)
    merged = [b for b in merged if abs(b["gain_db"]) >= 0.1]
    merged.sort(key=lambda b: b["center_hz"])

    bands = [
        {
            "region":  b["region"],
            "freq_hz": round(b["center_hz"], 1),
            "gain_db": round(b["gain_db"], 2),
            "q":       round(b["q"], 2),
        }
        for b in merged
    ]
    ffmpeg_filter = ",".join(
        f"equalizer=f={b['freq_hz']}:width_type=q:width={b['q']}:g={b['gain_db']}"
        for b in bands
    ) or None

    return {
        **base,
        "applied":               len(bands) > 0,
        "skipped":               False,
        "lifter_cutoff_samples": lifter_cutoff,
        "regions":               region_logs,
        "bands":                 bands,
        "ffmpeg_filter":         ffmpeg_filter,
        "merged_bands":          merge_count,
    }


# ── CLI ───────────────────────────────────────────────────────────────────────

def _load_voiced_mask(path, n_samples):
    with open(path) as fh:
        frame_list = json.load(fh)
    mask = np.zeros(n_samples, dtype=bool)
    for frame in frame_list:
        if not frame.get("isSilence", True):
            s = frame["offsetSamples"]
            e = min(s + frame["lengthSamples"], n_samples)
            if s < e:
                mask[s:e] = True
    return mask


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(message)s")
    parser = argparse.ArgumentParser(description="Stage 3a Corrective EQ analysis")
    parser.add_argument("--input",         required=True, help="Input WAV (float32, 44.1 kHz, mono)")
    parser.add_argument("--output",        required=True, help="Output JSON path")
    parser.add_argument("--vad-mask-json", default=None,  help="VAD frame list JSON")
    parser.add_argument("--f0-median",     type=float, required=True, help="Median F0 (Hz)")
    parser.add_argument("--f0-p5",         type=float, required=True, help="5th-percentile F0 (Hz)")
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    if np.issubdtype(audio.dtype, np.integer):
        audio = audio.astype(np.float32) / np.iinfo(audio.dtype).max
    else:
        audio = audio.astype(np.float32)
    if audio.ndim > 1:  # defensive — pipeline audio is mono by Stage 3a
        audio = audio.mean(axis=1)

    voiced_mask = None
    if args.vad_mask_json:
        voiced_mask = _load_voiced_mask(args.vad_mask_json, len(audio))

    f0_p5 = args.f0_p5 if args.f0_p5 > 0 else args.f0_median
    result = analyze(audio, sr, voiced_mask, args.f0_median, f0_p5)

    with open(args.output, "w") as fh:
        json.dump(result, fh)

    print(
        f"CorrectiveEQ: voice={result['voice_type']} "
        f"frames={result['voiced_frames_used']} "
        f"bands={len(result['bands'])} merged={result['merged_bands']}",
        flush=True,
    )
