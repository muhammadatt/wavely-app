"""
sibilance_detector.py
Self-contained sibilance event detector.

Provides the SibilanceDetector class and analyze_sibilance_events() function
used by airBoost (post-boost sibilant masking), the clip-gain de-esser, and
resonanceSuppressor (sibilant_only passes). Each calling stage supplies its
own detection parameters via the standard sparse-override pattern.

Scope: voiceless fricatives (/s/, /f/, /ʃ/). Voiced fricatives (/z/, /ʒ/,
/v/) are rejected by the voicing-dominance veto by design; if a downstream
need to capture them appears, the veto would be the place to relax.

Detection scheme:

  - Sibilant frequency band: derived from F0 via get_sibilant_band(). Lower
    edge is max(F0*6, 2.5 kHz); upper edge is fixed at 12 kHz (or Nyquist).
  - Per-frame band update: F0 is supplied externally as a per-STFT-frame
    contour (typically from estimate_f0_contour.py). The detector maintains
    a rolling-window median over those values and rebuilds the band mask
    when the median shifts beyond F0_MASK_RESHIFT_THRESHOLD_HZ -- avoids
    mask churn from contour jitter while tracking real pitch changes.
  - Voicing-dominance veto: frames where 80-1500 Hz energy dominates the
    in-band mean by more than voicing_veto_db are vowels/voiced content
    and are rejected before any other check.
  - Absolute energy gate: in-band mean must exceed the upstream-measured
    noise floor (noise_floor_dbfs) by min_sibilant_energy_above_noise_db.
    When the caller does not supply a noise floor the gate is disabled
    (standalone / audit use). The gate replaces the previous EMA and
    rolling-context-buffer references, which self-masked inside long
    fricatives because they were temporal references built from the very
    signal being detected.
  - Spectral-shape check (P95 + flatness): in-band P95 must exceed the
    in-band mean by p95_trigger_db AND in-band spectral flatness must
    exceed min_flatness. Distinguishes broadband fricative turbulence
    from narrow-band content that survives the veto and gate.

The module owns no F0 estimation. Callers that need an F0 contour should
get one from estimate_f0_contour.py via getF0Contour() in f0Analysis.js.
"""

import logging
import math
import time
from collections import deque

import numpy as np


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Rolling F0 parameters
# ---------------------------------------------------------------------------
# The detector consumes an externally-supplied per-frame F0 contour and
# maintains a rolling-median view of it. The band mask is rebuilt only when
# the median shifts beyond F0_MASK_RESHIFT_THRESHOLD_HZ -- prevents mask
# churn from per-frame contour jitter.

F0_ROLLING_WINDOW_SIZE       = 10
F0_MASK_RESHIFT_THRESHOLD_HZ = 20.0


# ---------------------------------------------------------------------------
# Default parameters
# ---------------------------------------------------------------------------
# Detection-only knobs. Each calling stage supplies a sparse override block
# (e.g. preset.airBoost.sibilanceDetection or preset.resonanceSuppressor[i]
# .sibilanceDetection); anything omitted inherits from this dict.

DEFAULT_PARAMS = {
    # Spectral-shape check: P95 spike + flatness gate. Distinguishes
    # broadband fricative turbulence from narrow-band content.
    "p95_trigger_db":              6.0,
    "min_flatness":                0.1,
    # Voicing-dominance veto. Vowels and other voiced content have low-band
    # (80-1500 Hz) energy that dominates the in-band mean by 30-50 dB;
    # voiceless fricatives have high-band energy at or above low-band level.
    # Suppress detection when LF-mean exceeds in-band mean by more than this
    # threshold (dB). Runs first so vetoed frames cannot fire.
    # TODO: when LF mean is also below an absolute floor (e.g. -50 dBFS) the
    # voice has gone quiet and the LF/HF ratio becomes noise-dominated --
    # deep male voices on quiet aspirated /h/+/s/ blends may need the veto
    # bypassed in that regime. Not adding the bypass yet -- current evidence
    # is the veto under-suppresses, not over-suppresses.
    "voicing_veto_db":             20.0,
    "voicing_veto_lf_low_hz":      80.0,
    "voicing_veto_lf_high_hz":     1500.0,
    # Absolute energy gate. In-band mean must exceed noise_floor_dbfs by
    # at least this many dB. Replaces the previous EMA/contextual-buffer
    # temporal references, which self-masked inside long fricatives. The
    # noise floor is supplied per-call by the pipeline (frameAnalysis.js).
    # When noise_floor_dbfs is None the gate is disabled (standalone use).
    "min_sibilant_energy_above_noise_db": 20.0,
    "noise_floor_dbfs":            None,
    # Minimum event duration (ms). Events shorter than this are dropped from
    # the returned event map entirely. Default 0 preserves backward
    # compatibility for stages that share the detector (airBoost,
    # resonanceSuppressor). The clip-gain de-esser sets ~25 ms so it never
    # treats brief consonant stops or click residuals as sibilants.
    "min_duration_ms":             0.0,
    # Gap merge (ms). Consecutive events separated by fewer frames than this
    # threshold are joined into one event. Reduces fragmentation of long
    # fricatives whose P95-mean ratio briefly dips below trigger mid-burst
    # (the loud body of a sustained /f/ or /s/ can flatten enough that the
    # spectral-shape check drops out for a few frames between the onset
    # and the trailing turbulence). The 80 ms window stays well inside
    # the silence_gap_reset_ms boundary, so it cannot bridge across
    # passage breaks.
    "gap_merge_ms":                80.0,
    # Silence-gap reset. When the analyzer sees this many ms of contiguous
    # unvoiced frames it treats the next voiced frame as a passage onset:
    # the rolling-F0 deque is cleared, and (when the caller supplies a
    # look-ahead median) the sibilant band is reseeded from the new
    # segment's pitch. Without this the band would stay frozen at the
    # previous segment's F0 for the first 2-3 voiced frames of the new
    # passage while the rolling-median buffer refills.
    "silence_gap_reset_ms":        150.0,
    # Voiced frames within this window after a passage onset are tagged
    # postSilenceOnset=True in the per-event detection diagnostics so
    # misfires concentrated at passage starts can be identified from logs.
    "post_silence_window_ms":      150.0,
    # Fricative tail extension (ms). Silero VAD marks the trailing
    # turbulence-only portion of unvoiced fricatives (/f/, /s/, /sh/)
    # as silence once the voicing dies, which truncates sibilant events
    # mid-burst. After every voiced->silence transition this many ms of
    # subsequent silence frames are forcibly marked voiced so the
    # detector continues running through the fricative tail. The voicing
    # veto and absolute energy gate still apply, so pure silence inside
    # the extension window cannot trigger detection.
    "fricative_tail_extension_ms": 80.0,
    # Fricative head pre-roll (ms). Symmetric counterpart to the tail
    # extension. Silero VAD marks the leading turbulence-only portion of
    # unvoiced fricatives (/f/, /s/, /sh/) as silence until voicing
    # begins, which truncates sibilant events on the head -- e.g. the
    # /sh/ in "she" can start 50-80 ms before the vowel. Before every
    # silence->voiced transition this many ms of preceding silence
    # frames are forcibly marked voiced so the detector can evaluate
    # them. Per-frame gates (P95+flatness, voicing veto, energy gate)
    # still apply, so silence cannot trigger detection.
    "fricative_head_extension_ms": 80.0,
    # Boundary expansion. After the main detection loop, walk outward from
    # each contiguous sibilant run and promote adjacent voiced frames whose
    # per-frame stats clear the *relaxed* P95 + flatness thresholds. Captures
    # the leading/trailing turbulence frames of fricatives whose spectral
    # margin has been eaten by upstream EQ -- the corrective EQ runs before
    # the de-esser, which puts boundary frames consistently 0.3-1.5 dB under
    # the steady-state P95 trigger and 0.005-0.02 under min_flatness. Hard
    # gates (voicing veto, absolute energy gate, pre-band check) are never
    # relaxed; only the spectral-shape margin is.
    #
    # boundary_p95_relax_db    -- relax p95_trigger_db by this many dB at
    #                              event boundaries (default 1.5 -> effective
    #                              trigger 4.5 dB at boundaries).
    # boundary_flatness_relax  -- relax min_flatness by this much at event
    #                              boundaries (default 0.02 -> effective
    #                              minimum 0.08 at boundaries).
    # 0 on either knob disables that side of the relaxation. Setting both
    # to 0 disables expansion entirely.
    "boundary_p95_relax_db":       1.5,
    "boundary_flatness_relax":     0.02,
}


