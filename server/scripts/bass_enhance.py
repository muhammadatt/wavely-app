#!/usr/bin/env python3
"""
Bass Enhancement — psychoacoustic bass synthesis (MaxxBass-style).

Instead of boosting sub-bass energy (which overloads downstream limiters and
disappears on small speakers), this stage synthesises harmonic overtones of
the fundamental and blends them additively into the dry signal. The auditory
system infers the missing fundamental from its overtones, producing the
sensation of deep bass without adding sub-bass energy.

Per-utterance F0 segmentation drives the LPF crossover so the band fed into
the saturator tracks the speaker's actual pitch. A balanced HPF above F0
strips most of the fundamental from the saturator output before the additive
blend; some residual fundamental survives — see fundamental_cut_ratio.

Upstream inputs consumed (both optional but recommended):
  --vad-frames-json   ctx.results.metrics.frames (Silero, 25 ms hop @ 44.1 kHz)
  --f0-contour-json   estimate_f0_contour.py output (autocorr, 512-sample hop)

Inputs/outputs: 32-bit float WAV; mono and stereo supported (stereo is summed
to mono for the harmonics chain, then the harmonics-only signal is added to
both channels equally — bass should be center).
"""

import argparse
import json
import logging
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt, sosfilt_zi

# tube_saturate already does 2× oversampling + tanh/arctan blend with bias —
# exactly what BassEnhance needs. Reuse rather than duplicate.
from vocal_saturation import tube_saturate

logger = logging.getLogger("bass_enhance")


# ---------------------------------------------------------------------------
# Filter helpers
# ---------------------------------------------------------------------------

def _butter_lp_sos(fc: float, sr: int, order: int = 4) -> np.ndarray:
    return butter(order, fc / (sr / 2.0), btype="low", output="sos")


def _butter_hp_sos(fc: float, sr: int, order: int = 4) -> np.ndarray:
    return butter(order, fc / (sr / 2.0), btype="high", output="sos")


def _sosfilt_with_zi(sos: np.ndarray, x: np.ndarray) -> np.ndarray:
    """sosfilt seeded to the input's leading sample — avoids the long boot
    transient a zero-initial-state SOS chain produces on bass-rich signals."""
    if x.size == 0:
        return x
    zi = sosfilt_zi(sos) * x[0]
    y, _ = sosfilt(sos, x, zi=zi)
    return y


# ---------------------------------------------------------------------------
# Per-utterance F0 segmentation
# ---------------------------------------------------------------------------

def _build_utterances(
    vad_frames: list,
    audio_len: int,
    sr: int,
    min_gap_ms: float,
    min_utterance_ms: float = 300.0,
) -> list[tuple[int, int]]:
    """
    Build (start_sample, end_sample) spans of contiguous voiced content.

    A new utterance starts after a silence gap of at least `min_gap_ms`.
    Utterances shorter than `min_utterance_ms` are dropped — pitch median over
    very short voiced runs is noisy and not worth a coefficient crossfade.

    With no VAD frames available, the whole file is treated as one utterance.
    """
    if not vad_frames:
        return [(0, audio_len)]

    gap_samples = int(min_gap_ms * sr / 1000.0)
    min_samples = int(min_utterance_ms * sr / 1000.0)

    utterances = []
    cur_start = None
    last_voiced_end = None
    silence_run_samples = 0

    for f in vad_frames:
        s = int(f["offsetSamples"])
        e = s + int(f["lengthSamples"])
        if not f.get("isSilence", False):
            if cur_start is None:
                cur_start = s
            last_voiced_end = e
            silence_run_samples = 0
        else:
            silence_run_samples += (e - s)
            if cur_start is not None and silence_run_samples >= gap_samples:
                if last_voiced_end - cur_start >= min_samples:
                    utterances.append((cur_start, last_voiced_end))
                cur_start = None
                last_voiced_end = None

    if cur_start is not None and last_voiced_end is not None:
        if last_voiced_end - cur_start >= min_samples:
            utterances.append((cur_start, last_voiced_end))

    return utterances


