"""
air_boost_precut.py
Predictive pre-attenuation sizing for the airBoost stage.

Reads the current audio, measures its 1/3-octave speech spectrum, predicts the
post-airBoost magnitude spectrum analytically (using the same Maag-model
BANDS table that airBoost.js applies), and — when the prediction exceeds the
preset's referenceEQ target curve in the 6-16 kHz region — sizes a single
parametric bell cut that brings the predicted excess down to target.

The cut is returned as { center_hz, q, gain_db }. When the raw excess would
exceed the configured maxCutDb, the script additionally returns a
gain_db_reduction value: the amount by which the Node side should reduce the
airBoost gain so the residual excess fits inside the clamp.

The BANDS table and REFERENCE_PLATEAU_DB constant are duplicated from
server/pipeline/airBoost.js — both are version-tagged
(maag_eq4_approximation_v2) and stable. A sanity check at module load
asserts the analytic transfer function reproduces the verification values
in the airBoost.js header.

Dependencies: numpy, scipy
"""

import argparse
import json
import logging
import sys

import numpy as np

# Reuse the speech-gated 1/3-octave spectrum measurement from referenceEQ so
# both stages compare against the reference curve on identical bins with
# identical normalisation.
from reference_eq import (
    THIRD_OCTAVE_CENTERS,
    speech_spectrum,
    _load_audio,
)

logger = logging.getLogger(__name__)

# ── airBoost model — must match server/pipeline/airBoost.js ───────────────────

REFERENCE_PLATEAU_DB = 12.5932

# (freqHz, type, q_or_width_oct, gRef_db)
BANDS = [
    (  600.0, 'bell',  0.5,    -0.02733),
    ( 1200.0, 'bell',  0.5,    -0.30754),
    ( 2400.0, 'bell',  0.5,    -1.18676),
    ( 4800.0, 'bell',  0.5,    -0.90883),
    ( 9600.0, 'bell',  0.5,    +0.91883),
    (14000.0, 'shelf', 3.023, +22.54678),
]

MODEL_NAME = 'maag_eq4_approximation_v2'
SR_FOR_TF  = 44100.0      # pipeline runs at 44.1 kHz throughout

# Region of interest for the pre-cut: the 1/3-octave bins from 6.3 kHz upward.
# Below 6 kHz the airBoost lift is mild and rarely causes harshness even on
# bright recordings. Above 16 kHz we have no measurement.
PRECUT_BAND_LO_HZ = 6000.0
PRECUT_BAND_HI_HZ = 16000.0

DEFAULT_MAX_CUT_DB    = 6.0
DEFAULT_MIN_EXCESS_DB = 1.0
Q_CLAMP_MIN = 0.5
Q_CLAMP_MAX = 4.0
DEFAULT_Q   = 1.0


# ── Biquad transfer function (RBJ cookbook, FFmpeg-compatible) ────────────────
#
# Reproduces FFmpeg's `equalizer` (peaking) and `highshelf` filters when called
# with the same width_type/value pair the airBoost stage uses.
#   peaking, width_type='q': alpha = sin(w0) / (2*Q)
#   shelf,   width_type='o': alpha = sin(w0) * sinh(ln(2)/2 * width * w0/sin(w0))
#
# The shelving coefficients are the RBJ form FFmpeg implements internally.

def _peaking_response_db(freq_hz, f0_hz, q, gain_db, sr):
    if gain_db == 0.0:
        return np.zeros_like(freq_hz)
    w0    = 2.0 * np.pi * f0_hz / sr
    cw0   = np.cos(w0)
    sw0   = np.sin(w0)
    A     = 10.0 ** (gain_db / 40.0)
    alpha = sw0 / (2.0 * q)

    b0 = 1.0 + alpha * A
    b1 = -2.0 * cw0
    b2 = 1.0 - alpha * A
    a0 = 1.0 + alpha / A
    a1 = -2.0 * cw0
    a2 = 1.0 - alpha / A

    return _biquad_magnitude_db(b0, b1, b2, a0, a1, a2, freq_hz, sr)