# Threshold below which an event is classified as an affricate (the percussive
# burst portion of /tʃ/, /dʒ/, etc.) rather than a steady-state fricative. Used
# downstream by the clip-gain de-esser to pick fade-in/-out lengths so the full
# reduction lands before the affricate's transient peak.
AFFRICATE_PEAK_POSITION = 0.35


# ---------------------------------------------------------------------------
# Spectral class (strident vs non-strident)
# ---------------------------------------------------------------------------
# Strident fricatives (/s/, /ʃ/) concentrate their turbulence energy in the
# 4-10 kHz band and sit at or above the surrounding voiced level. Non-strident
# fricatives (/f/, /θ/) are weak labiodental/interdental sources whose energy
# is distributed more evenly across 1-10 kHz at a much lower absolute level --
# they sit several dB *below* surrounding voiced speech in natural recordings.
#
# The single-axis "above surrounding voiced RMS" ceiling used by the clip-gain
# de-esser is well calibrated for stridents but cannot describe the natural
# rest position of non-stridents (which need a target *below* context, not
# above it). To support a class-keyed ceiling downstream, each event is
# tagged with its spectral class here at detection time.
#
# Classification feature: ratio of high-band RMS power (4-10 kHz) to low-mid
# band RMS power (1-4 kHz), measured over a Hann-windowed FFT of the entire
# event span. Empirical values from Jongman et al. 2000 and the literature:
#   /s/  ~  +8 to +15 dB    /ʃ/ ~  +3 to  +8 dB
#   /f/  ~  -3 to  +2 dB    /θ/ ~  -5 to   0 dB
# A threshold at +3 dB cleanly separates the two groups on clean fricative
# samples. Constant exposed so it can be tuned against a measured corpus.
#
# Two-axis rule: /ʃ/ peak energy sits at 2.5-4 kHz -- right on the LM/HF band
# boundary at 4 kHz -- so its ratio is intrinsically borderline and can dip
# below the +3 dB threshold on recordings with a darker mic or mid-cut EQ.
# Absolute in-band loudness (P95) cleanly separates /ʃ/ from /f/ in that
# regime: /f/ is an intrinsically weak labiodental source that sits 8-15 dB
# below /s/ and /ʃ/ in conversational speech (Jongman et al. 2000), so even
# a loud /f/ rarely reaches the +5 dB band-P95 mark. The rescue clause says:
# "if the core ratio is at least neutral AND the core P95 is genuinely loud
# in the sibilant band, treat as strident even if the ratio falls below the
# main threshold." Measured over the same P95-fired sub-span used for the
# ratio so both axes reflect identical detector evidence.
HF_BAND_LOW_HZ                       =  4000.0
HF_BAND_HIGH_HZ                      = 10000.0
LM_BAND_LOW_HZ                       =  1000.0
LM_BAND_HIGH_HZ                      =  4000.0
STRIDENT_CLASSIFICATION_THRESHOLD_DB =  3.0
STRIDENT_RESCUE_RATIO_FLOOR_DB       =  0.0
STRIDENT_RESCUE_LOUDNESS_DB          =  5.0


def resolve_params(overrides: dict = None) -> dict:
    """Merge sparse overrides over DEFAULT_PARAMS. None or empty -> defaults."""
    params = DEFAULT_PARAMS.copy()
    if overrides:
        params.update(overrides)
    return params


# ---------------------------------------------------------------------------
# Sibilant band identification
# ---------------------------------------------------------------------------

def get_sibilant_band(f0: float, sample_rate: int) -> tuple:
    """
    Derive the sibilant band from F0.

    Lower bound: max(F0*6, 2.5 kHz) -- /sh/, /ch/, /j/ have peak energy
    centred at 2.5-4 kHz; the previous 3 kHz floor excluded ~30% of their
    in-band power and was the dominant cause of post-silence /sh/ misses
    (see audit of 12_spectralSubtraction.wav, 12.25 s and 17.30 s events).
    The F0*6 multiplier still keeps the floor safely above F1/F2 for
    typical voices (a 400 Hz F0 -> 2.4 kHz lower bound, clamped up to 2.5).
    Upper bound: fixed at 12 kHz (or Nyquist) -- fricative turbulence is
    broadband noise whose extent depends on vocal tract acoustics, not F0.
    """
    nyquist = sample_rate / 2.0
    low_hz  = max(f0 * 6.0, 2500.0)
    high_hz = min(12000.0, nyquist)
    return float(low_hz), float(high_hz)


# ---------------------------------------------------------------------------
# Event map serialisation
# ---------------------------------------------------------------------------

def _compute_event_band_ratio_db(
    audio:        np.ndarray,
    start_sample: int,
    end_sample:   int,
    sample_rate:  int,
) -> float:
    """
    Ratio of HF (4-10 kHz) to LM (1-4 kHz) RMS power over the event span,
    measured from a Hann-windowed FFT of the full event audio. Positive
    values indicate a strident spectral profile (/s/, /ʃ/); near-zero or
    negative values indicate a non-strident profile (/f/, /θ/).

    Hann window suppresses vowel bleed at the event boundaries -- a hard
    rectangular window can pull spectral mass downward into the LM band
    when the event starts mid vowel->fricative transition. The whole-span
    FFT gives better frequency resolution than the detector's per-frame
    STFT for short events (a ~30 ms event holds barely one full STFT
    frame at n_fft=2048).

    Returns 0.0 when the event is too short for a meaningful FFT or when
    either band contains no measurable energy (degenerate case). 0.0
    classifies as non-strident under the default threshold (+3 dB) --
    safer default than crashing or returning NaN.
    """
    seg = audio[start_sample : end_sample + 1]
    if seg.size < 32:
        return 0.0

    n        = seg.size
    window   = np.hanning(n).astype(np.float64)
    spectrum = np.fft.rfft(seg.astype(np.float64) * window)
    power    = (np.abs(spectrum) ** 2)
    freqs    = np.fft.rfftfreq(n, d=1.0 / sample_rate)

    hf_mask = (freqs >= HF_BAND_LOW_HZ) & (freqs <= HF_BAND_HIGH_HZ)
    lm_mask = (freqs >= LM_BAND_LOW_HZ) & (freqs <= LM_BAND_HIGH_HZ)

    hf_power = float(power[hf_mask].sum())
    lm_power = float(power[lm_mask].sum())

    if hf_power <= 0.0 or lm_power <= 0.0:
        return 0.0
    return 10.0 * np.log10(hf_power / lm_power)


def _aggregate_event_detection(
    per_frame_diag: dict,
    frame_start:    int,
    frame_end:      int,
):
    """
    Reduce per-frame detection diagnostics across an event's frame range
    into a single summary block attached to the event JSON. Captures which
    detect() condition fired on each frame plus the in-band stats used to
    arrive at that decision, so per-event misfires can be audited from
    logs. Returns None when no frames in the range carry diagnostics.
    """
    diags = [
        per_frame_diag[i] for i in range(frame_start, frame_end + 1)
        if i in per_frame_diag
    ]
    if not diags:
        return None

    by_condition = {}
    p95_vals, mean_vals, flat_vals = [], [], []
    f0_vals,  lf_vals              = [], []
    band_lo, band_hi, post_silence = None, None, False

    for d in diags:
        cond = d.get("condition")
        if cond:
            by_condition[cond] = by_condition.get(cond, 0) + 1
        if d.get("p95Db")    is not None: p95_vals.append(d["p95Db"])
        if d.get("meanDb")   is not None: mean_vals.append(d["meanDb"])
        if d.get("flatness") is not None: flat_vals.append(d["flatness"])
        if d.get("f0Hz")     is not None: f0_vals.append(d["f0Hz"])
        if d.get("lfDb")     is not None: lf_vals.append(d["lfDb"])
        if d.get("postSilence"):
            post_silence = True
        if band_lo is None and d.get("bandLowHz")  is not None: band_lo = d["bandLowHz"]
        if band_hi is None and d.get("bandHighHz") is not None: band_hi = d["bandHighHz"]

    def _mean(vals, ndigits=2):
        return round(float(sum(vals) / len(vals)), ndigits) if vals else None

    return {
        "firedConditions":    sorted(by_condition.keys()),
        "framesByCondition":  by_condition,
        "meanP95Db":          _mean(p95_vals),
        "meanMeanDb":         _mean(mean_vals),
        "meanFlatness":       _mean(flat_vals, ndigits=4),
        "meanLfDb":           _mean(lf_vals),
        "bandHz":             [int(round(band_lo)), int(round(band_hi))] if band_lo is not None else None,
        "f0Hz":               _mean(f0_vals, ndigits=1),
        "postSilenceOnset":   post_silence,
    }


