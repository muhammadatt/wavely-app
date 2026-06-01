"""
Tests for server/scripts/rnnoise_denoise.py — RNNoise pre-pass + VAD gate.

Structure
---------
Unit tests exercise the two non-trivial pieces of script logic in isolation:

  * ``_apply_vad_gate``   — frame-level dry/denoised mixer with algorithmic
                            delay alignment, hangover dilation, and boxcar
                            crossfade smoothing.
  * Silero→RNNoise frame resolver — the vectorised mapping from the JS
                            wrapper's 25 ms Silero mask onto RNNoise's 10 ms
                            internal frame grid (with strip-frame pre-roll
                            and out-of-range tail handling).

Integration tests drive ``rnnoise_denoise.run([...])`` end-to-end against a
synthesised 2 s mono WAV with a Silero mask sidecar and assert the result
dict shape, output length preservation, and VAD-gate stats. They require the
``pyrnnoise`` C extension to be importable; they ``pytest.skip`` cleanly when
it isn't (e.g. CI without the native build).

Running
-------
  cd server
  .venv/Scripts/python -m pytest tests/test_rnnoise_denoise.py -v
"""

import json
import pathlib
import tempfile

import numpy as np
import pytest
from scipy.io import wavfile

import rnnoise_denoise as r

RNNOISE_SR = r.RNNOISE_SR        # 48 000
PIPELINE_SR = r.PIPELINE_SR      # 44 100
FRAME_SAMPLES = RNNOISE_SR // 100  # 480 samples = 10 ms at 48 kHz


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_frames(speech_probs, silero_per_rnn, n_samples=None):
    """Build dummy denoised/dry int16 buffers sized to the given frame count.

    Denoised is all zeros (clearly distinguishable), dry is a constant +1000.
    A mix that hits an override frame should pull the result toward +1000.
    """
    n_frames = len(speech_probs)
    n_samples = n_samples or n_frames * FRAME_SAMPLES
    denoised = np.zeros(n_samples, dtype=np.int16)
    dry = np.full(n_samples, 1000, dtype=np.int16)
    return (
        denoised,
        dry,
        np.asarray(speech_probs, dtype=np.float32),
        np.asarray(silero_per_rnn, dtype=bool),
    )


def _resolver_loop(silero_mask, frame_count, strip_frames):
    """Naive Python implementation used as a reference for the vectorised
    resolver in ``main()``. Mirrors the comment block in rnnoise_denoise.py."""
    out = [True] * frame_count
    for k in range(frame_count):
        t_orig_ms = (k - strip_frames) * 10
        if t_orig_ms < 0:
            continue
        sf = t_orig_ms // 25
        if 0 <= sf < len(silero_mask):
            out[k] = not silero_mask[sf]
    return np.asarray(out, dtype=bool)


def _resolver_vec(silero_mask, frame_count, strip_frames):
    """Vectorised resolver — copy of the implementation block under test."""
    silero_full = np.asarray(silero_mask, dtype=bool)
    k = np.arange(frame_count, dtype=np.int64)
    t_orig_ms = (k - strip_frames) * 10
    sf = t_orig_ms // 25
    out = np.ones(frame_count, dtype=bool)
    valid = (t_orig_ms >= 0) & (sf < silero_full.shape[0])
    out[valid] = ~silero_full[sf[valid]]
    return out


# ---------------------------------------------------------------------------
# Unit tests — _apply_vad_gate
# ---------------------------------------------------------------------------

