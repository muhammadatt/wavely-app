"""
click_remover.py  (v2)
Transient click and lip-smack removal for speech/narration audio.

Detection:  Hampel filter applied to a high-pass filtered residual of the
            signal. Running detection on the HPF residual isolates transient
            onsets from slow-moving voice content, making even 3–15ms mouth
            clicks detectable regardless of background voice amplitude.

Repair:     Autoregressive (Burg method) interpolation. Clean samples on
            both sides of each detected region are used to fit an AR model;
            the click region is replaced with a blend of forward and backward
            predictions.

Pipeline position: Between Pre-4 (VAD/noise floor measurement) and Stage 1
                   (HPF) in the Instant Polish standard chain.

Usage:
    python click_remover.py input.wav output.wav [options]
    python click_remover.py input.wav output.wav --threshold 3.5 --max-click-ms 15

Output:
    Processed WAV written to output path.
    JSON report printed to stdout.
"""

import argparse
import json
import sys
import numpy as np
import soundfile as sf
from scipy.ndimage import median_filter
from scipy.signal import butter, sosfilt


# ---------------------------------------------------------------------------
# Burg AR interpolation
# ---------------------------------------------------------------------------

def burg_ar_coeffs(x, order):
    """
    Estimate AR model coefficients using the Burg method.
    x     : 1-D float64 array of clean signal samples
    order : AR model order
    Returns 1-D array of AR coefficients [a1, a2, ..., a_order].
    """
    n = len(x)
    if n <= order:
        raise ValueError(f"Context length ({n}) must exceed AR order ({order})")

    ef = x.copy().astype(np.float64)
    eb = x.copy().astype(np.float64)
    a  = np.zeros(order, dtype=np.float64)

    for m in range(order):
        num = -2.0 * np.dot(ef[m + 1:], eb[m : n - 1])
        den = (np.dot(ef[m + 1:], ef[m + 1:])
               + np.dot(eb[m : n - 1], eb[m : n - 1]))
        if den < 1e-12:
            break
        km = num / den

        a_new      = a.copy()
        a_new[m]   = km
        if m > 0:
            a_new[:m] = a[:m] + km * a[m - 1 :: -1]
        a = a_new

        ef_new = ef[m + 1:] + km * eb[m : n - 1]
        eb_new = eb[m : n - 1] + km * ef[m + 1:]

        ef[m + 1:] = ef_new
        eb[m + 1:] = eb_new

    return a


def ar_interpolate(signal, click_start, click_end, context_samples, ar_order):
    """
    Replace signal[click_start:click_end] with AR-interpolated values.
    Uses context_samples clean samples from each side to fit the AR model.
    Blends forward and backward predictions with a linear crossfade.
    Modifies signal in place; also returns it.
    """
    n         = len(signal)
    click_len = click_end - click_start

    left_ctx  = signal[max(0, click_start - context_samples) : click_start].copy()
    right_ctx = signal[click_end : min(n, click_end + context_samples)].copy()

    # Clamp AR order to whatever context is actually available on each side.
    # Zero-filling when context is too short can introduce audible dropouts;
    # reducing the order trades model accuracy for avoiding silence artifacts.
    left_order  = min(ar_order, len(left_ctx) - 1) if len(left_ctx) > 1 else 0
    right_order = min(ar_order, len(right_ctx) - 1) if len(right_ctx) > 1 else 0

    # Safety clipping to prevent runaway predictions
    max_val = max(np.max(np.abs(left_ctx)) if len(left_ctx) > 0 else 0,
                  np.max(np.abs(right_ctx)) if len(right_ctx) > 0 else 0) * 1.5

    fwd = None
    bwd = None

    # Forward prediction from left context
    if left_order >= 1:
        a_fwd = burg_ar_coeffs(left_ctx, left_order)
        fwd   = np.zeros(click_len, dtype=np.float64)
        buf   = left_ctx[-left_order:].tolist()
        for i in range(click_len):
            pred   = -np.dot(a_fwd, buf[-left_order:][::-1])
            pred   = np.clip(pred, -max_val, max_val)
            fwd[i] = pred
            buf.append(pred)

    # Backward prediction from right context (reverse signal)
    if right_order >= 1:
        a_bwd = burg_ar_coeffs(right_ctx[::-1], right_order)
        bwd   = np.zeros(click_len, dtype=np.float64)
        buf   = right_ctx[:right_order][::-1].tolist()
        for i in range(click_len):
            pred                    = -np.dot(a_bwd, buf[-right_order:][::-1])
            pred                    = np.clip(pred, -max_val, max_val)
            bwd[click_len - 1 - i]  = pred
            buf.append(pred)

    # If neither side produced a usable prediction, leave the region untouched.
    if fwd is None and bwd is None:
        return signal
    if fwd is None:
        signal[click_start:click_end] = bwd
        return signal
    if bwd is None:
        signal[click_start:click_end] = fwd
        return signal

    # Linear crossfade: weight shifts from forward to backward across the region
    blend = np.linspace(1.0, 0.0, click_len) if click_len > 1 else np.array([0.5])
    signal[click_start:click_end] = blend * fwd + (1.0 - blend) * bwd
    return signal


