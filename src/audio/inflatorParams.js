/**
 * Inflator — panel params and their ranges, in a module node can import
 * (effects/inflator.js pulls in the worklet loader, which only Vite resolves).
 *
 * ⚠ EFFECT DEFAULTS TO 0.5 WHERE THE REFERENCE SHIPS 0. A VST must be
 * inaudible until asked; this app opens a plugin engaged and metering, and a
 * panel that does nothing on open reads as broken. Every other default here is
 * the reference's.
 */
import { CURVE_MIN_PCT, CURVE_MAX_PCT } from './dsp/inflator.js'

export const INFLATOR_DEFAULTS = {
  inputDb: 0,
  effect: 0.5,
  curve: 0,
  outputDb: 0,
  clip: false,
  bandSplit: false,
}

export const INFLATOR_INPUT_MIN_DB = -12
export const INFLATOR_INPUT_MAX_DB = 12
// Output only ever CUTS, matching the reference.
export const INFLATOR_OUTPUT_MIN_DB = -12
export const INFLATOR_OUTPUT_MAX_DB = 0
export { CURVE_MIN_PCT, CURVE_MAX_PCT }

/** The small-signal lift the curve gives, dB: f'(0) = 1.5 + Curve/100. See dsp/inflator.js. */
export function inflatorLiftDb(curvePct) {
  return 20 * Math.log10(1.5 + curvePct / 100)
}
