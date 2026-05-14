"""
sibilance_detector.py
Self-contained sibilance event detector.

Provides the SibilanceDetector class and analyze_sibilance_events() function
used by airBoost (post-boost sibilant masking) and resonanceSuppressor
(sibilant_only passes). Each calling stage supplies its own detection
parameters via the standard sparse-override pattern.

Detection scheme:

  - Sibilant frequency band: derived from F0 via get_sibilant_band(). Lower
    edge is max(F0*8, 3 kHz); upper edge is fixed at 12 kHz (or Nyquist).
  - Per-frame band update: F0 is supplied externally as a per-STFT-frame
    contour (typically from estimate_f0_contour.py). The detector maintains
    a rolling-window median over those values and rebuilds the band mask
    when the median shifts beyond F0_MASK_RESHIFT_THRESHOLD_HZ -- avoids
    mask churn from contour jitter while tracking real pitch changes.
  - Two-condition detect():
      * Condition 1 (P95 spike): in-band P95 energy exceeds the in-band
        mean by p95_trigger_db AND in-band spectral flatness exceeds
        min_flatness. Fires from frame zero -- no warmup needed.
      * Condition 2 (broadband elevation): in-band mean energy exceeds
        the long-term EMA reference (built on voiced non-sibilant frames)
        by broadband_trigger_db. Active only after warmup_frames voiced
        non-sibilant frames have populated the EMA.

The module owns no F0 estimation. Callers that need an F0 contour should
get one from estimate_f0_contour.py via getF0Contour() in f0Analysis.js.
"""

import logging
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
    # Condition 1: P95 spike + flatness gate. Fires from frame zero.
    "p95_trigger_db":       6.0,
    "min_flatness":         0.1,
    # Condition 2: broadband elevation above long-term reference. Requires
    # warmup before firing so the EMA reference is stable.
    "broadband_trigger_db": 10.0,
    "ema_time_constant_ms": 300.0,
    "warmup_frames":        25,
    # Minimum event duration (ms). Events shorter than this are dropped from
    # the returned event map entirely. Default 0 preserves backward
    # compatibility for stages that share the detector (airBoost,
    # resonanceSuppressor). The clip-gain de-esser sets ~25 ms so it never
    # treats brief consonant stops or click residuals as sibilants.
    "min_duration_ms":      0.0,
}


