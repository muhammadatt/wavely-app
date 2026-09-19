/**
 * Punch Chain panel params, defaults and latency — with NO worklet loader
 * behind them.
 *
 * ⚠ THAT SEPARATION IS THE WHOLE REASON THIS FILE EXISTS. `punchChain.js`
 * imports `punchChainWorkletLoader.js`, whose `?worker&url` specifier only
 * resolves under Vite, so nothing in it is reachable from `node --test` —
 * and `toKernelParams` is exactly the seam where a param silently fails to be
 * carried and the control looks wired when it is not. OptoSmooth shipped that
 * bug (`ceilingDb` missing from its own mapping) and it was caught only because
 * `la2aParams.js` had already been split out this way. Same split, same reason,
 * as `la2aParams.js`, `softClipperParams.js` and `schepsParams.js`.
 */

import {
  PUNCH_CHAIN_KERNEL_DEFAULTS, PUNCH_CHAIN_PREROLL_S,
} from '../punchChainProcessor.js'
import { OVERSAMPLE_LATENCY_SAMPLES } from '../dsp/oversample.js'
import { la2aTuningOverrides } from './la2aTuning.js'
import { fet1176TuningOverrides } from './fet1176Tuning.js'

export { PUNCH_CHAIN_PREROLL_S }

/**
 * Both embedded kernels oversample their gain cell and saturator, and both
 * report 50 samples for it. In series that is 100.
 *
 * ⚠ A CONSTANT ONLY BECAUSE `LA2A_FIXED` PINS `lookaheadMs: 0`. The kernel's
 * `latencySamples` getter is the real answer and adds the lookahead when there
 * is one; if the Opto's lookahead is ever put on this plate — see the note on
 * LA2A_FIXED, which is the leading follow-up — this has to become per-patch
 * before that lands, or the apply path will trim the wrong amount and shift the
 * region late.
 */
export const PUNCH_CHAIN_LATENCY_SAMPLES = OVERSAMPLE_LATENCY_SAMPLES * 2

/**
 * ⚠ DERIVED FROM THE KERNEL'S OWN DEFAULTS, NOT RESTATED, BECAUSE RESTATING
 * THEM DRIFTED AND SHIPPED — on Scheps, twice, once at four times the intended
 * gain reduction. This plugin is exposed to that failure on BOTH sides: it
 * holds two kernels, so a re-voicing of either lands here without its knob
 * moving. `test/dsp/punchChain.test.js` pins this round trip against
 * `toKernelParams` below, so the two cannot disagree without a test failing.
 *
 * The measured values are the panel-only keys, because they are read off the
 * audio rather than dialled: there is no kernel default for them to derive
 * from, and they must never be saved into a preset — a ceiling, an alignment
 * or a makeup is a property of the FILE. Same rule as OptoSmooth's
 * `ceilingDb` and `inputAlignDb`.
 */
export const PUNCH_CHAIN_DEFAULTS = {
  drive: PUNCH_CHAIN_KERNEL_DEFAULTS.drive,
  peakReduction: PUNCH_CHAIN_KERNEL_DEFAULTS.peakReduction,
  output: PUNCH_CHAIN_KERNEL_DEFAULTS.outputDb,
  /** Solved per region by `computePunchChainPlan`. */
  makeupDb: PUNCH_CHAIN_KERNEL_DEFAULTS.makeupDb,
  /** The source's own peak, measured with the makeup. */
  ceilingDb: PUNCH_CHAIN_KERNEL_DEFAULTS.ceilingDb,
  ceilingKneeDb: PUNCH_CHAIN_KERNEL_DEFAULTS.ceilingKneeDb,
  /**
   * Side-chain alignment for the FET, from the whole file, and for the Opto,
   * derived from the FET's.
   *
   * ⚠ NULL HERE WHERE THE KERNEL'S DEFAULT IS 0, AND THE TWO MEAN DIFFERENT
   * THINGS. At the kernel, 0 is a real value — "no offset", the raw hardware
   * behaviour where the file's own level decides what a knob position does. At
   * the panel the question is whether a measurement has happened yet, and 0 is
   * a perfectly ordinary measured answer for a file that is already at nominal.
   * Using it as the sentinel would make an aligned file indistinguishable from
   * an unmeasured one, and `toKernelParams` would carry a zero that reads as
   * deliberate. Same split, same reason, as `inputAlignDb` in schepsParams.js.
   */
  fetAlignDb: null,
  optoAlignDb: null,
}

/**
 * The measured keys THIS plugin can clear back to "no measurement".
 *
 * ⚠ ITS OWN LIST RATHER THAN THE SHARED `MEASURED_KEYS`, because two of them
 * are this chain's alone. `measuredKeys.js` states the rule — anything that is
 * a conditional spread in `toKernelParams` belongs in the clear list, or a
 * `null` pushed at a live node means "unchanged" instead of "off" — and the
 * two alignments are conditional spreads here. Adding them to the shared
 * constant would push two null keys nothing else understands into every other
 * plugin's live params, so `withMeasuredClears` takes this instead.
 */
export const PUNCH_CHAIN_MEASURED_KEYS = Object.freeze([
  'ceilingDb', 'ceilingKneeDb', 'fetAlignDb', 'optoAlignDb',
])

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  return {
    drive: params.drive,
    peakReduction: params.peakReduction,
    outputDb: params.output,
    makeupDb: params.makeupDb,
    // Only when they are real, so the params object is key-for-key what it was
    // everywhere the measurement is not in play — same reason as the matching
    // mapping in la2aParams.js.
    ...(Number.isFinite(params.ceilingDb) ? { ceilingDb: params.ceilingDb } : {}),
    ...(Number.isFinite(params.ceilingKneeDb) ? { ceilingKneeDb: params.ceilingKneeDb } : {}),
    ...(Number.isFinite(params.fetAlignDb) ? { fetAlignDb: params.fetAlignDb } : {}),
    ...(Number.isFinite(params.optoAlignDb) ? { optoAlignDb: params.optoAlignDb } : {}),
    ...embeddedTuning(),
  }
}

/**
 * The two bench tunings, for the two compressors this chain embeds.
 *
 * ⚠ SUBSCRIBED TO BOTH BENCHES BECAUSE IT HOLDS BOTH KERNELS. Scheps shipped
 * following neither and had to be retrofitted — a tuning session moved
 * OptoSmooth and left Scheps behind, two plugins running the same cell at
 * different constants with nothing saying so. This plugin doubles that exposure
 * and is wired for it from the start.
 *
 * ⚠ NESTED RATHER THAN SPREAD FLAT, for the reason schepsParams.js records:
 * these are the embedded compressors' params, not this chain's, and both
 * kernels have keys whose names would collide with each other and with this
 * chain's. `PunchChainKernel.setParams` spreads each into its own kernel after
 * its own allowlist, so the bench wins there and only there.
 *
 * ⚠ AND EACH IS ABSENT WHEN ITS BENCH IS UNTOUCHED, not an empty object, so
 * the params stay key-for-key what they were before this existed.
 */
function embeddedTuning() {
  const la2a = la2aTuningOverrides()
  const fet = fet1176TuningOverrides()
  return {
    ...(Object.keys(la2a).length > 0 ? { la2aTuning: la2a } : {}),
    ...(Object.keys(fet).length > 0 ? { fetTuning: fet } : {}),
  }
}
