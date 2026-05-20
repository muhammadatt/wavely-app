"""
Re-fit the airBoost BANDS gRef parameters against the Maag EQ4 hardware
measurement (Air Band, 10 kHz corner, knob=10).

The optimiser holds the band topology fixed — 5 peaking bells at 600 / 1200 /
2400 / 4800 / 9600 Hz (Q=0.5) plus 1 high shelf at 14000 Hz (3.023 oct) —
and solves for the 6 gRef values that minimise log-frequency RMS error
between the realised FFmpeg-biquad response and the Maag target, evaluated
at the reference plateau gain (12.5932 dB).

Outputs a fit report on stdout. The new gRef values are PROPOSED — they
are not written back to airBoost.js or air_boost_precut.py automatically.

Dependencies: numpy, scipy
"""
from __future__ import annotations

import numpy as np
from scipy.optimize import least_squares

from air_boost_precut import (
    BANDS,
    REFERENCE_PLATEAU_DB,
    SR_FOR_TF,
    _peaking_response_db,
    _highshelf_response_db,
)

# ── Canonical Maag data — Air Band, 10 kHz corner, knob = 10 ─────────────────
#
# X = frequency (Hz), Y = RMS level (dBu). The Maag's full-scale plateau lift
# (high-frequency asymptote minus low-frequency baseline) is what airBoost
# treats as REFERENCE_PLATEAU_DB.

MAAG_KNOB10 = np.array([
    (    4.95,  -1.33), (    5.83,  -0.28), (    6.80,   0.96), (    8.38,   2.25),
    (   10.91,   3.26), (   14.73,   3.82), (   19.35,   3.87), (   27.59,   3.83),
    (   36.92,   3.92), (   50.31,   3.84), (   67.32,   3.69), (   94.27,   3.77),
    (  132.01,   3.94), (  173.46,   3.91), (  217.77,   3.91), (  283.55,   3.91),
    (  375.96,   4.00), (  476.29,   4.16), (  592.51,   4.37), (  778.41,   4.69),
    ( 1041.38,   5.10), ( 1271.97,   5.54), ( 1539.38,   6.23), ( 1863.04,   6.87),
    ( 2213.84,   7.76), ( 2606.95,   8.56), ( 3069.82,   9.41), ( 3614.80,  10.29),
    ( 4295.37,  11.22), ( 5150.54,  12.22), ( 6176.31,  13.11), ( 7542.70,  13.91),
    ( 9211.54,  14.68), (11353.50,  15.24), (14645.01,  15.81), (18892.50,  16.17),
    (24373.67,  16.38), (30599.80,  16.46), (40206.36,  16.47), (48677.66,  16.31),
    (57871.87,  16.11), (68179.34,  15.91), (80327.06,  15.60),
])
MAAG_F  = MAAG_KNOB10[:, 0]
MAAG_DB = MAAG_KNOB10[:, 1]

# Baseline = median in 50–500 Hz (the flat passband region).
# Plateau  = median in 29 k–40 kHz (the flat HF asymptote region).
_baseline_mask = (MAAG_F >= 50.0)   & (MAAG_F <=   500.0)
_plateau_mask  = (MAAG_F >= 29000.0) & (MAAG_F <= 40000.0)
BASELINE_DBU = float(np.median(MAAG_DB[_baseline_mask]))
PLATEAU_DBU  = float(np.median(MAAG_DB[_plateau_mask]))
MEASURED_LIFT_DB = PLATEAU_DBU - BASELINE_DBU   # ~12.56 dB → REFERENCE_PLATEAU_DB

# Maag lift curve = level − baseline, then rescale so its asymptotic plateau
# equals exactly REFERENCE_PLATEAU_DB. This is the curve the realised biquad
# chain at gain = REFERENCE_PLATEAU_DB must approximate.
_lift_db = (MAAG_DB - BASELINE_DBU) * (REFERENCE_PLATEAU_DB / MEASURED_LIFT_DB)


def maag_target_db(freq_hz: np.ndarray) -> np.ndarray:
    """Interpolate the rescaled Maag lift curve on a log-frequency axis."""
    return np.interp(np.log(freq_hz), np.log(MAAG_F), _lift_db)


# ── Forward model ────────────────────────────────────────────────────────────

def realised_response_db(freq_hz: np.ndarray, gref_values: np.ndarray) -> np.ndarray:
    """Sum the FFmpeg-equivalent biquad responses for a candidate gRef vector."""
    total = np.zeros_like(freq_hz)
    for (f0, kind, width, _), g in zip(BANDS, gref_values):
        if kind == 'bell':
            total += _peaking_response_db(freq_hz, f0, width, g, SR_FOR_TF)
        else:
            total += _highshelf_response_db(freq_hz, f0, width, g, SR_FOR_TF)
    return total


