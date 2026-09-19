/**
 * FET Punch (1176) panel params, defaults and latency — with NO worklet loader
 * behind them.
 *
 * ⚠ THAT SEPARATION IS THE WHOLE REASON THIS FILE EXISTS. The effect wrapper
 * imports `fet1176WorkletLoader.js`, whose `?worker&url` import only resolves
 * under Vite — so anything that pulls in the wrapper cannot be imported from
 * Node, and the params mapping is exactly what the test suite needs to reach.
 * It had to: the measured keys (`ceilingDb`, `ceilingKneeDb`, `inputAlignDb`)
 * are mapped UNCONDITIONALLY here so a `null` can clear a ceiling on the live
 * node, and that is the kind of property a test has to hold rather than a
 * comment. Same split, for the same reason, as `la2aParams.js` and
 * `softClipperParams.js`.
 *
 * `fet1176Compressor.js` re-exports all of it, so existing importers are
 * unaffected.
 */

import { fet1176TuningState } from './fet1176Tuning.js'
import { OVERSAMPLE_LATENCY_SAMPLES } from '../dsp/oversample.js'

/**
 * The gain cell and FET stage run oversampled, and the halfband filters that
 * get them there are linear phase, so the plugin delays. Constant at every
 * setting — see `latencySamples` on the kernel.
 */
export const FET1176_LATENCY_SAMPLES = OVERSAMPLE_LATENCY_SAMPLES

export const FET1176_DEFAULTS = {
  inputDrive: 50, // 0-100, drives the fixed internal threshold
  output: 0, // makeup gain dB
  attack: 4, // dial 1-7, 7 = fastest (20 us)
  release: 4, // dial 1-7, 7 = fastest (50 ms)
  ratio: '4', // '4' | '8' | '12' | '20' | 'all'
  /**
   * FET / output-amp saturation, 0-1, where 1 IS the curve measured from
   * FETish rather than an arbitrary top of travel.
   *
   * ⚠ THIS FILE HAD ITS OWN COPY OF THE DEFAULT AND IT WENT STALE. The kernel's
   * default moved to 1 with the measured curve; this one stayed at 0.35, and
   * since `toKernelParams` always sends `fetDrive` the kernel's value never
   * applied in the app — the panel would have shipped 35 % of the curve while
   * every test and script saw the whole of it.
   */
  fetDrive: 1,
  scHpf: 0, // sidechain high-pass corner in Hz, 0 = off (stock)
  mix: 1, // wet/dry blend for parallel compression
}

/**
 * Map UI param names to kernel param names.
 *
 * ⚠ THE BENCH TUNING IS FOLDED IN HERE AND NOWHERE ELSE. Both the live worklet
 * and the offline apply path build their params through this function, so
 * merging at one point is what keeps them sample-identical — the alternative is
 * threading the tuning through every caller and relying on none of them
 * forgetting. See `fet1176Tuning.js`.
 *
 * ⚠ THE COMPLETE STATE, NOT THE DIFF AGAINST THE DEFAULTS. It used to send only
 * the keys that differed, which cannot say "this one went back to normal": the
 * kernel merges partials, so a reset key kept its old value in the live worklet
 * while apply got the default. Every key travels every time. The values are the
 * shipping defaults until the bench panel is touched, so an untouched result is
 * behaviourally identical to what this returned before the panel existed.
 */
export function toKernelParams(params) {
  return {
    ...fet1176TuningState(),
    inputDrive: params.inputDrive,
    outputGainDb: params.output,
    attack: params.attack,
    release: params.release,
    ratio: params.ratio,
    fetDrive: params.fetDrive,
    scHpfHz: params.scHpf,
    mix: params.mix,
    inputAlignDb: params.inputAlignDb ?? 0,
    /**
     * Pass-through, not defaulted: null IS the value that means "no ceiling",
     * and `?? 0` here would be a ceiling at 0 dBFS on every render. The
     * percentile makeup and this travel together — see
     * `computeFET1176AutoMakeupPlan`.
     */
    ceilingDb: params.ceilingDb ?? null,
    ceilingKneeDb: params.ceilingKneeDb ?? null,
  }
}