def _highshelf_response_db(freq_hz, f0_hz, width_oct, gain_db, sr):
    if gain_db == 0.0:
        return np.zeros_like(freq_hz)
    w0   = 2.0 * np.pi * f0_hz / sr
    cw0  = np.cos(w0)
    sw0  = np.sin(w0)
    A    = 10.0 ** (gain_db / 40.0)
    sA   = np.sqrt(A)
    # FFmpeg's octave-width conversion for biquad shelves.
    alpha = sw0 * np.sinh(np.log(2.0) / 2.0 * width_oct * w0 / sw0)

    b0 =      A * ((A + 1) + (A - 1) * cw0 + 2 * sA * alpha)
    b1 = -2 * A * ((A - 1) + (A + 1) * cw0)
    b2 =      A * ((A + 1) + (A - 1) * cw0 - 2 * sA * alpha)
    a0 =          (A + 1) - (A - 1) * cw0 + 2 * sA * alpha
    a1 =      2 * ((A - 1) - (A + 1) * cw0)
    a2 =          (A + 1) - (A - 1) * cw0 - 2 * sA * alpha

    return _biquad_magnitude_db(b0, b1, b2, a0, a1, a2, freq_hz, sr)


def _biquad_magnitude_db(b0, b1, b2, a0, a1, a2, freq_hz, sr):
    w   = 2.0 * np.pi * freq_hz / sr
    ejw  = np.exp(-1j * w)
    ej2w = np.exp(-2j * w)
    num  = b0 + b1 * ejw + b2 * ej2w
    den  = a0 + a1 * ejw + a2 * ej2w
    return 20.0 * np.log10(np.abs(num / den) + 1e-20)


def air_boost_response_db(freq_hz, air_boost_db):
    """Sum the Maag-model band responses at `air_boost_db` request gain."""
    freq_hz = np.asarray(freq_hz, dtype=float)
    if air_boost_db <= 0:
        return np.zeros_like(freq_hz)
    scale = air_boost_db / REFERENCE_PLATEAU_DB
    total = np.zeros_like(freq_hz)
    for f0, kind, width, gref in BANDS:
        g = gref * scale
        if kind == 'bell':
            total += _peaking_response_db(freq_hz, f0, width, g, SR_FOR_TF)
        else:
            total += _highshelf_response_db(freq_hz, f0, width, g, SR_FOR_TF)
    return total


def _sanity_check_transfer_function():
    """
    Drift detector for the JS↔Python copies of BANDS.

    The expected values are the response of the current BANDS table — realised
    through the FFmpeg-equivalent RBJ biquads in this module — at three probe
    frequencies when air_boost_db=18:
      1870 Hz  → +4.56 dB
      5556 Hz  → +12.05 dB
      13610 Hz → +16.63 dB
    Verified empirically by running the same filter chain through FFmpeg
    (impulse → equalizer/highshelf chain → FFT). If either copy of BANDS is
    edited without updating the other this check will fire.
    """
    check = air_boost_response_db([1870.0, 5556.0, 13610.0], 18.0)
    expected = np.array([4.56, 12.05, 16.63])
    err = np.abs(check - expected)
    if np.any(err > 0.15):
        raise RuntimeError(
            f"airBoost transfer function disagrees with airBoost.js verification "
            f"values at 18 dB: got {check.tolist()}, expected {expected.tolist()} "
            f"(max error {float(err.max()):.3f} dB). "
            f"BANDS constants in air_boost_precut.py and airBoost.js are out of sync."
        )


_sanity_check_transfer_function()


# ── Cut sizing ────────────────────────────────────────────────────────────────

def _interp_log_freq_crossing(f_lo, f_hi, v_lo, v_hi, target):
    """Linear interp in log-frequency to find the f where v crosses target."""
    if v_hi == v_lo:
        return f_lo
    t = (target - v_lo) / (v_hi - v_lo)
    return float(np.exp(np.log(f_lo) + t * (np.log(f_hi) - np.log(f_lo))))


