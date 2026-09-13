/**
 * Vocal chain dynamics — panel params and the kernel mapping, with NO worklet
 * loader behind them.
 *
 * ⚠ THAT SEPARATION IS THE WHOLE REASON THIS FILE EXISTS. The effect wrapper
 * imports `dynamicsWorkletLoader.js`, whose `?worker&url` import only resolves
 * under Vite — so anything that pulls in the wrapper cannot be imported from
 * Node, and the params are exactly what the test suite and the offline apply
 * path need to reach. Same split, for the same reason, as `la2aParams.js`,
 * `schepsParams.js` and `softClipperParams.js`.
 *
 * `dynamics.js` re-exports all of it, so existing importers are unaffected.
 */

import {
  DYNAMICS_KERNEL_DEFAULTS, dynamicsPreRollSeconds,
} from '../dynamicsProcessor.js'

export { dynamicsPreRollSeconds }

/**
 * Latency of the section, in samples — clipper, FET and opto in series.
 *
 * ⚠ A CONSTANT, UNLIKE OptoSmooth's AND THE SOFT CLIPPER's. Both of those are
 * per-patch because a control can switch their lookahead on; this composite
 * pins the clipper's limiter off and the opto's lookahead to zero precisely so
 * this number cannot move. `dynamicsComposite.test.js` tries to move it.
 */
export const DYNAMICS_LATENCY_SAMPLES = 150

/**
 * What the PANEL holds. Everything else the kernel reads is MEASURED by
 * `solveDynamics` and arrives with the solve, not from here.
 *
 * ⚠ THE SEPARATION IS THE POINT, AND IT IS WHAT MAKES A PRESET PORTABLE. A
 * saved patch is a macro position, a voicing and a blend — three things that
 * describe an intention. The threshold, the drives, the two alignment offsets
 * and the blend's correlation all describe THE FILE, and a preset carrying any
 * of them would apply one recording's gain staging to another.
 */
export const DYNAMICS_DEFAULTS = {
  density: 50, // the macro, 0-100
  voicing: 'audiobook',
  /**
   * Null means "take the voicing's own blend". A number is the user overriding
   * it, which survives a re-solve — the same contract AUTO knobs have
   * elsewhere: the measurement owns the value until somebody disagrees.
   */
  mix: null,
  outputDb: 0,
}

/**
 * Params that are measured from the audio rather than dialled.
 *
 * ⚠ ANYTHING THE SOLVE PRODUCES BELONGS HERE. These are cleared to null on a
 * live node when no solve is in force, because the kernel MERGES a partial —
 * an omitted key means "unchanged", not "none" — and a stale alignment left
 * armed on a running node is a compressor doing a different amount of work from
 * what the panel says. See effects/measuredKeys.js for the version of this bug
 * that shipped once.
 */
export const DYNAMICS_MEASURED_KEYS = Object.freeze([
  'clipThresholdDb', 'fetDrive', 'fetAlignDb', 'squash', 'optoAlignDb',
  'correlation', 'densityDb',
])

/**
 * Map panel state plus a solve result to kernel params.
 *
 * @param {object} panel   DYNAMICS_DEFAULTS shape
 * @param {object|null} solved `solveDynamics().params`, or null for un-solved
 */
export function toKernelParams(panel, solved = null) {
  const base = { ...DYNAMICS_KERNEL_DEFAULTS }
  if (solved) {
    for (const key of DYNAMICS_MEASURED_KEYS) {
      if (key in solved) base[key] = solved[key]
    }
    // Ballistics and character are the solve's too — it honours whatever patch
    // it was given, and the result is what was actually measured against.
    for (const key of ['fetAttack', 'fetRelease', 'fetRatio', 'fetSat', 'fetScHpfHz',
      'clipShape', 'character']) {
      if (key in solved) base[key] = solved[key]
    }
  }
  return {
    ...base,
    /**
     * ⚠ MIX IS THE PANEL'S, NOT THE SOLVE'S, AND IT MOVES AFTER IT. The solve
     * measures the blend at Mix 1 — the worst case — so the mix law stays valid
     * wherever the knob lands, exactly as Scheps sizes its knee at Mix 1
     * because Mix moves after the solve.
     */
    mix: panel.mix ?? solved?.mix ?? DYNAMICS_KERNEL_DEFAULTS.mix,
    outputDb: panel.outputDb ?? 0,
  }
}

/** Kernel params for a LIVE node: the mapping, plus an explicit clear. */
export function toLiveKernelParams(panel, solved = null) {
  const mapped = toKernelParams(panel, solved)
  if (solved) return mapped
  const out = { ...mapped }
  for (const key of DYNAMICS_MEASURED_KEYS) out[key] = null
  return out
}
