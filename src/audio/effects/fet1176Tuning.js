/**
 * FET Punch bench tuning — which static curve runs, and where it sits.
 *
 * ⚠ THIS IS A BENCH CONTROL, NOT A PRODUCT FEATURE. It exists so the measured
 * FETish curve can be A/B'd by ear against the `tanh` that preceded it, and so
 * the three shaper positions can be compared on real material — neither of
 * which can be done from a script. Same arrangement, and the same reasoning, as
 * `la2aTuning.js`.
 *
 * ⚠ DELIBERATELY NOT PART OF THE PATCH. These are not in `FET1176_DEFAULTS`, so
 * they are never serialised into a preset, a saved patch or an undo entry — a
 * bench session cannot silently follow a file to another machine. They are
 * module state, read at the moment kernel params are built.
 *
 * ⚠ AND AT DEFAULTS IT EMITS NOTHING. `fet1176TuningOverrides()` returns only
 * the keys that actually differ, so an untouched session produces kernel params
 * byte-identical to those from before this file existed. That is what keeps the
 * shipping behaviour, and the test suite, exactly where they are.
 *
 * No Vue import: this is reached from the effect wrapper, which Node imports.
 * Subscribers get a plain callback instead.
 */

import { FET1176_KERNEL_DEFAULTS, FET_LEGACY_PATCH } from '../fet1176Processor.js'

/**
 * Every default here is the kernel's own, so "at defaults" and "as shipped" are
 * the same state by construction rather than by two lists agreeing.
 */
export const FET1176_TUNING_DEFAULTS = Object.freeze({
  /**
   * 'poly' — the degree-5 curve measured from Analog Obsession FETish.
   * 'tanh' — the fitted asymmetric hyperbolic tangent that shipped before it.
   */
  fetCurve: FET1176_KERNEL_DEFAULTS.fetCurve,
  /**
   * 'preInput' | 'preCell' | 'postCell' — see the kernel's note. The short
   * version: `preCell` is FETish's measured topology and is NOT its behaviour
   * on our real-gain Input knob (H2 swings 79.6 dB across the knob against the
   * reference's 0.0), which is why `preInput` ships.
   */
  fetPosition: FET1176_KERNEL_DEFAULTS.fetPosition,
  /**
   * 'datasheet' — 20-800 us, the 1176's published span, which our constants
   *               quote and which ships.
   * 'fetish'    — 7630-170 us, solved so our dials reproduce FETish's own
   *               measured attack times.
   *
   * ⚠ THIS IS THE ONE OPEN QUESTION THE BENCH EXISTS FOR RIGHT NOW. The two
   * disagree by about 5x and there is no measurement that settles which is
   * right: the datasheet is what the hardware claims, FETish is what the
   * reference does, and release moved 2.73x in the OTHER direction so they are
   * not one common cause. It is a listening decision, which is why it is here
   * and not in a script.
   */
  attackRange: FET1176_KERNEL_DEFAULTS.attackRange,
  /**
   * 'depth' — the release constant scales with the current reduction, which is
   *           the limb FETish measurably has. SHIPS.
   * 'none'  — one constant per knob position, as before the fit.
   *
   * ⚠ IT IS HERE BECAUSE `FET_LEGACY_PATCH` CARRIES IT AND THE BENCH WAS SILENTLY
   * DROPPING IT. `setFET1176Tuning` only accepts keys present in these defaults,
   * so LEGACY restored the curve and the position, left the depth schedule
   * running, and `isFET1176TuningLegacy()` returned true anyway — a button
   * claiming to reproduce the pre-capture kernel while reproducing two thirds of
   * it. Any key added to the legacy patch has to be added here too, which is the
   * coupling a test now pins.
   */
  releaseSchedule: FET1176_KERNEL_DEFAULTS.releaseSchedule,
  /**
   * 'none' ships; 'depth' shortens the attack as the TARGET reduction deepens.
   *
   * ⚠ IT IS HALF A MODEL. Paired with `attackRange: 'fetish'` it reproduces the
   * reference to 1.15 % across 6-22 dB; on its own it is 36 % out, and the
   * FETish ladder on its own is 41 %. The two were fitted together and the
   * panel says to select both or neither.
   */
  attackSchedule: FET1176_KERNEL_DEFAULTS.attackSchedule,
})

