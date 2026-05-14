"""
clip_gain_deesser.py
Clip-gain de-esser. Per-event gain reduction rendered as a cosine fade
envelope multiplied against the audio. No time constants, no compressor
sidechain -- two discrete passes:

  1. Read the sibilance event map (produced by analyze_sibilance_events.py
     with min_duration_ms set so brief consonant stops are filtered out).
  2. For each event compute a target gain reduction relative to the RMS of
     surrounding voiced (non-sibilant) speech, then accumulate a cosine fade
     envelope into a per-sample multiplier array. The whole array is applied
     to the audio in a single vectorised pass.

Inputs (CLI):
  --input             32-bit float mono WAV at 44.1 kHz
  --output            Output WAV (mono float32)
  --events-json       Event map JSON (must contain per-event peak metadata:
                      startSample/endSample/peakSample/peakRelativePosition/
                      eventPeakDb/eventType). Produced by
                      analyze_sibilance_events.py with min_duration_ms >= 25.
  --vad-mask-json     Optional frame-list JSON (offsetSamples, lengthSamples,
                      isSilence). Used to identify voiced frames for the
                      context RMS measurement. When absent the script falls
                      back to "any frame that is not part of a sibilant event"
                      as the voiced context.
  --natural-ceiling-db
  --reduction-ratio
  --max-reduction-db
  --context-window-ms (default 80)
  --fricative-fade-in-ms / --fricative-fade-out-ms
  --affricate-fade-in-ms / --affricate-fade-out-ms

Output: rewrites the WAV with the gain envelope applied. Emits a single
JSON_RESULT: line summarising treated event counts and max reduction.

Dependencies: numpy, scipy
"""

import argparse
import json
import logging
import sys

import numpy as np
from scipy.io import wavfile


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_wav_float32(path: str):
    """
    Returns (sr, audio_2d, was_stereo). audio_2d has shape (n_samples, n_channels);
    mono inputs come back as (n_samples, 1) so the same code path handles both.
    Channel preservation matters for presets whose channelOutput is 'preserve'.
    """
    sr, audio = wavfile.read(path)
    if np.issubdtype(audio.dtype, np.integer):
        audio = audio.astype(np.float32) / np.iinfo(audio.dtype).max
    else:
        audio = audio.astype(np.float32)
    if audio.ndim == 1:
        return sr, audio[:, None], False
    return sr, audio, True


def _mono_view(audio_2d: np.ndarray) -> np.ndarray:
    """Mono mixdown for detection / context-RMS measurement only."""
    if audio_2d.shape[1] == 1:
        return audio_2d[:, 0]
    return audio_2d.mean(axis=1).astype(np.float32)


def _build_sibilant_sample_mask(events: list, n_samples: int) -> np.ndarray:
    """Boolean mask over samples where any sibilant event is active."""
    mask = np.zeros(n_samples, dtype=bool)
    for ev in events:
        s = max(0, int(ev.get("startSample", 0)))
        e = min(n_samples - 1, int(ev.get("endSample", s)))
        if e >= s:
            mask[s : e + 1] = True
    return mask


def _build_voiced_sample_mask(vad_frames: list, n_samples: int):
    """Boolean mask over samples that VAD flagged as voiced (isSilence false)."""
    if vad_frames is None:
        return None
    mask = np.zeros(n_samples, dtype=bool)
    for fr in vad_frames:
        if fr.get("isSilence"):
            continue
        s = int(fr["offsetSamples"])
        e = min(n_samples, s + int(fr["lengthSamples"]))
        if e > s:
            mask[s:e] = True
    return mask


def _context_rms_db(
    audio: np.ndarray,
    event_start: int,
    event_end: int,
    window_samples: int,
    sibilant_mask: np.ndarray,
    voiced_mask,
) -> float:
    """
    Mean-square energy of the voiced non-sibilant samples in a ±window around
    the event. Returns None when no usable context is found (utterance bounded
    by sibilants or silence on both sides).

    Flexible window: takes whatever voiced non-sibilant samples are available
    on either side of the event, so utterance-initial and utterance-final
    sibilants fall back to the single available side cleanly.
    """
    n = audio.shape[0]
    pre_start  = max(0, event_start - window_samples)
    pre_end    = event_start
    post_start = event_end + 1
    post_end   = min(n, event_end + 1 + window_samples)

    def _slice_mask(start, end):
        if end <= start:
            return None
        m = np.ones(end - start, dtype=bool)
        m &= ~sibilant_mask[start:end]
        if voiced_mask is not None:
            m &= voiced_mask[start:end]
        return m

    samples = []
    pre_m = _slice_mask(pre_start, pre_end)
    if pre_m is not None and pre_m.any():
        samples.append(audio[pre_start:pre_end][pre_m])
    post_m = _slice_mask(post_start, post_end)
    if post_m is not None and post_m.any():
        samples.append(audio[post_start:post_end][post_m])

    if not samples:
        return None
    ctx = np.concatenate(samples)
    if ctx.size == 0:
        return None
    rms = float(np.sqrt(np.mean(ctx.astype(np.float64) ** 2)) + 1e-12)
    return 20.0 * np.log10(rms + 1e-12)


