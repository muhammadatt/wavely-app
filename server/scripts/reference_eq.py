"""
reference_eq.py
referenceEQ — corpus-reference broad tonal correction.

Compares a recording's overall spectral shape against a corpus-derived
reference curve and applies a smooth, broad linear-phase FIR correction that
pushes the recording's tonal balance toward the reference.

This script handles both the spectrum measurement and the FIR application —
unlike the FFmpeg-based EQ stages (correctiveEQ, airBoost, humEQ), a broad
smooth match-curve is the one EQ task where a linear-phase FIR is clearly the
right tool. The Node side (referenceEQ.js) spawns this script and parses the
result JSON, mirroring the corrective_eq.py pattern.

Reference: referenceEQ stage spec v1.0 (docs/instant_polish_reference_eq_spec.md).

Dependencies: numpy, scipy
"""

import argparse
import json
import logging
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import firwin2, fftconvolve

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

# ISO 1/3-octave centre frequencies (25 bands).
THIRD_OCTAVE_CENTERS = np.array([
    63, 80, 100, 125, 160, 200, 250, 315, 400, 500,
    630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000,
    6300, 8000, 10000, 12500, 16000,
], dtype=float)

FRAME_SIZE      = 4096
HOP_SIZE        = 1024
SPEECH_GATE_DB  = 8.0          # speech mask = energy > noise_floor + 8 dB
NORM_BAND_HZ    = (800, 1200)  # spectra normalised to 0 dB at this band's mean
MIN_SPEECH_FRAMES = 40

# Correction shaping.
SCALE_FACTOR    = 0.65         # correct 65% of the measured gap
SMOOTH_OCTAVES  = 0.5          # log-Gaussian smoothing sigma
TAPER_LOW_HZ    = 100 #150          # correction is 0 below this
TAPER_FULL_HZ   = 250 #500          # correction reaches full strength here
SKIP_THRESHOLD_DB = 0.5        # skip the stage if max |correction| is below this

# FIR.
N_TAPS          = 2049         # odd, Type I linear-phase
DENSE_GRID_N    = 512

# Per-region (boost, cut) caps in dB — see spec §B4. The sub-500 Hz boost cap is
# overridable so the Node side can tighten it on the ACX noise-floor retry.
DEFAULT_LF_MAX_BOOST_DB = 4.0


def region_caps(freq_hz, lf_max_boost_db):
    """Return (max_boost_db, max_cut_db) for a 1/3-octave centre frequency."""
    if freq_hz < 500:
        return (lf_max_boost_db, 5.0)
    if freq_hz < 2000:
        return (6.0, 8.0)
    if freq_hz < 6000:
        return (7.0, 9.0)
    if freq_hz < 10000:
        return (5.0, 8.0)
    return (4.0, 10)


# ── Spectrum measurement ──────────────────────────────────────────────────────

