"""
Tests for server/scripts/breath_reducer.py — Stage 4c (Breath Reducer).

Structure
---------
Unit tests verify each function in isolation using programmatically-generated
signals with known properties (white noise, sine waves, silence). Integration
tests load the real fixture audio and assert that the full pipeline detects
breaths with both default and relaxed thresholds.

Fixture
-------
server/tests/fixtures/breath_sample.wav
  Source: pipeline-logs/ACXAudiobook-9c1e12/09_noiseReduce.wav
  Stage:  Post-noise-reduction, pre-breath-reduction — the canonical input
          for Stage 4c. Contains known breath sounds between speech phrases.

Running
-------
  cd server
  .venv/Scripts/python -m pytest tests/ -v
"""

import pathlib

import numpy as np
import pytest
from scipy.io import wavfile

from breath_reducer import (
    DEFAULT_PARAMS,
    apply_breath_reduction,
    apply_gain_envelope,
    compute_features,
    detect_breath_frames,
    group_events,
    resolve_params,
)

SR = 44_100
FIXTURES = pathlib.Path(__file__).parent / "fixtures"
BREATH_SAMPLE = FIXTURES / "breath_sample.wav"


# ---------------------------------------------------------------------------
# Signal generators
# ---------------------------------------------------------------------------

def _white_noise(duration_s: float, rms_db: float, seed: int = 0) -> np.ndarray:
    """White noise normalised to a target RMS level (dBFS)."""
    rng = np.random.default_rng(seed)
    n = int(duration_s * SR)
    noise = rng.standard_normal(n).astype(np.float32)
    current_rms = float(np.sqrt(np.mean(noise ** 2)))
    target_rms = float(10 ** (rms_db / 20.0))
    return noise * (target_rms / current_rms)


def _sine(duration_s: float, freq_hz: float, rms_db: float) -> np.ndarray:
    """Pure sine at a target RMS level (dBFS)."""
    t = np.linspace(0, duration_s, int(duration_s * SR), endpoint=False, dtype=np.float32)
    wave = np.sin(2 * np.pi * freq_hz * t)
    current_rms = float(np.sqrt(np.mean(wave ** 2)))
    target_rms = float(10 ** (rms_db / 20.0))
    return wave * (target_rms / current_rms)


def _load_fixture(path: pathlib.Path) -> tuple[np.ndarray, int]:
    """Load a WAV fixture and return (float32 mono audio, sample_rate)."""
    sr, data = wavfile.read(str(path))
    audio = data.astype(np.float32)
    if audio.ndim > 1:
        audio = audio[:, 0]
    # Normalise integer PCM to [-1.0, 1.0]
    if data.dtype == np.int16:
        audio /= 32_768.0
    elif data.dtype == np.int32:
        audio /= 2_147_483_648.0
    return audio, sr


# ===========================================================================
# compute_features
# ===========================================================================

class TestComputeFeatures:
    def test_audio_shorter_than_fft_returns_empty_arrays(self):
        audio = np.zeros(100, dtype=np.float32)  # shorter than n_fft=2048
        rms, zcr, flatness = compute_features(audio, 512, 2048)
        assert len(rms) == 0
        assert len(zcr) == 0
        assert len(flatness) == 0

    def test_output_arrays_have_equal_length(self):
        audio = _white_noise(1.0, -36)
        rms, zcr, flatness = compute_features(audio, 512, 2048)
        assert len(rms) == len(zcr) == len(flatness)
        assert len(rms) > 0

    def test_white_noise_has_high_spectral_flatness(self):
        # Wiener entropy of white noise approaches 1.0; should be well above 0.5
        audio = _white_noise(1.0, -36)
        _, _, flatness = compute_features(audio, 512, 2048)
        median_flatness = float(np.median(flatness))
        assert median_flatness > 0.5, (
            f"White noise spectral flatness {median_flatness:.3f} should be > 0.5"
        )

    def test_pure_sine_has_low_spectral_flatness(self):
        # A single-frequency signal concentrates all energy in one bin → near-zero flatness
        audio = _sine(1.0, 440.0, -12)
        _, _, flatness = compute_features(audio, 512, 2048)
        median_flatness = float(np.median(flatness))
        assert median_flatness < 0.05, (
            f"Sine spectral flatness {median_flatness:.3f} should be < 0.05"
        )

    def test_white_noise_has_high_zcr(self):
        # White noise alternates sign frequently; ZCR should be well above the 0.08 threshold
        audio = _white_noise(1.0, -36)
        _, zcr, _ = compute_features(audio, 512, 2048)
        median_zcr = float(np.median(zcr))
        assert median_zcr > 0.3, (
            f"White noise ZCR {median_zcr:.3f} should be > 0.3"
        )

    def test_low_frequency_sine_has_low_zcr(self):
        # A 200 Hz sine at 44100 Hz crosses zero ~400 times per second → ZCR ≈ 400/2048 ≈ 0.02
        audio = _sine(1.0, 200.0, -12)
        _, zcr, _ = compute_features(audio, 512, 2048)
        median_zcr = float(np.median(zcr))
        assert median_zcr < 0.05, (
            f"200 Hz sine ZCR {median_zcr:.3f} should be < 0.05"
        )

    def test_output_dtype_is_float32(self):
        audio = _white_noise(0.5, -36)
        rms, zcr, flatness = compute_features(audio, 512, 2048)
        assert rms.dtype == np.float32
        assert zcr.dtype == np.float32
        assert flatness.dtype == np.float32


