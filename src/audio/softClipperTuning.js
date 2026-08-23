/**
 * TEMPORARY: expose the Drive ratios on the panel so they can be tuned by ear.
 *
 *   ?driveTuning=1                                one page load
 *   localStorage.setItem('driveTuning', '1')      until cleared
 *
 * The ratios that split Drive between Asymmetry, HF Loss and Soften are fixed
 * constants (DRIVE_ASYM_RATIO and friends) chosen by measurement: each control
 * scales completely differently, so equal ratios would let Soften dominate and
 * Asymmetry do nothing. But measurement can rank them and cannot say which
 * blend SOUNDS like tape, and that decision needs a person, one file, and a way
 * to move the ratios without a rebuild — the same reason `voicerxBaseline`
 * exists, and this follows its pattern deliberately.
 *
 * ⚠ THIS IS SCAFFOLDING AND IS MEANT TO COME OUT. Once the ratios are settled
 * the constants get the chosen values and this module, the three knobs and the
 * badge all go. It is behind a flag rather than shipped-but-hidden so that a
 * half-finished tuning session cannot reach a user: with no flag set the panel
 * is exactly the two-knob panel and the kernel reads its constants.
 *
 * Its own module rather than a function inside useSoftClipper.js so it can be
 * tested under node — importing the composable drags in Vite's `?worker&url`
 * specifiers, which only the bundler can resolve.
 */

/** Shipping ratios, mirrored from the kernel so the panel can seed its knobs. */
export const DEFAULT_DRIVE_RATIOS = { asymmetry: 1, hfLoss: 1, soften: 0.65 }

/**
 * Ratios are clamped to [0, 1.5]. Above 1.5 a component reaches its own full
 * travel before Drive is halfway and the rest of the knob does nothing, which
 * is the failure this whole collapse was meant to remove — a control that
 * saturates early teaches the listener nothing about the blend.
 */
const MIN_RATIO = 0
const MAX_RATIO = 1.5

export function driveTuningEnabled() {
  const raw = read('driveTuning')
  return raw === '1' || raw === 'true'
}

export function clampRatio(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return 0
  return v < MIN_RATIO ? MIN_RATIO : v > MAX_RATIO ? MAX_RATIO : v
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