def speech_spectrum(audio, sr, noise_floor_db=None):
    """
    Compute a recording's normalised 1/3-octave speech spectrum.

    Frames are classified as speech by an energy gate at noise_floor + 8 dB.
    When noise_floor_db is None (corpus files have no pipeline measurement) the
    10th percentile of per-frame energy is used. The result is normalised to
    0 dB at the mean level of the 800-1200 Hz band, so only tonal *shape* is
    represented — absolute level is irrelevant.

    Returns (levels_db, n_speech_frames) or (None, n_speech_frames) when there
    is too little speech content to measure.
    """
    if len(audio) < FRAME_SIZE:
        return None, 0

    window = np.hanning(FRAME_SIZE).astype(np.float32)
    starts = list(range(0, len(audio) - FRAME_SIZE + 1, HOP_SIZE))

    # First pass — per-frame energy only. Frame slices are not retained, so
    # memory stays flat regardless of file duration.
    frame_energy = np.empty(len(starts))
    for i, s in enumerate(starts):
        frame = audio[s:s + FRAME_SIZE]
        rms   = float(np.sqrt(np.mean(frame.astype(np.float64) ** 2)))
        frame_energy[i] = 20.0 * np.log10(rms + 1e-10)

    if noise_floor_db is None:
        noise_floor_db = float(np.percentile(frame_energy, 10))

    gate        = noise_floor_db + SPEECH_GATE_DB
    speech_mask = frame_energy > gate
    n_speech    = int(np.count_nonzero(speech_mask))
    if n_speech < MIN_SPEECH_FRAMES:
        return None, n_speech

    # Second pass — accumulate the mean power spectrum over speech frames only,
    # re-slicing the audio (NumPy slices are views, not copies).
    freqs = np.fft.rfftfreq(FRAME_SIZE, d=1.0 / sr)
    psd   = np.zeros(len(freqs), dtype=np.float64)
    for s, is_speech in zip(starts, speech_mask):
        if is_speech:
            frame = audio[s:s + FRAME_SIZE]
            mag   = np.abs(np.fft.rfft(frame.astype(np.float64) * window))
            psd  += mag ** 2
    psd /= n_speech

    # Resample to 1/3-octave bands — average power within each band's edges in
    # the linear domain, then convert to dB. Bands with no FFT bins are NaN.
    levels_db = np.full(len(THIRD_OCTAVE_CENTERS), np.nan)
    for i, fc in enumerate(THIRD_OCTAVE_CENTERS):
        lo  = fc / (2 ** (1 / 6))
        hi  = fc * (2 ** (1 / 6))
        sel = (freqs >= lo) & (freqs < hi)
        if np.any(sel):
            levels_db[i] = 10.0 * np.log10(np.mean(psd[sel]) + 1e-20)

    # Normalise to 0 dB at the mean level of the 800-1200 Hz band.
    norm_sel = (THIRD_OCTAVE_CENTERS >= NORM_BAND_HZ[0]) & \
               (THIRD_OCTAVE_CENTERS <= NORM_BAND_HZ[1])
    ref = np.nanmean(levels_db[norm_sel])
    if not np.isfinite(ref):
        return None, n_speech
    return levels_db - ref, n_speech


# ── Correction ────────────────────────────────────────────────────────────────

def log_gaussian_smooth(values, sigma_octaves):
    """Smooth a 1/3-octave dB array with a Gaussian kernel in log-frequency."""
    log_f = np.log2(THIRD_OCTAVE_CENTERS)
    out   = np.empty_like(values)
    for i in range(len(values)):
        w = np.exp(-0.5 * ((log_f - log_f[i]) / sigma_octaves) ** 2)
        out[i] = np.sum(values * w) / np.sum(w)
    return out


def low_freq_taper():
    """Per-band taper factor: 0 below 150 Hz, ramps to 1 by 500 Hz."""
    factor = np.ones(len(THIRD_OCTAVE_CENTERS))
    for i, fc in enumerate(THIRD_OCTAVE_CENTERS):
        if fc < TAPER_LOW_HZ:
            factor[i] = 0.0
        elif fc < TAPER_FULL_HZ:
            factor[i] = (fc - TAPER_LOW_HZ) / (TAPER_FULL_HZ - TAPER_LOW_HZ)
    return factor


def compute_correction(reference_levels, recording_levels, lf_max_boost_db):
    """
    Build the capped, scaled, tapered correction curve (dB per 1/3-octave band).
    Returns (raw_db, smoothed_db, applied_db, centering_offset_db).
    """
    reference_levels = np.asarray(reference_levels, dtype=float)
    recording_levels = np.asarray(recording_levels, dtype=float)

    raw = reference_levels - recording_levels
    raw = np.where(np.isfinite(raw), raw, 0.0)

    smoothed = log_gaussian_smooth(raw, SMOOTH_OCTAVES)

    # Unweighted least-squares centering. The correction's relative shape is
    # independent of any global dB offset (Stage 5 loudness normalisation
    # erases a constant offset anyway), so the offset is free to choose.
    # Subtracting the mean of the actively corrected bands minimises the total
    # squared excursion, which keeps bands away from the per-region caps — no
    # single region is forced to carry the whole correction by moving every
    # other band. The offset is measured only over the fully active bands
    # (taper factor 1.0, i.e. >= 500 Hz); the low-frequency taper region is
    # excluded so its untrusted, soon-to-be-zeroed values do not bias it.
    taper            = low_freq_taper()
    active           = taper >= 1.0
    centering_offset = float(np.mean(smoothed[active]))
    centered         = smoothed - centering_offset

    tapered = centered * taper
    scaled  = tapered * SCALE_FACTOR

    applied = np.empty_like(scaled)
    for i, fc in enumerate(THIRD_OCTAVE_CENTERS):
        max_boost, max_cut = region_caps(fc, lf_max_boost_db)
        applied[i] = float(np.clip(scaled[i], -max_cut, max_boost))

    return raw, smoothed, applied, centering_offset


