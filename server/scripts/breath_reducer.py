"""
breath_reducer.py
Stage 4c -- Breath Reducer

Detects breath events in unvoiced audio regions using frame-level RMS, zero
crossing rate, and spectral flatness, then applies smooth wideband gain
reduction across each detected event.

Architecture:
  Detection:
    Per-frame features — RMS, ZCR, spectral flatness — computed via vectorised
    numpy operations (sliding_window_view + batched rfft). Breath frames pass
    all three thresholds: moderate energy (not silence, not speech), high ZCR,
    high flatness (noise-like spectrum). When a VAD mask is provided, voiced
    frames are excluded from candidacy regardless of feature values.

  Event grouping:
    Contiguous breath frames are merged into events and filtered by duration
    (min_breath_ms – max_breath_ms) to reject clicks and long noise beds.

  Reduction:
    Sample-domain gain envelope — no STFT required. Breaths are broadband so
    uniform gain reduction is appropriate and avoids spectral artifacts. A
    linear fade ramp of fade_ms at each event boundary prevents clicks.

Dependencies: numpy, scipy
"""

import argparse
import json
import logging
import sys
import time

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.io import wavfile
from scipy.signal import get_window

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Default parameters — single source of truth
# ---------------------------------------------------------------------------
# Per-preset overrides live in src/audio/presets.js as sparse `breathReducer`
# blocks and are passed via --params-json. Missing keys inherit from here.

DEFAULT_PARAMS = {
    # Gain
    "max_reduction_db":  12.0,  # Peak attenuation applied during breath events

    # Detection thresholds
    "rms_min_db":       -48.0,  # Below = silence (not a breath)
    "rms_max_db":       -24.0,  # Above = voiced speech (not a breath)
    "flatness_min":       0.20, # Spectral flatness minimum (Wiener entropy)
    "zcr_min":            0.08, # ZCR minimum (breaths have fast sign changes)

    # Event filtering
    "min_breath_ms":     60.0,  # Shorter events are clicks / transients
    "max_breath_ms":    550.0,  # Longer events are likely room noise sections

    # Fade ramps at event boundaries to prevent clicks
    "fade_ms":           15.0,

    # STFT geometry (must stay consistent across passes)
    "hop_length":        512,
    "n_fft":            2048,
}


def resolve_params(overrides=None):
    p = DEFAULT_PARAMS.copy()
    if overrides:
        p.update(overrides)
    return p


# ---------------------------------------------------------------------------
# Feature extraction — vectorised
# ---------------------------------------------------------------------------

def compute_features(audio, hop_length, n_fft):
    """
    Compute RMS, ZCR, and spectral flatness for all frames in one pass.

    Uses sliding_window_view + batched rfft — no Python-level per-frame loop.
    Returns three float32 arrays of shape (n_frames,), or three empty arrays
    if the audio is too short to form even one frame.
    """
    if len(audio) < n_fft:
        return np.array([], dtype=np.float32), np.array([], dtype=np.float32), np.array([], dtype=np.float32)

    window   = get_window("hann", n_fft, fftbins=True).astype(np.float32)
    frames   = sliding_window_view(audio.astype(np.float32), n_fft)[::hop_length]  # (n_frames, n_fft)
    n_frames = len(frames)

    if n_frames == 0:
        return np.array([], dtype=np.float32), np.array([], dtype=np.float32), np.array([], dtype=np.float32)

    # RMS
    rms = np.sqrt(np.mean(frames ** 2, axis=1))

    # ZCR — count sign crossings per frame, normalised by frame length
    signs          = np.sign(frames)
    signs[signs == 0] = 1.0
    zcr = np.sum(np.diff(signs, axis=1) != 0, axis=1) / float(n_fft)

    # Spectral flatness (Wiener entropy): geometric_mean / arithmetic_mean of |X|^2
    windowed  = frames * window                          # (n_frames, n_fft)
    power     = np.abs(np.fft.rfft(windowed, axis=1)) ** 2 + 1e-10  # (n_frames, n_bins)
    log_mean  = np.exp(np.mean(np.log(power), axis=1))
    arith     = np.mean(power, axis=1)
    flatness  = np.where(arith > 0.0, log_mean / arith, np.float32(0.0))

    return rms.astype(np.float32), zcr.astype(np.float32), flatness.astype(np.float32)


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