def _summarize_boundary_frame(diag: dict) -> dict:
    """
    Compact single-frame view used by _build_event_boundary_diag. Captures
    only the fields needed to identify which gate rejected the frame:

      - delta = p95Db - meanDb (compared against p95_trigger_db)
      - flat  = flatness when computed (only set when p95 passed)
      - veto  = voicing-dominance veto fired
      - nrg   = absolute-energy gate fired
      - band  = pre-band-mask check failed (no sibilant band at all)

    Returns None when the frame had no diag entry (e.g. unvoiced -- skipped
    upstream).
    """
    if diag is None:
        return None
    p95 = diag.get("p95Db")
    mn  = diag.get("meanDb")
    delta = round(p95 - mn, 2) if (p95 is not None and mn is not None) else None
    return {
        "deltaDb":  delta,
        "p95Db":    p95,
        "meanDb":   mn,
        "lfDb":     diag.get("lfDb"),
        "flatness": diag.get("flatness"),
        "p95Pass":  diag.get("p95Pass"),
        "flatPass": diag.get("flatPass"),
        "veto":     bool(diag.get("voicingVetoed")),
        "nrg":      bool(diag.get("energyGated")),
        "band":     p95 is None and mn is None,
        "fired":    diag.get("condition") is not None,
    }


def _build_event_boundary_diag(
    all_frame_diag: dict,
    frame_start:    int,
    frame_end:      int,
    k:              int = 4,
) -> dict:
    """
    Build the boundaryDiag block for one event. Captures per-frame stats for
    the K frames immediately before frame_start (head side) and after
    frame_end (tail side). Each side is ordered nearest-to-farthest from
    the event boundary so the first entry is the frame that "almost" fired.
    """
    head = []
    for offset in range(1, k + 1):
        fi   = frame_start - offset
        if fi < 0:
            break
        head.append({"frame": fi, **(_summarize_boundary_frame(all_frame_diag.get(fi)) or {"missing": True})})

    tail = []
    for offset in range(1, k + 1):
        fi = frame_end + offset
        tail.append({"frame": fi, **(_summarize_boundary_frame(all_frame_diag.get(fi)) or {"missing": True})})

    return {"head": head, "tail": tail}


def _expand_event_boundaries(
    sibilant_indices:     list,
    all_frame_diag:       dict,
    voiced_frame_indices,
    resolved:             dict,
):
    """
    Post-loop boundary expansion.

    Walks outward from each contiguous sibilant run and promotes adjacent
    voiced frames whose per-frame stats clear the relaxed P95 + flatness
    thresholds:

      relaxed_p95  = p95_trigger_db  - boundary_p95_relax_db
      relaxed_flat = min_flatness    - boundary_flatness_relax

    Hard gates (voicing veto, absolute-energy gate, pre-band check) are
    never relaxed -- only the spectral-shape margin is. A walk stops at
    the first non-qualifying frame on its side, at a frame outside the
    head/tail-extended voiced set (so legitimate silences between events
    are preserved), or at the boundary of the next contiguous run (so
    expansion never bridges into a different event -- gap_merge handles
    that case downstream).

    Returns (expanded_indices, added_diag) where:
      - expanded_indices is sorted and includes every frame from the
        original sibilant_indices plus newly promoted boundary frames;
      - added_diag maps each newly promoted frame to its diag dict
        (tagged with condition="boundary" so the [sib-event] aggregator
        records that the frame was added by relaxation rather than by
        the primary detection loop).
    """
    if not sibilant_indices:
        return sibilant_indices, {}

    p95_relax  = float(resolved.get("boundary_p95_relax_db",   0.0) or 0.0)
    flat_relax = float(resolved.get("boundary_flatness_relax", 0.0) or 0.0)
    if p95_relax <= 0.0 and flat_relax <= 0.0:
        return sibilant_indices, {}

    p95_threshold  = float(resolved.get("p95_trigger_db", 6.0)) - p95_relax
    flat_threshold = float(resolved.get("min_flatness",   0.1)) - flat_relax

    sib_set    = set(sibilant_indices)
    sorted_idx = sorted(sib_set)
    runs       = []
    rs = prev = sorted_idx[0]
    for fi in sorted_idx[1:]:
        if fi == prev + 1:
            prev = fi
            continue
        runs.append((rs, prev))
        rs = prev = fi
    runs.append((rs, prev))

    def _qualifies(diag):
        if diag is None:
            return False
        if diag.get("voicingVetoed") or diag.get("energyGated"):
            return False
        p95 = diag.get("p95Db")
        mn  = diag.get("meanDb")
        if p95 is None or mn is None:
            return False
        flatness = diag.get("flatness")
        if flatness is None:
            return False
        return (p95 - mn) > p95_threshold and flatness >= flat_threshold

    added_diag = {}
    added      = set()
    for ridx, (run_s, run_e) in enumerate(runs):
        prev_end   = runs[ridx - 1][1] if ridx > 0                  else -1
        next_start = runs[ridx + 1][0] if ridx < len(runs) - 1      else None

        # Head walk.
        fi = run_s - 1
        while fi > prev_end and fi >= 0:
            if voiced_frame_indices is not None and fi not in voiced_frame_indices:
                break
            diag = all_frame_diag.get(fi)
            if not _qualifies(diag):
                break
            promoted = dict(diag)
            promoted["condition"] = "boundary"
            added_diag[fi] = promoted
            added.add(fi)
            fi -= 1

        # Tail walk.
        fi = run_e + 1
        while next_start is None or fi < next_start:
            if voiced_frame_indices is not None and fi not in voiced_frame_indices:
                break
            diag = all_frame_diag.get(fi)
            if not _qualifies(diag):
                break
            promoted = dict(diag)
            promoted["condition"] = "boundary"
            added_diag[fi] = promoted
            added.add(fi)
            fi += 1

    if not added:
        return sibilant_indices, {}
    return sorted(sib_set | added), added_diag