# ---------------------------------------------------------------------------
# HPF residual + Hampel filter detection
# ---------------------------------------------------------------------------

def build_hpf(sample_rate, cutoff_hz=800, order=4):
    """
    Build a high-pass Butterworth SOS filter.
    Applied to the signal before detection to isolate transient onsets.
    """
    return butter(order, cutoff_hz / (sample_rate / 2), btype='high', output='sos')


def hampel_detect(signal, window_samples, threshold_sigma):
    """
    Hampel outlier filter on a 1-D signal.
    Returns a boolean mask — True where the sample is a statistical outlier.

    Running this on an HPF-filtered version of the original signal means
    the MAD is computed over a residual where voice energy is suppressed
    and transient onsets are preserved.

    Vectorized via scipy.ndimage.median_filter: O(N log W) rather than the
    O(N * W) Python loop, which is prohibitively slow for long-form audio.
    """
    sig64      = signal.astype(np.float64)
    med        = median_filter(sig64, size=window_samples, mode='reflect')
    abs_dev    = np.abs(sig64 - med)
    mad_scaled = 1.4826 * median_filter(abs_dev, size=window_samples, mode='reflect')

    # Establish an absolute minimum noise floor using the global MAD
    # This prevents the detector from triggering wildly on tiny background
    # hiss or digital dither when the local signal amplitude drops to near-zero.
    global_mad = 1.4826 * np.median(np.abs(sig64 - np.median(sig64)))
    min_mad    = max(1e-4, global_mad * 0.5)

    mad_scaled = np.maximum(mad_scaled, min_mad)
    return (abs_dev > threshold_sigma * mad_scaled)


def merge_click_regions(mask, min_gap_samples):
    """
    Convert a boolean sample mask to a list of (start, end) tuples.
    Regions closer than min_gap_samples are merged into one.
    """
    regions  = []
    in_click = False
    start    = 0

    for i, flagged in enumerate(mask):
        if flagged and not in_click:
            start    = i
            in_click = True
        elif not flagged and in_click:
            regions.append((start, i))
            in_click = False
    if in_click:
        regions.append((start, len(mask)))

    if not regions:
        return regions

    merged = [regions[0]]
    for (s, e) in regions[1:]:
        if s - merged[-1][1] < min_gap_samples:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))

    return merged


# ---------------------------------------------------------------------------
# Main per-channel processing
# ---------------------------------------------------------------------------

