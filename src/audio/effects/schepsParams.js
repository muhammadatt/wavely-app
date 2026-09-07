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
 * The wet path runs through OptoSmooth's oversampled gain cell, whose halfband
 * filters are linear phase and therefore delay. The dry side of the blend is
 * delayed to match inside the kernel; this is the whole plugin's delay, which
 * the offline apply path compensates.
 */
export const SCHEPS_LATENCY_SAMPLES = OVERSAMPLE_LATENCY_SAMPLES

export const SCHEPS_DEFAULTS = {
  character: 'thick', // 'thick' | 'presence'
  squash: 62, // LA-2A Peak Reduction on the wet path — see the kernel defaults
  mix: 35, // percent wet — the panel's unit
  output: 0, // manual trim on the summed output, dB
  // Measured by the auto trim pass. Held here rather than derived at apply time
  // so the applied render uses the same two numbers the preview was heard with.
  wetTrimDb: 0,
  correlation: 0,
  densityDb: 0,
  /**
   * Output ceiling, dBFS — the source's own peak, measured with the trim.
   *
   * ⚠ HELD HERE WHERE OPTOSMOOTH DELIBERATELY KEEPS ITS OWN OUT OF
   * `LA2A_DEFAULTS`, and the difference is presets. There, a measured value in
   * the defaults would be saved into patches and apply one file's peak to
   * another; Scheps has no preset collection, and it already holds `wetTrimDb`,
   * `correlation` and `densityDb` here for the reason this needs to be here too
   * — so the applied render uses the same numbers the preview was heard with.
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