# ── Fit ──────────────────────────────────────────────────────────────────────

# Evaluate the fit on a log-spaced grid spanning the audible band. The Maag
# data extends to 80 kHz but the pipeline runs at 44.1 kHz so any energy
# above ~20 kHz is irrelevant (and unrealisable through these biquads).
FIT_F_LO = 100.0
FIT_F_HI = 20000.0
FIT_GRID = np.geomspace(FIT_F_LO, FIT_F_HI, 256)
TARGET   = maag_target_db(FIT_GRID)


def residuals(gref_values: np.ndarray) -> np.ndarray:
    return realised_response_db(FIT_GRID, gref_values) - TARGET


x0 = np.array([band[3] for band in BANDS], dtype=float)
result = least_squares(residuals, x0, method='lm', xtol=1e-10, ftol=1e-10)
x_fit = result.x

# ── Report ───────────────────────────────────────────────────────────────────

old_response = realised_response_db(FIT_GRID, x0)
new_response = realised_response_db(FIT_GRID, x_fit)
old_rms = float(np.sqrt(np.mean((old_response - TARGET) ** 2)))
new_rms = float(np.sqrt(np.mean((new_response - TARGET) ** 2)))
old_max = float(np.max(np.abs(old_response - TARGET)))
new_max = float(np.max(np.abs(new_response - TARGET)))

print('Maag EQ4 Air Band — knob=10 reference data')
print(f'  baseline  : {BASELINE_DBU:+7.3f} dBu  (median 50–500 Hz)')
print(f'  plateau   : {PLATEAU_DBU:+7.3f} dBu  (median 29k–40k Hz)')
print(f'  lift      : {MEASURED_LIFT_DB:+7.3f} dB   (REFERENCE_PLATEAU_DB = {REFERENCE_PLATEAU_DB:.4f})')
print()
print(f'Fit grid  : {FIT_F_LO:.0f} Hz – {FIT_F_HI:.0f} Hz log-spaced, 256 points')
print(f'Fit status: {result.message}  (cost={result.cost:.4f})')
print()
print(f'  RMS error    old: {old_rms:6.3f} dB    new: {new_rms:6.3f} dB')
print(f'  max |error|  old: {old_max:6.3f} dB    new: {new_max:6.3f} dB')
print()

print('Band-by-band gRef (at REFERENCE_PLATEAU_DB):')
print(f'  {"freq Hz":>8}  {"type":<6}  {"width":>6}  {"old gRef":>10}  {"new gRef":>10}  {"delta":>8}')
for (f0, kind, width, _), g_old, g_new in zip(BANDS, x0, x_fit):
    print(f'  {f0:8.0f}  {kind:<6}  {width:6.3f}  {g_old:+10.5f}  {g_new:+10.5f}  {g_new-g_old:+8.5f}')
print()

# Spot check at the airBoost.js verification probe points (18 dB request).
PROBES = np.array([1870.0, 5556.0, 13610.0])
maag_at_18 = maag_target_db(PROBES) * (18.0 / REFERENCE_PLATEAU_DB)
old_at_18  = realised_response_db(PROBES, x0  * (18.0 / REFERENCE_PLATEAU_DB))
new_at_18  = realised_response_db(PROBES, x_fit * (18.0 / REFERENCE_PLATEAU_DB))
print('Verification probes at air_boost_db = 18:')
print(f'  {"freq Hz":>8}  {"Maag":>8}  {"old":>8}  {"new":>8}  {"old err":>9}  {"new err":>9}')
for f, m, o, n in zip(PROBES, maag_at_18, old_at_18, new_at_18):
    print(f'  {f:8.0f}  {m:+8.3f}  {o:+8.3f}  {n:+8.3f}  {o-m:+9.3f}  {n-m:+9.3f}')
print()

# Coarse 1/3-octave audit across the audible band.
AUDIT = np.array([100, 200, 400, 800, 1250, 1600, 2000, 2500, 3150,
                  4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000.0])
tgt = maag_target_db(AUDIT)
old = realised_response_db(AUDIT, x0)
new = realised_response_db(AUDIT, x_fit)
print('Audible-band audit (at REFERENCE_PLATEAU_DB):')
print(f'  {"freq Hz":>8}  {"Maag":>8}  {"old":>8}  {"new":>8}  {"old err":>9}  {"new err":>9}')
for f, t, o, n in zip(AUDIT, tgt, old, new):
    print(f'  {f:8.0f}  {t:+8.3f}  {o:+8.3f}  {n:+8.3f}  {o-t:+9.3f}  {n-t:+9.3f}')