def remove_clicks(
    signal,
    sample_rate,
    threshold_sigma=3.5,
    max_click_ms=15.0,
    context_ms=8.0,
    window_ms=1.5,
    hpf_cutoff_hz=800,
    ar_order=None,
):
    """
    Detect and repair clicks in a mono float32 signal.

    Parameters
    ----------
    signal          : np.ndarray, float32, mono, shape (N,)
    sample_rate     : int
    threshold_sigma : Hampel detection sensitivity on HPF residual.
                      Lower = more aggressive. 3.5 is conservative (few false
                      positives); 2.5 is aggressive (catches quieter clicks,
                      higher false-positive risk on sibilants).
    max_click_ms    : Clicks longer than this are left untouched. AR
                      interpolation becomes unreliable beyond ~15ms.
    context_ms      : Clean context on each side used to fit the AR model.
    window_ms       : Hampel filter window width applied to HPF residual.
                      Should be noticeably smaller than max_click_ms.
    hpf_cutoff_hz   : High-pass cutoff for the detection residual.
                      800 Hz suppresses voice fundamentals while preserving
                      click transient onsets.
    ar_order        : AR model order. Defaults to context_samples // 2.

    Returns
    -------
    repaired : np.ndarray, float32
    report   : dict
    """
    sig              = signal.astype(np.float64)
    max_click_samp   = int(sample_rate * max_click_ms  / 1000)
    context_samp     = int(sample_rate * context_ms    / 1000)
    window_samp      = max(3, int(sample_rate * window_ms / 1000) | 1)  # force odd

    if ar_order is None:
        ar_order = min(32, max(4, context_samp // 2))

    # Build HPF residual for detection
    hpf_sos    = build_hpf(sample_rate, cutoff_hz=hpf_cutoff_hz)
    hpf_signal = sosfilt(hpf_sos, sig)

    # Detect on HPF residual
    mask    = hampel_detect(hpf_signal, window_samp, threshold_sigma)
    regions = merge_click_regions(mask, min_gap_samples=3)

    repaired_count  = 0
    skipped_count   = 0
    skipped_regions = []

    for (start, end) in regions:
        click_len = end - start

        if click_len > max_click_samp:
            skipped_count += 1
            skipped_regions.append({
                "start_ms":   round(start / sample_rate * 1000, 2),
                "end_ms":     round(end   / sample_rate * 1000, 2),
                "duration_ms": round(click_len / sample_rate * 1000, 2),
                "reason": "exceeds max_click_ms"
            })
            continue

        if start < ar_order or (len(sig) - end) < ar_order:
            skipped_count += 1
            skipped_regions.append({
                "start_ms":   round(start / sample_rate * 1000, 2),
                "end_ms":     round(end   / sample_rate * 1000, 2),
                "duration_ms": round(click_len / sample_rate * 1000, 2),
                "reason": "insufficient context (near file boundary)"
            })
            continue

        ar_interpolate(sig, start, end, context_samp, ar_order)
        repaired_count += 1

    report = {
        "clicks_detected": len(regions),
        "clicks_repaired": repaired_count,
        "clicks_skipped":  skipped_count,
        "skipped_regions": skipped_regions,
        "parameters": {
            "threshold_sigma": threshold_sigma,
            "max_click_ms":    max_click_ms,
            "context_ms":      context_ms,
            "window_ms":       window_ms,
            "hpf_cutoff_hz":   hpf_cutoff_hz,
            "ar_order":        ar_order,
        }
    }

    return sig.astype(np.float32), report


# ---------------------------------------------------------------------------
# Multi-channel file wrapper
# ---------------------------------------------------------------------------

def process_file(input_path, output_path, **kwargs):
    """
    Read input file, remove clicks from each channel independently,
    write output. Returns the combined report dict.
    """
    audio, sr = sf.read(input_path, dtype='float32', always_2d=True)

    channels_out    = []
    combined_report = {
        "sample_rate":    sr,
        "channels":       [],
        "clicks_detected": 0,
        "clicks_repaired": 0,
        "clicks_skipped":  0,
    }

    for ch in range(audio.shape[1]):
        repaired_ch, ch_report = remove_clicks(audio[:, ch], sr, **kwargs)
        channels_out.append(repaired_ch)
        combined_report["channels"].append({f"channel_{ch}": ch_report})
        combined_report["clicks_detected"] += ch_report.get("clicks_detected", 0)
        combined_report["clicks_repaired"] += ch_report.get("clicks_repaired", 0)
        combined_report["clicks_skipped"]  += ch_report.get("clicks_skipped",  0)

    combined_report["total_clicks_repaired"] = combined_report["clicks_repaired"]

    sf.write(output_path, np.stack(channels_out, axis=1), sr, subtype='FLOAT')
    return combined_report


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Click and lip-smack remover for speech/narration audio"
    )
    parser.add_argument("input",  help="Input WAV path")
    parser.add_argument("output", help="Output WAV path")
    parser.add_argument("--threshold",    type=float, default=3.5,
        help="Hampel detection threshold in sigma (default: 3.5). "
             "Lower = more aggressive. Recommended range: 2.5–4.5.")
    parser.add_argument("--max-click-ms", type=float, default=15.0,
        help="Max click duration to repair in ms (default: 15). "
             "Longer regions are left untouched.")
    parser.add_argument("--context-ms",   type=float, default=8.0,
        help="AR context window per side in ms (default: 8).")
    parser.add_argument("--window-ms",    type=float, default=1.5,
        help="Hampel filter window width in ms (default: 1.5).")
    parser.add_argument("--hpf-cutoff",   type=float, default=800.0,
        help="High-pass cutoff Hz for detection residual (default: 800).")
    parser.add_argument("--ar-order",     type=int,   default=None,
        help="AR model order (default: context_samples // 2).")
    args = parser.parse_args()

    report = process_file(
        args.input,
        args.output,
        threshold_sigma=args.threshold,
        max_click_ms=args.max_click_ms,
        context_ms=args.context_ms,
        window_ms=args.window_ms,
        hpf_cutoff_hz=args.hpf_cutoff,
        ar_order=args.ar_order,
    )

    print(json.dumps(report, indent=2))
    sys.exit(0)