class TestApplyVadGate:
    """Frame-level dry/denoised mixer behaviour."""

    EXPECTED_KEYS = {
        'overrides', 'raw_overrides', 'total_frames',
        'threshold', 'crossfade_ms', 'hangover_frames',
    }

    def test_no_overrides_when_silero_silence_everywhere(self):
        # Silero says silence on every frame → gate never triggers, even
        # though RNNoise speech_prob is below threshold.
        denoised, dry, probs, silero = _make_frames(
            speech_probs=[0.1] * 10,
            silero_per_rnn=[False] * 10,
        )
        res = r._apply_vad_gate(denoised, dry, probs, silero,
                                rnnoise_threshold=0.3, crossfade_ms=1.0)
        buf = res.pop('_buffer')
        assert res['overrides'] == 0
        assert res['raw_overrides'] == 0
        # Early-return path keeps the denoised buffer untouched.
        assert np.array_equal(buf, denoised)
        # Early-return dict omits algo_delay_samples (no mix happened).
        assert set(res.keys()) == self.EXPECTED_KEYS

    def test_no_overrides_when_rnnoise_confident(self):
        # Silero says speech but RNNoise also says speech → no disagreement.
        denoised, dry, probs, silero = _make_frames(
            speech_probs=[0.9] * 10,
            silero_per_rnn=[True] * 10,
        )
        res = r._apply_vad_gate(denoised, dry, probs, silero,
                                rnnoise_threshold=0.3, crossfade_ms=1.0)
        res.pop('_buffer')
        assert res['overrides'] == 0
        assert res['raw_overrides'] == 0

    def test_basic_override_mixes_dry_into_denoised(self):
        # Frames 4..6 disagree (silero=speech, rnn<thr). With no hangover the
        # override count should match the raw disagreement count exactly.
        probs = [0.9, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9]
        silero = [True] * 10
        denoised, dry, probs_arr, silero_arr = _make_frames(probs, silero)
        res = r._apply_vad_gate(denoised, dry, probs_arr, silero_arr,
                                rnnoise_threshold=0.3, crossfade_ms=1.0,
                                hangover_frames=0)
        buf = res.pop('_buffer')
        assert res['raw_overrides'] == 3
        assert res['overrides'] == 3
        # The centre of the override region (well clear of any crossfade
        # ramp) should now be dominated by the dry signal (+1000), not the
        # denoised signal (0).
        centre = 5 * FRAME_SAMPLES + FRAME_SAMPLES // 2
        assert buf[centre] > 500

    def test_hangover_dilates_override_region_forward(self):
        # Three raw disagreement frames; with hangover=2 the override region
        # extends two frames forward, giving 5 total override frames.
        probs = [0.9] * 4 + [0.1] * 3 + [0.9] * 3
        silero = [True] * 10
        denoised, dry, probs_arr, silero_arr = _make_frames(probs, silero)
        res = r._apply_vad_gate(denoised, dry, probs_arr, silero_arr,
                                rnnoise_threshold=0.3, crossfade_ms=1.0,
                                hangover_frames=2)
        res.pop('_buffer')
        assert res['raw_overrides'] == 3
        assert res['overrides'] == 5
        assert res['hangover_frames'] == 2

    def test_hangover_merges_adjacent_short_runs(self):
        # Two single-frame override runs separated by a 2-frame gap. With
        # hangover=2, the first run's dilation covers the gap entirely and
        # both runs merge into one contiguous override.
        probs = [0.9, 0.1, 0.9, 0.9, 0.1, 0.9]
        silero = [True] * 6
        denoised, dry, probs_arr, silero_arr = _make_frames(probs, silero)
        res = r._apply_vad_gate(denoised, dry, probs_arr, silero_arr,
                                rnnoise_threshold=0.3, crossfade_ms=1.0,
                                hangover_frames=2)
        res.pop('_buffer')
        assert res['raw_overrides'] == 2
        # 1 + hangover(2) + 1 + hangover(2) = 6, but capped at frame count.
        # The actual merged run covers frames 1..5 (after dilation) = 5 frames.
        assert res['overrides'] == 5

    def test_algo_delay_shifts_dry_source(self):
        # Construct a dry buffer whose first half is +2000 and second half is
        # 0. With algo_delay = first-half length, the override at the front
        # of the buffer should see zero-padded dry (warmup region), not the
        # +2000 content that "belongs" to a later denoised position.
        n_frames = 8
        n_samples = n_frames * FRAME_SAMPLES
        denoised = np.zeros(n_samples, dtype=np.int16)
        # Dry: front half = +2000, back half = +1000.
        dry = np.full(n_samples, 1000, dtype=np.int16)
        dry[:n_samples // 2] = 2000
        probs = np.array([0.1] * n_frames, dtype=np.float32)
        silero = np.ones(n_frames, dtype=bool)

        # algo_delay = half the buffer → first half of mixed should be dry
        # zero-pad (samples shifted in from before t=0), second half should
        # be the *front* of the dry buffer (the +2000 region).
        algo_delay = n_samples // 2
        res = r._apply_vad_gate(denoised, dry, probs, silero,
                                rnnoise_threshold=0.3, crossfade_ms=0.0,
                                algo_delay_samples=algo_delay,
                                hangover_frames=0)
        buf = res.pop('_buffer')
        # Sample well inside the front half — outside any crossfade ramp.
        assert buf[100] == 0, "front half should be zero-padded dry"
        # Sample well inside the back half — should see the +2000 dry data
        # that was shifted in from the front of the original dry buffer.
        assert buf[3 * n_samples // 4] == 2000

    def test_crossfade_creates_smooth_transition(self):
        # Single override block with a non-trivial crossfade. Samples in the
        # ramp region should sit strictly between the dry and denoised
        # values, not jump abruptly between them.
        probs = [0.9] * 5 + [0.1] * 5 + [0.9] * 5
        silero = [True] * 15
        denoised, dry, probs_arr, silero_arr = _make_frames(probs, silero)
        res = r._apply_vad_gate(denoised, dry, probs_arr, silero_arr,
                                rnnoise_threshold=0.3, crossfade_ms=2.0,
                                hangover_frames=0)
        buf = res.pop('_buffer')
        # Inspect the boundary at frame 5 (dry → denoised handoff): there
        # should be at least one sample in (0, 1000) on either side.
        boundary = 5 * FRAME_SAMPLES
        window = buf[boundary - 50: boundary + 50].astype(np.int32)
        ramp = window[(window > 0) & (window < 1000)]
        assert ramp.size > 0, "crossfade window should contain intermediate values"

    def test_result_dict_has_no_legacy_override_frames_key(self):
        # Regression: the duplicate 'override_frames' key was removed during
        # the perf/cleanup pass. Both code paths (early-return and main mix)
        # must omit it.
        denoised, dry, probs, silero = _make_frames([0.9] * 4, [False] * 4)
        early = r._apply_vad_gate(denoised, dry, probs, silero,
                                  rnnoise_threshold=0.3, crossfade_ms=1.0)
        early.pop('_buffer')
        assert 'override_frames' not in early

        denoised, dry, probs, silero = _make_frames([0.1] * 4, [True] * 4)
        mixed = r._apply_vad_gate(denoised, dry, probs, silero,
                                  rnnoise_threshold=0.3, crossfade_ms=1.0)
        mixed.pop('_buffer')
        assert 'override_frames' not in mixed


# ---------------------------------------------------------------------------
# Unit tests — Silero→RNNoise frame resolver
# ---------------------------------------------------------------------------

class TestSileroResolver:
    """The 25 ms Silero mask is mapped onto the 10 ms RNNoise frame grid by
    a short vectorised block in main(). These tests verify the mapping rules
    by comparing against a naive Python loop with identical semantics."""

    def test_preroll_frames_default_to_speech(self):
        # Frames k < strip_frames map to negative original time; the
        # resolver must leave them as True (speech) so the gate never
        # touches the warmup region (which is stripped from the output).
        strip_frames = 4
        silero = [True] * 80    # every silero frame says "silence"
        out = _resolver_vec(silero, frame_count=20, strip_frames=strip_frames)
        assert out[:strip_frames].all(), "pre-roll frames must default to True"

    def test_tail_frames_beyond_mask_default_to_speech(self):
        # If frame_count overruns the silero mask (e.g. due to pad/flush),
        # the trailing frames must default to True, not index out of bounds.
        strip_frames = 4
        silero = [True] * 10     # only 10 silero frames (250 ms)
        frame_count = 40         # 400 ms of RNNoise frames
        out = _resolver_vec(silero, frame_count=frame_count, strip_frames=strip_frames)
        # Tail frames (beyond what the silero mask covers) stay True.
        assert out[-5:].all()

    def test_normal_mapping_matches_naive_loop(self):
        # Deterministic seed; exercise a mask with both speech and silence
        # spans plus pre-roll and tail edge cases.
        rng = np.random.RandomState(0)
        silero = (rng.random(120) > 0.7).tolist()
        for strip_frames in (0, 2, 4):
            for frame_count in (50, 200, 350):
                vec = _resolver_vec(silero, frame_count, strip_frames)
                loop = _resolver_loop(silero, frame_count, strip_frames)
                assert np.array_equal(vec, loop), (
                    f"resolver mismatch: strip={strip_frames}, n={frame_count}")

    def test_frame_grid_alignment(self):
        # With strip_frames=4 and silero[0]=False (=speech), frames 4..6
        # (covering t=0..30 ms) should land in silero frame 0 → speech →
        # resolver output False (not-silence == speech, so flipped to True).
        # The resolver returns ~isSilence, so isSilence=False → out=True.
        # Inversely silero[1]=True (=silence) maps to t=25..50 ms → frames
        # 6..8 (with strip=4 that's k=6 onward) should be False.
        strip_frames = 4
        silero = [False, True, False, False]   # 0..25 speech, 25..50 silence
        out = _resolver_vec(silero, frame_count=10, strip_frames=strip_frames)
        # k=4 → t=0 → sf=0 → silero[0]=False → out=True
        assert out[4] is np.True_ or bool(out[4]) is True
        # k=7 → t=30 → sf=1 → silero[1]=True → out=False
        assert bool(out[7]) is False


# ---------------------------------------------------------------------------
# Integration tests — main() / run() end-to-end
# ---------------------------------------------------------------------------

# pyrnnoise carries a C extension; gracefully skip if the build is missing.
pyrnnoise_required = pytest.mark.skipif(
    r._RNNoiseClass is None,
    reason="pyrnnoise unavailable — skipping end-to-end smoke tests",
)


def _synth_voiced_wav(path, sr=PIPELINE_SR, duration_s=2.0):
    """2 s mono float32 WAV: voiced sine burst 0.5–1.5 s + low-level noise."""
    n = int(sr * duration_s)
    t = np.arange(n) / sr
    sig = np.zeros(n, dtype=np.float32)
    burst = slice(int(0.5 * sr), int(1.5 * sr))
    sig[burst] = 0.3 * np.sin(2 * np.pi * 200 * t[burst]).astype(np.float32)
    sig += np.random.RandomState(0).normal(0, 0.005, n).astype(np.float32)
    wavfile.write(str(path), sr, sig)
    return n


def _write_silero_mask(path, duration_s, speech_window_s):
    """Write a Silero-style isSilence sidecar: 25 ms frames, with speech
    flagged inside speech_window_s = (start, end)."""
    n_frames = int(duration_s * 1000 / 25)
    is_silence = [True] * n_frames
    start_f, end_f = (int(speech_window_s[0] * 1000 / 25),
                      int(speech_window_s[1] * 1000 / 25))
    for i in range(start_f, end_f):
        is_silence[i] = False
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'frame_duration_ms': 25, 'isSilence': is_silence}, f)


