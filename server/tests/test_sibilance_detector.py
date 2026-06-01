"""
Tests for server/scripts/sibilance_detector.py — sibilance event detection.

Structure
---------
Unit tests verify the band-derivation and voicing-veto helpers in isolation
using synthetic signals with known spectral content (LF-dominated tone vs.
HF-dominated noise). Integration tests load the real fixture audio and
assert that the full analyze_sibilance_events() pipeline detects the known
sibilants identified in the 12_spectralSubtraction.wav audit while keeping
the total event count within a regression band.

Fixture
-------
server/tests/fixtures/sibilance_sample.wav
  Source: pipeline-logs/ACXAudiobook-2a057a/12_spectralSubtraction.wav
  Stage:  Post-spectral-subtraction, pre-clipGainDeEss — the canonical
          input the clip-gain de-esser runs detection on. The audit-derived
          ground truth below references this exact file.

Audit ground truth (sibilance_sample.wav)
-----------------------------------------
KNOWN_SIBILANTS — high-confidence /sh/ and /s/ bursts that the detector
must capture. Verified by listening + spectrogram inspection. These were
the primary misses before the band-floor + voicing-veto fixes.

Add to KNOWN_NON_SIBILANTS as new false-positive timestamps are confirmed
from the [sib-event] logs against the audio.

Running
-------
  cd server
  .venv/Scripts/python -m pytest tests/test_sibilance_detector.py -v -s
"""

import pathlib

import numpy as np
import pytest
from scipy.io import wavfile

from sibilance_detector import (
    DEFAULT_PARAMS,
    SibilanceDetector,
    analyze_sibilance_events,
    get_sibilant_band,
    resolve_params,
)
from estimate_f0_contour import estimate_f0_contour

SR = 44_100
N_FFT = 2048
HOP_LENGTH = 512
FIXTURES = pathlib.Path(__file__).parent / "fixtures"
SIBILANCE_SAMPLE = FIXTURES / "sibilance_sample.wav"

# Audit-confirmed sibilant onsets in sibilance_sample.wav (seconds).
# An event must overlap (±150 ms) the listed timestamp to count as a hit.
KNOWN_SIBILANTS = [
    12.25,
    17.30,
]

# Audit-confirmed non-sibilant timestamps (vowel onsets, "I"/"her", breath).
# An event detected within ±150 ms of any listed timestamp is a false positive.
# Populate from the [sib-event] log once user identifies them in the audio.
KNOWN_NON_SIBILANTS: list[float] = []

EVENT_MATCH_WINDOW_S = 0.15


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_fixture(path: pathlib.Path) -> tuple[np.ndarray, int]:
    sr, data = wavfile.read(str(path))
    audio = data.astype(np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1).astype(np.float32)
    if data.dtype == np.int16:
        audio /= 32_768.0
    elif data.dtype == np.int32:
        audio /= 2_147_483_648.0
    return audio, sr


def _event_at(events: list, t_sec: float, window: float = EVENT_MATCH_WINDOW_S):
    """Return the first event overlapping [t-window, t+window]; else None."""
    lo, hi = t_sec - window, t_sec + window
    for ev in events:
        if ev["endSec"] >= lo and ev["startSec"] <= hi:
            return ev
    return None


def _lf_dominated_frame(sr: int, n_fft: int) -> np.ndarray:
    """A single STFT magnitude frame with all energy in the 80-1500 Hz band."""
    t = np.arange(n_fft) / sr
    sig = (np.sin(2 * np.pi * 200.0 * t) + np.sin(2 * np.pi * 800.0 * t)).astype(np.float32)
    return np.abs(np.fft.rfft(sig * np.hanning(n_fft)))