def detect_breath_frames(rms, zcr, flatness, params, voiced_mask=None):
    """
    Return a boolean frame mask — True = breath candidate.

    voiced_mask: bool array, same length as rms. When provided, frames where
    voiced_mask is True are excluded unconditionally — breaths only occur in
    unvoiced regions between speech phrases.
    """
    rms_db     = 20.0 * np.log10(rms + 1e-10)
    candidates = (
        (rms_db  >= params["rms_min_db"]) &
        (rms_db  <= params["rms_max_db"]) &
        (flatness >= params["flatness_min"]) &
        (zcr      >= params["zcr_min"])
    )
    if voiced_mask is not None and len(voiced_mask) == len(rms):
        candidates &= ~voiced_mask
    return candidates


# ---------------------------------------------------------------------------
# Event grouping
# ---------------------------------------------------------------------------

def group_events(breath_mask, hop_length, sr, params):
    """
    Merge contiguous True frames into (start_sample, end_sample) pairs.
    Events shorter than min_breath_ms or longer than max_breath_ms are dropped.
    """
    if not breath_mask.any():
        return []

    min_frames = max(1, int(params["min_breath_ms"] * sr / 1000.0 / hop_length))
    max_frames = int(params["max_breath_ms"] * sr / 1000.0 / hop_length)

    # Vectorised run-length encoding
    padded = np.concatenate([[False], breath_mask, [False]])
    diff   = np.diff(padded.view(np.int8))
    starts = np.where(diff ==  1)[0]
    ends   = np.where(diff == -1)[0]

    events = []
    for s, e in zip(starts, ends):
        dur = e - s
        if min_frames <= dur <= max_frames:
            events.append((int(s) * hop_length, int(e) * hop_length))
    return events


# ---------------------------------------------------------------------------
# Gain application
# ---------------------------------------------------------------------------

def apply_gain_envelope(audio, events, max_reduction_db, fade_samples):
    """
    Build a sample-domain gain envelope and multiply the audio by it.

    Per event:
      [start, start+fade)     — linear fade from 1.0 → target_gain
      [start+fade, end-fade)  — hold at target_gain
      [end-fade, end)         — linear fade from target_gain → 1.0

    np.minimum ensures the deepest reduction wins when events are adjacent.
    """
    n           = len(audio)
    target_gain = float(10.0 ** (-max_reduction_db / 20.0))
    gain        = np.ones(n, dtype=np.float32)

    for start_s, end_s in events:
        start_s = max(0, start_s)
        end_s   = min(n, end_s)
        if start_s >= end_s:
            continue

        half_event = (end_s - start_s) // 2
        fade_in_n  = min(fade_samples, half_event)
        fade_out_n = min(fade_samples, half_event)

        # Fade in
        fi_end = start_s + fade_in_n
        if fade_in_n > 0:
            ramp = np.linspace(1.0, target_gain, fade_in_n, dtype=np.float32)
            gain[start_s:fi_end] = np.minimum(gain[start_s:fi_end], ramp)

        # Hold
        hold_start = fi_end
        hold_end   = end_s - fade_out_n
        if hold_start < hold_end:
            gain[hold_start:hold_end] = np.minimum(
                gain[hold_start:hold_end], target_gain,
            )

        # Fade out
        fo_start = hold_end
        if fade_out_n > 0:
            ramp = np.linspace(target_gain, 1.0, fade_out_n, dtype=np.float32)
            gain[fo_start:end_s] = np.minimum(gain[fo_start:end_s], ramp)

    return (audio * gain).astype(np.float32)


# ---------------------------------------------------------------------------
# Pipeline entry point
# ---------------------------------------------------------------------------