@pyrnnoise_required
class TestMainSmoke:
    """End-to-end run() invocations against synthesised WAVs."""

    def test_result_dict_shape_with_vad_gate(self, tmp_path):
        in_wav = tmp_path / 'in.wav'
        out_wav = tmp_path / 'out.wav'
        mask = tmp_path / 'mask.json'
        n_in = _synth_voiced_wav(in_wav, duration_s=2.0)
        _write_silero_mask(mask, duration_s=2.0, speech_window_s=(0.5, 1.5))

        res = r.run([
            '--input', str(in_wav), '--output', str(out_wav),
            '--silero-mask', str(mask),
            '--vad-gate',
            '--rnnoise-threshold', '0.3',
            '--crossfade-ms', '1.0',
            '--hangover-frames', '2',
        ])

        # Result dict: cleanup pass removed input_sr / output_sr.
        assert set(res.keys()) == {'model', 'speech_prob_out', 'vad_gate'}
        assert res['model'] == 'RNNoise'
        assert res['speech_prob_out'] is None

        # vad_gate stats: cleanup pass removed override_frames.
        stats = res['vad_gate']
        assert 'override_frames' not in stats
        assert {'overrides', 'raw_overrides', 'total_frames',
                'threshold', 'crossfade_ms', 'hangover_frames',
                'algo_delay_samples'}.issubset(stats.keys())
        assert stats['hangover_frames'] == 2
        assert stats['threshold'] == pytest.approx(0.3)

        # Output preserves input length and sample rate.
        sr_out, out_sig = wavfile.read(str(out_wav))
        assert sr_out == PIPELINE_SR
        assert len(out_sig) == n_in

    def test_speech_prob_sidecar_has_silero_alignment(self, tmp_path):
        in_wav = tmp_path / 'in.wav'
        out_wav = tmp_path / 'out.wav'
        mask = tmp_path / 'mask.json'
        dump = tmp_path / 'dump.json'
        _synth_voiced_wav(in_wav, duration_s=1.0)
        _write_silero_mask(mask, duration_s=1.0, speech_window_s=(0.25, 0.75))

        r.run([
            '--input', str(in_wav), '--output', str(out_wav),
            '--silero-mask', str(mask),
            '--vad-gate',
            '--speech-prob-out', str(dump),
        ])

        with open(dump, encoding='utf-8') as f:
            payload = json.load(f)
        assert payload['frame_duration_ms'] == 10
        assert payload['sample_rate'] == RNNOISE_SR
        # Silero alignment block should be present (mask was supplied).
        assert 'silero_speech_per_rnn_frame' in payload
        assert payload['silero_mask_frame_duration_ms'] == 25
        # Summary should carry the disagreement count produced by the
        # vectorised resolver.
        assert 'disagree_silero_speech_rnnoise_lt_0p30' in payload['summary']