def build_fir(applied_db, sr):
    """
    Build a linear-phase FIR from the 1/3-octave correction curve.

    firwin2 interpolates linearly in linear-frequency / linear-gain space, so
    the log-spaced 1/3-octave centres cannot be handed to it directly. The dB
    curve is first resampled onto a dense linear-frequency grid by interpolating
    in log-frequency / dB space; edge values extend flat to 0 Hz and Nyquist.
    """
    nyquist  = sr / 2.0
    dense_f  = np.linspace(0.0, nyquist, DENSE_GRID_N)

    log_centers = np.log2(THIRD_OCTAVE_CENTERS)
    log_dense   = np.log2(np.clip(dense_f, 1.0, None))
    # np.interp clamps to endpoint values outside the range — flat extension.
    dense_db    = np.interp(log_dense, log_centers, applied_db)
    dense_gain  = 10.0 ** (dense_db / 20.0)

    fir = firwin2(N_TAPS, dense_f / nyquist, dense_gain, window='hann')
    return fir


# ── ACX analytic LF cap solver ────────────────────────────────────────────────
# Replaces the JS-side apply-and-remeasure retry loop. The FIR's realised
# response is the log-freq / dB interpolation of the per-1/3-octave applied
# curve (see build_fir). Predicting lift from that interpolation against the
# silence-frame noise PSD lets us bisect the sub-500 Hz cap analytically and
# build the FIR exactly once.

def predict_noise_floor_lift_db(applied_db, psd_freq_hz, psd_power):
    """RMS lift in dB the applied curve would impose on a signal with this PSD."""
    log_centers = np.log2(THIRD_OCTAVE_CENTERS)
    log_psd_f   = np.log2(np.clip(psd_freq_hz, 1.0, None))
    psd_db      = np.interp(log_psd_f, log_centers, applied_db)
    gain_sq     = 10.0 ** (psd_db / 10.0)
    power_in    = float(np.sum(psd_power))
    if power_in <= 0:
        return 0.0
    return 10.0 * np.log10(float(np.sum(gain_sq * psd_power)) / power_in)


def solve_acx_lf_cap(reference_levels, recording_levels,
                     lf_max_boost_db_init, headroom_db,
                     psd_freq_hz, psd_power):
    """
    Bisect the sub-500 Hz boost cap so predicted lift ≤ headroom_db.
    Returns (final_cap_db, applied_db, predicted_lift_db, exhausted).
    """
    def lift_at(cap):
        _, _, ap, _ = compute_correction(reference_levels, recording_levels, cap)
        return predict_noise_floor_lift_db(ap, psd_freq_hz, psd_power), ap

    base_lift, base_applied = lift_at(lf_max_boost_db_init)
    if base_lift <= headroom_db:
        return lf_max_boost_db_init, base_applied, base_lift, False

    floor_lift, floor_applied = lift_at(0.0)
    if floor_lift > headroom_db:
        # Even with the LF boost fully capped at 0 dB the non-LF correction
        # alone predicts over-headroom lift — surface this to the caller.
        return 0.0, floor_applied, floor_lift, True

    lo, hi = 0.0, lf_max_boost_db_init
    for _ in range(14):
        mid = (lo + hi) / 2
        lift, _ = lift_at(mid)
        if lift > headroom_db:
            hi = mid
        else:
            lo = mid
    final_lift, final_applied = lift_at(lo)
    return lo, final_applied, final_lift, False