def apply_breath_reduction(audio, sr, params=None, vad_frames=None):
    """
    Detect and attenuate breath events in mono float32 audio.

    vad_frames: list of frame dicts { offsetSamples, lengthSamples, isSilence }
      from frameAnalysis.js. When provided, voiced frames (isSilence=False) are
      excluded from detection — breaths only occur between speech phrases.

    Returns a dict. When applied=True the dict also contains an "audio" key
    with the processed float32 array; the caller pops it before serialising.
    """
    t0     = time.perf_counter()
    params = resolve_params(params)
    hop    = params["hop_length"]
    n_fft  = params["n_fft"]

    if audio.ndim != 1:
        raise ValueError("breath_reducer expects mono (1D) input")

    rms, zcr, flatness = compute_features(audio, hop, n_fft)
    n_frames = len(rms)

    if n_frames == 0:
        return {
            "applied": False, "breath_events": 0,
            "max_reduction_db": 0.0,
            "process_seconds": round(time.perf_counter() - t0, 3),
        }

    # Build voiced exclusion mask from VAD frame list
    voiced_mask = None
    if vad_frames:
        voiced_mask = np.zeros(n_frames, dtype=bool)
        for frame in vad_frames:
            if not frame.get("isSilence"):
                s = max(0, frame["offsetSamples"] // hop)
                e = min(n_frames, (frame["offsetSamples"] + frame["lengthSamples"]) // hop + 1)
                voiced_mask[s:e] = True
        logger.info(f"VAD mask: {int(voiced_mask.sum())} / {n_frames} frames voiced (excluded from detection)")

    breath_mask = detect_breath_frames(rms, zcr, flatness, params, voiced_mask)
    logger.info(
        f"Detection: {int(breath_mask.sum())} / {n_frames} frames passed "
        f"rms/zcr/flatness thresholds"
    )

    events = group_events(breath_mask, hop, sr, params)
    logger.info(f"Events after duration filter: {len(events)}")

    if not events:
        return {
            "applied": False, "breath_events": 0,
            "max_reduction_db": 0.0,
            "process_seconds": round(time.perf_counter() - t0, 3),
        }

    fade_samples = max(1, int(params["fade_ms"] * sr / 1000.0))
    out_audio    = apply_gain_envelope(audio, events, params["max_reduction_db"], fade_samples)
    elapsed      = round(time.perf_counter() - t0, 3)

    logger.info(
        f"Done: {len(events)} events reduced by up to "
        f"{params['max_reduction_db']:.1f} dB in {elapsed}s"
    )
    return {
        "audio":            out_audio,
        "applied":          True,
        "breath_events":    len(events),
        "max_reduction_db": params["max_reduction_db"],
        "process_seconds":  elapsed,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(message)s")

    parser = argparse.ArgumentParser(description="Stage 4c -- Breath Reducer")
    parser.add_argument("--input",         required=True)
    parser.add_argument("--output",        required=True)
    parser.add_argument("--params-json",   default=None,
                        help="Sparse parameter overrides (JSON). Missing keys "
                             "inherit from DEFAULT_PARAMS. Sourced from the "
                             "preset's breathReducer block in presets.js.")
    parser.add_argument("--vad-mask-json", default=None,
                        help="VAD frame list JSON from frameAnalysis.js. Voiced "
                             "frames are excluded from breath detection.")
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    audio = audio.astype(np.float32)
    if audio.ndim > 1:
        audio = audio[:, 0]

    params = None
    if args.params_json:
        with open(args.params_json) as fh:
            params = json.load(fh)

    vad_frames = None
    if args.vad_mask_json:
        with open(args.vad_mask_json) as fh:
            vad_frames = json.load(fh)

    result    = apply_breath_reduction(audio, sr, params, vad_frames)
    out_audio = result.pop("audio", None)

    if result["applied"] and out_audio is not None:
        wavfile.write(args.output, sr, out_audio)

    print(json.dumps(result), flush=True)
