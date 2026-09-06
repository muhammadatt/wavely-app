/**
 * OptoSmooth (LA-2A) panel params, defaults and latency — with NO worklet
 * loader behind them.
 *
 * ⚠ THAT SEPARATION IS THE WHOLE REASON THIS FILE EXISTS. The effect wrapper
 * imports `la2aWorkletLoader.js`, whose `?worker&url` import only resolves
 * under Vite — so anything that pulls in the wrapper cannot be imported from
 * Node, and the params and the latency arithmetic are exactly what the test
 * suite and the offline apply path need to reach. Same split, for the same
 * reason, as `softClipperParams.js`.
 *
 * `la2aCompressor.js` re-exports all of it, so existing importers are
 * unaffected.
 */

import { OVERSAMPLE_LATENCY_SAMPLES } from '../dsp/oversample.js'
import { la2aLatencySamples, LOOKAHEAD_MAX_MS } from '../la2aProcessor.js'
import { la2aTuningOverrides } from './la2aTuning.js'

export { LOOKAHEAD_MAX_MS }

/**
 * The tube stage runs oversampled, and the halfband filters that get it there
 * are linear phase, so the plugin delays. This is the delay with LOOKAHEAD OFF,
 * which is the default and every patch that predates that control.
 *
 * ⚠ IT IS NO LONGER THE WHOLE STORY. Lookahead adds its own delay on top, so
 * anything sizing a render must go through `la2aPatchLatencySamples` — see
 * `applyLA2ARegion`. This constant remains the floor, and the static
 * `latencySamples` the chain reads for a nominal figure.
 */
export const LA2A_LATENCY_SAMPLES = OVERSAMPLE_LATENCY_SAMPLES

export const LA2A_DEFAULTS = {
  mode: 'compress', // 'compress' | 'limit'
  peakReduction: 50,
  gain: 0, // makeup gain dB
  r37: 100, // R37 side-chain trimmer as knob rotation; 100 = flat (factory)
  /**
   * Lookahead, ms. 0 is off and is the hardware; the control exists because the
   * T4's 10 ms attack makes peak-referenced auto-makeup read an un-compressed
   * onset as the file's peak. See LOOKAHEAD_MAX_MS in la2aProcessor.js for the
   * measurements and for why the ceiling is 20 and not higher.
   */
  lookahead: 0,
  /**
   * Which statistic the AUTO makeup solve references: 'peak' (the shipping
   * behaviour) or 'percentile'.
   *
   * ⚠ IT ONLY MEANS ANYTHING WITH AUTO MAKEUP ON, because it names how the
   * solve measures — with AUTO off there is no solve and the knob is the
   * user's. The panel disables the control there rather than showing a setting
   * that does nothing.
   *
   * ⚠ AND IT NEVER TRAVELS ALONE. 'percentile' gives up the arithmetic
   * guarantee that the output cannot exceed the source, and a ceiling measured
   * from the region puts it back — see `computeLA2AAutoMakeup`, which returns
   * both, and `peakOfChannels` in la2aProcessor.js for the measurement that
   * rejected the percentile on its own.
   */
  makeupReference: 'peak',
}

/**
 * Map UI param names to kernel param names.
 *
 * ⚠ IT ALSO FOLDS IN THE BENCH TUNING OVERRIDES, WHICH IS A HIDDEN INPUT AND IS
 * DELIBERATE. Preview (`la2aCompressor.js`) and offline apply
 * (`applyLA2ARegion`) both build their kernel params here and nowhere else, so
 * merging at this one point is what keeps them sample-identical — the
 * alternative is threading the tuning through every caller and relying on none
 * of them forgetting. `la2aTuningOverrides()` is empty unless the tuning panel
 * has been touched, so the untouched result is byte-identical to what this
 * returned before. See `la2aTuning.js`.
 */
export function toKernelParams(params) {
  return {
    mode: params.mode,
    peakReduction: params.peakReduction,
    gainDb: params.gain,
    r37: params.r37,
    lookaheadMs: params.lookahead,
    ...la2aTuningOverrides(),
    /**
     * ⚠ MEASURED, NOT DIALLED, WHICH IS WHY IT IS NOT IN `LA2A_DEFAULTS`. The
     * ceiling is a property of the AUDIO — the region's own peak — so it is
     * handed in by whoever ran the makeup measurement, and is absent for every
     * other caller including a preset. Storing it in the patch would freeze one
     * file's peak into a setting that then travelled to another file.
     *
     * ⚠ SPREAD IN ONLY WHEN IT IS REAL, so the params object is KEY-FOR-KEY
     * what it has always been everywhere the ceiling is not in play. An
     * unconditional `ceilingDb: null` is inert to the kernel and still changes
     * the shape of this object, which `la2aTuning.test.js` pins deliberately —
     * that test is the guard on "an untouched bench emits nothing", and it
     * caught this.
     */
    ...(Number.isFinite(params.ceilingDb) ? { ceilingDb: params.ceilingDb } : {}),
  }
}

/**
 * This patch's latency in samples — the oversampler's floor plus whatever
 * lookahead is dialled in. Takes PANEL params; the apply path holds those.
 */
export function la2aPatchLatencySamples(params, sampleRate) {
  return la2aLatencySamples(toKernelParams({ ...LA2A_DEFAULTS, ...params }), sampleRate)
}