def build_events_map(
    sibilant_indices:       list,
    f0_per_frame:           list,
    f0_median:              float,
    n_frames:               int,
    sample_rate:            int,
    n_fft:                  int,
    hop_length:             int,
    audio:                  np.ndarray = None,
    min_duration_ms:        float = 0.0,
    gap_merge_ms:           float = 0.0,
    per_frame_diag:         dict = None,
    all_frame_diag:         dict = None,
    core_sibilant_indices:  list = None,
) -> dict:
    """
    Build the canonical sibilance event-map JSON payload.

    Output shape matches what air_boost_masked.py and resonance_suppressor.py
    consume (sibilantFrameIndices + f0.perFrame + STFT geometry). When `audio`
    is provided each event is also enriched with sample-domain peak metadata
    (startSample/endSample/peakSample/peakRelativePosition/eventPeakDb/eventType)
    consumed by the clip-gain de-esser.

    When `min_duration_ms > 0`, events shorter than that threshold are dropped
    and the corresponding frame indices are removed from `sibilantFrameIndices`
    so the returned map is internally consistent.

    `core_sibilant_indices` is the pre-expansion frame list captured directly
    from the detection loop (frames that fired the primary p95+flatness
    triggers). When provided, the output JSON includes a parallel top-level
    `coreSibilantFrameIndices` array containing those core frames that
    survived gap-merge and min-duration filtering. Consumers whose envelope
    must NOT include boundary-relaxed frames (e.g. airBoost's HF mask, where
    boundary halos exaggerate the time-averaged shelf collapse) read this
    field; consumers that benefit from boundary expansion's smooth ramps
    (e.g. clipGainDeEsser's gain reduction) continue reading the unchanged
    `sibilantFrameIndices`. Omitted from the output when None.
    """
    events = []
    if sibilant_indices:
        run_start = sibilant_indices[0]
        prev      = sibilant_indices[0]
        for fi in sibilant_indices[1:]:
            if fi == prev + 1:
                prev = fi
                continue
            events.append((run_start, prev))
            run_start = fi
            prev      = fi
        events.append((run_start, prev))

    frame_period_sec = hop_length / sample_rate

    # --- Gap merge (Gonzalez & Brookes 2012 max-filter equivalent) ---
    # Joins consecutive events separated by fewer than gap_merge_ms of silence
    # into a single event. Prevents long fricatives from fragmenting into
    # multiple short events due to 1-2 frame dips below threshold.
    if gap_merge_ms > 0 and len(events) > 1:
        gap_merge_frames = int((gap_merge_ms / 1000.0) / frame_period_sec)
        merged = [events[0]]
        for s, e in events[1:]:
            prev_s, prev_e = merged[-1]
            if (s - prev_e - 1) <= gap_merge_frames:
                merged[-1] = (prev_s, e)
            else:
                merged.append((s, e))
        events = merged
        # Regenerate sibilant_indices from merged spans so sibilantFrameIndices
        # stays consistent with the event list (gap frames are included).
        sibilant_indices = []
        for s, e in events:
            sibilant_indices.extend(range(int(s), int(e) + 1))

    n_samples = int(audio.shape[0]) if audio is not None else None

    event_objs    = []
    kept_runs     = []
    for s, e in events:
        duration_ms = (e + 1 - s) * frame_period_sec * 1000.0
        if min_duration_ms > 0 and duration_ms < min_duration_ms:
            continue

        obj = {
            "startFrame": int(s),
            "endFrame":   int(e),
            "startSec":   round(s * frame_period_sec, 4),
            "endSec":     round((e + 1) * frame_period_sec, 4),
            "durationMs": round(duration_ms, 1),
        }

        if audio is not None and n_samples is not None and n_samples > 0:
            start_sample = max(0, int(s) * hop_length)
            end_sample   = min(n_samples - 1, (int(e) + 1) * hop_length - 1)
            if end_sample <= start_sample:
                end_sample = min(n_samples - 1, start_sample + 1)

            seg = audio[start_sample : end_sample + 1]
            if seg.size > 0:
                local_peak_idx = int(np.argmax(np.abs(seg)))
                peak_sample    = start_sample + local_peak_idx
                peak_value     = float(np.abs(seg[local_peak_idx]))
                peak_db        = 20.0 * np.log10(peak_value + 1e-12)
            else:
                peak_sample = start_sample
                peak_db     = -120.0

            span = max(1, end_sample - start_sample)
            peak_rel_pos = float(peak_sample - start_sample) / float(span)
            event_type   = "affricate" if peak_rel_pos < AFFRICATE_PEAK_POSITION else "fricative"

            # Spectral class (strident vs non-strident). Orthogonal to
            # eventType -- a /tʃ/ is affricate+strident, a soft /f/ is
            # fricative+non_strident. See module-level docstring for the
            # band definitions and threshold rationale.
            #
            # Measurement window: prefer the sub-span covered by frames that
            # fired the *core* P95 condition during the main detection loop,
            # excluding any boundary-promoted frames (condition="boundary")
            # added by the post-loop relaxation pass. Boundary frames pass
            # only the relaxed thresholds, so they tend to sit immediately
            # adjacent to vowel content and carry HF bleed from the vowel
            # onset / offset transition -- in a long expanded event (e.g.
            # 6 core + 10 boundary frames) that bleed dominates the
            # whole-event FFT and tilts the HF/LM ratio strident even for a
            # naturally weak /f/. Restricting the FFT window to the P95
            # sub-span removes the contamination without changing the
            # underlying acoustic model or the +3 dB threshold (which is
            # still correct for clean fricative samples). Falls back to the
            # full event span when no P95 frames are present (defensive --
            # the event came from the main detection loop so this branch
            # is only reached in pathological corner cases).
            ratio_start    = start_sample
            ratio_end      = end_sample
            core_mean_p95  = None
            if per_frame_diag:
                p95_frames = [
                    fi for fi in range(int(s), int(e) + 1)
                    if per_frame_diag.get(fi, {}).get("condition") == "p95"
                ]
                if p95_frames:
                    ratio_start = max(0, p95_frames[0] * hop_length)
                    ratio_end   = min(
                        n_samples - 1, (p95_frames[-1] + 1) * hop_length - 1,
                    )
                    if ratio_end <= ratio_start:
                        ratio_end = min(n_samples - 1, ratio_start + 1)
                    core_p95_vals = [
                        per_frame_diag[fi].get("p95Db") for fi in p95_frames
                        if per_frame_diag.get(fi, {}).get("p95Db") is not None
                    ]
                    if core_p95_vals:
                        core_mean_p95 = float(np.mean(core_p95_vals))

            hf_ratio_db = _compute_event_band_ratio_db(
                audio, ratio_start, ratio_end, sample_rate,
            )

            # Two-axis rule: ratio alone is borderline for /ʃ/ on recordings
            # whose mic/EQ profile pushes its 2.5-4 kHz peak below the +3 dB
            # ratio threshold. Rescue via absolute in-band loudness -- /f/
            # cannot reach the +5 dB band-P95 mark even when EQ-boosted, but
            # /ʃ/ routinely does.
            is_strident_by_ratio = (
                hf_ratio_db >= STRIDENT_CLASSIFICATION_THRESHOLD_DB
            )
            is_strident_by_loudness = (
                core_mean_p95 is not None
                and hf_ratio_db >= STRIDENT_RESCUE_RATIO_FLOOR_DB
                and core_mean_p95 >= STRIDENT_RESCUE_LOUDNESS_DB
            )
            sibilant_class = (
                "strident"
                if (is_strident_by_ratio or is_strident_by_loudness)
                else "non_strident"
            )

            obj.update({
                "startSample":          int(start_sample),
                "endSample":            int(end_sample),
                "peakSample":           int(peak_sample),
                "peakRelativePosition": round(peak_rel_pos, 4),
                "eventPeakDb":          round(peak_db, 2),
                "eventType":            event_type,
                "hfRatioDb":            round(hf_ratio_db, 2),
                "coreMeanP95Db":        (
                    round(core_mean_p95, 2) if core_mean_p95 is not None else None
                ),
                "sibilantClass":        sibilant_class,
            })

        if per_frame_diag:
            detection = _aggregate_event_detection(per_frame_diag, int(s), int(e))
            if detection is not None:
                obj["detection"] = detection

        # Boundary diag: per-frame stats for the K frames immediately before
        # startFrame and after endFrame. Lets the operator see whether the
        # P95 gate, voicing veto, energy gate, or pre-band check rejected
        # the boundary frames -- so gate tuning becomes data-driven instead
        # of guesswork. K=4 covers the typical fricative ramp-up / ramp-down
        # range without bloating logs.
        if all_frame_diag:
            obj["boundaryDiag"] = _build_event_boundary_diag(
                all_frame_diag, int(s), int(e), k=4,
            )

        event_objs.append(obj)
        kept_runs.append((s, e))

    # When events were filtered out, sync sibilantFrameIndices so downstream
    # consumers that read raw frame indices see a consistent view.
    if min_duration_ms > 0 and len(kept_runs) != len(events):
        kept_indices = []
        for s, e in kept_runs:
            kept_indices.extend(range(int(s), int(e) + 1))
        sibilant_indices = kept_indices

    # Core-only frame view: intersection of the pre-expansion fire list with
    # the final filtered sibilant set. By construction this excludes both
    # boundary-relaxed promotions (added by _expand_event_boundaries) and
    # inter-event gap-merge frames (added during the merge pass above), while
    # honouring min-duration culling (because filtered events drop their
    # indices from `sibilant_indices` first). Field omitted when the caller
    # did not pass `core_sibilant_indices` so older consumers don't see a
    # spurious empty list when none was intended.
    out = {
        "sampleRate":           sample_rate,
        "nFft":                 n_fft,
        "hopLength":            hop_length,
        "frameCount":           int(n_frames),
        "f0": {
            "median":   round(f0_median, 1) if f0_median is not None else None,
            "perFrame": [round(v, 1) if v is not None else None for v in f0_per_frame],
        },
        "sibilantFrameIndices": [int(i) for i in sibilant_indices],
        "events":               event_objs,
    }
    if core_sibilant_indices is not None:
        kept_set = set(int(i) for i in sibilant_indices)
        out["coreSibilantFrameIndices"] = sorted(
            int(i) for i in core_sibilant_indices if int(i) in kept_set
        )
    return out


# ---------------------------------------------------------------------------
# Detector
# ---------------------------------------------------------------------------