/**
 * The kernel as it stood before the FETish capture — both keys at once.
 *
 * ⚠ A PRESET RATHER THAN TWO SEPARATE MOVES, because "the old plugin" is a pair
 * of choices and setting one without the other is a configuration that never
 * shipped. `FET_LEGACY_PATCH` is the kernel's own definition of it, imported
 * rather than restated so the two cannot drift.
 */
export const FET1176_LEGACY_TUNING = Object.freeze({ ...FET_LEGACY_PATCH })

const KEYS = Object.keys(FET1176_TUNING_DEFAULTS)
const CURVES = new Set(['poly', 'tanh'])
const POSITIONS = new Set(['preInput', 'preCell', 'postCell'])
const ATTACK_RANGES = new Set(['datasheet', 'fetish'])
const SCHEDULES = new Set(['depth', 'none'])

let tuning = { ...FET1176_TUNING_DEFAULTS }
const listeners = new Set()

/** The current values, as a copy — callers cannot mutate the store by holding it. */
export function getFET1176Tuning() {
  return { ...tuning }
}

/** True when nothing has been moved, i.e. the kernel sees no overrides at all. */
export function isFET1176TuningDefault() {
  return KEYS.every(k => tuning[k] === FET1176_TUNING_DEFAULTS[k])
}

/** True when the bench is set to reproduce the pre-capture kernel exactly. */
export function isFET1176TuningLegacy() {
  return KEYS.every(k => tuning[k] === (FET1176_LEGACY_TUNING[k] ?? FET1176_TUNING_DEFAULTS[k]))
}

/**
 * Only the keys that differ from the shipping constants. This is what reaches
 * the kernel, and it is empty in the untouched case — see the file header.
 */
export function fet1176TuningOverrides() {
  const out = {}
  for (const k of KEYS) {
    if (tuning[k] !== FET1176_TUNING_DEFAULTS[k]) out[k] = tuning[k]
  }
  return out
}

/**
 * Merge a partial update. Unknown keys, and values outside the allowed set,
 * are ignored rather than stored — a typo here would otherwise reach
 * `setParams`, which treats anything it does not recognise as the default and
 * would silently give the bench the opposite of what it asked for.
 */
export function setFET1176Tuning(patch) {
  let changed = false
  for (const k of KEYS) {
    if (!(k in patch)) continue
    const v = String(patch[k])
    if (k === 'fetCurve' && !CURVES.has(v)) continue
    if (k === 'fetPosition' && !POSITIONS.has(v)) continue
    if (k === 'attackRange' && !ATTACK_RANGES.has(v)) continue
    if (k === 'releaseSchedule' && !SCHEDULES.has(v)) continue
    if (k === 'attackSchedule' && !SCHEDULES.has(v)) continue
    if (tuning[k] !== v) { tuning[k] = v; changed = true }
  }
  if (changed) for (const fn of listeners) fn()
  return changed
}

/** Back to the shipping constants. */
export function resetFET1176Tuning() {
  return setFET1176Tuning({ ...FET1176_TUNING_DEFAULTS })
}

/** Subscribe to changes; returns an unsubscribe. */
export function onFET1176TuningChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Whether the bench panel should be offered at all.
 *
 * ⚠ OFF BY DEFAULT IN A PRODUCTION BUILD, because these are not product
 * controls: a user who found them could put the plugin in a configuration that
 * no preset was voiced against, with no way back except Reset. On in dev, and
 * openable in a preview build with `localStorage['wavely:fet-bench'] = '1'` —
 * which is what makes it usable for an A/B against reference plugins on a
 * deployed URL.
 *
 * Guarded: this module is reached from the effect wrapper, which Node imports,
 * and Node has neither `localStorage` nor `import.meta.env`.
 */
export function isFET1176TuningVisible() {
  try {
    if (globalThis.localStorage?.getItem('wavely:fet-bench') === '1') return true
  } catch {
    // Storage access throws outright in some privacy modes; fall through.
  }
  return import.meta.env?.DEV === true
}