def _hf_dominated_frame(sr: int, n_fft: int, seed: int = 0) -> np.ndarray:
    """A frame of HF-bandpassed noise centred in the sibilant band (3-10 kHz)."""
    rng = np.random.default_rng(seed)
    sig = rng.standard_normal(n_fft).astype(np.float32)
    # Crude HF emphasis: zero out everything below 3 kHz in the frequency domain
    spec = np.fft.rfft(sig * np.hanning(n_fft))
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    spec[freqs < 3000.0] = 0.0
    spec[freqs > 10000.0] = 0.0
    return np.abs(spec)


# ===========================================================================
# get_sibilant_band — band floor logic
# ===========================================================================

class TestGetSibilantBand:
    def test_low_f0_clamps_to_2500_hz_floor(self):
        # A 120 Hz F0 (typical male voice) would give F0*6 = 720 Hz; the
        # clamp must keep the floor at 2.5 kHz to capture /sh/ energy.
        low, high = get_sibilant_band(120.0, SR)
        assert low == 2500.0, f"Low F0 should clamp lower edge to 2500 Hz, got {low}"
        assert high == 12000.0

    def test_high_f0_lets_floor_rise(self):
        # A 500 Hz F0 (high-pitched voice) gives F0*6 = 3000 Hz, well above
        # the 2.5 kHz floor — the band should track the pitch.
        low, _ = get_sibilant_band(500.0, SR)
        assert low == 3000.0, f"F0*6 should win above 2500 Hz, got {low}"

    def test_band_floor_below_previous_3khz_threshold(self):
        # Regression: the previous hard 3 kHz floor was the dominant cause
        # of /sh/ misses. Any reasonable male-voice F0 must now yield a
        # floor strictly below 3 kHz.
        low, _ = get_sibilant_band(150.0, SR)
        assert low < 3000.0, (
            f"Band floor at F0=150 Hz must be below the old 3 kHz threshold, got {low}"
        )

    def test_high_edge_clamps_to_nyquist(self):
        # At 22.05 kHz sample rate the upper edge must clamp to Nyquist
        # rather than the nominal 12 kHz ceiling.
        _, high = get_sibilant_band(150.0, 22_050)
        assert high <= 11_025.0



# ===========================================================================
# Voicing-dominance veto
# ===========================================================================

class TestVoicingVeto:
    def _detector(self, **param_overrides) -> SibilanceDetector:
        # Seed with a typical male-voice F0 so the sibilant band lives at
        # the 2.5 kHz floor (well separated from the LF veto band).
        params = resolve_params(param_overrides)
        return SibilanceDetector(
            sample_rate=SR, n_fft=N_FFT, hop_length=HOP_LENGTH,
            params=params, f0=150.0,
        )

    def test_lf_dominated_frame_is_vetoed(self):
        # Pure vowel-like content (200 + 800 Hz tones) has LF energy far
        # above HF; the veto must fire and the frame must not classify
        # as sibilant regardless of the spectral-shape / energy-gate checks.
        det = self._detector()
        magnitude = _lf_dominated_frame(SR, N_FFT)
        is_sibilant = det.detect(magnitude)
        assert not is_sibilant
        assert det.last_diag is not None
        assert det.last_diag.get("voicingVetoed") is True

    def test_hf_dominated_frame_is_not_vetoed(self):
        # HF-only noise in the sibilant band must not be vetoed (it should
        # be free to clear the energy gate and spectral-shape check — or
        # not — based on its content).
        det = self._detector()
        magnitude = _hf_dominated_frame(SR, N_FFT)
        det.detect(magnitude)
        assert det.last_diag is not None
        assert det.last_diag.get("voicingVetoed") is False

    def test_disabled_veto_does_not_block_lf_dominated_frame(self):
        # Setting the threshold beyond any realistic LF/HF gap must
        # disable the veto path — the veto flag should be False even on
        # an LF-dominated frame. Verifies the threshold is wired through.
        det = self._detector(voicing_veto_db=1000.0)
        magnitude = _lf_dominated_frame(SR, N_FFT)
        det.detect(magnitude)
        assert det.last_diag is not None
        assert det.last_diag.get("voicingVetoed") is False


