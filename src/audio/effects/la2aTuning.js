/**
 * OptoSmooth bench tuning — the distortion constants, made movable at runtime.
 *
 * ⚠ THIS IS A BENCH CONTROL, NOT A PRODUCT FEATURE, AND THE DISTINCTION IS
 * LOAD-BEARING. OptoSmooth deliberately has no drive knob: the ledger's
 * position is that an LA-2A's valves are driven by LEVEL alone, so a control
 * scaling the curve would be modelling the operator rather than the hardware.
 * Nothing here changes that. These values exist so the distortion can be
 * JUDGED BY EAR against reference plugins, which cannot be done without moving
 * them, and every one of them is fitted to something — the hardware paper, or
 * a measurement in the ledger. Anything moved here has to come back through
 * the ledger before it ships.
 *
 * ⚠ THEREFORE IT IS DELIBERATELY NOT PART OF THE PATCH. These are not in
 * `LA2A_DEFAULTS`, so they are never serialised into a preset, a saved patch or
 * an undo entry — a tuning session cannot silently follow a file to another
 * machine. They are module state, read at the moment kernel params are built.
 *
 * ⚠ AND AT DEFAULTS IT EMITS NOTHING. `la2aTuningOverrides()` returns only the
 * keys that actually differ, so an untouched session produces kernel params
 * byte-identical to those from before this file existed. That is what keeps
 * the shipping behaviour, and the test suite, exactly where they were.
 *
 * No Vue import: `la2aParams.js` imports this, and that file exists precisely
 * so Node can reach the params and the latency arithmetic. Subscribers get a
 * plain callback instead.
 */

import {
  TUBE_DRIVE_LIN, TUBE_BIAS, CELL_MOD_MAX, CELL_MOD_TAU_DB,
} from '../la2aProcessor.js'

/**
 * Every default here is the module constant the kernel would use anyway, so
 * "at defaults" and "as shipped" are the same state by construction rather
 * than by two lists agreeing.
 */
export const LA2A_TUNING_DEFAULTS = Object.freeze({
  /** Master depth on the cell modulation, 0..1. 0 removes it entirely. */
  cellMod: 1,
  /** Cell modulation depth at full compression. Fitted to the paper. */
  cellModMax: CELL_MOD_MAX,
  /** How fast that depth rises with gain reduction, in dB. */
  cellModTauDb: CELL_MOD_TAU_DB,
  /**
   * One-pole on the rectifier ahead of `rect / env`, ms. 0 is off and is what
   * ships. The only control here that changes the harmonic PROFILE rather
   * than the level — see the kernel's note, including why 0.5 ms nulls it.
   */
  rectLpMs: 0,
  /** Valve stage on/off. Off isolates the cell. */
  tube: true,
  /** Valve drive. Anchored to the paper's -63.80 dBc H2 median. */
  tubeDriveLin: TUBE_DRIVE_LIN,
  /** Valve operating-point offset, which is what makes the stage even. */
  tubeBias: TUBE_BIAS,
})

const KEYS = Object.keys(LA2A_TUNING_DEFAULTS)

let tuning = { ...LA2A_TUNING_DEFAULTS }
const listeners = new Set()

/** The current values, as a copy — callers cannot mutate the store by holding it. */
export function getLA2ATuning() {
  return { ...tuning }
}

/** True when nothing has been moved, i.e. the kernel sees no overrides at all. */
export function isLA2ATuningDefault() {
  return KEYS.every(k => tuning[k] === LA2A_TUNING_DEFAULTS[k])
}

/**
 * Only the keys that differ from the shipping constants. This is what reaches
 * the kernel, and it is empty in the untouched case — see the file header.
 */
export function la2aTuningOverrides() {
  const out = {}
  for (const k of KEYS) {
    if (tuning[k] !== LA2A_TUNING_DEFAULTS[k]) out[k] = tuning[k]
  }
  return out
}

/** Merge a partial update. Unknown keys are ignored rather than stored. */
export function setLA2ATuning(patch) {
  let changed = false
  for (const k of KEYS) {
    if (!(k in patch)) continue
    const v = patch[k]
    const next = k === 'tube' ? v !== false : Number(v)
    if (k !== 'tube' && !Number.isFinite(next)) continue
    if (tuning[k] !== next) { tuning[k] = next; changed = true }
  }
  if (changed) for (const fn of listeners) fn()
  return changed
}

/** Back to the shipping constants. */
export function resetLA2ATuning() {
  return setLA2ATuning({ ...LA2A_TUNING_DEFAULTS })
}

/** Subscribe to changes; returns an unsubscribe. */
export function onLA2ATuningChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Whether the bench panel should be offered at all.
 *
 * ⚠ OFF BY DEFAULT IN A PRODUCTION BUILD, because these are not product
 * controls and a user who finds them can detune the plugin with no way back
 * except this file's Reset. On in dev, and openable in a preview build with
 * `localStorage['wavely:la2a-bench'] = '1'` — which is what makes it usable
 * for an A/B against reference plugins on a deployed URL.
 *
 * Both accessors are guarded: this module is imported by `la2aParams.js`,
 * which exists so Node can reach the params, and Node has neither.
 */
export function isLA2ATuningVisible() {
  try {
    if (globalThis.localStorage?.getItem('wavely:la2a-bench') === '1') return true
  } catch {
    // Storage access throws outright in some privacy modes; fall through.
  }
  return import.meta.env?.DEV === true
}