def _fwhm_q(bins_hz, excess_db, peak_idx):
    """
    Derive a parametric-EQ Q from the full-width-half-maximum of the excess
    curve in log-frequency. Returns DEFAULT_Q if the FWHM can't be measured
    (excess monotonic to an edge of the measurement region).
    """
    peak_val = excess_db[peak_idx]
    half = peak_val / 2.0

    lo_freq = None
    for i in range(peak_idx, 0, -1):
        if excess_db[i - 1] < half <= excess_db[i]:
            lo_freq = _interp_log_freq_crossing(
                bins_hz[i - 1], bins_hz[i], excess_db[i - 1], excess_db[i], half,
            )
            break

    hi_freq = None
    for i in range(peak_idx, len(bins_hz) - 1):
        if excess_db[i] >= half > excess_db[i + 1]:
            hi_freq = _interp_log_freq_crossing(
                bins_hz[i], bins_hz[i + 1], excess_db[i], excess_db[i + 1], half,
            )
            break

    if lo_freq is None or hi_freq is None:
        return DEFAULT_Q

    bw_oct = float(np.log2(hi_freq / lo_freq))
    if bw_oct <= 0:
        return DEFAULT_Q
    q = 1.0 / (2.0 * np.sinh(np.log(2.0) / 2.0 * bw_oct))
    return float(np.clip(q, Q_CLAMP_MIN, Q_CLAMP_MAX))


def size_precut(measured_db, reference_db, air_boost_db, max_cut_db, min_excess_db):
    """
    Decide whether a pre-cut is warranted and, if so, return its parameters.

    Returns one of:
      { 'applied': True, center_hz, q, gain_db, gain_db_reduction,
        excess_curve_db, excess_curve_freqs_hz, ... }
      { 'applied': False, 'reason': str, ... }
    """
    # Restrict to the 6-16 kHz region of interest.
    region_mask = (
        (THIRD_OCTAVE_CENTERS >= PRECUT_BAND_LO_HZ)
        & (THIRD_OCTAVE_CENTERS <= PRECUT_BAND_HI_HZ)
    )
    region_freqs    = THIRD_OCTAVE_CENTERS[region_mask]
    region_measured = measured_db[region_mask]
    region_ref      = reference_db[region_mask]

    # Drop bins where either side is non-finite.
    valid = np.isfinite(region_measured) & np.isfinite(region_ref)
    if not np.any(valid):
        return {'applied': False, 'reason': 'no_valid_region_bins'}
    region_freqs    = region_freqs[valid]
    region_measured = region_measured[valid]
    region_ref      = region_ref[valid]

    boost_response = air_boost_response_db(region_freqs, air_boost_db)
    predicted_db   = region_measured + boost_response
    raw_excess     = predicted_db - region_ref
    excess_db      = np.maximum(raw_excess, 0.0)

    peak_idx = int(np.argmax(excess_db))
    peak_val = float(excess_db[peak_idx])

    excess_payload = {
        'excess_curve_db':       [round(float(v), 3) for v in excess_db],
        'excess_curve_freqs_hz': [int(f) for f in region_freqs],
        'predicted_db':          [round(float(v), 3) for v in predicted_db],
        'reference_db':          [round(float(v), 3) for v in region_ref],
        'measured_db':           [round(float(v), 3) for v in region_measured],
        'air_boost_response_db': [round(float(v), 3) for v in boost_response],
    }

    if peak_val < min_excess_db:
        return {
            'applied': False,
            'reason':  'below_dead_zone',
            'peak_excess_db': peak_val,
            **excess_payload,
        }

    # Decide whether to reduce airBoost gain so residual excess fits in the
    # clamp. excess(f, g) = baseline(f) + g * weight(f), linear in g.
    baseline   = region_measured - region_ref
    weight     = boost_response / max(air_boost_db, 1e-9)   # per-dB gain weight
    pos_weight = weight > 0
    if peak_val > max_cut_db and np.any(pos_weight):
        # Smallest g for which every bin's excess <= max_cut_db.
        max_g_candidates = (max_cut_db - baseline[pos_weight]) / weight[pos_weight]
        max_g_candidates = max_g_candidates[max_g_candidates > 0]
        if len(max_g_candidates):
            g_new = float(min(air_boost_db, np.min(max_g_candidates)))
        else:
            g_new = 0.0
        gain_db_reduction = max(0.0, air_boost_db - g_new)
        # Recompute excess curve at the reduced gain for downstream sizing.
        boost_response_new = air_boost_response_db(region_freqs, g_new)
        predicted_new      = region_measured + boost_response_new
        excess_new         = np.maximum(predicted_new - region_ref, 0.0)
        peak_idx           = int(np.argmax(excess_new))
        peak_val_new       = float(excess_new[peak_idx])
        cut_gain_db        = -min(peak_val_new, max_cut_db)
        q                  = _fwhm_q(region_freqs, excess_new, peak_idx)
    else:
        gain_db_reduction = 0.0
        cut_gain_db       = -peak_val
        q                 = _fwhm_q(region_freqs, excess_db, peak_idx)

    return {
        'applied':           True,
        'center_hz':         int(region_freqs[peak_idx]),
        'q':                 round(q, 3),
        'gain_db':           round(cut_gain_db, 3),
        'gain_db_reduction': round(gain_db_reduction, 4),
        'peak_excess_db':    round(peak_val, 3),
        **excess_payload,
    }