# ===========================================================================
# lf_db_override fast path
# ===========================================================================

class TestLfDbOverride:
    """
    The vectorised batch path in analyze_sibilance_events() precomputes the
    voicing-veto's low-band dB across every voiced row and feeds it back into
    detect() via the lf_db_override kwarg. The override branch must produce
    the same fire/no-fire decision and the same diag.lfDb the per-frame path
    would have computed from the magnitude — that's the equivalence
    guarantee the batch precompute relies on.
    """

    def _detector(self, **param_overrides) -> SibilanceDetector:
        params = resolve_params(param_overrides)
        return SibilanceDetector(
            sample_rate=SR, n_fft=N_FFT, hop_length=HOP_LENGTH,
            params=params, f0=150.0,
        )

    @staticmethod
    def _compute_lf_db(det: SibilanceDetector, magnitude: np.ndarray) -> float:
        # Mirror analyze_sibilance_events()'s batched precompute for a single
        # row: 10*log10(mean(mag[lf_mask]**2) + 1e-10).
        lf_power = magnitude[det.lf_mask] ** 2
        return 10.0 * np.log10(float(lf_power.mean()) + 1e-10)

    def test_override_matches_per_frame_on_lf_dominated_frame(self):
        magnitude = _lf_dominated_frame(SR, N_FFT)

        ref = self._detector()
        ref_fired = ref.detect(magnitude)
        ref_diag  = dict(ref.last_diag)

        ovr = self._detector()
        lf_db = self._compute_lf_db(ovr, magnitude)
        ovr_fired = ovr.detect(magnitude, lf_db_override=lf_db)

        assert ovr_fired == ref_fired
        assert ovr.last_diag["lfDb"] == ref_diag["lfDb"]
        assert ovr.last_diag["voicingVetoed"] == ref_diag["voicingVetoed"]

    def test_override_matches_per_frame_on_hf_dominated_frame(self):
        # HF-dominated frame clears the veto on both paths and exercises
        # the downstream spectral-shape gates; the override path must reach
        # the same fire/no-fire outcome.
        magnitude = _hf_dominated_frame(SR, N_FFT)

        ref = self._detector()
        ref_fired = ref.detect(magnitude)
        ref_diag  = dict(ref.last_diag)

        ovr = self._detector()
        lf_db = self._compute_lf_db(ovr, magnitude)
        ovr_fired = ovr.detect(magnitude, lf_db_override=lf_db)

        assert ovr_fired == ref_fired
        assert ovr.last_diag["lfDb"] == ref_diag["lfDb"]
        assert ovr.last_diag["voicingVetoed"] == ref_diag["voicingVetoed"]
        # Downstream gate diagnostics must also agree — confirms the override
        # path didn't accidentally short-circuit later checks.
        assert ovr.last_diag["p95Pass"]  == ref_diag["p95Pass"]
        assert ovr.last_diag["flatPass"] == ref_diag["flatPass"]


# ===========================================================================
# Fricative tail extension (VAD-truncated fricatives)
# ===========================================================================

