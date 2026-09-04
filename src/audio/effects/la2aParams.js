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
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  return {
    mode: params.mode,
    peakReduction: params.peakReduction,
    gainDb: params.gain,
    r37: params.r37,
    lookaheadMs: params.lookahead,
  }
}

/**
 * This patch's latency in samples — the oversampler's floor plus whatever
 * lookahead is dialled in. Takes PANEL params; the apply path holds those.
 */
export function la2aPatchLatencySamples(params, sampleRate) {
  return la2aLatencySamples(toKernelParams({ ...LA2A_DEFAULTS, ...params }), sampleRate)
}