# ── Entry point ───────────────────────────────────────────────────────────────

def analyze_precut(audio, sr, reference_levels, noise_floor_db, air_boost_db,
                   max_cut_db, min_excess_db):
    measured_db, n_speech = speech_spectrum(audio, sr, noise_floor_db)
    if measured_db is None:
        return {
            'applied':         False,
            'reason':          'insufficient_speech',
            'n_speech_frames': n_speech,
        }
    out = size_precut(
        measured_db, reference_levels, air_boost_db, max_cut_db, min_excess_db,
    )
    out['n_speech_frames'] = n_speech
    return out


def main(argv=None):
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(message)s')
    parser = argparse.ArgumentParser(description='airBoost predictive pre-attenuation')
    parser.add_argument('--input',         required=True, help='Input WAV (float32, 44.1 kHz, mono)')
    parser.add_argument('--result-json',   required=True, help='Result JSON path')
    parser.add_argument('--curve',         required=True, help='Reference curve JSON path')
    parser.add_argument('--air-boost-db',  required=True, type=float)
    parser.add_argument('--max-cut-db',    type=float, default=DEFAULT_MAX_CUT_DB)
    parser.add_argument('--min-excess-db', type=float, default=DEFAULT_MIN_EXCESS_DB)
    parser.add_argument('--noise-floor',   type=float, default=None,
                        help='Canonical pipeline noise floor (dBFS) for the speech gate')
    args = parser.parse_args(argv)

    with open(args.curve) as fh:
        curve = json.load(fh)
    curve_freqs  = np.asarray(curve['frequencies_hz'], dtype=float)
    curve_levels = np.asarray(curve['levels_db'], dtype=float)
    if not np.array_equal(curve_freqs, THIRD_OCTAVE_CENTERS):
        curve_levels = np.interp(
            np.log2(THIRD_OCTAVE_CENTERS), np.log2(curve_freqs), curve_levels,
        )

    sr, audio = _load_audio(args.input)
    result = analyze_precut(
        audio, sr, curve_levels, args.noise_floor,
        args.air_boost_db, args.max_cut_db, args.min_excess_db,
    )
    result['reference_corpus_version'] = curve.get('corpus_version')
    result['reference_spec_version']   = curve.get('spec_version')
    result['requested_air_boost_db']   = args.air_boost_db
    result['model']                    = MODEL_NAME

    with open(args.result_json, 'w') as fh:
        json.dump(result, fh)

    if result.get('applied'):
        print(
            f"airBoostPrecut: cut={result['gain_db']:+.2f} dB @ {result['center_hz']} Hz "
            f"Q={result['q']:.2f} reduction={result['gain_db_reduction']:.3f} dB",
            flush=True,
        )
    else:
        print(f"airBoostPrecut: skipped — {result.get('reason')}", flush=True)

    return {
        'applied': result.get('applied', False),
        'gain_db': result.get('gain_db'),
    }


def run(argv):
    """Entry point used by the persistent worker (_worker.py)."""
    return main(argv)


if __name__ == '__main__':
    main()