def _cosine_fade(length: int, *, rising: bool) -> np.ndarray:
    """
    Half-Hann (cosine) ramp of `length` samples from 0->1 (rising) or 1->0
    (falling). Zero derivative at both endpoints — avoids the click a linear
    fade produces at its inflection point.
    """
    if length <= 0:
        return np.zeros(0, dtype=np.float32)
    t = np.linspace(0.0, np.pi, length, endpoint=True, dtype=np.float64)
    ramp = (1.0 - np.cos(t)) * 0.5
    if not rising:
        ramp = 1.0 - ramp
    return ramp.astype(np.float32)


def _render_event_envelope(
    multiplier:    np.ndarray,
    event_start:   int,
    event_end:     int,
    gain_linear:   float,
    fade_in:       int,
    fade_out:      int,
) -> None:
    """
    Accumulate an event's gain envelope into the file-wide multiplier array
    (initialised to 1.0).

    Shape:
        Unity ──┐                              ┌── Unity
                └── [cosine fade] ── [flat] ── [cosine fade]
                                      ↑
                                gain_linear held
                                across body

    To accumulate multiple overlapping events correctly we MULTIPLY the
    rendered envelope into the array (rather than overwrite). Overlapping
    events compound, which is the right behaviour: two simultaneous sibilants
    should both contribute to reduction.
    """
    n = multiplier.shape[0]
    body_start = min(n, event_start + fade_in)
    body_end   = max(body_start, event_end - fade_out + 1)

    # Fade-in: unity at event_start, gain_linear at body_start. ramp goes
    # 0 -> 1 across the fade window, so seg interpolates from 1.0 down to
    # gain_linear (zero derivative at both endpoints).
    if fade_in > 0 and event_start < n:
        a = max(0, event_start)
        b = min(n, event_start + fade_in)
        if b > a:
            ramp = _cosine_fade(b - a, rising=True)
            seg  = (1.0 - ramp) * 1.0 + ramp * gain_linear
            multiplier[a:b] *= seg.astype(multiplier.dtype)

    # Flat body
    if body_end > body_start:
        a = max(0, body_start)
        b = min(n, body_end)
        if b > a:
            multiplier[a:b] *= gain_linear

    # Fade-out: gain_linear at body_end, unity at event_end + 1
    if fade_out > 0 and event_end + 1 <= n:
        a = max(0, event_end - fade_out + 1)
        b = min(n, event_end + 1)
        if b > a:
            ramp = _cosine_fade(b - a, rising=True)  # 0 -> 1
            seg  = (1.0 - ramp) * gain_linear + ramp * 1.0
            multiplier[a:b] *= seg.astype(multiplier.dtype)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Clip-gain de-esser.")
    parser.add_argument("--input",          required=True)
    parser.add_argument("--output",         required=True)
    parser.add_argument("--events-json",    required=True)
    parser.add_argument("--vad-mask-json",  default=None)
    parser.add_argument("--natural-ceiling-db", type=float, default=7.0)
    parser.add_argument("--reduction-ratio",    type=float, default=0.55)
    parser.add_argument("--max-reduction-db",   type=float, default=7.0)
    parser.add_argument("--context-window-ms",  type=float, default=80.0)
    parser.add_argument("--fricative-fade-in-ms",  type=float, default=3.0)
    parser.add_argument("--fricative-fade-out-ms", type=float, default=4.0)
    parser.add_argument("--affricate-fade-in-ms",  type=float, default=1.5)
    parser.add_argument("--affricate-fade-out-ms", type=float, default=4.5)
    args = parser.parse_args()

    sr, audio_2d, was_stereo = _read_wav_float32(args.input)
    n_samples = audio_2d.shape[0]
    # Detection / context-RMS / event-peak comparison all run on a mono
    # mixdown so a centred sibilant doesn't get measured twice. The gain
    # envelope is later applied to every channel, preserving stereo layout
    # for presets where channelOutput is 'preserve'.
    audio = _mono_view(audio_2d)

    with open(args.events_json, "r") as fh:
        event_map = json.load(fh)
    events = event_map.get("events", []) or []

    vad_frames = None
    if args.vad_mask_json:
        with open(args.vad_mask_json, "r") as fh:
            vad_frames = json.load(fh)

    sibilant_mask = _build_sibilant_sample_mask(events, n_samples)
    voiced_mask   = _build_voiced_sample_mask(vad_frames, n_samples)

    window_samples = max(1, int(round((args.context_window_ms / 1000.0) * sr)))

    multiplier        = np.ones(n_samples, dtype=np.float32)
    treated_events    = []
    skipped_in_range  = 0
    skipped_no_ctx    = 0
    max_reduction_db  = 0.0

    for ev in events:
        # Reject events without the sample-domain peak metadata. The
        # caller (sibilance_detector.build_events_map) emits these fields
        # only when `audio` was passed in; this script can't synthesize
        # them itself.
        if "startSample" not in ev or "eventPeakDb" not in ev:
            logger.warning(
                "clip_gain_deesser: event missing peak metadata — skipping"
            )
            continue

        s = max(0, int(ev["startSample"]))
        e = min(n_samples - 1, int(ev["endSample"]))
        if e <= s:
            continue

        event_peak_db = float(ev["eventPeakDb"])
        ev_type       = ev.get("eventType", "fricative")

        ctx_rms_db = _context_rms_db(
            audio, s, e,
            window_samples,
            sibilant_mask,
            voiced_mask,
        )
        if ctx_rms_db is None:
            skipped_no_ctx += 1
            continue

        excess_db = event_peak_db - (ctx_rms_db + args.natural_ceiling_db)
        if excess_db <= 0:
            skipped_in_range += 1
            continue

        gain_db = -min(excess_db * args.reduction_ratio, args.max_reduction_db)
        gain_linear = float(10.0 ** (gain_db / 20.0))

        if ev_type == "affricate":
            fade_in_ms  = args.affricate_fade_in_ms
            fade_out_ms = args.affricate_fade_out_ms
        else:
            fade_in_ms  = args.fricative_fade_in_ms
            fade_out_ms = args.fricative_fade_out_ms

        fade_in_samples  = max(1, int(round((fade_in_ms  / 1000.0) * sr)))
        fade_out_samples = max(1, int(round((fade_out_ms / 1000.0) * sr)))

        # Ensure the fades fit inside the event. If the event is too short to
        # hold both fades, scale them down proportionally so each still gets
        # some samples and the flat body collapses to zero length cleanly.
        total_fades = fade_in_samples + fade_out_samples
        event_len   = e - s + 1
        if total_fades > event_len:
            scale = event_len / float(total_fades)
            fade_in_samples  = max(1, int(fade_in_samples  * scale))
            fade_out_samples = max(1, int(fade_out_samples * scale))

        _render_event_envelope(
            multiplier,
            event_start = s,
            event_end   = e,
            gain_linear = gain_linear,
            fade_in     = fade_in_samples,
            fade_out    = fade_out_samples,
        )

        max_reduction_db = max(max_reduction_db, abs(gain_db))
        treated_events.append({
            "startSec":     round(s / sr, 4),
            "endSec":       round((e + 1) / sr, 4),
            "durationMs":   round((e - s + 1) * 1000.0 / sr, 1),
            "eventType":    ev_type,
            "eventPeakDb":  round(event_peak_db, 2),
            "contextRmsDb": round(ctx_rms_db, 2),
            "gainDb":       round(gain_db, 2),
        })

    # Vectorised single-pass apply. Multiplier is per-sample, broadcast
    # across channels so stereo layout is preserved.
    processed_2d = (audio_2d.astype(np.float32) * multiplier[:, None]).astype(np.float32)
    out = processed_2d[:, 0] if not was_stereo else processed_2d
    wavfile.write(args.output, sr, out)

    summary = {
        "applied":            len(treated_events) > 0,
        "eventCount":         len(events),
        "treatedCount":       len(treated_events),
        "skippedInRange":     skipped_in_range,
        "skippedNoContext":   skipped_no_ctx,
        "maxReductionDb":     round(max_reduction_db, 2) if treated_events else 0.0,
        "treatedEvents":      treated_events,
        "naturalCeilingDb":   args.natural_ceiling_db,
        "reductionRatio":     args.reduction_ratio,
        "maxReductionCapDb":  args.max_reduction_db,
    }
    print("JSON_RESULT:" + json.dumps(summary), flush=True)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    sys.exit(main())