class SibilanceDetector:
    """
    Per-frame sibilance detector. F0 is supplied externally per frame; no
    internal pitch estimation is performed.

    Inputs to process_frame():
      magnitude     - linear magnitude spectrum (n_bins,)
      is_voiced     - whether the frame is voiced (VAD)
      f0_for_frame  - external F0 for this frame in Hz; None to inherit the
                      current rolling-median band

    State surfaced to consumers (read-only):
      sibilant_mask     - current frequency-bin mask (n_bins boolean)
      sibilant_low/high - band edges in Hz
      f0                - F0 from which the current band was derived
      f0_rolling        - deque of recent per-frame F0 values

    The detector holds no temporal reference (EMA, rolling power buffer)
    built from the signal being detected. The absolute energy gate uses
    the upstream-measured noise_floor_dbfs supplied via params, so a
    sustained fricative cannot self-mask by adapting the gate up.
    """

    def __init__(
        self,
        sample_rate: int,
        n_fft: int,
        hop_length: int,
        params: dict,
        f0: float = None,
    ):
        self.sr         = sample_rate
        self.n_fft      = n_fft
        self.hop_length = hop_length
        self.params     = params

        self.freqs  = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)
        self.n_bins = len(self.freqs)

        # Voicing-dominance veto mask. Fixed band (not F0-dependent) covering
        # the vocal body. See voicing_veto_db in DEFAULT_PARAMS for rationale
        # and the open question about a low-energy bypass.
        lf_low  = float(params.get("voicing_veto_lf_low_hz",  80.0))
        lf_high = float(params.get("voicing_veto_lf_high_hz", 1500.0))
        self.lf_mask = (self.freqs >= lf_low) & (self.freqs <= lf_high)

        # Absolute energy gate threshold (dBFS). Computed once from
        # noise_floor_dbfs + min_sibilant_energy_above_noise_db; None when
        # the caller did not supply a noise floor (gate disabled).
        nf = params.get("noise_floor_dbfs")
        offset = float(params.get("min_sibilant_energy_above_noise_db", 20.0))
        self.energy_gate_dbfs = (
            float(nf) + offset if nf is not None and np.isfinite(nf) else None
        )

        # F0 / band state
        self.f0            = f0
        self.sibilant_low  = None
        self.sibilant_high = None
        self.sibilant_mask = None

        self.f0_rolling           = deque(maxlen=F0_ROLLING_WINDOW_SIZE)
        self._current_band_f0     = None

        if f0 is not None:
            self._set_sibilant_band(f0)
            self._current_band_f0 = f0
            self.f0_rolling.append(f0)

        # Silence-gap reset state. analyze_sibilance_events() decides when a
        # passage-onset reset is due (it owns the silence-run counter and
        # the look-ahead F0 needed for reseeding) and calls
        # mark_passage_onset() before process_frame(). The detector itself
        # only tracks how many voiced frames remain inside the post-silence
        # observation window so per-frame diagnostics can flag onset frames.
        frame_period_ms = (hop_length / sample_rate) * 1000.0
        self._post_silence_window_frames = max(
            1, int(params.get("post_silence_window_ms", 150.0) / frame_period_ms)
        )
        self._post_silence_remaining = 0

        # Per-frame detection diagnostics. detect() populates this on every
        # voiced frame so analyze_sibilance_events() can collect it and
        # aggregate per event. Reassigned (new dict) on every detect() call;
        # consumers should not retain the reference across frames.
        self.last_diag = None

    def seed_f0(self, f0: float) -> None:
        """Set the initial F0/band before processing begins."""
        self._set_sibilant_band(f0)
        self._current_band_f0 = f0
        self.f0_rolling.append(f0)

    def _set_sibilant_band(self, f0: float) -> None:
        self.f0            = f0
        low, high          = get_sibilant_band(f0, self.sr)
        self.sibilant_low  = low
        self.sibilant_high = high
        self.sibilant_mask = (self.freqs >= low) & (self.freqs <= high)
        logger.info(
            f"SibilanceDetector: F0={f0:.1f} Hz -> "
            f"sibilant band {low:.0f}-{high:.0f} Hz "
            f"({self.sibilant_mask.sum()} bins)"
        )

    def update_rolling_f0(self, f0_for_frame: float, is_voiced: bool) -> None:
        """
        Push an external per-frame F0 estimate into the rolling buffer and
        rebuild the band mask when the rolling median shifts past the
        reshift threshold.

        Non-voiced frames and missing values are ignored.
        """
        if not is_voiced or f0_for_frame is None:
            return
        # math.isfinite is a C-level scalar check (~0.1us); np.isfinite
        # goes through ufunc dispatch (~5us) even on scalars. This runs
        # once per voiced frame -- ~60k calls in a typical analyze pass,
        # so the dispatch saving alone is worth the swap. math.isfinite
        # accepts numpy scalars via __float__, so callers passing
        # contour values straight from estimate_f0_contour are fine too.
        if not math.isfinite(f0_for_frame) or f0_for_frame <= 0:
            return
        self.f0_rolling.append(float(f0_for_frame))
        n = len(self.f0_rolling)
        if n >= 3:
            # np.median on a deque copies the contents to a fresh ndarray
            # every call, so its per-call overhead far exceeds the actual
            # median work on a 10-element buffer. sorted()+index in pure
            # Python is ~30x faster here and produces identical results
            # (np.median averages the two middle values on even-length
            # inputs, matched below). Saves ~1.5s across a 12-min file.
            s = sorted(self.f0_rolling)
            median_f0 = s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])
            if (self._current_band_f0 is None or
                    abs(median_f0 - self._current_band_f0)
                    > F0_MASK_RESHIFT_THRESHOLD_HZ):
                self._set_sibilant_band(median_f0)
                self._current_band_f0 = median_f0

    def detect(self, magnitude: np.ndarray, lf_db_override: float = None) -> bool:
        """Per-frame voiceless-fricative detection.

        Three frame-local gates: voicing-dominance veto, absolute energy
        above noise floor, and spectral shape (P95 spike + flatness). All
        three must clear for a frame to be classified as sibilant. None of
        them carry state derived from the signal being detected, so a
        sustained fricative cannot self-mask.

        When ``lf_db_override`` is supplied, the voicing-veto's low-band
        dB measurement is taken from the override instead of being
        recomputed from ``magnitude`` here. ``lf_mask`` is F0-independent
        (set once in __init__) so the override produced by a vectorised
        batch precompute is numerically equivalent to the per-frame value
        up to float32 round-off. Used by analyze_sibilance_events() to
        hoist ~3 numpy dispatches per voiced frame out of the hot loop.

        Populates self.last_diag for analyze_sibilance_events() to
        aggregate into the per-event detection summary.
        """
        diag = {
            "condition":     None,
            "p95Db":         None,
            "meanDb":        None,
            "flatness":      None,
            "lfDb":          None,
            "voicingVetoed": False,
            "energyGated":   False,
            # p95Pass / flatPass record whether each spectral-shape gate
            # cleared on this frame, independently of whether the frame
            # ultimately fired sibilant. They let boundary-expansion logic
            # (and the wrapper's [sib-bound] formatter) distinguish a
            # p95-margin failure from a flatness failure without round-
            # tripping the trigger thresholds. None = not evaluated (frame
            # rejected upstream by voicing veto, energy gate, or band).
            "p95Pass":       None,
            "flatPass":      None,
            "bandLowHz":     self.sibilant_low,
            "bandHighHz":    self.sibilant_high,
            "f0Hz":          self.f0,
            "postSilence":   self._post_silence_remaining > 0,
        }
        self.last_diag = diag

        if self.sibilant_mask is None or not self.sibilant_mask.any():
            return False

        sib_energy  = magnitude[self.sibilant_mask] ** 2
        # float() converts the numpy scalar from .mean() to a Python float
        # so math.log10 (C path, ~0.1us) can replace np.log10's ufunc
        # dispatch (~5us). Same swap on the p95 and lf_db computations
        # below. At ~60k voiced frames per analyze pass this trims ~1.5s
        # off the per-frame loop.
        mean_energy = float(sib_energy.mean())

        # Linear-interpolated 95th percentile via np.partition. Matches
        # np.percentile's default ('linear') behaviour bit-for-bit: it
        # partitions only at the two ranks straddling the target index
        # and applies the same fractional weight. ~10x faster than
        # np.percentile on ~500-element arrays, which is mostly Python
        # dispatch overhead at this size.
        n_sib   = sib_energy.size
        p95_idx = 0.95 * (n_sib - 1)
        lo_idx  = int(p95_idx)
        hi_idx  = min(lo_idx + 1, n_sib - 1)
        if lo_idx == hi_idx:
            p95_energy = float(np.partition(sib_energy, lo_idx)[lo_idx])
        else:
            part       = np.partition(sib_energy, [lo_idx, hi_idx])
            frac       = p95_idx - lo_idx
            p95_energy = float(part[lo_idx]) * (1.0 - frac) + float(part[hi_idx]) * frac

        mean_db = 10.0 * math.log10(mean_energy + 1e-10)
        p95_db  = 10.0 * math.log10(p95_energy  + 1e-10)

        diag["p95Db"]  = round(p95_db,  2)
        diag["meanDb"] = round(mean_db, 2)

        # --- Voicing-dominance veto ---
        # Frames where low-band energy dominates the in-band mean by more
        # than voicing_veto_db cannot be voiceless fricatives -- they are
        # vowels or other voiced content with negligible HF content.
        if lf_db_override is not None:
            # Caller pre-computed lf_db across the whole batch in
            # vectorised form (see analyze_sibilance_events). Skip the
            # per-frame numpy ops entirely.
            lf_db = float(lf_db_override)
            diag["lfDb"] = round(lf_db, 2)
            if (lf_db - mean_db) > self.params.get("voicing_veto_db", 20.0):
                diag["voicingVetoed"] = True
                return False
        elif self.lf_mask is not None and self.lf_mask.any():
            lf_power = magnitude[self.lf_mask] ** 2
            lf_db    = 10.0 * math.log10(float(lf_power.mean()) + 1e-10)
            diag["lfDb"] = round(lf_db, 2)
            if (lf_db - mean_db) > self.params.get("voicing_veto_db", 20.0):
                diag["voicingVetoed"] = True
                return False

        # --- Absolute energy gate ---
        # In-band mean must exceed the upstream-measured noise floor by
        # min_sibilant_energy_above_noise_db. Because the gate is
        # independent of the detection result it cannot self-mask the way
        # the previous EMA / contextual-buffer references did. When no
        # noise floor was supplied the gate is bypassed (standalone use).
        if self.energy_gate_dbfs is not None and mean_db < self.energy_gate_dbfs:
            diag["energyGated"] = True
            return False

        # --- Spectral-shape check: P95 spike + flatness ---
        # Both gates are always evaluated once the upstream gates clear, so
        # diag carries the full picture (p95Pass, flatPass, flatness value)
        # for boundary-expansion candidates -- previously flatness was only
        # computed when the P95 margin cleared, hiding flatness-failure
        # boundary frames from the post-loop expansion pass.
        delta_db   = p95_db - mean_db
        p95_pass   = bool(delta_db > self.params["p95_trigger_db"])
        diag["p95Pass"] = p95_pass

        valid = sib_energy > 0
        if valid.any():
            geo_mean = np.exp(np.mean(np.log(sib_energy[valid])))
            arith    = np.mean(sib_energy[valid])
            flatness = geo_mean / arith if arith > 0 else 0.0
        else:
            flatness = 0.0
        diag["flatness"] = round(float(flatness), 4)
        flat_pass        = bool(flatness >= self.params["min_flatness"])
        diag["flatPass"] = flat_pass

        if p95_pass and flat_pass:
            diag["condition"] = "p95"
            return True

        return False

    def mark_passage_onset(self, seed_f0: float = None) -> None:
        """
        Reset short-term state on a silence-to-voiced transition.

        Called by analyze_sibilance_events() when it detects a contiguous
        unvoiced run longer than `silence_gap_reset_ms` between two voiced
        runs. Clears the rolling-F0 deque so the next voiced frame starts
        from a fresh pitch reference instead of stale state from the
        previous voiced segment.

        When seed_f0 is supplied (look-ahead median over the next K voiced
        frames in the contour) the sibilant band is reseeded immediately
        so the first post-silence frame uses the right band -- otherwise
        the band would stay frozen at the previous segment's F0 until the
        rolling buffer refills (typically 2-3 voiced frames).
        """
        self.f0_rolling.clear()
        if seed_f0 is not None and np.isfinite(seed_f0) and seed_f0 > 0:
            self._set_sibilant_band(float(seed_f0))
            self._current_band_f0 = float(seed_f0)
            self.f0_rolling.append(float(seed_f0))
        self._post_silence_remaining = self._post_silence_window_frames

    def process_frame(
        self,
        magnitude:      np.ndarray,
        is_voiced:      bool,
        f0_for_frame:   float = None,
        lf_db_override: float = None,
    ) -> bool:
        """
        Full per-frame pipeline: rolling F0 update -> detection.

        ``lf_db_override`` is forwarded to detect() as a precomputed
        scalar substitute for the voicing-veto's low-band measurement
        (see detect() docstring). Callers that don't precompute leave it
        as None and detect() falls back to the per-frame numpy path.

        Returns True when the frame is classified as sibilant.
        """
        self.update_rolling_f0(f0_for_frame, is_voiced)
        is_sibilant = self.detect(magnitude, lf_db_override=lf_db_override) if is_voiced else False
        if is_voiced and self._post_silence_remaining > 0:
            self._post_silence_remaining -= 1
        return is_sibilant