def _utterance_median_f0(
    start_sample: int,
    end_sample: int,
    f0_per_frame: list[float],
    f0_hop: int,
    f0_min_hz: float,
    f0_max_hz: float,
    min_estimates: int = 10,
) -> float | None:
    """Median F0 across the utterance's F0 frames, clamped to [f0_min, f0_max].

    Returns None when fewer than `min_estimates` valid frames overlap the
    utterance — caller falls back to the crossover_fallback_hz value."""
    if not f0_per_frame or f0_hop <= 0:
        return None

    lo = max(0, start_sample // f0_hop)
    hi = min(len(f0_per_frame), (end_sample + f0_hop - 1) // f0_hop)
    if hi <= lo:
        return None

    vals = [v for v in f0_per_frame[lo:hi] if v and f0_min_hz <= v <= f0_max_hz]
    if len(vals) < min_estimates:
        return None
    return float(np.median(vals))


# ---------------------------------------------------------------------------
# Time-varying HPF — pre-computed bank with sample-level interpolation
# ---------------------------------------------------------------------------

def _build_hpf_bank(
    sr: int,
    f0_min_hz: float,
    f0_max_hz: float,
    cut_ratio: float,
    n_filters: int,
    order: int,
) -> tuple[np.ndarray, list[np.ndarray]]:
    """
    Build a bank of HPFs at semitone-spaced cutoff frequencies from
    f0_min*cut_ratio to f0_max*cut_ratio. Returns (cutoff_array, [sos, ...]).

    Per the spec the bank is precomputed once; the chunk loop selects the two
    nearest filters per sample and interpolates their outputs.
    """
    fc_lo = f0_min_hz * cut_ratio
    fc_hi = f0_max_hz * cut_ratio
    # Geometric (semitone-ish) spacing so the perceptual resolution is
    # constant across the bank — high cutoffs would otherwise be too sparsely
    # covered.
    cutoffs = np.geomspace(fc_lo, fc_hi, n_filters)
    bank = [_butter_hp_sos(float(fc), sr, order=order) for fc in cutoffs]
    return cutoffs, bank


def _apply_tracking_hpf(
    x: np.ndarray,
    sr: int,
    sample_cutoff_hz: np.ndarray,
    bank_cutoffs: np.ndarray,
    bank_sos: list[np.ndarray],
) -> np.ndarray:
    """
    Apply a time-varying HPF whose cutoff follows `sample_cutoff_hz` (one
    cutoff per sample, smooth from upstream F0 smoothing).

    Implementation: run x through every filter in the bank in parallel, then
    per-sample linear-interpolate between the two adjacent filter outputs that
    bracket the requested cutoff. With a 12-filter bank this is 12 IIR passes
    per call — bounded and easy to verify, no per-frame coefficient design.
    """
    # All bank outputs at once. State-initialised to first-sample value to
    # suppress the IIR boot transient.
    outputs = np.stack([_sosfilt_with_zi(sos, x) for sos in bank_sos], axis=0)

    # Clamp cutoff to the bank's covered range, then locate the right bracket.
    clamped = np.clip(sample_cutoff_hz, bank_cutoffs[0], bank_cutoffs[-1])
    # searchsorted returns insertion index; we want the bracket [i-1, i].
    idx_hi = np.searchsorted(bank_cutoffs, clamped, side="left")
    idx_hi = np.clip(idx_hi, 1, len(bank_cutoffs) - 1)
    idx_lo = idx_hi - 1

    # Interpolation weight in log-cutoff space (matches the geometric bank
    # spacing — a half-step between two bank cutoffs is one half-octave, not
    # one half of the linear Hz gap).
    log_lo = np.log(bank_cutoffs[idx_lo])
    log_hi = np.log(bank_cutoffs[idx_hi])
    log_target = np.log(clamped)
    denom = log_hi - log_lo
    # Where lo == hi (clamped past the bank edges) denom is 0 — pick the edge
    # filter outright by sending weight to the bracket-low output.
    weight = np.where(denom > 1e-12, (log_target - log_lo) / denom, 0.0)

    samples = np.arange(len(x))
    y_lo = outputs[idx_lo, samples]
    y_hi = outputs[idx_hi, samples]
    return (1.0 - weight) * y_lo + weight * y_hi


# ---------------------------------------------------------------------------
# Smoothing & per-sample maps
# ---------------------------------------------------------------------------

def _causal_smooth(x: np.ndarray, window: int) -> np.ndarray:
    """Causal moving average; window in samples (>=1)."""
    if window <= 1 or x.size == 0:
        return x
    # Use cumulative sum for an O(n) causal mean.
    pad = np.concatenate([np.full(window - 1, x[0]), x])
    csum = np.cumsum(pad)
    return (csum[window - 1:] - np.concatenate([[0.0], csum[:-window]])) / window


def _f0_contour_to_sample_cutoff(
    f0_per_frame: list[float],
    f0_hop: int,
    n_samples: int,
    sr: int,
    cut_ratio: float,
    smooth_ms: float,
    fallback_hz: float,
    f0_min_hz: float,
    f0_max_hz: float,
) -> np.ndarray:
    """
    Expand the F0 contour to a per-sample HPF cutoff signal.

    Smoothing is causal so the cutoff lags the F0 contour slightly rather
    than leading it — matters across phoneme boundaries where leading the
    pitch can sweep the cutoff past a sustained vowel before the harmonics
    appear in the saturator output.
    """
    if f0_per_frame and f0_hop > 0:
        f0_arr = np.asarray(f0_per_frame, dtype=np.float64)
        # Replace zero/NaN entries (gaps the upstream estimator couldn't fill)
        # with the fallback so the cutoff curve stays continuous.
        bad = ~np.isfinite(f0_arr) | (f0_arr <= 0)
        if bad.any():
            f0_arr = np.where(bad, fallback_hz / max(cut_ratio, 1e-6), f0_arr)
        # Clamp to the estimator's operating range — anything outside is an
        # octave error or a regression to silence.
        f0_arr = np.clip(f0_arr, f0_min_hz, f0_max_hz)

        # Upsample frame-rate values to sample-rate via nearest-neighbour;
        # smoothing turns the staircase into a smooth ramp.
        sample_idx = np.arange(n_samples) // f0_hop
        sample_idx = np.clip(sample_idx, 0, f0_arr.size - 1)
        per_sample_f0 = f0_arr[sample_idx]
    else:
        per_sample_f0 = np.full(n_samples, fallback_hz / max(cut_ratio, 1e-6))

    cutoff = per_sample_f0 * cut_ratio
    smooth_samples = max(1, int(smooth_ms * sr / 1000.0))
    return _causal_smooth(cutoff, smooth_samples).astype(np.float64)


def _build_vad_sample_mask(
    vad_frames: list,
    n_samples: int,
    sr: int,
    attack_ms: float,
    release_ms: float,
) -> tuple[np.ndarray, float]:
    """
    Convert VAD frame labels to a per-sample float gate with asymmetric
    attack/release envelopes. Returns (mask, voiced_coverage_fraction).

    With no VAD frames available the whole file is treated as voiced. The
    25 ms VAD frame quantisation is the effective floor on attack sharpness;
    sub-frame attack times act as envelope shaping on the step transitions.
    """
    if not vad_frames:
        return np.ones(n_samples, dtype=np.float32), 1.0

    step = np.zeros(n_samples, dtype=np.float32)
    voiced_samples = 0
    for f in vad_frames:
        s = int(f["offsetSamples"])
        e = min(s + int(f["lengthSamples"]), n_samples)
        if s >= n_samples:
            break
        if not f.get("isSilence", False):
            step[s:e] = 1.0
            voiced_samples += (e - s)

    a_coef = np.exp(-1.0 / max(1.0, attack_ms  * sr / 1000.0))
    r_coef = np.exp(-1.0 / max(1.0, release_ms * sr / 1000.0))
    mask = np.empty(n_samples, dtype=np.float32)
    prev = 0.0
    # State-dependent coefficient — attack when rising, release when falling.
    # Tight loop in Python is the bottleneck for very long files; acceptable
    # for the current synchronous pipeline (10–60 s clips) but worth a numba
    # JIT pass if BassEnhance graduates to batch mode.
    for i in range(n_samples):
        t = step[i]
        c = a_coef if t >= prev else r_coef
        prev = c * prev + (1.0 - c) * t
        mask[i] = prev

    coverage = voiced_samples / float(n_samples) if n_samples > 0 else 0.0
    return mask, coverage


# ---------------------------------------------------------------------------
# Per-utterance LPF with boundary crossfade
# ---------------------------------------------------------------------------

def _apply_utterance_lpf(
    audio: np.ndarray,
    sr: int,
    utterances: list[tuple[int, int]],
    utterance_crossovers: list[float],
    transition_ms: float,
) -> np.ndarray:
    """
    Apply a per-utterance LPF whose cutoff follows the utterance median F0,
    crossfaded at boundaries to avoid clicks on hard consonants.

    Outside utterance spans the LPF still runs (using the nearest utterance's
    cutoff) so the saturator sees a continuous bass band — the VAD gate later
    zeros the harmonics-only signal in those regions anyway.
    """
    n = len(audio)
    if not utterances:
        return _sosfilt_with_zi(_butter_lp_sos(300.0, sr), audio)

    transition_samples = max(8, int(transition_ms * sr / 1000.0))

    # Build a sample-aligned cutoff envelope: piecewise constant inside each
    # utterance, linearly interpolated in log-Hz space across the boundary.
    cutoff_env = np.empty(n, dtype=np.float64)
    last_end = 0
    last_fc = utterance_crossovers[0]
    for (s, e), fc in zip(utterances, utterance_crossovers):
        # Gap before this utterance — ramp from last cutoff to this one in the
        # last `transition_samples` of the gap region.
        if s > last_end:
            ramp_start = max(last_end, s - transition_samples)
            cutoff_env[last_end:ramp_start] = last_fc
            ramp_n = s - ramp_start
            if ramp_n > 0:
                log_lo = np.log(last_fc)
                log_hi = np.log(fc)
                cutoff_env[ramp_start:s] = np.exp(
                    np.linspace(log_lo, log_hi, ramp_n, endpoint=False)
                )
        cutoff_env[s:e] = fc
        last_end = e
        last_fc = fc
    cutoff_env[last_end:n] = last_fc

    # Reuse the tracking-HPF infrastructure for the LPF too — build an LPF
    # bank, run audio through it, and pick the correct cutoff per sample.
    # The bank's cutoff range covers the utterance crossovers ±20%.
    fc_lo = max(60.0, min(utterance_crossovers) * 0.8)
    fc_hi = max(fc_lo * 2.0, max(utterance_crossovers) * 1.2)
    cutoffs = np.geomspace(fc_lo, fc_hi, 8)
    bank = [_butter_lp_sos(float(fc), sr) for fc in cutoffs]

    outputs = np.stack([_sosfilt_with_zi(sos, audio) for sos in bank], axis=0)

    clamped = np.clip(cutoff_env, cutoffs[0], cutoffs[-1])
    idx_hi = np.searchsorted(cutoffs, clamped, side="left")
    idx_hi = np.clip(idx_hi, 1, len(cutoffs) - 1)
    idx_lo = idx_hi - 1
    log_lo = np.log(cutoffs[idx_lo])
    log_hi = np.log(cutoffs[idx_hi])
    log_t  = np.log(clamped)
    denom  = log_hi - log_lo
    w = np.where(denom > 1e-12, (log_t - log_lo) / denom, 0.0)

    samples = np.arange(n)
    y_lo = outputs[idx_lo, samples]
    y_hi = outputs[idx_hi, samples]
    return ((1.0 - w) * y_lo + w * y_hi).astype(np.float32)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def bass_enhance(
    audio: np.ndarray,
    sr: int,
    vad_frames: list | None,
    f0_contour: dict | None,
    *,
    # Segmentation
    crossover_fallback_hz: float = 300.0,
    segment_transition_ms: float = 75.0,
    f0_cluster_min_gap_ms: float = 500.0,
    f0_min_hz: float = 80.0,
    f0_max_hz: float = 400.0,
    # Waveshaper
    drive: float = 3.0,
    softness: float = 0.5,
    bias: float = 0.3,
    # Fundamental removal
    fundamental_cut_ratio: float = 1.25,
    fundamental_cut_smooth_ms: float = 50.0,
    fundamental_cut_n_filters: int = 12,
    # VAD gate
    vad_attack_ms: float = 5.0,
    vad_release_ms: float = 20.0,
    # Skip conditions
    skip_if_voiced_ratio_below: float = 0.05,
    # Mix & output
    mix: float = 0.3,
    normalize_output: bool = True,
) -> tuple[np.ndarray, dict]:
    """
    Apply psychoacoustic bass enhancement to `audio`.

    Stereo input is summed to mono for the harmonics chain, then the
    harmonics-only signal is added equally to both channels (bass should be
    center; per-channel processing would produce stereo de-correlation in the
    bass band).

    Returns (processed_audio, info_dict).
    """
    audio = np.asarray(audio, dtype=np.float32)

    # --- Stereo handling: extract a mono sum for processing -----------------
    if audio.ndim == 2:
        n_channels = audio.shape[1]
        mono = np.mean(audio, axis=1).astype(np.float32)
    else:
        n_channels = 1
        mono = audio
    n_samples = len(mono)

    # --- VAD gate mask + voiced coverage guard ------------------------------
    vad_mask, voiced_ratio = _build_vad_sample_mask(
        vad_frames, n_samples, sr, vad_attack_ms, vad_release_ms,
    )
    if voiced_ratio < skip_if_voiced_ratio_below:
        logger.info(
            "BassEnhance: voiced coverage %.1f%% < %.1f%% — skipping stage",
            voiced_ratio * 100, skip_if_voiced_ratio_below * 100,
        )
        return audio, {
            "applied": False,
            "skip_reason": "voiced_ratio_below_threshold",
            "vad_coverage_pct": round(voiced_ratio * 100, 2),
        }

    # --- Per-utterance segmentation -----------------------------------------
    utterances = _build_utterances(
        vad_frames, n_samples, sr, f0_cluster_min_gap_ms,
    )
    if not utterances:
        utterances = [(0, n_samples)]

    f0_per_frame = (f0_contour or {}).get("perFrame") or []
    f0_hop       = int((f0_contour or {}).get("hopLength") or 512)
    file_median  = (f0_contour or {}).get("median") or crossover_fallback_hz / 1.5

    utterance_crossovers = []
    for (s, e) in utterances:
        med = _utterance_median_f0(
            s, e, f0_per_frame, f0_hop, f0_min_hz, f0_max_hz,
        )
        if med is None:
            # Fall back to the file median (clamped) rather than the global
            # crossover constant — file median is closer to the speaker than
            # an arbitrary 300 Hz default.
            med = float(np.clip(file_median, f0_min_hz, f0_max_hz))
        utterance_crossovers.append(med * 1.5)

    if not utterance_crossovers:
        utterance_crossovers = [crossover_fallback_hz]

    f0_used = [c / 1.5 for c in utterance_crossovers]
    f0_range_hz = (min(f0_used), max(f0_used))

    # --- Step 1: LPF to isolate the bass band -------------------------------
    bass_band = _apply_utterance_lpf(
        mono, sr, utterances, utterance_crossovers, segment_transition_ms,
    )

    # Track dry low-band RMS for the report (low_band_gain_db advisory).
    dry_low_rms = float(np.sqrt(np.mean(bass_band ** 2)) + 1e-12)

    # --- Step 2: Waveshaping — generates harmonics at 2F0, 3F0, … ----------
    saturated = tube_saturate(
        bass_band.astype(np.float32),
        drive=drive, bias=bias, softness=softness,
    ).astype(np.float32)

    # --- Step 3: Time-varying HPF — strip (most of) the fundamental --------
    sample_cutoff = _f0_contour_to_sample_cutoff(
        f0_per_frame, f0_hop, n_samples, sr,
        cut_ratio=fundamental_cut_ratio,
        smooth_ms=fundamental_cut_smooth_ms,
        fallback_hz=crossover_fallback_hz,
        f0_min_hz=f0_min_hz,
        f0_max_hz=f0_max_hz,
    )
    bank_cutoffs, bank_sos = _build_hpf_bank(
        sr, f0_min_hz, f0_max_hz, fundamental_cut_ratio,
        n_filters=fundamental_cut_n_filters, order=4,
    )
    harmonics_only = _apply_tracking_hpf(
        saturated, sr, sample_cutoff, bank_cutoffs, bank_sos,
    ).astype(np.float32)

    # --- Step 4: VAD gate — zero harmonics during silence ------------------
    gated = harmonics_only * vad_mask

    # Post-blend low-band energy for the advisory check.
    post_low_rms = float(np.sqrt(np.mean((bass_band + mix * gated) ** 2)) + 1e-12)
    low_band_gain_db = round(20.0 * np.log10(post_low_rms / dry_low_rms), 2)

    # --- Step 5: Additive blend onto the dry signal -------------------------
    if audio.ndim == 2:
        # Add the same harmonics signal to every channel (bass = center).
        blend = audio.copy()
        for ch in range(n_channels):
            blend[:, ch] = audio[:, ch] + mix * gated
    else:
        blend = audio + mix * gated

    # --- Step 6: Optional RMS-match back to dry level -----------------------
    if normalize_output:
        dry_rms = float(np.sqrt(np.mean(audio ** 2)) + 1e-12)
        out_rms = float(np.sqrt(np.mean(blend ** 2)) + 1e-12)
        if out_rms > 0:
            blend = blend * (dry_rms / out_rms)

    # Safety clip — the saturator + blend can push transient peaks past unity
    # on inputs that were already close to full scale.
    blend = np.clip(blend, -1.0, 1.0).astype(np.float32)

    info = {
        "applied":               True,
        "n_segments":            len(utterances),
        "segment_crossovers_hz": [round(c, 1) for c in utterance_crossovers],
        "f0_range_hz":           [round(f0_range_hz[0], 1), round(f0_range_hz[1], 1)],
        "vad_coverage_pct":      round(voiced_ratio * 100, 2),
        "mix_effective":         round(mix, 3),
        "low_band_gain_db":      low_band_gain_db,
        "fundamental_cut_ratio": round(fundamental_cut_ratio, 3),
        "drive":                 round(drive, 3),
        "softness":              round(softness, 3),
        "bias":                  round(bias, 3),
        "channels":              n_channels,
    }
    return blend, info


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(message)s")

    parser = argparse.ArgumentParser(
        description="BassEnhance — psychoacoustic bass synthesis stage",
    )
    parser.add_argument("--input",  required=True, help="Input WAV path (32-bit float)")
    parser.add_argument("--output", required=True, help="Output WAV path (32-bit float)")

    # Upstream inputs (passed via temp JSON files by the JS wrapper)
    parser.add_argument("--vad-frames-json", default=None,
                        help="Path to JSON list of FrameInfo objects "
                             "(ctx.results.metrics.frames). Optional — if absent, "
                             "the whole file is treated as voiced.")
    parser.add_argument("--f0-contour-json", default=None,
                        help="Path to JSON produced by estimate_f0_contour.py "
                             "(getF0Contour in f0Analysis.js). Optional — if "
                             "absent, the crossover fallback drives both the LPF "
                             "and the fundamental-removal HPF.")

    # Segmentation
    parser.add_argument("--crossover-fallback-hz",  type=float, default=300.0)
    parser.add_argument("--segment-transition-ms",  type=float, default=75.0)
    parser.add_argument("--f0-cluster-min-gap-ms",  type=float, default=500.0)
    parser.add_argument("--f0-min-hz",              type=float, default=80.0)
    parser.add_argument("--f0-max-hz",              type=float, default=400.0)
    # Waveshaper
    parser.add_argument("--drive",                  type=float, default=3.0)
    parser.add_argument("--softness",               type=float, default=0.5)
    parser.add_argument("--bias",                   type=float, default=0.3)
    # Fundamental removal
    parser.add_argument("--fundamental-cut-ratio",       type=float, default=1.25)
    parser.add_argument("--fundamental-cut-smooth-ms",   type=float, default=50.0)
    parser.add_argument("--fundamental-cut-n-filters",   type=int,   default=12)
    # VAD gate
    parser.add_argument("--vad-attack-ms",          type=float, default=5.0)
    parser.add_argument("--vad-release-ms",         type=float, default=20.0)
    # Skip conditions & mix
    parser.add_argument("--skip-if-voiced-ratio-below", type=float, default=0.05)
    parser.add_argument("--mix",                    type=float, default=0.3)
    parser.add_argument("--no-normalize-output",    action="store_true",
                        help="Skip the post-blend RMS-match step")

    args = parser.parse_args()

    # --- Load audio ---------------------------------------------------------
    sr, audio = wavfile.read(args.input)
    # The pipeline always feeds 32-bit float PCM; defensive cast for safety.
    if np.issubdtype(audio.dtype, np.integer):
        audio = audio.astype(np.float32) / np.iinfo(audio.dtype).max
    audio = audio.astype(np.float32, copy=False)

    # --- Load upstream JSON inputs ------------------------------------------
    vad_frames = None
    if args.vad_frames_json:
        with open(args.vad_frames_json) as fh:
            vad_frames = json.load(fh)

    f0_contour = None
    if args.f0_contour_json:
        with open(args.f0_contour_json) as fh:
            f0_contour = json.load(fh)

    processed, info = bass_enhance(
        audio, sr, vad_frames, f0_contour,
        crossover_fallback_hz=args.crossover_fallback_hz,
        segment_transition_ms=args.segment_transition_ms,
        f0_cluster_min_gap_ms=args.f0_cluster_min_gap_ms,
        f0_min_hz=args.f0_min_hz,
        f0_max_hz=args.f0_max_hz,
        drive=args.drive,
        softness=args.softness,
        bias=args.bias,
        fundamental_cut_ratio=args.fundamental_cut_ratio,
        fundamental_cut_smooth_ms=args.fundamental_cut_smooth_ms,
        fundamental_cut_n_filters=args.fundamental_cut_n_filters,
        vad_attack_ms=args.vad_attack_ms,
        vad_release_ms=args.vad_release_ms,
        skip_if_voiced_ratio_below=args.skip_if_voiced_ratio_below,
        mix=args.mix,
        normalize_output=not args.no_normalize_output,
    )

    wavfile.write(args.output, sr, processed.astype(np.float32))

    # Pure JSON on stdout — consumed by spawnPythonCapture in the JS wrapper.
    print(json.dumps(info))


if __name__ == "__main__":
    main()
