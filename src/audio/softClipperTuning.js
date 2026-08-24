/**
 * ADMIN TUNING PANEL: the Soft Clipper's research controls, hidden behind a
 * flag so a half-finished tuning session cannot reach a user.
 *
 *   ?softClipperTuning=1                          one page load
 *   localStorage.setItem('softClipperTuning','1') until cleared
 *   ?driveTuning=1                                the original key, still read
 *
 * WHAT IS BEHIND IT, and why each one is there rather than on the faceplate:
 *
 *   Limiter        how the peak control is split between the lookahead limiter
 *                  and the curve. ⚠ It CHANGES THE STAGE'S LATENCY while
 *                  engaged (50 samples -> 242), which is why it is a research
 *                  control rather than something a user turns under a running
 *                  timeline.
 *   Knee           EARLY / MID / LATE. Depth-matched at SHAPE_ANCHOR_DB, so it
 *                  moves character rather than amount — and peak-matched it is
 *                  worth at most 0.7 dB of residual against HF Emphasis's 3.4.
 *                  The smaller lever by a factor of five, on a two-knob panel.
 *   HF Emphasis    AIMING: which transients the curve works on. Peak-matched,
 *                  0 is the cleanest setting by 2.2-3.4 dB and there is no
 *                  interior optimum, so there is nothing here for a user to
 *                  find by turning it — but the aiming has never been measured
 *                  and the knob is how that gets done.
 * ⚠ THE DRIVE RATIOS ARE GONE, and with them the last of the scaffolding this
 * module was originally written for. They split one knob between Asymmetry,
 * HF Loss and Soften; asymmetry is deleted and HF Loss moved to Tube
 * Saturation, so the split has one member left and the panel shows it under
 * its own name. What is left behind this flag is all shipped kernel behaviour
 * with the control hidden — which is not the same as not having one, and the
 * kernel's defaults are what a user gets either way.
 *
 * Its own module rather than a function inside useSoftClipper.js so it can be
 * tested under node — importing the composable drags in Vite's `?worker&url`
 * specifiers, which only the bundler can resolve.
 */

/**
 * Is the hidden tuning panel on?
 *
 * Two keys, because the drive ratios shipped behind `driveTuning` first and a
 * flag that stops working is indistinguishable from a panel that broke.
 */
export function tuningEnabled() {
  for (const key of ['softClipperTuning', 'driveTuning']) {
    const raw = read(key)
    if (raw === '1' || raw === 'true') return true
  }
  return false
}

/** Query string, then stored preference. Null when neither has an opinion. */
function read(key) {
  try {
    return new URLSearchParams(window.location.search).get(key)
      ?? window.localStorage.getItem(key)
  } catch {
    // No window under test, or a browser that throws on localStorage in
    // private mode. Neither is a reason to fail.
    return null
  }
}