# ── Main ──────────────────────────────────────────────────────────────────────

def apply_reference_eq(audio, sr, reference_levels, noise_floor_db, lf_max_boost_db,
                       acx_target_noise_floor_db=None, noise_psd=None):
    recording_levels, n_speech = speech_spectrum(audio, sr, noise_floor_db)
    if recording_levels is None:
        return {
            'stage':   'referenceEQ',
            'status':  'skipped',
            'applied': False,
            'reason':  f'insufficient speech content ({n_speech} frames)',
        }, None

    raw, smoothed, applied, centering_offset = compute_correction(
        reference_levels, recording_levels, lf_max_boost_db,
    )

    # ACX analytic LF cap backoff. The JS-side ACX retry loop is replaced by a
    # single closed-form solve here when both --acx-target-noise-floor-db and
    # --noise-psd-json are supplied (pre-EQ noise floor comes from --noise-floor).
    acx_backoff = None
    if (acx_target_noise_floor_db is not None
            and noise_floor_db is not None
            and noise_psd is not None):
        headroom_db = acx_target_noise_floor_db - noise_floor_db
        final_cap, applied, predicted_lift_db, exhausted = solve_acx_lf_cap(
            reference_levels, recording_levels, lf_max_boost_db, headroom_db,
            noise_psd['freq_hz'], noise_psd['power'],
        )
        acx_backoff = {
            'requested_lf_max_boost_db': round(float(lf_max_boost_db), 3),
            'applied_lf_max_boost_db':   round(float(final_cap), 3),
            'predicted_lift_db':         round(float(predicted_lift_db), 3),
            'headroom_db':               round(float(headroom_db), 3),
            'psd_source':                noise_psd.get('source', 'measured'),
            'exhausted':                 bool(exhausted),
        }
        lf_max_boost_db = final_cap

        # solve_acx_lf_cap returns the post-backoff `applied` curve but the
        # initial compute_correction call above also produced `raw`, `smoothed`,
        # and `centering_offset` at the pre-backoff cap. Recompute the full
        # correction at the final cap so all four diagnostics stay consistent
        # with the FIR that's about to be built.
        raw, smoothed, applied, centering_offset = compute_correction(
            reference_levels, recording_levels, lf_max_boost_db,
        )

    max_correction = float(np.max(np.abs(applied)))

    if max_correction < SKIP_THRESHOLD_DB:
        return {
            'stage':             'referenceEQ',
            'status':            'skipped',
            'applied':           False,
            'reason':            f'max correction {max_correction:.2f} dB '
                                 f'below {SKIP_THRESHOLD_DB} dB threshold',
            'max_correction_db': round(max_correction, 3),
        }, None

    fir       = build_fir(applied, sr)
    corrected = fftconvolve(audio.astype(np.float64), fir, mode='same')

    # Did the correction boost any sub-500 Hz band? (Drives the ACX retry.)
    lf_boost = bool(np.any(
        (THIRD_OCTAVE_CENTERS < TAPER_FULL_HZ) & (applied > 0.01)
    ))

    result = {
        'stage':             'referenceEQ',
        'status':            'applied',
        'applied':           True,
        'n_speech_frames':   n_speech,
        'max_correction_db':  round(max_correction, 3),
        'centering_offset_db': round(centering_offset, 3),
        'lf_boost_applied':   lf_boost,
        'lf_max_boost_db':    round(lf_max_boost_db, 3),
        'fir_taps':           N_TAPS,
        'correction_curve': {
            'frequencies_hz': THIRD_OCTAVE_CENTERS.tolist(),
            'raw_db':         [round(float(v), 3) for v in raw],
            'smoothed_db':    [round(float(v), 3) for v in smoothed],
            'applied_db':     [round(float(v), 3) for v in applied],
        },
        'recording_spectrum_db': [
            None if not np.isfinite(v) else round(float(v), 3)
            for v in recording_levels
        ],
        'reference_spectrum_db': [
            None if not np.isfinite(v) else round(float(v), 3)
            for v in reference_levels
        ],
    }
    if acx_backoff is not None:
        result['acx_backoff'] = acx_backoff
    return result, corrected.astype(np.float32)