def _voiced_plus_fricative_tail() -> tuple[np.ndarray, np.ndarray]:
    """
    Build a synthetic clip with a voiced run followed by a VAD-silent
    fricative tail (HF noise only, no pitch). Returns (audio, vad_mask)
    where vad_mask marks only the voiced run as voiced.
    """
    voiced_dur = 1.0        # 1.0 s of voiced tone + HF noise
    tail_dur   = 0.200      # 200 ms of HF-only fricative tail
    silence_dur = 0.300     # 300 ms of true silence at end

    n_voiced  = int(voiced_dur * SR)
    n_tail    = int(tail_dur * SR)
    n_silence = int(silence_dur * SR)

    rng = np.random.default_rng(0)
    t   = np.arange(n_voiced) / SR
    # Voiced segment: 200 Hz fundamental + harmonic + HF noise floor
    voiced = (0.3 * np.sin(2 * np.pi * 200.0 * t)
              + 0.15 * np.sin(2 * np.pi * 400.0 * t)).astype(np.float32)
    voiced += 0.02 * rng.standard_normal(n_voiced).astype(np.float32)

    # Fricative tail: HF-bandpassed noise centred in the sibilant band
    # with a concentrated peak around 6-8 kHz so the spectral-shape
    # check (P95-mean elevation + flatness) has something to fire on.
    # Flat bandpassed noise alone has P95/mean too close to unity to
    # pass the trigger -- real /s/ and /f/ have characteristic peaks.
    tail_noise = rng.standard_normal(n_tail).astype(np.float32) * 0.15
    spec = np.fft.rfft(tail_noise)
    freqs = np.fft.rfftfreq(n_tail, d=1.0 / SR)
    spec[freqs < 3000.0] = 0.0
    spec[freqs > 9000.0] = 0.0
    peak_band = (freqs >= 6000.0) & (freqs <= 8000.0)
    spec[peak_band] *= 4.0
    tail = np.fft.irfft(spec, n=n_tail).astype(np.float32)

    silence = np.zeros(n_silence, dtype=np.float32)
    audio   = np.concatenate([voiced, tail, silence])

    # VAD mask: True only on the voiced segment; the fricative tail is
    # marked as silence (the failure mode we're reproducing).
    vad_mask = np.zeros(len(audio), dtype=bool)
    vad_mask[:n_voiced] = True
    return audio, vad_mask