# Threshold below which an event is classified as an affricate (the percussive
# burst portion of /tʃ/, /dʒ/, etc.) rather than a steady-state fricative. Used
# downstream by the clip-gain de-esser to pick fade-in/-out lengths so the full
# reduction lands before the affricate's transient peak.
AFFRICATE_PEAK_POSITION = 0.35


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

    Lower bound: max(F0*8, 3 kHz) -- fricative energy begins around the 8th
    harmonic, never below 3 kHz (avoids voice body for high-F0 voices).
    Upper bound: fixed at 12 kHz (or Nyquist) -- fricative turbulence is
    broadband noise whose extent depends on vocal tract acoustics, not F0.
    """
    nyquist = sample_rate / 2.0
    low_hz  = max(f0 * 8.0, 3000.0)
    high_hz = min(12000.0, nyquist)
    return float(low_hz), float(high_hz)


# ---------------------------------------------------------------------------
# Event map serialisation
# ---------------------------------------------------------------------------

def build_events_map(
    sibilant_indices: list,
    f0_per_frame:     list,
    f0_median:        float,
    n_frames:         int,
    sample_rate:      int,
    n_fft:            int,
    hop_length:       int,
    audio:            np.ndarray = None,
    min_duration_ms:  float = 0.0,
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

            obj.update({
                "startSample":          int(start_sample),
                "endSample":            int(end_sample),
                "peakSample":           int(peak_sample),
                "peakRelativePosition": round(peak_rel_pos, 4),
                "eventPeakDb":          round(peak_db, 2),
                "eventType":            event_type,
            })

        event_objs.append(obj)
        kept_runs.append((s, e))

    # When events were filtered out, sync sibilantFrameIndices so downstream
    # consumers that read raw frame indices see a consistent view.
    if min_duration_ms > 0 and len(kept_runs) != len(events):
        kept_indices = []
        for s, e in kept_runs:
            kept_indices.extend(range(int(s), int(e) + 1))
        sibilant_indices = kept_indices

    return {
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
      sibilant_mask      - current frequency-bin mask (n_bins boolean)
      sibilant_low/high  - band edges in Hz
      long_term_power    - per-bin EMA reference
      voiced_frame_count - voiced non-sibilant frames contributing to EMA
      f0                 - F0 from which the current band was derived
      f0_rolling         - deque of recent per-frame F0 values
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

        # EMA state
        frame_period_ms      = (hop_length / sample_rate) * 1000.0
        self.ema_alpha       = self._time_to_coeff(
            params["ema_time_constant_ms"], frame_period_ms
        )
        self.long_term_power    = None
        self.voiced_frame_count = 0

    @staticmethod
    def _time_to_coeff(time_ms: float, frame_period_ms: float) -> float:
        if time_ms <= 0 or frame_period_ms <= 0:
            return 1.0
        return np.exp(-frame_period_ms / time_ms)

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
        if not is_voiced or f0_for_frame is None or not np.isfinite(f0_for_frame):
            return
        if f0_for_frame <= 0:
            return
        self.f0_rolling.append(float(f0_for_frame))
        if len(self.f0_rolling) >= 3:
            median_f0 = float(np.median(self.f0_rolling))
            if (self._current_band_f0 is None or
                    abs(median_f0 - self._current_band_f0)
                    > F0_MASK_RESHIFT_THRESHOLD_HZ):
                self._set_sibilant_band(median_f0)
                self._current_band_f0 = median_f0

    def detect(self, magnitude: np.ndarray) -> bool:
        """Two-condition per-frame detection. See module docstring."""
        if self.sibilant_mask is None or not self.sibilant_mask.any():
            return False

        sib_energy  = magnitude[self.sibilant_mask] ** 2
        mean_energy = np.mean(sib_energy)
        p95_energy  = np.percentile(sib_energy, 95)

        mean_db = 10.0 * np.log10(mean_energy + 1e-10)
        p95_db  = 10.0 * np.log10(p95_energy  + 1e-10)

        if (p95_db - mean_db) > self.params["p95_trigger_db"]:
            valid = sib_energy > 0
            if valid.any():
                geo_mean = np.exp(np.mean(np.log(sib_energy[valid])))
                arith    = np.mean(sib_energy[valid])
                flatness = geo_mean / arith if arith > 0 else 0.0
            else:
                flatness = 0.0
            if flatness >= self.params["min_flatness"]:
                return True

        if (self.long_term_power is not None and
                self.voiced_frame_count >= self.params["warmup_frames"]):
            ref_mean_db = 10.0 * np.log10(
                np.mean(self.long_term_power[self.sibilant_mask]) + 1e-10
            )
            if (mean_db - ref_mean_db) > self.params["broadband_trigger_db"]:
                return True

        return False

    def update_ema(
        self,
        frame_power: np.ndarray,
        is_voiced:   bool,
        is_sibilant: bool,
    ) -> None:
        """Update the long-term reference on voiced, non-sibilant frames."""
        if not (is_voiced and not is_sibilant):
            return
        if self.long_term_power is None:
            self.long_term_power = frame_power.copy()
        else:
            self.long_term_power = (
                self.ema_alpha         * self.long_term_power +
                (1.0 - self.ema_alpha) * frame_power
            )
        self.voiced_frame_count += 1

    def process_frame(
        self,
        magnitude:    np.ndarray,
        is_voiced:    bool,
        f0_for_frame: float = None,
    ) -> bool:
        """
        Full per-frame pipeline: rolling F0 update -> detection -> EMA update.

        Returns True when the frame is classified as sibilant.
        """
        self.update_rolling_f0(f0_for_frame, is_voiced)
        is_sibilant = self.detect(magnitude) if is_voiced else False
        frame_power = magnitude ** 2
        self.update_ema(frame_power, is_voiced, is_sibilant)
        return is_sibilant


# ---------------------------------------------------------------------------
# Public analysis function
# ---------------------------------------------------------------------------

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
    resolved = resolve_params(params)
    min_duration_ms = float(resolved.get("min_duration_ms", 0.0) or 0.0)

    if n_samples == 0:
        logger.warning("analyze_sibilance_events: empty audio — returning empty event map")
        return build_events_map(
            sibilant_indices = [],
            f0_per_frame     = [],
            f0_median        = contour_median if contour_median is not None else 0.0,
            n_frames         = 0,
            sample_rate      = sample_rate,
            n_fft            = n_fft,
            hop_length       = hop_length,
            audio            = audio,
            min_duration_ms  = min_duration_ms,
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
    if vad_voiced_mask is not None and len(vad_voiced_mask) == len(audio):
        voiced_frame_indices = set()
        for fi in range(n_frames):
            o_start = max(0, fi * hop_length - pad)
            o_end   = min(len(audio), fi * hop_length - pad + n_fft)
            if o_start < o_end and vad_voiced_mask[o_start:o_end].any():
                voiced_frame_indices.add(fi)

    window           = get_window("hann", n_fft, fftbins=True)
    sibilant_indices = []
    f0_per_frame     = []

    for i in range(n_frames):
        start     = i * hop_length
        end       = start + n_fft
        frame_raw = audio_padded[start:end]
        magnitude = np.abs(np.fft.rfft(frame_raw * window))
        is_voiced = (voiced_frame_indices is None) or (i in voiced_frame_indices)

        f0_for_frame = None
        if i < len(contour_per_frame):
            f0_for_frame = contour_per_frame[i]

        if detector.process_frame(magnitude, is_voiced, f0_for_frame):
            sibilant_indices.append(i)
        f0_per_frame.append(detector.f0)

    rolling   = detector.f0_rolling
    f0_median = float(np.median(rolling)) if len(rolling) > 0 else detector.f0

    events_map = build_events_map(
        sibilant_indices = sibilant_indices,
        f0_per_frame     = f0_per_frame,
        f0_median        = f0_median if f0_median is not None else (contour_median or 0.0),
        n_frames         = n_frames,
        sample_rate      = sample_rate,
        n_fft            = n_fft,
        hop_length       = hop_length,
        audio            = audio,
        min_duration_ms  = min_duration_ms,
    )

    logger.info(
        f"SibilanceDetector: frames={n_frames} sibilant={len(sibilant_indices)} "
        f"events={len(events_map['events'])} "
        f"f0_median={events_map['f0']['median']} Hz"
    )

    return events_map