def _load_audio(path):
    sr, audio = wavfile.read(path)
    if np.issubdtype(audio.dtype, np.integer):
        audio = audio.astype(np.float32) / np.iinfo(audio.dtype).max
    else:
        audio = audio.astype(np.float32)
    if audio.ndim > 1:  # defensive — pipeline audio is mono by this stage
        audio = audio.mean(axis=1)
    return sr, audio


def main(argv=None):
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(message)s')
    parser = argparse.ArgumentParser(description='referenceEQ broad tonal correction')
    parser.add_argument('--input',       required=True, help='Input WAV (float32, 44.1 kHz, mono)')
    parser.add_argument('--output',      required=True, help='Output WAV path')
    parser.add_argument('--result-json', required=True, help='Result JSON path')
    parser.add_argument('--curve',       required=True, help='Reference curve JSON path')
    parser.add_argument('--noise-floor', type=float, default=None,
                        help='Canonical pipeline noise floor (dBFS) for the speech gate')
    parser.add_argument('--lf-max-boost-db', type=float, default=DEFAULT_LF_MAX_BOOST_DB,
                        help='Sub-500 Hz boost cap (dB) — starting cap for the analytic ACX backoff')
    parser.add_argument('--noise-psd-json', type=str, default=None,
                        help='Path to PSD JSON ({freq_hz, power, source}) for the analytic ACX backoff')
    parser.add_argument('--acx-target-noise-floor-db', type=float, default=None,
                        help='ACX post-EQ noise-floor ceiling (dBFS); enables analytic LF cap solve')
    args = parser.parse_args(argv)

    with open(args.curve) as fh:
        curve = json.load(fh)
    curve_freqs  = np.asarray(curve['frequencies_hz'], dtype=float)
    curve_levels = np.asarray(curve['levels_db'], dtype=float)
    if not np.array_equal(curve_freqs, THIRD_OCTAVE_CENTERS):
        # Curve grid must match this script's band centres exactly.
        curve_levels = np.interp(
            np.log2(THIRD_OCTAVE_CENTERS), np.log2(curve_freqs), curve_levels,
        )

    noise_psd = None
    if args.noise_psd_json is not None:
        with open(args.noise_psd_json) as fh:
            psd_raw = json.load(fh)
        noise_psd = {
            'freq_hz': np.asarray(psd_raw['freq_hz'], dtype=float),
            'power':   np.asarray(psd_raw['power'],   dtype=float),
            'source':  psd_raw.get('source', 'measured'),
        }

    sr, audio = _load_audio(args.input)
    result, corrected = apply_reference_eq(
        audio, sr, curve_levels, args.noise_floor,
        min(args.lf_max_boost_db, DEFAULT_LF_MAX_BOOST_DB),
        acx_target_noise_floor_db=args.acx_target_noise_floor_db,
        noise_psd=noise_psd,
    )

    result['reference_corpus_version'] = curve.get('corpus_version')
    result['reference_spec_version']   = curve.get('spec_version')
    result['n_corpus_files']           = curve.get('n_corpus_files')

    if corrected is not None:
        wavfile.write(args.output, sr, corrected)

    with open(args.result_json, 'w') as fh:
        json.dump(result, fh)

    print(
        f"referenceEQ: status={result['status']} "
        f"max_correction={result.get('max_correction_db', 0)} dB",
        flush=True,
    )

    return {
        'status': result['status'],
        'max_correction_db': result.get('max_correction_db', 0),
    }


def run(argv):
    """Entry point used by the persistent worker (_worker.py)."""
    return main(argv)


if __name__ == '__main__':
    main()