class TestFricativeTailExtension:
    def _f0_contour(self, n_samples: int) -> dict:
        # Constant 200 Hz contour matching the synthetic voiced segment.
        pad      = N_FFT // 2
        n_frames = max(0, (n_samples + 2 * pad - N_FFT) // HOP_LENGTH + 1)
        return {
            "median":    200.0,
            "perFrame":  [200.0] * n_frames,
            "nFft":      N_FFT,
            "hopLength": HOP_LENGTH,
        }

    def test_extension_disabled_truncates_at_vad_boundary(self):
        audio, vad = _voiced_plus_fricative_tail()
        result = analyze_sibilance_events(
            audio, SR, self._f0_contour(len(audio)),
            params={"fricative_tail_extension_ms": 0.0},
            vad_voiced_mask=vad,
            n_fft=N_FFT, hop_length=HOP_LENGTH,
        )
        # With the extension disabled, every event must end inside the
        # VAD-voiced region (sample 44100 == 1.0 s).
        voiced_end_sec = 1.0
        for ev in result["events"]:
            assert ev["endSec"] <= voiced_end_sec + 0.05, (
                f"Event {ev['startSec']:.3f}-{ev['endSec']:.3f} extends past "
                f"VAD boundary {voiced_end_sec} s with extension disabled."
            )

    def test_extension_enabled_captures_fricative_tail(self):
        audio, vad = _voiced_plus_fricative_tail()
        result = analyze_sibilance_events(
            audio, SR, self._f0_contour(len(audio)),
            params={"fricative_tail_extension_ms": 150.0},
            vad_voiced_mask=vad,
            n_fft=N_FFT, hop_length=HOP_LENGTH,
        )
        # With the extension enabled, at least one event must extend
        # into the post-VAD fricative tail (between 1.00 s and 1.20 s).
        tail_events = [
            ev for ev in result["events"]
            if ev["endSec"] > 1.0 and ev["startSec"] < 1.2
        ]
        assert tail_events, (
            f"No events extended into the fricative tail. "
            f"Got events: {[(e['startSec'], e['endSec']) for e in result['events']]}"
        )


# ===========================================================================
# Integration: real audio fixture
# ===========================================================================

@pytest.mark.skipif(
    not SIBILANCE_SAMPLE.exists(),
    reason=f"Fixture not found: {SIBILANCE_SAMPLE} — copy "
           "pipeline-logs/ACXAudiobook-2a057a/12_spectralSubtraction.wav here",
)
class TestSibilanceDetectionOnRealAudio:
    """
    End-to-end tests on sibilance_sample.wav.

    These tests define the contract for the clip-gain de-esser detection
    path: known sibilants in the audit list MUST be detected by the full
    F0 + analyze_sibilance_events() pipeline. Negative cases listed in
    KNOWN_NON_SIBILANTS MUST NOT trigger an event.

    Run with `pytest -s` to print the full event list with timestamps;
    that output is the primary tool for correlating [sib-event] log lines
    with positions in the audio editor.
    """

    @pytest.fixture(scope="class")
    def events(self):
        audio, sr = _load_fixture(SIBILANCE_SAMPLE)
        f0_contour = estimate_f0_contour(audio, sr, n_fft=N_FFT, hop_length=HOP_LENGTH)
        result = analyze_sibilance_events(
            audio, sr, f0_contour,
            n_fft=N_FFT, hop_length=HOP_LENGTH,
        )
        ev_list = result["events"]
        print(f"\n[fixture] {SIBILANCE_SAMPLE.name}  sr={sr}  "
              f"duration={len(audio)/sr:.2f}s  events={len(ev_list)}")
        print(f"{'idx':>3}  {'t_start':>8}  {'t_end':>8}  {'dur_ms':>7}  "
              f"{'type':>9}  {'cond':<28}  {'mean':>6}  {'lf':>6}  postSil")
        for i, ev in enumerate(ev_list):
            det  = ev.get("detection") or {}
            cond = ",".join(
                f"{c}({det['framesByCondition'][c]})"
                for c in det.get("firedConditions", [])
            ) or "none"
            print(
                f"{i:>3}  {ev['startSec']:>8.3f}  {ev['endSec']:>8.3f}  "
                f"{ev['durationMs']:>7.0f}  {ev.get('eventType','?'):>9}  "
                f"{cond:<28}  {det.get('meanMeanDb', 0):>6.1f}  "
                f"{det.get('meanLfDb', 0):>6.1f}  {det.get('postSilenceOnset')}"
            )
        return ev_list

    @pytest.mark.parametrize("t_sec", KNOWN_SIBILANTS)
    def test_known_sibilant_is_detected(self, events, t_sec):
        ev = _event_at(events, t_sec)
        assert ev is not None, (
            f"No event detected within ±{EVENT_MATCH_WINDOW_S*1000:.0f} ms of "
            f"audit-confirmed sibilant at {t_sec:.2f} s. "
            f"Run with -s to see the full event list."
        )

    @pytest.mark.parametrize(
        "t_sec",
        KNOWN_NON_SIBILANTS if KNOWN_NON_SIBILANTS
        else [pytest.param(0.0, marks=pytest.mark.skip(reason="No false positives recorded yet"))],
    )
    def test_known_non_sibilant_is_not_detected(self, events, t_sec):
        ev = _event_at(events, t_sec)
        assert ev is None, (
            f"False positive: event at {ev['startSec']:.3f}-{ev['endSec']:.3f} s "
            f"overlaps audit-confirmed non-sibilant at {t_sec:.2f} s. "
            f"detection={ev.get('detection')}"
        )

    def test_at_least_one_event_detected(self, events):
        assert len(events) >= 1, "Expected at least one sibilant event in the fixture"

    def test_event_count_within_regression_band(self, events):
        # Non-binding upper bound — catches accidental floods (e.g. a
        # regression that disables the veto). The audit's manually
        # reviewed list was ~36 true sibilants; running standalone here
        # (no upstream noise floor, so the absolute energy gate is
        # disabled) the spectral-shape + voicing-veto path stays well
        # below this ceiling. Tighten as further FP fixes land.
        assert len(events) <= 150, (
            f"Event count {len(events)} exceeds regression ceiling — "
            f"detector likely regressed into over-firing."
        )