# ---------------------------------------------------------------------------
# Public analysis function
# ---------------------------------------------------------------------------

def _lookahead_f0_median(
    contour:               list,
    voiced_frame_indices,
    start_frame:           int,
    n_lookahead:           int,
) -> float:
    """
    Median of the next n_lookahead voiced F0 estimates from `contour`
    starting at start_frame. Used by analyze_sibilance_events() to give
    the detector a clean F0 seed when resetting state on a silence-to-
    voiced transition — without it the band would stay frozen at the
    previous segment's pitch for the first 2-3 voiced frames of the new
    passage while the rolling-median buffer refills.

    voiced_frame_indices may be a set of frame indices flagged voiced by
    VAD, or None (no VAD — every contour entry is treated as voiced for
    the purpose of the lookahead). Returns None when no valid F0 estimate
    is available within the search window.
    """
    vals = []
    i = start_frame
    n = len(contour)
    while len(vals) < n_lookahead and i < n:
        if voiced_frame_indices is None or i in voiced_frame_indices:
            v = contour[i]
            if v is not None and np.isfinite(v) and v > 0:
                vals.append(float(v))
        i += 1
    if not vals:
        return None
    return float(np.median(vals))


def analyze_sibilance_events(
    audio: np.ndarray,
    sample_rate: int,
    f0_contour: dict,
    params: dict = None,
    vad_voiced_mask: np.ndarray = None,
    n_fft: int = 2048,
    hop_length: int = 512,
) -> dict:
    """
    Detection-only STFT pass over `audio`. Returns a serializable event map.

    Args:
        audio:           Mono float32 audio at sample_rate.
        sample_rate:     Sample rate in Hz (44100 in the pipeline).
        f0_contour:      Required dict with keys 'median' and 'perFrame'
                         (as produced by estimate_f0_contour.py). Drives
                         per-frame band updates inside the detector. Must
                         match the same n_fft/hop_length used here so frame
                         indices align.
        params:          Sparse override dict overlaid on DEFAULT_PARAMS.
                         Anything omitted uses the default. Callers should
                         supply their stage's sibilanceDetection block.
        vad_voiced_mask: Optional boolean array (same length as audio).
                         Frames with any voiced sample are classified voiced.
        n_fft:           STFT size.
        hop_length:      STFT hop.

    Returns:
        Event map dict (see build_events_map() for shape).
    """
    if audio.ndim != 1:
        raise ValueError("analyze_sibilance_events expects mono input (1D array).")
    if f0_contour is None:
        raise ValueError(
            "analyze_sibilance_events requires an external f0_contour "
            "(from estimate_f0_contour.py). Run getF0Contour(ctx) and "
            "pass the result in."
        )

    from scipy.signal import get_window

    contour_per_frame = list(f0_contour.get("perFrame") or [])
    contour_median    = f0_contour.get("median")

    # Seed F0 -- pick the median (or first valid value) so the initial band
    # is sensible before the rolling buffer fills.
    seed_f0 = contour_median if contour_median else None
    if seed_f0 is None:
        for v in contour_per_frame:
            if v is not None and np.isfinite(v) and v > 0:
                seed_f0 = float(v)
                break

    # Resolve detection params up-front so they're available both to the
    # detector below and to the empty-audio guard a few lines down.
    resolved        = resolve_params(params)
    min_duration_ms = float(resolved.get("min_duration_ms", 0.0) or 0.0)
    gap_merge_ms    = float(resolved.get("gap_merge_ms",    0.0) or 0.0)

    detector = SibilanceDetector(
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        params=resolved,
        f0=seed_f0,
    )

    pad       = n_fft // 2
    n_samples = len(audio)

    # Short-audio guard mirroring estimate_f0_contour.py. np.pad mode='reflect'
    # requires pad < len(audio) (strictly less than), so very short or empty
    # clips would otherwise raise a ValueError.
    #   - Empty input: return a minimal event map with no frames so callers
    #     get a consistent shape.
    #   - Short input (≤ pad samples): fall back to 'edge' padding (repeats
    #     the boundary sample), valid for any non-empty array.

    if n_samples == 0:
        logger.warning("analyze_sibilance_events: empty audio — returning empty event map")
        return build_events_map(
            sibilant_indices      = [],
            f0_per_frame          = [],
            f0_median             = contour_median if contour_median is not None else 0.0,
            n_frames              = 0,
            sample_rate           = sample_rate,
            n_fft                 = n_fft,
            hop_length            = hop_length,
            audio                 = audio,
            min_duration_ms       = min_duration_ms,
            gap_merge_ms          = gap_merge_ms,
            core_sibilant_indices = [],
        )

    pad_mode = "reflect" if n_samples > pad else "edge"
    if pad_mode == "edge":
        logger.warning(
            f"analyze_sibilance_events: audio ({n_samples} samples) shorter than "
            f"pad ({pad} samples) — using 'edge' padding instead of 'reflect'"
        )

    audio_padded = np.pad(audio, pad, mode=pad_mode)
    n_frames     = max(0, (len(audio_padded) - n_fft) // hop_length + 1)

    voiced_frame_indices = None
    vad_mask_supplied    = vad_voiced_mask is not None
    vad_mask_len_match   = vad_mask_supplied and len(vad_voiced_mask) == len(audio)
    tail_added           = 0
    head_added           = 0
    if vad_mask_len_match:
        voiced_frame_indices = set()
        for fi in range(n_frames):
            o_start = max(0, fi * hop_length - pad)
            o_end   = min(len(audio), fi * hop_length - pad + n_fft)
            if o_start < o_end and vad_voiced_mask[o_start:o_end].any():
                voiced_frame_indices.add(fi)

        # Fricative tail extension. Silero classifies the trailing
        # turbulence-only portion of unvoiced fricatives as silence the
        # moment voicing dies, which truncates events like /f/, /s/,
        # /sh/ ~80 ms early. Walk the voiced set in order and append
        # tail_frames of subsequent unvoiced frames after every voiced
        # run so detection continues through the fricative tail. The
        # extension stops as soon as another voiced frame is reached
        # (so we don't bridge across legitimate inter-word silences).
        tail_ms     = float(resolved.get("fricative_tail_extension_ms", 0.0) or 0.0)
        tail_frames = max(0, int(tail_ms / ((hop_length / sample_rate) * 1000.0)))
        tail_added  = 0
        if tail_frames > 0 and voiced_frame_indices:
            sorted_voiced = sorted(voiced_frame_indices)
            extended      = set()
            for vfi in sorted_voiced:
                if (vfi + 1) in voiced_frame_indices:
                    continue
                # vfi is the last voiced frame in its run; extend forward
                # until we run out of frames, hit another voiced frame,
                # or hit the tail budget.
                for k in range(1, tail_frames + 1):
                    nxt = vfi + k
                    if nxt >= n_frames or nxt in voiced_frame_indices:
                        break
                    extended.add(nxt)
            voiced_frame_indices.update(extended)
            tail_added = len(extended)

        # Fricative head pre-roll. Symmetric to the tail extension:
        # walk the voiced set in order and prepend head_frames of
        # preceding unvoiced frames before every voiced-run start so
        # the detector can evaluate fricative onsets that begin before
        # the vowel (e.g. /sh/ in "she"). Stops as soon as another
        # voiced frame is reached upstream so we don't bridge across
        # legitimate inter-word silences. Frame gates still apply, so
        # silence cannot trigger detection.
        head_ms     = float(resolved.get("fricative_head_extension_ms", 0.0) or 0.0)
        head_frames = max(0, int(head_ms / ((hop_length / sample_rate) * 1000.0)))
        head_added  = 0
        if head_frames > 0 and voiced_frame_indices:
            sorted_voiced = sorted(voiced_frame_indices)
            prepended     = set()
            for vfi in sorted_voiced:
                if (vfi - 1) in voiced_frame_indices:
                    continue
                # vfi is the first voiced frame in its run; extend backward
                # until we run out of frames, hit another voiced frame,
                # or hit the head budget.
                for k in range(1, head_frames + 1):
                    prv = vfi - k
                    if prv < 0 or prv in voiced_frame_indices:
                        break
                    prepended.add(prv)
            voiced_frame_indices.update(prepended)
            head_added = len(prepended)

    # Single summary line so callers can verify the VAD mask is being
    # threaded through and see how many silence-classified frames each
    # extension pass reclaimed for detection. Always emitted -- when no
    # mask is supplied head/tail extension cannot run and we want that
    # to surface in logs instead of being silently skipped.
    logger.info(
        "SibilanceDetector: VAD frames extended -- "
        f"vad_mask_supplied={vad_mask_supplied} "
        f"vad_mask_len_match={vad_mask_len_match} "
        f"tail_added={tail_added} head_added={head_added} "
        f"voiced_total="
        f"{len(voiced_frame_indices) if voiced_frame_indices is not None else 'None'}"
        f"/{n_frames}"
    )

    # Hann window cast to float32 up front. The audio buffer is float32 (the
    # pipeline's canonical internal format) and keeping the window dtype the
    # same lets the batched rfft below run on a single contiguous float32
    # buffer with complex64 output, halving FFT memory and dispatch cost
    # versus the implicit float64 promotion the un-cast Hann would trigger.
    window           = get_window("hann", n_fft, fftbins=True).astype(np.float32)
    sibilant_indices = []
    f0_per_frame     = []
    per_frame_diag   = {}
    # Diag for every voiced frame (sibilant or not). Used by build_events_map
    # to attach boundary stats showing why frames adjacent to each event's
    # startFrame/endFrame failed the per-frame gates. Independent of
    # per_frame_diag so _aggregate_event_detection() still sees only the
    # frames that actually fired sibilant.
    all_frame_diag   = {}

    # Silence-gap reset bookkeeping. On any silence-to-voiced transition
    # longer than silence_reset_frames we (a) compute a look-ahead F0 from
    # the next few voiced frames in the contour and (b) call
    # mark_passage_onset() so the detector clears its rolling-F0 + N1/N2
    # context buffer and reseeds the sibilant band from the new pitch.
    # silence_run starts at the threshold so the very first frame of the
    # file is treated as a passage onset (file start == post-silence).
    frame_period_ms      = (hop_length / sample_rate) * 1000.0
    silence_reset_frames = max(
        1, int(resolved.get("silence_gap_reset_ms", 150.0) / frame_period_ms)
    )
    lookahead_frames = 5
    silence_run      = silence_reset_frames

    # Per-frame voicing mask as a numpy bool array for O(1) batched lookup
    # in the FFT loop below. voiced_frame_indices stays as a set/None so the
    # downstream helpers that consume it (_lookahead_f0_median,
    # _expand_event_boundaries) keep their existing contract.
    if voiced_frame_indices is None:
        voiced_arr = np.ones(n_frames, dtype=bool)
    else:
        voiced_arr = np.zeros(n_frames, dtype=bool)
        if voiced_frame_indices:
            idx_arr = np.fromiter(
                voiced_frame_indices, dtype=np.int64, count=len(voiced_frame_indices)
            )
            voiced_arr[idx_arr] = True

    # Batched STFT. The per-frame `np.fft.rfft(frame * window)` previously ran
    # one FFT per iteration -- ~65k Python-level dispatch / planning round-
    # trips for a 12-min file at 44.1 kHz / hop=512. Materialising voiced rows
    # in bounded batches and calling rfft once per batch amortises that cost;
    # the state-machine loop below then reads precomputed magnitudes by frame
    # index. Magnitudes are computed for voiced rows only because
    # `detector.process_frame` only consults `magnitude` when is_voiced -- see
    # SibilanceDetector.process_frame above. The same `sliding_window_view +
    # batched rfft` pattern is used by estimate_f0_contour.py; BATCH_SIZE is
    # sized independently for this stage against the per-batch memory budget
    # documented immediately below (estimate_f0_contour's _AUTOCORR_BATCH_SIZE
    # is smaller because its irfft output dominates its budget, not the input).
    #
    # Peak memory per batch during the rfft call (float32 path):
    #   input float32 rows : BATCH_SIZE * n_fft           * 4 bytes
    #   complex64 spectrum : BATCH_SIZE * (n_fft // 2 + 1) * 8 bytes
    # For BATCH_SIZE=8192, n_fft=2048:
    #   input  ~= 64 MB
    #   output ~= 67 MB
    #   peak   ~= 131 MB during rfft, ~33 MB for the float32 magnitudes alone.
    # rfft on float32 input emits complex64 (8 bytes/bin), not float32 -- a
    # previous version of this comment underestimated the peak by half.
    windows_view = np.lib.stride_tricks.sliding_window_view(audio_padded, n_fft)[::hop_length]
    BATCH_SIZE   = 8192

    # Profile timers. _t_fft / _t_loop split the per-batch wall clock into the
    # vectorised FFT + lf_db precompute block and the per-frame state-machine
    # loop respectively; _t_total is wall clock for the whole batched section
    # so the residual (= total - fft - loop) shows pure setup/bookkeeping
    # overhead. Used to confirm where the per-pass cost actually goes after
    # successive optimisation rounds: batched FFT moved the FFT itself out of
    # the loop, then vectorised lf_db / math.log10 / np.partition trimmed the
    # remaining per-frame numpy ops -- the profile line is how we verified
    # each change landed where intended.
    _t_fft   = 0.0
    _t_loop  = 0.0
    _t_total = time.perf_counter()

    for batch_start in range(0, n_frames, BATCH_SIZE):
        batch_end       = min(batch_start + BATCH_SIZE, n_frames)
        batch_len       = batch_end - batch_start
        batch_voiced_lo = np.flatnonzero(voiced_arr[batch_start:batch_end])

        _t_fft_b0 = time.perf_counter()
        if batch_voiced_lo.size > 0:
            # Fancy-indexing the strided view returns a fresh contiguous
            # writable buffer; copy=False on astype is a no-op when the
            # source is already float32 (the canonical pipeline dtype) and
            # avoids a redundant ~64 MB copy per batch in that case.
            voiced_rows = (
                windows_view[batch_start + batch_voiced_lo].astype(np.float32, copy=False)
            )
            voiced_rows *= window
            batch_mags = np.abs(np.fft.rfft(voiced_rows, axis=1))
            # Vectorised low-band dB precompute. lf_mask is F0-independent
            # (set once in SibilanceDetector.__init__) so computing the
            # voicing-veto's lf_db across every voiced row in the batch as a
            # single (n_voiced, n_lf_bins) reduction is numerically
            # equivalent to detect()'s per-frame
            #     lf_db = 10*log10(mean(magnitude[lf_mask]**2) + 1e-10)
            # and saves three numpy dispatches per voiced frame. Passed
            # through to detect() via process_frame's lf_db_override kwarg.
            # Memory: (n_voiced x ~70 lf bins) float32 ~= 2 MB at BATCH_SIZE
            # 8192 -- negligible next to the rfft output.
            # Mirror detect()'s `self.lf_mask is not None and self.lf_mask.any()`
            # guard: with an empty LF veto mask there are no bins to reduce over,
            # so leave the override unset and let the per-frame path in detect()
            # skip the veto computation entirely.
            if detector.lf_mask is not None and detector.lf_mask.any():
                lf_band     = batch_mags[:, detector.lf_mask]
                lf_pow_mean = (lf_band * lf_band).mean(axis=1)
                batch_lf_db = 10.0 * np.log10(lf_pow_mean + 1e-10)
            else:
                batch_lf_db = None
        else:
            batch_mags  = None
            batch_lf_db = None
        _t_fft += time.perf_counter() - _t_fft_b0

        # Dense position map: pos_in_batch[local_i] = row index in batch_mags
        # for voiced frames, -1 for non-voiced. A numpy lookup keeps the
        # inner-loop magnitude access O(1) without a Python dict.
        pos_in_batch                  = np.full(batch_len, -1, dtype=np.int64)
        pos_in_batch[batch_voiced_lo] = np.arange(batch_voiced_lo.size)

        _t_loop_b0 = time.perf_counter()
        for local_i in range(batch_len):
            i         = batch_start + local_i
            is_voiced = bool(voiced_arr[i])

            f0_for_frame = None
            if i < len(contour_per_frame):
                f0_for_frame = contour_per_frame[i]

            if is_voiced and silence_run >= silence_reset_frames:
                seed_f0 = _lookahead_f0_median(
                    contour_per_frame, voiced_frame_indices,
                    i, lookahead_frames,
                )
                detector.mark_passage_onset(seed_f0)

            if is_voiced:
                silence_run    = 0
                pos            = pos_in_batch[local_i]
                magnitude      = batch_mags[pos]
                # batch_lf_db is None when the LF veto mask is empty (see the
                # precompute guard above); falling back to None keeps detect()
                # on its per-frame path for that configuration.
                lf_db_override = batch_lf_db[pos] if batch_lf_db is not None else None
            else:
                silence_run    += 1
                # detector.process_frame ignores magnitude when is_voiced is
                # False (see SibilanceDetector.process_frame), so None is the
                # canonical "unused" sentinel here.
                magnitude       = None
                lf_db_override  = None

            fired = detector.process_frame(
                magnitude, is_voiced, f0_for_frame,
                lf_db_override=lf_db_override,
            )
            # Capture diag for EVERY voiced frame, not just sibilant ones, so
            # build_events_map() can emit boundary diagnostics for the N frames
            # immediately before/after each detected event. Memory is bounded
            # (~10 floats per frame * n_frames). Non-voiced frames are skipped --
            # they cannot contribute to event boundaries.
            if is_voiced and detector.last_diag is not None:
                all_frame_diag[i] = detector.last_diag
            if fired:
                sibilant_indices.append(i)
                if detector.last_diag is not None:
                    per_frame_diag[i] = detector.last_diag
            f0_per_frame.append(detector.f0)
        _t_loop += time.perf_counter() - _t_loop_b0

    _t_total = time.perf_counter() - _t_total
    # Per-pass profile line. Gated at DEBUG so normal runs stay quiet; raise
    # the logger to DEBUG locally when validating future optimisations.
    logger.debug(
        "[SibilanceDetector] profile -- "
        "fft=%.3fs loop=%.3fs other=%.3fs total=%.3fs "
        "(batches=%d voiced=%d/%d)",
        _t_fft, _t_loop, _t_total - _t_fft - _t_loop, _t_total,
        (n_frames + BATCH_SIZE - 1) // BATCH_SIZE,
        int(voiced_arr.sum()), n_frames,
    )

    rolling   = detector.f0_rolling
    f0_median = float(np.median(rolling)) if len(rolling) > 0 else detector.f0

    # Boundary expansion. Walks outward from each contiguous sibilant run
    # and promotes adjacent voiced frames whose per-frame stats clear the
    # relaxed P95 + flatness thresholds (see _expand_event_boundaries
    # docstring). Runs before gap_merge so newly-adjacent runs can still
    # be joined by build_events_map() if they fall inside gap_merge_ms.
    #
    # `sibilant_indices` at this point is the pre-expansion fire list (core
    # frames only); it gets passed verbatim into build_events_map as
    # `core_sibilant_indices` so the output JSON carries both views. After
    # this call the local name is rebound to `expanded_indices` for the
    # event-building path; keep `core_sibilant_indices` aliased now so it
    # survives.
    core_sibilant_indices = list(sibilant_indices)
    expanded_indices, boundary_added = _expand_event_boundaries(
        sibilant_indices, all_frame_diag, voiced_frame_indices, resolved,
    )
    if boundary_added:
        per_frame_diag.update(boundary_added)
        logger.info(
            "SibilanceDetector: boundary expansion -- "
            f"frames_promoted={len(boundary_added)} "
            f"sibilant_total={len(expanded_indices)} (was {len(sibilant_indices)})"
        )

    events_map = build_events_map(
        sibilant_indices      = expanded_indices,
        f0_per_frame          = f0_per_frame,
        f0_median             = f0_median if f0_median is not None else (contour_median or 0.0),
        n_frames              = n_frames,
        sample_rate           = sample_rate,
        n_fft                 = n_fft,
        hop_length            = hop_length,
        audio                 = audio,
        min_duration_ms       = min_duration_ms,
        gap_merge_ms          = gap_merge_ms,
        per_frame_diag        = per_frame_diag,
        all_frame_diag        = all_frame_diag,
        core_sibilant_indices = core_sibilant_indices,
    )

    logger.info(
        f"SibilanceDetector: frames={n_frames} sibilant={len(expanded_indices)} "
        f"events={len(events_map['events'])} "
        f"f0_median={events_map['f0']['median']} Hz"
    )

    return events_map
