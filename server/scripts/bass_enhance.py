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

def _safe_cutoff(fc: float, sr: int) -> float:
    """Clamp a cutoff frequency to the open interval (0, Nyquist). ``butter``
    rejects normalized frequencies at or beyond 1.0, so a user-supplied
    ``crossoverFallbackHz`` or ``fundamentalCutRatio`` that pushes a cutoff
    to/above Nyquist would crash the stage at runtime. Clamping at 99 % of
    Nyquist keeps the filter design valid for any input."""
    nyquist = sr / 2.0
    return float(np.clip(fc, 20.0, 0.99 * nyquist))


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
# VAD mask — frame-rate asymmetric IIR with vectorised upsampling
# ---------------------------------------------------------------------------

def _build_vad_sample_mask(
    vad_frames: list,
    n_samples: int,
    sr: int,
    attack_ms: float,
    release_ms: float,
) -> tuple[np.ndarray, float]:
    """
    Convert VAD frame labels to a per-sample float gate with asymmetric
    attack/release envelopes. Returns ``(mask, voiced_coverage_fraction)``.

    Implementation runs the IIR at frame rate (~40 Hz for 25 ms VAD frames),
    not sample rate (44.1 kHz). The frame quantisation is already the
    effective floor on attack sharpness — sub-frame attack times act as
    envelope shaping on the step transitions — so processing at frame rate
    is algorithmically equivalent within the VAD's own time resolution while
    being ~1000× cheaper than a per-sample Python loop. The frame envelope
    is upsampled to sample rate via vectorised linear interpolation.

    With no VAD frames available the whole file is treated as voiced.
    """
    if not vad_frames:
        return np.ones(n_samples, dtype=np.float32), 1.0

    n_frames        = len(vad_frames)
    targets         = np.empty(n_frames, dtype=np.float32)
    centers_samples = np.empty(n_frames, dtype=np.float64)
    voiced_samples  = 0

    for i, f in enumerate(vad_frames):
        s = int(f["offsetSamples"])
        ln = int(f["lengthSamples"])
        e = min(s + ln, n_samples)
        if s >= n_samples:
            # Frames past the end of the audio — clamp the array and break.
            targets         = targets[:i]
            centers_samples = centers_samples[:i]
            n_frames        = i
            break
        silent = bool(f.get("isSilence", False))
        targets[i]         = 0.0 if silent else 1.0
        centers_samples[i] = (s + e) / 2.0
        if not silent:
            voiced_samples += max(0, e - s)

    if n_frames == 0:
        return np.ones(n_samples, dtype=np.float32), 1.0

    # Frame period for the IIR coefficients. Most callers pass uniform 25 ms
    # frames so the median is a good representative; degenerate single-frame
    # inputs fall back to the frame's own length.
    if n_frames > 1:
        frame_period_ms = float(np.median(np.diff(centers_samples)) * 1000.0 / sr)
    else:
        frame_period_ms = float(int(vad_frames[0]["lengthSamples"]) * 1000.0 / sr)
    frame_period_ms = max(frame_period_ms, 1.0)

    a_coef = np.exp(-frame_period_ms / max(1.0, attack_ms))
    r_coef = np.exp(-frame_period_ms / max(1.0, release_ms))

    # Asymmetric IIR at frame rate — ~40 iterations per second of audio.
    env  = np.empty(n_frames, dtype=np.float32)
    prev = 0.0
    for i in range(n_frames):
        t = targets[i]
        c = a_coef if t >= prev else r_coef
        prev = c * prev + (1.0 - c) * t
        env[i] = prev

    # Upsample to sample rate via vectorised linear interpolation between
    # frame centres. Edges are held at the first/last frame value.
    sample_indices = np.arange(n_samples, dtype=np.float64)
    mask = np.interp(
        sample_indices, centers_samples, env,
        left=float(env[0]), right=float(env[-1]),
    ).astype(np.float32)

    coverage = voiced_samples / float(n_samples) if n_samples > 0 else 0.0
    return mask, coverage


# ---------------------------------------------------------------------------
# Per-utterance fixed-cutoff filter with boundary crossfade
# ---------------------------------------------------------------------------

