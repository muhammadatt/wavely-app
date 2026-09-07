/**
 * Scheps Parallel panel params, defaults and latency — with NO worklet loader
 * behind them.
 *
 * ⚠ THAT SEPARATION IS THE WHOLE REASON THIS FILE EXISTS, and it exists because
 * the gap it closes had already cost two bugs elsewhere today. `scheps.js`
 * imports `schepsWorkletLoader.js`, whose `?worker&url` specifier only resolves
 * under Vite — so nothing in it is reachable from `node --test`, and
 * `toKernelParams` is exactly the kind of seam where a param silently fails to
 * be carried and the control looks wired when it is not. OptoSmooth shipped
 * precisely that bug this week (`ceilingDb` missing from its own mapping) and it
 * was caught only because `la2aParams.js` had already been split out this way.
 *
 * Same split, same reason, as `la2aParams.js` and `softClipperParams.js`.
 * `scheps.js` re-exports all of it, so existing importers are unaffected.
 */

import { OVERSAMPLE_LATENCY_SAMPLES } from '../dsp/oversample.js'
/**
 * ⚠ THIS IMPORT DOES NOT COST THE NODE-REACHABILITY THIS FILE EXISTS FOR.
 * `schepsProcessor.js` guards its `registerProcessor` call on the symbol being
 * defined, so it imports cleanly outside a worklet; it is the effect WRAPPER
 * that pulls `?worker&url` and cannot, and that is still on the other side.
 */
import { SCHEPS_KERNEL_DEFAULTS } from '../schepsProcessor.js'

/**
 * The wet path runs through OptoSmooth's oversampled gain cell, whose halfband
 * filters are linear phase and therefore delay. The dry side of the blend is
 * delayed to match inside the kernel; this is the whole plugin's delay, which
 * the offline apply path compensates.
 */
export const SCHEPS_LATENCY_SAMPLES = OVERSAMPLE_LATENCY_SAMPLES

/**
 * ⚠ DERIVED FROM THE KERNEL'S OWN DEFAULTS, NOT RESTATED, BECAUSE RESTATING
 * THEM DRIFTED AND SHIPPED. `squash` was recalibrated 80 -> 62 -> 40 as the
 * Peak Reduction taper and then the R37 mechanism were corrected underneath it
 * — Scheps inherits every LA-2A constant by construction, so a change there
 * moves its operating point without its knob moving. The last of those moves,
 * 62 -> 40, landed on `SCHEPS_KERNEL_DEFAULTS` and NOT here, and this is the
 * object the panel actually opens with. Users got 62: measured on narration,
 * 4.75 dB of average gain reduction on the wet path against the calibrated
 * value's 1.11, and 18.83 dB peak against 11.49. Four times the compression the
 * default patch is supposed to have, for as long as the two numbers disagreed.
 *
 * So the panel no longer holds a number of its own for anything the kernel
 * already defines. This is the exact inverse of `toKernelParams` below, and
 * `test/dsp/scheps.test.js` pins the round trip — the two cannot disagree again
 * without a test failing.
 *
 * `ceilingDb` is the one panel-only key, because it is MEASURED from the audio
 * rather than dialled: there is no kernel default for it to derive from.
 */
export const SCHEPS_DEFAULTS = {
  character: SCHEPS_KERNEL_DEFAULTS.character,
  squash: SCHEPS_KERNEL_DEFAULTS.squash,
  // The panel's unit is percent; the kernel's is 0-1.
  mix: SCHEPS_KERNEL_DEFAULTS.mix * 100,
  output: SCHEPS_KERNEL_DEFAULTS.outputDb,
  // Measured by the auto trim pass. Held here rather than derived at apply time
  // so the applied render uses the same numbers the preview was heard with.
  wetTrimDb: SCHEPS_KERNEL_DEFAULTS.wetTrimDb,
  correlation: SCHEPS_KERNEL_DEFAULTS.correlation,
  densityDb: SCHEPS_KERNEL_DEFAULTS.densityDb,
  /**
   * Output ceiling, dBFS — the source's own peak, measured with the trim.
   *
   * ⚠ HELD HERE WHERE OPTOSMOOTH DELIBERATELY KEEPS ITS OWN OUT OF
   * `LA2A_DEFAULTS`, and the difference is presets. There, a measured value in
   * the defaults would be saved into patches and apply one file's peak to
   * another; Scheps has no preset collection, and it already holds the three
   * values above here for the reason this needs to be here too.
   */
  ceilingDb: null,
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  return {
    character: params.character,
    squash: params.squash,
    mix: params.mix / 100,
    outputDb: params.output,
    wetTrimDb: params.wetTrimDb,
    correlation: params.correlation,
    densityDb: params.densityDb,
    // Only when it is real, so the params object is key-for-key what it was
    // everywhere the ceiling is not in play — same reason as `toKernelParams`
    // in la2aParams.js.
    ...(Number.isFinite(params.ceilingDb) ? { ceilingDb: params.ceilingDb } : {}),
  }
}

