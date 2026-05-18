"""
wavely_ar_utils.py
Shared autoregressive (AR) modelling utilities for Wavely audio stages.

Burg-method AR coefficient estimation and forward prediction. Extracted from
click_remover.py so that throat_click_attenuator.py can reuse the same model
fitting without duplicating the implementation.

  click_remover.py            — burg_ar_coeffs + ar_forward_predict, for
                                 forward/backward AR interpolation of clicks.
  throat_click_attenuator.py  — burg_ar_coeffs + ar_forward_predict, for
                                 prediction-error measurement only.
"""

import numpy as np


def burg_ar_coeffs(x, order):
    """
    Estimate AR model coefficients using the Burg method.
    x     : 1-D float64 array of clean signal samples
    order : AR model order
    Returns 1-D array of AR coefficients [a1, a2, ..., a_order].
    """
    n = len(x)
    if n <= order:
        raise ValueError(f"Context length ({n}) must exceed AR order ({order})")

    ef = x.copy().astype(np.float64)
    eb = x.copy().astype(np.float64)
    a  = np.zeros(order, dtype=np.float64)

    for m in range(order):
        num = -2.0 * np.dot(ef[m + 1:], eb[m : n - 1])
        den = (np.dot(ef[m + 1:], ef[m + 1:])
               + np.dot(eb[m : n - 1], eb[m : n - 1]))
        if den < 1e-12:
            break
        km = num / den

        a_new      = a.copy()
        a_new[m]   = km
        if m > 0:
            a_new[:m] = a[:m] + km * a[m - 1 :: -1]
        a = a_new

        ef_new = ef[m + 1:] + km * eb[m : n - 1]
        eb_new = eb[m : n - 1] + km * ef[m + 1:]

        ef[m + 1:] = ef_new
        eb[m + 1:] = eb_new

    return a


def ar_forward_predict(context, ar_coeffs, n_samples, max_val=None):
    """
    Run AR model forward for n_samples using context as the initial buffer.
    Returns predicted signal array of length n_samples.

    Used by click_remover.py for interpolation (combined with backward
    prediction and crossfade) and by throat_click_attenuator.py for
    prediction error measurement only.

    max_val : Optional safety clip. Pass the context amplitude envelope
              maximum when used for interpolation. Not needed for error
              measurement.
    """
    order = len(ar_coeffs)
    buf = list(context[-order:])
    out = np.zeros(n_samples, dtype=np.float64)
    for i in range(n_samples):
        pred = -np.dot(ar_coeffs, buf[-order:][::-1])
        if max_val is not None:
            pred = np.clip(pred, -max_val, max_val)
        out[i] = pred
        buf.append(pred)
    return out