def _apply_per_utterance_filter(
    audio: np.ndarray,
    sr: int,
    utterances: list[tuple[int, int]],
    cutoffs: list[float],
    transition_ms: float,
    btype: str,
    order: int = 4,
) -> np.ndarray:
    """
    Apply a per-utterance fixed-cutoff Butterworth filter to ``audio``.

    Within an utterance the filter is a single fixed-cutoff biquad chain. At
    boundaries between adjacent utterances, the outgoing and incoming filter
    outputs are linearly crossfaded over a window centred on the midpoint
    between the two utterances.

    Memory: ~4 × n_samples peak (input + one filter output + per-utterance
    weight envelope + accumulator). The previous bank-based approach held
    ``n_filters × n_samples`` in parallel — switching to one filter at a
    time means peak memory is independent of utterance count.

    CPU: ``n_utterances`` full-file IIR passes. For very long files with
    many utterances this could still be a lot of work; the simpler design
    is acceptable because per-utterance fixed cutoff is correct for a
    psychoacoustic effect (typical within-utterance pitch variation maps
    to bounded ~±6 dB of fundamental-attenuation swing).

    ``btype`` is ``'low'`` or ``'high'``. With no utterances, falls back
    to a single filter applied to the whole file at ``cutoffs[0]`` (or 300
    Hz when cutoffs is empty).
    """
    n = len(audio)
    if n == 0:
        return audio.astype(np.float32, copy=False)

    if not utterances:
        fc = cutoffs[0] if cutoffs else 300.0
        sos = butter(order, _safe_cutoff(fc, sr) / (sr / 2.0), btype=btype, output='sos')
        return _sosfilt_with_zi(sos, audio).astype(np.float32)

    transition_samples = max(8, int(transition_ms * sr / 1000.0))
    half_trans = transition_samples // 2

    out = np.zeros(n, dtype=np.float32)

    for i, ((s, e), fc) in enumerate(zip(utterances, cutoffs)):
        sos = butter(order, _safe_cutoff(fc, sr) / (sr / 2.0), btype=btype, output='sos')
        # One IIR pass over the whole file for this utterance's cutoff. The
        # output is reused via weighted-sum below and then released to the
        # garbage collector before the next iteration.
        y = _sosfilt_with_zi(sos, audio).astype(np.float32, copy=False)

        # Build this utterance's weight envelope: 1.0 in its active region,
        # ramped at the midpoints between adjacent utterances.
        weight = np.zeros(n, dtype=np.float32)

        # Left edge: ramp 0 → 1 across the boundary with the previous utterance.
        if i == 0:
            active_start = 0
        else:
            prev_e  = utterances[i - 1][1]
            mid     = (prev_e + s) // 2
            xf_lo   = max(0, mid - half_trans)
            xf_hi   = min(n, mid + half_trans)
            if xf_hi > xf_lo:
                weight[xf_lo:xf_hi] = np.linspace(
                    0.0, 1.0, xf_hi - xf_lo, dtype=np.float32, endpoint=False,
                )
            active_start = xf_hi

        # Right edge: ramp 1 → 0 across the boundary with the next utterance.
        if i == len(utterances) - 1:
            active_end = n
        else:
            next_s  = utterances[i + 1][0]
            mid     = (e + next_s) // 2
            xf_lo   = max(0, mid - half_trans)
            xf_hi   = min(n, mid + half_trans)
            if xf_hi > xf_lo:
                weight[xf_lo:xf_hi] = np.linspace(
                    1.0, 0.0, xf_hi - xf_lo, dtype=np.float32, endpoint=False,
                )
            active_end = xf_lo

        # Active region (full weight).
        if active_end > active_start:
            weight[active_start:active_end] = 1.0

        out += weight * y

    return out


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
    # VAD gate
    vad_attack_ms: float = 5.0,
    vad_release_ms: float = 20.0,
    # Skip conditions
    skip_if_voiced_ratio_below: float = 0.05,
    # Mix & output
    mix: float = 0.3,
    normalize_mode: str = 'harmonics-band',
    peak_ceiling_db: float = -1.0,
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
    bass_band = _apply_per_utterance_filter(
        mono, sr, utterances, utterance_crossovers,
        segment_transition_ms, btype='low',
    )

    # Track dry low-band RMS for the report (low_band_gain_db advisory).
    dry_low_rms = float(np.sqrt(np.mean(bass_band ** 2)) + 1e-12)

    # --- Step 2: Waveshaping — generates harmonics at 2F0, 3F0, … ----------
    saturated = tube_saturate(
        bass_band.astype(np.float32),
        drive=drive, bias=bias, softness=softness,
    ).astype(np.float32)

    # --- Step 3: Per-utterance HPF — strip (most of) the fundamental ------
    # Per-utterance fixed cutoff at f0_median × fundamental_cut_ratio.
    # Within an utterance the cutoff is fixed; speech pitch varies ~±20% so
    # the resulting fundamental attenuation swings ~±6 dB around the target,
    # which is acceptable for a psychoacoustic effect.
    hpf_cutoffs = [c / 1.5 * fundamental_cut_ratio for c in utterance_crossovers]
    harmonics_only = _apply_per_utterance_filter(
        saturated, sr, utterances, hpf_cutoffs,
        segment_transition_ms, btype='high',
    ).astype(np.float32)

    # --- Step 4: VAD gate — zero harmonics during silence ------------------
    gated = harmonics_only * vad_mask

    # Band-limit the gated harmonics back into the LPF crossover band — used
    # both for the low_band_gain_db advisory metric and (in 'broadband' mode)
    # as the post-blend energy check. The gated signal itself carries energy
    # at 2 × F0 / 3 × F0 / … above the LPF cutoff which would inflate the
    # metric if included raw.
    gated_low = _apply_per_utterance_filter(
        gated, sr, utterances, utterance_crossovers,
        segment_transition_ms, btype='low',
    )

    # --- Step 5: Determine the harmonics scale factor -----------------------
    # Three normalisation modes select different ways of deciding how loud
    # the added harmonics should be:
    #
    #   'harmonics-band' (default) — Match the harmonics' RMS in their own
    #     band to mix × dry-band-RMS, then cap by a peak-aware bound that
    #     keeps the blend under peak_ceiling_db. The dry voice is preserved
    #     bit-exact; only the added harmonics are scaled.
    #
    #   'broadband' — Legacy behaviour. Add mix × gated to the dry signal,
    #     then scale the whole blend back to the dry signal's broadband RMS.
    #     Preserves total loudness but attenuates the dry voice to "pay for"
    #     the new harmonic energy.
    #
    #   'off' — Pure additive: blend = audio + mix × gated. No level control
    #     beyond the final safety clip + downstream truePeakLimit.
    mode = (normalize_mode or 'harmonics-band').lower()
    if mode not in ('off', 'broadband', 'harmonics-band'):
        logger.warning(
            "BassEnhance: unknown normalize_mode=%r — falling back to 'harmonics-band'",
            normalize_mode,
        )
        mode = 'harmonics-band'

    peak_ceiling    = float(10.0 ** (peak_ceiling_db / 20.0))
    rms_scale       = float(mix)
    peak_safe_scale = float('inf')
    dry_band_rms    = 0.0
    gated_band_rms  = 0.0

    if mode == 'harmonics-band':
        # Dry energy in the harmonics band — same per-utterance HPF cutoffs
        # used to make harmonics_only. Restricted to voiced frames so silence
        # doesn't dilute either side of the ratio.
        dry_in_band = _apply_per_utterance_filter(
            mono, sr, utterances, hpf_cutoffs,
            segment_transition_ms, btype='high',
        )
        voiced_idx = vad_mask > 1e-6
        if voiced_idx.any():
            dry_band_rms   = float(np.sqrt(np.mean(dry_in_band[voiced_idx] ** 2)) + 1e-12)
            gated_band_rms = float(np.sqrt(np.mean(gated[voiced_idx]       ** 2)) + 1e-12)
        else:
            dry_band_rms   = float(np.sqrt(np.mean(dry_in_band ** 2)) + 1e-12)
            gated_band_rms = float(np.sqrt(np.mean(gated       ** 2)) + 1e-12)

        rms_scale = (dry_band_rms * float(mix)) / max(gated_band_rms, 1e-12)

        # Peak-aware cap: largest s such that max(|audio + s × gated|) <=
        # peak_ceiling. Only same-sign samples constrain the bound; opposite
        # signs partially cancel. Samples where the dry is already over the
        # ceiling are excluded — they're downstream truePeakLimit's problem,
        # not this stage's, and including them would force scale to zero on a
        # single pre-existing over.
        abs_g = np.abs(gated)
        if audio.ndim == 2:
            bounds = []
            for ch in range(n_channels):
                ach   = audio[:, ch]
                valid = (abs_g > 1e-6) & (np.sign(ach) == np.sign(gated)) & (np.abs(ach) < peak_ceiling)
                if valid.any():
                    bounds.append(float(((peak_ceiling - np.abs(ach[valid])) / abs_g[valid]).min()))
            if bounds:
                peak_safe_scale = min(bounds)
        else:
            valid = (abs_g > 1e-6) & (np.sign(audio) == np.sign(gated)) & (np.abs(audio) < peak_ceiling)
            if valid.any():
                peak_safe_scale = float(((peak_ceiling - np.abs(audio[valid])) / abs_g[valid]).min())

        scale = min(rms_scale, peak_safe_scale)
    else:
        # 'off' and 'broadband' both start from the literal mix multiplier.
        scale = float(mix)

    scale_limited_by = 'peak' if peak_safe_scale < rms_scale else 'rms'

    # --- Step 6: Additive blend onto the dry signal -------------------------
    if audio.ndim == 2:
        # Add the same harmonics signal to every channel (bass = center).
        blend = audio.copy()
        for ch in range(n_channels):
            blend[:, ch] = audio[:, ch] + scale * gated
    else:
        blend = audio + scale * gated

    # --- Step 7: Broadband RMS-match (legacy mode only) ---------------------
    # In 'harmonics-band' mode the scale was already chosen to match a target
    # band RMS; rescaling the broadband output here would defeat the design.
    # In 'off' mode the user opted out of any level matching. Only 'broadband'
    # mode performs the legacy whole-blend RMS scaling.
    effective_scale = scale
    if mode == 'broadband':
        dry_rms = float(np.sqrt(np.mean(audio ** 2)) + 1e-12)
        out_rms = float(np.sqrt(np.mean(blend ** 2)) + 1e-12)
        if out_rms > 0:
            renorm          = dry_rms / out_rms
            blend           = blend * renorm
            effective_scale = scale * renorm

    # Post-blend low-band energy for the advisory metric. dry_low_rms was
    # measured on the LPF'd bass band; the post measurement uses the same
    # band-limited gated signal multiplied by the effective coefficient that
    # ended up on gated in the final output.
    post_low_rms     = float(np.sqrt(np.mean((bass_band + effective_scale * gated_low) ** 2)) + 1e-12)
    low_band_gain_db = round(20.0 * np.log10(post_low_rms / dry_low_rms), 2)

    # Safety clip — the saturator + blend can push transient peaks past unity
    # on inputs that were already close to full scale. In 'harmonics-band'
    # mode this should be a no-op because the peak-safe scale already caps
    # the blend at peak_ceiling; the clip remains as a last-resort defence.
    blend = np.clip(blend, -1.0, 1.0).astype(np.float32)

    info = {
        "applied":               True,
        "n_segments":            len(utterances),
        "segment_crossovers_hz": [round(c, 1) for c in utterance_crossovers],
        "f0_range_hz":           [round(f0_range_hz[0], 1), round(f0_range_hz[1], 1)],
        "vad_coverage_pct":      round(voiced_ratio * 100, 2),
        "mix_effective":         round(float(mix), 3),
        "normalize_mode":        mode,
        "rms_scale":             round(rms_scale, 4),
        "peak_safe_scale":       (round(peak_safe_scale, 4)
                                  if np.isfinite(peak_safe_scale) else None),
        "applied_scale":         round(float(effective_scale), 4),
        "scale_limited_by":      scale_limited_by,
        "peak_ceiling_dbfs":     round(peak_ceiling_db, 2),
        "dry_band_rms_db":       (round(20.0 * np.log10(dry_band_rms), 2)
                                  if dry_band_rms > 0 else None),
        "gated_band_rms_db":     (round(20.0 * np.log10(gated_band_rms), 2)
                                  if gated_band_rms > 0 else None),
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
    # VAD gate
    parser.add_argument("--vad-attack-ms",          type=float, default=5.0)
    parser.add_argument("--vad-release-ms",         type=float, default=20.0)
    # Skip conditions & mix
    parser.add_argument("--skip-if-voiced-ratio-below", type=float, default=0.05)
    parser.add_argument("--mix",                    type=float, default=0.3)
    parser.add_argument("--normalize-mode",         default="harmonics-band",
                        choices=("off", "broadband", "harmonics-band"),
                        help="How to balance added harmonics against the dry "
                             "signal. Default 'harmonics-band' matches harmonic "
                             "RMS to dry-band RMS with a peak-aware cap.")
    parser.add_argument("--peak-ceiling-db",        type=float, default=-1.0,
                        help="Target peak ceiling (dBFS) for the harmonics-band "
                             "peak-safe scale cap. Ignored in other modes.")
    # Deprecated alias kept so older callers that pass --no-normalize-output
    # don't break. Equivalent to --normalize-mode off when set.
    parser.add_argument("--no-normalize-output",    action="store_true",
                        help=argparse.SUPPRESS)

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
        vad_attack_ms=args.vad_attack_ms,
        vad_release_ms=args.vad_release_ms,
        skip_if_voiced_ratio_below=args.skip_if_voiced_ratio_below,
        mix=args.mix,
        normalize_mode=('off' if args.no_normalize_output else args.normalize_mode),
        peak_ceiling_db=args.peak_ceiling_db,
    )

    wavfile.write(args.output, sr, processed.astype(np.float32))

    # Pure JSON on stdout — consumed by spawnPythonCapture in the JS wrapper.
    print(json.dumps(info))


if __name__ == "__main__":
    main()