# ===========================================================================
# detect_breath_frames
# ===========================================================================

class TestDetectBreathFrames:
    def test_silence_not_detected(self):
        # -60 dBFS is well below rms_min_db (-48) → silence, not a breath
        params = resolve_params()
        audio = _white_noise(1.0, -60)
        rms, zcr, flatness = compute_features(audio, 512, 2048)
        mask = detect_breath_frames(rms, zcr, flatness, params)
        assert not mask.any(), "Sub-threshold silence should not be flagged as a breath"

    def test_loud_signal_not_detected(self):
        # -12 dBFS is well above rms_max_db (-24) → voiced speech, not a breath
        params = resolve_params()
        audio = _white_noise(1.0, -12)
        rms, zcr, flatness = compute_features(audio, 512, 2048)
        mask = detect_breath_frames(rms, zcr, flatness, params)
        assert not mask.any(), "Loud signal should not be flagged as a breath"

    def test_breath_like_noise_detected(self):
        # -36 dBFS white noise: RMS within window, high flatness, high ZCR → breath
        params = resolve_params()
        audio = _white_noise(1.0, -36)
        rms, zcr, flatness = compute_features(audio, 512, 2048)
        mask = detect_breath_frames(rms, zcr, flatness, params)
        assert mask.any(), (
            "Moderate-RMS white noise (high flatness + high ZCR) should be detected as breath. "
            f"RMS range: [{rms.min():.4f}, {rms.max():.4f}], "
            f"ZCR median: {np.median(zcr):.3f}, "
            f"Flatness median: {np.median(flatness):.3f}"
        )

    def test_full_voiced_mask_excludes_all_frames(self):
        # Even breath-like audio is suppressed when the entire region is marked voiced
        params = resolve_params()
        audio = _white_noise(1.0, -36)
        rms, zcr, flatness = compute_features(audio, 512, 2048)
        voiced = np.ones(len(rms), dtype=bool)
        mask = detect_breath_frames(rms, zcr, flatness, params, voiced_mask=voiced)
        assert not mask.any(), "Frames covered by voiced_mask=True should be excluded from detection"

    def test_partial_voiced_mask_only_excludes_voiced_half(self):
        params = resolve_params()
        audio = _white_noise(2.0, -36)
        rms, zcr, flatness = compute_features(audio, 512, 2048)
        n = len(rms)
        voiced = np.zeros(n, dtype=bool)
        voiced[: n // 2] = True  # first half is voiced; second half is unvoiced
        mask = detect_breath_frames(rms, zcr, flatness, params, voiced_mask=voiced)
        assert not mask[: n // 2].any(), "Voiced frames in first half should be excluded"
        assert mask[n // 2 :].any(), "Unvoiced frames in second half should still be detected"

    def test_voiced_mask_length_mismatch_is_ignored(self):
        # When the mask length doesn't match, the code ignores it (no crash, no filtering)
        params = resolve_params()
        audio = _white_noise(1.0, -36)
        rms, zcr, flatness = compute_features(audio, 512, 2048)
        wrong_length_mask = np.ones(len(rms) + 10, dtype=bool)
        # Should not raise — should behave the same as no mask
        mask_with_bad = detect_breath_frames(rms, zcr, flatness, params, voiced_mask=wrong_length_mask)
        mask_without = detect_breath_frames(rms, zcr, flatness, params, voiced_mask=None)
        np.testing.assert_array_equal(mask_with_bad, mask_without)


# ===========================================================================
# group_events
# ===========================================================================

class TestGroupEvents:
    def _params(self):
        return resolve_params()

    def test_all_false_mask_returns_empty_list(self):
        mask = np.zeros(200, dtype=bool)
        events = group_events(mask, 512, SR, self._params())
        assert events == []

    def test_event_shorter_than_min_breath_ms_is_dropped(self):
        # min_breath_ms=60 ms → at 44100/512 hop ≈ 5.2 frames minimum
        # 2 frames ≈ 23 ms — below threshold
        params = self._params()
        mask = np.zeros(100, dtype=bool)
        mask[10:12] = True  # 2 frames
        events = group_events(mask, params["hop_length"], SR, params)
        assert events == [], f"2-frame event should be dropped by min_breath_ms, got {events}"

    def test_event_longer_than_max_breath_ms_is_dropped(self):
        # max_breath_ms=550 ms → at 44100/512 hop ≈ 47 frames maximum
        # 60 frames ≈ 695 ms — above threshold
        params = self._params()
        mask = np.zeros(150, dtype=bool)
        mask[10:70] = True  # 60 frames
        events = group_events(mask, params["hop_length"], SR, params)
        assert events == [], f"60-frame event should be dropped by max_breath_ms, got {events}"

    def test_valid_duration_event_returned_with_correct_sample_offsets(self):
        # 15 frames ≈ 174 ms — within [60 ms, 550 ms]
        params = self._params()
        hop = params["hop_length"]
        pad_frames = int(params.get("pad_ms", 0) * SR / 1000.0 / hop)
        mask = np.zeros(100, dtype=bool)
        mask[10:25] = True
        events = group_events(mask, hop, SR, params)
        assert len(events) == 1
        start_s, end_s = events[0]
        # Core detection spans frames 10–25; padding extends both sides (in frames)
        # No voiced_mask → padding extends the full pad_frames amount
        assert start_s == max(0, 10 - pad_frames) * hop
        assert end_s == min(100, 25 + pad_frames) * hop

    def test_two_valid_events_both_returned(self):
        params = self._params()
        hop = params["hop_length"]
        mask = np.zeros(200, dtype=bool)
        mask[10:25] = True  # ~174 ms — valid
        mask[60:75] = True  # ~174 ms — valid
        events = group_events(mask, hop, SR, params)
        assert len(events) == 2

    def test_mixed_valid_and_invalid_events(self):
        # 2-frame (too short), 15-frame (valid), 60-frame (too long)
        params = self._params()
        mask = np.zeros(200, dtype=bool)
        mask[5:7] = True     # 2 frames — too short
        mask[20:35] = True   # 15 frames — valid
        mask[60:120] = True  # 60 frames — too long
        events = group_events(mask, params["hop_length"], SR, params)
        assert len(events) == 1, f"Expected 1 valid event, got {len(events)}: {events}"


# ===========================================================================
# apply_gain_envelope
# ===========================================================================

class TestApplyGainEnvelope:
    def test_no_events_leaves_audio_unchanged(self):
        audio = _white_noise(1.0, -20)
        result = apply_gain_envelope(audio.copy(), [], 12.0, fade_samples=661)
        np.testing.assert_array_equal(result, audio)

    def test_hold_region_is_at_target_gain(self):
        # Flat signal of 1.0 → hold region should equal target_gain exactly
        audio = np.ones(SR, dtype=np.float32)
        fade_samples = 200
        start, end = SR // 4, SR // 2
        events = [(start, end)]
        result = apply_gain_envelope(audio, events, 12.0, fade_samples)

        target = float(10 ** (-12.0 / 20.0))
        hold_s = start + fade_samples
        hold_e = end - fade_samples
        np.testing.assert_allclose(
            result[hold_s:hold_e], target, rtol=1e-4,
            err_msg="Hold region should be at uniform target gain"
        )

    def test_signal_before_event_is_unchanged(self):
        audio = np.ones(SR, dtype=np.float32)
        result = apply_gain_envelope(audio, [(SR // 4, SR // 2)], 12.0, fade_samples=200)
        np.testing.assert_allclose(result[: SR // 4 - 1], 1.0, rtol=1e-5)

    def test_signal_after_event_is_unchanged(self):
        audio = np.ones(SR, dtype=np.float32)
        result = apply_gain_envelope(audio, [(SR // 4, SR // 2)], 12.0, fade_samples=200)
        np.testing.assert_allclose(result[SR // 2 + 1 :], 1.0, rtol=1e-5)

    def test_gain_never_drops_below_target(self):
        # Even with overlapping events, gain floor should not exceed the target reduction
        audio = np.ones(SR, dtype=np.float32)
        events = [(SR // 4, SR // 2), (SR // 3, SR * 2 // 3)]  # deliberate overlap
        result = apply_gain_envelope(audio, events, 12.0, fade_samples=100)
        target = float(10 ** (-12.0 / 20.0))
        assert float(result.min()) >= target - 1e-5

    def test_output_is_float32(self):
        audio = np.ones(SR, dtype=np.float32)
        result = apply_gain_envelope(audio, [(SR // 4, SR // 2)], 12.0, fade_samples=200)
        assert result.dtype == np.float32


# ===========================================================================
# Integration: real audio fixture
# ===========================================================================

@pytest.mark.skipif(
    not BREATH_SAMPLE.exists(),
    reason=f"Fixture not found: {BREATH_SAMPLE} — copy a post-noise-reduction WAV here",
)
class TestBreathDetectionOnRealAudio:
    """
    End-to-end tests on breath_sample.wav (sourced from pipeline stage 09_noiseReduce).

    These tests define the contract for Stage 4c:
      - Default params MUST detect breath events in a file with known breath sounds.
      - If TestDefaultParamsDetectBreaths fails, the detection thresholds need widening.
        Run pytest -v -s and look at the printed feature diagnostics to guide tuning.
    """

    @pytest.fixture(scope="class")
    def audio_sr(self):
        return _load_fixture(BREATH_SAMPLE)

    # --- Report fields ---

    def test_result_has_required_keys(self, audio_sr):
        audio, sr = audio_sr
        result = apply_breath_reduction(audio, sr)
        for key in ("applied", "breath_events", "max_reduction_db", "process_seconds"):
            assert key in result, f"Missing key '{key}' in result"

    def test_process_seconds_is_non_negative(self, audio_sr):
        audio, sr = audio_sr
        result = apply_breath_reduction(audio, sr)
        assert result["process_seconds"] >= 0

    # --- Detection: default params ---

    def test_default_params_detect_breaths(self, audio_sr):
        """
        Core contract: a file with known breath sounds MUST be detected with
        default thresholds. If this fails, widen rms_max_db or rms_min_db.

        Diagnostic: re-run with `pytest -s` to see printed feature stats.
        """
        audio, sr = audio_sr

        # Print feature diagnostics to aid threshold calibration when this fails
        params = resolve_params()
        rms, zcr, flatness = compute_features(audio, params["hop_length"], params["n_fft"])
        rms_db = 20.0 * np.log10(rms + 1e-10)
        in_rms_window = (rms_db >= params["rms_min_db"]) & (rms_db <= params["rms_max_db"])
        print(
            f"\n[diagnostics] {BREATH_SAMPLE.name}  sr={sr}  frames={len(rms)}\n"
            f"  RMS dB: min={rms_db.min():.1f}  max={rms_db.max():.1f}  "
            f"median={np.median(rms_db):.1f}\n"
            f"  Frames in RMS window [{params['rms_min_db']}, {params['rms_max_db']}]: "
            f"{int(in_rms_window.sum())} / {len(rms)}\n"
            f"  ZCR: min={zcr.min():.3f}  max={zcr.max():.3f}  "
            f"median={np.median(zcr):.3f}  (threshold: >={params['zcr_min']})\n"
            f"  Flatness: min={flatness.min():.3f}  max={flatness.max():.3f}  "
            f"median={np.median(flatness):.3f}  (threshold: >={params['flatness_min']})"
        )

        result = apply_breath_reduction(audio, sr)
        assert result["applied"], (
            f"No breaths detected with default params on {BREATH_SAMPLE.name}. "
            f"Run `pytest -s` for feature diagnostics — likely rms_max_db ({params['rms_max_db']} dB) "
            f"needs to be raised or rms_min_db ({params['rms_min_db']} dB) lowered."
        )
        assert result["breath_events"] >= 1

    # --- Detection: relaxed thresholds ---

    def test_raising_rms_max_detects_at_least_as_many_events(self, audio_sr):
        """
        Raising rms_max_db from -24 to -18 dB allows louder breath sounds.
        The relaxed setting must not detect *fewer* events than default.
        When the default test fails but this passes, rms_max_db is the culprit.
        """
        audio, sr = audio_sr
        default_n = apply_breath_reduction(audio, sr)["breath_events"]
        relaxed_n = apply_breath_reduction(audio, sr, params={"rms_max_db": -18.0})["breath_events"]
        assert relaxed_n >= default_n, (
            f"Raising rms_max_db to -18 dB should find >= events (default={default_n}, relaxed={relaxed_n})"
        )

    def test_lowering_rms_min_detects_at_least_as_many_events(self, audio_sr):
        """
        Lowering rms_min_db from -48 to -54 dB catches quieter breath sounds.
        When the default test fails but this passes, rms_min_db is the culprit.
        """
        audio, sr = audio_sr
        default_n = apply_breath_reduction(audio, sr)["breath_events"]
        relaxed_n = apply_breath_reduction(audio, sr, params={"rms_min_db": -54.0})["breath_events"]
        assert relaxed_n >= default_n, (
            f"Lowering rms_min_db to -54 dB should find >= events (default={default_n}, relaxed={relaxed_n})"
        )

    def test_wide_open_thresholds_detect_breaths(self, audio_sr):
        """
        Sanity check: with a deliberately permissive RMS window [-60, -12], the
        detector must find at least one breath event. If this also fails, the
        problem is in the ZCR or flatness thresholds, or in the event duration
        filter — not the RMS window.
        """
        audio, sr = audio_sr
        result = apply_breath_reduction(
            audio, sr,
            params={"rms_min_db": -60.0, "rms_max_db": -12.0},
        )
        assert result["applied"], (
            "Even with a wide-open RMS window [-60, -12 dB], no breath events were detected. "
            "Investigate zcr_min, flatness_min, or min/max_breath_ms thresholds."
        )

    # --- Output correctness ---

    def test_output_audio_shape_matches_input(self, audio_sr):
        audio, sr = audio_sr
        result = apply_breath_reduction(audio, sr)
        if result["applied"]:
            assert result["audio"].shape == audio.shape

    def test_output_audio_is_float32(self, audio_sr):
        audio, sr = audio_sr
        result = apply_breath_reduction(audio, sr)
        if result["applied"]:
            assert result["audio"].dtype == np.float32

    def test_gain_is_applied_at_detected_event_regions(self, audio_sr):
        """RMS in the hold region of every detected event must be lower after processing."""
        audio, sr = audio_sr
        params = resolve_params()
        hop = params["hop_length"]

        rms_arr, zcr_arr, flat_arr = compute_features(audio, hop, params["n_fft"])
        breath_mask = detect_breath_frames(rms_arr, zcr_arr, flat_arr, params)
        events = group_events(breath_mask, hop, sr, params)

        if not events:
            pytest.skip("No events detected with default params — skipping gain-application check")

        fade_s = max(1, int(params["fade_ms"] * sr / 1000))
        processed = apply_gain_envelope(audio, events, params["max_reduction_db"], fade_s)

        for start_s, end_s in events:
            hold_s = start_s + fade_s
            hold_e = end_s - fade_s
            if hold_s >= hold_e:
                continue
            in_rms = float(np.sqrt(np.mean(audio[hold_s:hold_e] ** 2)))
            out_rms = float(np.sqrt(np.mean(processed[hold_s:hold_e] ** 2)))
            assert out_rms < in_rms, (
                f"Event [{start_s}, {end_s}]: output RMS {out_rms:.5f} "
                f"not less than input RMS {in_rms:.5f}"
            )
