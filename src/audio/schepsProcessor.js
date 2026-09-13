/**
 * Scheps Parallel — worklet kernel.
 *
 * Andrew Scheps' vocal trick, as one effect: a Pultec EQP-1A push into an LA-2A
 * into a second Pultec that roughly undoes the push, the whole thing blended
 * back against the untouched signal.
 *
 *   dry ─────────────────────── delay ────────────────┐
 *                                                     ├─ equal-power mix ─ out
 *   wet ─ Pultec(pre) ─ OptoSmooth(+makeup) ─ Pultec(post) ─┘
 *
 * WHAT THE PRE STAGE IS FOR. It is not a tone control. Cutting the lows before
 * the compressor takes the plosives and the chest thump out of the sidechain,
 * so the opto cell stops ducking the whole voice every time a "p" lands; the
 * 8 kHz lift does the same in reverse, handing the cell the presence band so it
 * rides that instead. The LA-2A's own R37 trimmer is pinned fully counter-
 * clockwise here for the same reason, and it is the single setting the trick is
 * named for.
 *
 * WHY THE POST STAGE IS NOT AN EXACT INVERSE. It is measured, not derived: the
 * curves in data/pultec_curves/ are what a passive EQP-1A actually does, and its
 * boost and cut at the same nominal frequency are different shapes. The net of
 * the two stages is therefore a real curve — Thick nets +4 dB at 30 Hz and
 * -4.6 dB at 20 kHz — and that residue is a large part of the sound. See
 * src/audio/dsp/pultec.js.
 *
 * WHY THE PARALLEL BLEND LIVES INSIDE THE KERNEL. The wet path is delayed by the
 * LA-2A's oversampling latency. Splitting the blend across two Web Audio nodes
 * would put an undelayed dry signal against a delayed wet one and comb-filter
 * the result — audibly, since the two are near-identical below 1 kHz. Here the
 * dry side runs through a delay line of exactly the compressor's latency, so the
 * two arrive sample-aligned, and the plugin reports that latency once for the
 * offline apply path to trim.
 *
 * This file is BOTH a normal ES module (exports SchepsKernel,
 * processSchepsBuffer and computeSchepsAutoTrim) AND an AudioWorklet module
 * (registers 'scheps-processor'). Its loader goes through `?worker&url` so Vite
 * bundles the DSP it imports — see schepsWorkletLoader.js.
 */

import { LA2AKernel } from './la2aProcessor.js'
import {
  MAKEUP_PERCENTILE, CEILING_KNEE_DB, ceilingKneeDbFor,
  softCeiling, float32AtOrBelow, percentileOfChannels,
} from './dsp/makeupReference.js'
import { DelayLine } from './dsp/oversample.js'
import { BiquadCascade, highpass, lowpass } from './dsp/biquad.js'
import { pultecSections, PULTEC_STAGES } from './dsp/pultec.js'
import { clamp, finite, mixGains } from './dsp/parallelMix.js'
/**
 * ⚠ THE MATCHING BAND MOVED TO `dsp/speechBand.js`, shared with the vocal
 * chain's dynamics section, which matches two paths the same way and for the
 * same reason — a Pultec stage either side of the compressor. Imported, not
 * forwarded, because `speechWeight` is used locally below.
 */
import { speechWeight, SPEECH_BAND_HZ } from './dsp/speechBand.js'

export { mixGains }

const LN10_OVER_20 = Math.LN10 / 20

/**
 * LA-2A settings the trick fixes, and why none of them is on the panel.
 *
 * `r37: 0` is the trick: the trimmer wound fully counter-clockwise, which is
 * what "turn the HF knob all the way up" means on a unit whose factory position
 * is clockwise and flat. `mode: 'compress'` because this is levelling, not
 * limiting. `mix: 1` because the parallel blend is ours, not the compressor's.
 *
 * ⚠ THIS PLUGIN GOT MARKEDLY MORE COMPRESSED WHEN R37's MECHANISM WAS CORRECTED,
 * AND THE SETTING WAS DELIBERATELY LEFT ALONE. R37 used to be modelled as an
 * attenuator of lows; it is pre-emphasis, a BOOST of highs (see SC_EMPH_HZ for
 * the manufacturer's figure and the measurement that settled it). At `r37: 0`
 * that is ~17 dB of extra side-chain drive at the top, into a fixed threshold —
 * so on real narration at Squash's default the peak reduction went 13.02 ->
 * 20.33 dB and the delivered depth 7.05 -> 9.87.
 *
 * ⚠ THE TRICK ITSELF IS UNCHANGED AND ARGUABLY BETTER SERVED: "the cell rides
 * the presence band" is exactly what pre-emphasis does, where the old model
 * reached it by a mechanism the hardware does not have. What moved is HOW HARD,
 * not what — and the drive is put back by the `squash` default, below. Backing
 * the trimmer off instead does not work: it takes r37 to 100, which is the
 * trick switched off.
 *
 * `gainDb` is NOT here: the wet path's makeup is handed to the compressor as
 * its own Gain, in `setParams` below. It used to be pinned to zero with the
 * makeup applied after the post EQ instead, which was the wrong stage. On the
 * hardware the Gain knob feeds the output amplifier and the second Pultec sits
 * after it, so makeup drives the tube rather than bypassing it — measured at
 * about 1 dB more harmonic content, which is small because our post EQ is a
 * linear biquad cascade with no gain stage of its own to be driven. The reason
 * to get it right anyway is structural: the makeup now flows through the
 * compressor's own machinery, so every change to how OptoSmooth computes makeup
 * reaches this plugin instead of having to be mirrored into it.
 */
const LA2A_FIXED = {
  mode: 'compress',
  r37: 0,
  mix: 1,
  /**
   * ⚠ PINNED OFF, EXPLICITLY, EVEN THOUGH IT IS THE KERNEL DEFAULT. Lookahead
   * moves `la2a.latencySamples`, which this composite's dry delay follows and
   * `SCHEPS_LATENCY_SAMPLES` does not — that constant is what the apply path
   * trims. Inheriting the default would make Scheps' reported latency a
   * hostage to a default it does not own. Pinning it here means the constant
   * is true by construction, and its test says so.
   *
   * Scheps has the same slow-attack transient behaviour and could reasonably
   * want this control of its own; that is a deliberate follow-up, not an
   * oversight. It needs `SCHEPS_LATENCY_SAMPLES` to become per-patch first.
   */
  lookaheadMs: 0,
}

/**
 * Pre-roll for the offline apply path, seconds. See applyWorkletRegion.
 *
 * ⚠ THE SAME NUMBER AS LA2A_PREROLL_S AND FOR THE SAME REASON: this stage HOLDS
 * the LA-2A kernel rather than a copy, so it inherits its ballistics and its
 * convergence behaviour exactly. Measured on the adversarial probe (loud right
 * up to the region boundary, then quiet):
 *
 *   pre-roll     0 s      0.5 s      1 s      2 s
 *   max diff   1.3e-2    1.7e-5   4.5e-8   0.0e+0
 *   RMS dB    -0.2404   -0.0003  -0.0000   0.0000
 *
 * Bit-exact at 2 s. If the embedded kernel's ballistics ever change, this
 * number is downstream of that change and should be re-measured with it.
 */
export const SCHEPS_PREROLL_S = 2

export const SCHEPS_KERNEL_DEFAULTS = {
  character: 'thick', // 'thick' | 'presence'
  /**
   * Drives the LA-2A's Peak Reduction, 0–100. Parallel compression wants far
   * more of this than a series insert would — the squashed copy is a layer, not
   * the signal.
   *
   * ⚠ SET LOW BECAUSE THE SIDE-CHAIN ARRIVES PRE-EMPHASISED, WHICH IS THE
   * OPPOSITE OF WHY IT USED TO BE SET HIGH. The pre EQ takes ~4.7 dB out of the
   * lows, and R37 fully counter-clockwise ADDS up to 17 dB above the emphasis
   * corner, so the cell sees far more presence than the raw signal carries and
   * needs much less knob to reach the same reduction. On speech at nominal
   * level this lands around 7.6 dB of gain reduction on the wet path; the same
   * number on the Opto Comp panel, with a flat side-chain, gives 3.7.
   *
   * WAS 80, THEN 62, AND THE OPERATING POINT IS WHAT IS PRESERVED HERE, NOT THE
   * NUMBER — TWICE NOW.
   *
   * 80 delivered that ~7 dB under the old Peak Reduction taper, which topped out
   * at 13 dB of reduction across its whole travel; the taper is now fitted to a
   * reference LA-2A and reaches 27, so 80 on the same clip became 14.2 dB —
   * double the compression on the default patch, silently. 62 restored it.
   *
   * ⚠ 62 -> 40 BECAUSE R37's MECHANISM WAS CORRECTED. It is pre-emphasis, a
   * BOOST of highs, where it used to be modelled as an attenuator of lows (see
   * SC_EMPH_HZ). This plugin pins `r37: 0`, so it went from having ~10 dB of
   * drive REMOVED to having ~11 dB ADDED — peak reduction on the reference clip
   * 7.62 -> 20.33 dB at the same knob. 40 puts it back to 7.64.
   *
   * ⚠ THE OFFSET IS CONSTANT ACROSS THE KNOB, WHICH IS WHY A NEW DEFAULT IS
   * ENOUGH AND NO REMAPPING IS NEEDED. Matching the old reduction at squash
   * 45 / 62 / 80 / 95 needs -21.9 / -22.0 / -21.9 / -21.9 knob units — the
   * taper is linear, so a fixed drive boost is a fixed knob shift. An offset
   * inside the mapping was rejected for costing the top of the travel: it would
   * cap Peak Reduction at 78 and make the knob's last fifth unreachable.
   *
   * ⚠ AND PEAK IS WHAT 40 PRESERVES, NOT AVERAGE — no single number restores
   * both, because pre-emphasis REDISTRIBUTES the reduction rather than scaling
   * it. On the reference clip: old 62 gave peak 7.62 / average 2.00 dB; new 40
   * gives 7.64 / 1.23; new 45.6 would give 9.52 / 2.01. Peak is the figure this
   * note has always quoted, and the layer is deliberately a bit less dense than
   * before because the cell now spends its reduction on sibilance instead of
   * spreading it. ⚠ MEASURED ON ONE NARRATION CLIP, so the exact number is
   * material-dependent; the mechanism is not.
   */
  squash: 40,
  mix: 0.35, // 0–1 wet
  /**
   * The wet path's makeup, handed to the compressor as its own Gain — so it
   * sits before the tube stage and before the post EQ, where the hardware puts
   * it. Measured by computeSchepsAutoTrim. Zero means unmeasured, not "no
   * makeup needed".
   */
  wetTrimDb: 0,
  /**
   * Zero-lag correlation between the dry signal and the level-matched wet one,
   * -1 to 1, also from computeSchepsAutoTrim. Corrects the mix law — see
   * `_updateMix`. Zero gives a textbook equal-power crossfade.
   */
  correlation: 0,
  /**
   * How much louder the wet copy's average is than the dry one's once its loud
   * parts are level — the compression's yield, from computeSchepsAutoTrim. The
   * mix law passes it through instead of flattening it, so Mix gently raises
   * loudness. Zero means unmeasured.
   */
  densityDb: 0,
  outputDb: 0, // manual trim on the summed output
}

/**
 * ⚠ THE BLEND LAW AND ITS GUARDS NOW LIVE IN `dsp/parallelMix.js`, shared with
 * the vocal chain's dynamics section, which blends the same way. Re-exported
 * here so importers and `scheps.test.js` are unchanged.
 *
 * ⚠ IMPORTED AND RE-EXPORTED, NOT JUST RE-EXPORTED, AND THE DIFFERENCE IS A
 * RUNTIME CRASH — this file already records paying for that once. `export { X }
 * from '...'` forwards the binding without introducing it into this module's
 * scope, and `clamp`, `finite` and `mixGains` are all used locally below.
 */
export class SchepsKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.la2a = new LA2AKernel(sampleRate)

    this.preEq = null
    this.postEq = null
    this.dryLines = [] // one per channel, grown on demand
    this.wetScratch = []

    this.params = { ...SCHEPS_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Merge a partial param update and rebuild coefficients. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    const character = PULTEC_STAGES[p.character] ? p.character : SCHEPS_KERNEL_DEFAULTS.character
    const pre = pultecSections(this.sampleRate, character, 'pre')
    const post = pultecSections(this.sampleRate, character, 'post')
    // Rebuilt rather than resized when the character changes: the two curves
    // can differ in section count, and a cascade's state is meaningless across
    // a topology change anyway.
    if (!this.preEq || this.preEq.sectionCount !== pre.length) {
      this.preEq = new BiquadCascade(pre.length, Math.max(1, this.dryLines.length))
    }
    if (!this.postEq || this.postEq.sectionCount !== post.length) {
      this.postEq = new BiquadCascade(post.length, Math.max(1, this.dryLines.length))
    }
    this.preEq.setSections(pre)
    this.postEq.setSections(post)

    this.la2a.setParams({
      ...LA2A_FIXED,
      peakReduction: finite(p.squash, SCHEPS_KERNEL_DEFAULTS.squash, 0, 100),
      // The wet path's makeup, at the stage the hardware puts it — before the
      // tube, after the cell, and therefore before the post EQ.
      gainDb: finite(p.wetTrimDb, 0, -36, 36),
      // Measurement mode propagates through: with oversampling off the whole
      // wet path is latency-free, and the dry delay below follows it to zero.
      oversample: p.oversample !== false,
      // ⚠ SO DOES THE GAIN CELL'S MODULATION, for the same reason and not as a
      // control. It is the LA-2A's dominant distortion term (Moore, JAES
      // 74(1/2):61-72) and it ships on, so Scheps carries it by inheriting the
      // kernel default — but with no pass-through there was NO WAY to difference
      // against a build without it from outside this file, which is the whole
      // job of a measurement bypass. Nothing in the app sets it.
      cellMod: p.cellMod,
      /**
       * ⚠ SCHEPS INHERITS THE THRESHOLD PROBLEM AND SO IT INHERITS THE FIX. The
       * embedded kernel is the same one, driven by `squash` into the same fixed
       * internal threshold, so how much this composite compresses is set by the
       * FILE's level exactly as OptoSmooth's is — and Scheps is worse off,
       * because `squash` is a calibrated default nobody is expected to touch, so
       * there is no knob the user would think to move. Passed straight through:
       * it is a side-chain drive offset, so it changes what the cell hears and
       * nothing about the wet path's level, which matters more here than in
       * OptoSmooth — the ceiling and the dry sum both sit downstream of it.
       */
      inputAlignDb: finite(p.inputAlignDb, 0, -60, 60),
      /**
       * ⚠ LAST, SO THE BENCH WINS — and only over the keys it actually carries.
       * `la2aTuningOverrides` emits nothing while the tuning panel is untouched,
       * so this spread is empty on every normal render and the allowlist above
       * stands unchanged. When it is not empty it may override `cellMod`, which
       * is the point: the bench exists to move exactly these constants, and
       * OptoSmooth has followed it since it shipped.
       *
       * It cannot reach `LA2A_FIXED`'s pins — the tuning carries no `r37`,
       * `mode`, `mix` or `lookaheadMs` — so Scheps' own fixed decisions survive
       * a tuning session intact.
       */
      ...(p.la2aTuning ?? {}),
    })

    this.outputLin = Math.exp(finite(p.outputDb, 0, -24, 24) * LN10_OVER_20)

    /**
     * OUTPUT CEILING, dBFS. Null/absent is off and skips the branch entirely.
     *
     * ⚠ IT IS AT THIS PLUGIN'S OUTPUT AND NOT ON THE EMBEDDED LA-2A, AND THAT IS
     * THE WHOLE POINT OF PUTTING IT HERE. In OptoSmooth the kernel IS the last
     * stage, so its internal ceiling bounds what leaves. Here the same kernel is
     * mid-chain — the post EQ and the dry sum both come after it — so a ceiling
     * inside it would clamp the wet path and then be undone by everything
     * downstream. `LA2A_FIXED` therefore never sets `ceilingDb`, and this does.
     *
     * ⚠ AND SCHEPS NEEDS ONE MORE THAN OPTOSMOOTH DID. Measured on narration
     * with the auto trim: the output ran up to 5.37 dB OVER the source peak and
     * reached +2.57 dBFS at Squash 90 / Mix 1 — it clipped, and had done since
     * the plugin shipped. A parallel blend sums two paths; nothing in the trim
     * bounds their sum.
     */
    this.ceilingLin = Number.isFinite(p.ceilingDb)
      ? float32AtOrBelow(Math.exp(p.ceilingDb * LN10_OVER_20)) : 0
    /**
     * ⚠ SIZED BY THE SOLVE, AND THIS PLUGIN IS WHY IT HAD TO BE. A fixed 3 dB
     * knee cost 0.63 dB of peak at Mix 0, where this kernel is otherwise
     * BIT-EXACT against the delayed input — the ceiling is the source peak and
     * at low Mix the output is approximately the source, so the peak sample
     * lands where the knee is deepest by construction. See `ceilingKneeDbFor`.
     * `CEILING_KNEE_DB` remains the cap and the fallback, so a ceiling handed
     * over without a width behaves exactly as it used to.
     */
    /**
     * ⚠ THE OUTPUT TRIM WIDENS IT, BECAUSE THE TRIM IS APPLIED BEFORE THE
     * CEILING AND CAN MOVE AFTER THE SOLVE. `outputLin` multiplies the summed
     * blend on the line above the ceiling, and Output is a manual knob that AUTO
     * does not own — so a user can add up to 12 dB to a peak the knee was sized
     * for at 0 dB and turn a soft knee into a hard clamp. The solve renders at
     * `outputDb: 0` (see `renderWetPath`), so the trim above zero is exactly the
     * unmeasured extra and adding it back is exactly the right widening. A
     * NEGATIVE trim is ignored: it only moves the signal further under the
     * ceiling, where a narrower knee is already correct and free.
     */
    const solvedKneeDb = Number.isFinite(p.ceilingKneeDb)
      ? clamp(p.ceilingKneeDb, 0, CEILING_KNEE_DB) : CEILING_KNEE_DB
    const trimHeadroomDb = Math.max(0, finite(p.outputDb, 0, -24, 24))
    const ceilingKneeDb = Number.isFinite(p.ceilingKneeDb)
      ? clamp(solvedKneeDb + trimHeadroomDb, 0, CEILING_KNEE_DB)
      : CEILING_KNEE_DB
    this.ceilingKneeLin = this.ceilingLin > 0
      ? this.ceilingLin * Math.exp(-ceilingKneeDb * LN10_OVER_20) : 0
    this._updateMix()

    // The dry delay has to match the wet path's latency exactly; rebuild it if
    // the compressor's latency moved (it only does between measurement mode and
    // the audible path, which never happens on a running preview).
    const latency = this.la2a.latencySamples
    if (this.dryLatency !== latency) {
      this.dryLatency = latency
      this.dryLines = this.dryLines.map(() => new DelayLine(latency))
    }
  }

  _updateMix() {
    const { dry, wet, compensation } = mixGains(
      this.params.mix, this.params.correlation, this.params.densityDb,
    )
    this.dryGain = dry * compensation
    this.wetGain = wet * compensation
  }

  /** Algorithmic latency, in samples — the compressor's, since the EQs are IIR. */
  get latencySamples() {
    return this.la2a.latencySamples
  }

  /** Current gain reduction, in dB (positive). */
  getReduction() {
    return this.la2a.getMetering().grDb
  }

  _ensureChannels(count) {
    this.preEq.ensureChannels(count)
    this.postEq.ensureChannels(count)
    while (this.dryLines.length < count) this.dryLines.push(new DelayLine(this.dryLatency))
    while (this.wetScratch.length < count) this.wetScratch.push(new Float32Array(128))
  }

  /**
   * Process one block.
   *
   * @param {Float32Array[]} inputChannels
   * @param {Float32Array[]} outputChannels
   * @param {number} n
   */
  process(inputChannels, outputChannels, n) {
    const nIn = inputChannels.length
    const nOut = outputChannels.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].fill(0, 0, n)
      return
    }

    this._ensureChannels(nOut)
    for (let ch = 0; ch < nOut; ch++) {
      if (this.wetScratch[ch].length < n) this.wetScratch[ch] = new Float32Array(n)
    }

    // Pre EQ into the wet scratch. Channels beyond the input count reuse the
    // last one, matching the convention in la2aProcessor.js.
    const wet = []
    for (let ch = 0; ch < nOut; ch++) {
      const src = inputChannels[ch < nIn ? ch : nIn - 1]
      const w = this.wetScratch[ch].subarray(0, n)
      this.preEq.process(src, w, n, ch)
      wet.push(w)
    }

    // One compressor across the whole wet bus: its detector is shared between
    // channels by design, so a stereo file's two sides move together.
    this.la2a.process(wet, wet, n)

    const { dryGain, wetGain, outputLin } = this
    for (let ch = 0; ch < nOut; ch++) {
      const src = inputChannels[ch < nIn ? ch : nIn - 1]
      const w = wet[ch]
      const out = outputChannels[ch]
      this.postEq.process(w, w, n, ch)

      const line = this.dryLines[ch]
      for (let i = 0; i < n; i++) {
        // Read the dry sample before writing the output, so an in-place caller
        // (input and output the same array) still works.
        const dry = line.push(src[i])
        const mixed = (dry * dryGain + w[i] * wetGain) * outputLin
        out[i] = this.ceilingLin > 0
          ? softCeiling(mixed, this.ceilingLin, this.ceilingKneeLin)
          : mixed
      }
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by the tests and by the trim measurement below; the app renders through
 * an OfflineAudioContext running the worklet, so preview and apply share the
 * same code path.
 */
export function processSchepsBuffer(channelData, sampleRate, params = {}) {
  const kernel = new SchepsKernel(sampleRate)
  kernel.setParams(params)

  const n = channelData[0].length
  const output = channelData.map(() => new Float32Array(n))
  const BLOCK = 128
  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    kernel.process(
      channelData.map(c => c.subarray(off, off + len)),
      output.map(c => c.subarray(off, off + len)),
      len,
    )
  }
  return { channelData: output, latencySamples: kernel.latencySamples }
}

/**
 * Render the wet path alone — pre EQ, compressor at the given makeup, post EQ,
 * no blend. Separate from `process` because the measurement needs the wet
 * signal before it is mixed with anything.
 */
function renderWetPath(channelData, sampleRate, params, wetTrimDb = 0) {
  const kernel = new SchepsKernel(sampleRate)
  kernel.setParams({
    ...params,
    mix: 1,
    correlation: 0,
    wetTrimDb,
    outputDb: 0,
    /**
     * ⚠ PINNED OFF, BECAUSE `params` CAN CARRY THE PREVIOUS SOLVE'S CEILING and
     * this render is what the NEXT one is measured from. Leaving it in would
     * clamp the peak this measures, and a ceiling sized from an already-ceilinged
     * render converges downward on every re-solve. It is also the same reason
     * computeAutoMakeupPlan measures without one: the solve belongs below the
     * enforcement, never through it.
     */
    ceilingDb: null,
    // Base rate: the question is what the wet path's level and shape are, and
    // oversampling moves neither by anything measurable. It also makes the wet
    // output latency-free, so it lines up with the dry input sample for sample
    // — which the correlation below depends on.
    oversample: false,
  })

  const n = channelData[0].length
  const out = channelData.map(() => new Float32Array(n))
  const BLOCK = 128
  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    kernel.process(
      channelData.map(c => c.subarray(off, off + len)),
      out.map(c => c.subarray(off, off + len)),
      len,
    )
  }
  return out
}


/**
 * Band-limit a copy of a signal to the speech range, for measurement only.
 *
 * BROADBAND RMS CANNOT MEASURE A VOICE'S LOUDNESS, and the failure is not
 * marginal. Measured on a real narrator recording: **81% of the file's total
 * energy sits between 125 and 500 Hz**, and 2–8 kHz carries **1.6%**. So a
 * broadband RMS match is, to within a rounding error, a match of the
 * fundamental region alone — which is the one part of the spectrum Thick's net
 * curve raises. The trim therefore read "already loud enough" while the entire
 * intelligibility range came out 3 dB down, and the file sounded quieter with
 * the meters saying it was level.
 *
 * K-weighting is not enough to fix it: its shelf is +4 dB above 1.7 kHz, and on
 * a band carrying 1.6% of the energy that moved the answer by 0.34 dB against a
 * 3 dB deficit. Measured, not assumed.
 *
 * A flat band-pass over the speech range is blunt, but it puts the measurement
 * where the ear decides loudness for a voice, and it is explicable in one line —
 * which a weighting curve fitted to this one recording would not be.
 */
/**
 * Level of the LOUD PARTS: the 95th percentile of 100 ms block levels, in dB.
 *
 * This is what makeup gain has always been referenced to, and it is not the
 * same as the average. A compressor earns loudness by pulling the loud moments
 * down and then handing back roughly what it took: the loud parts land back
 * where they started, everything quieter comes up by the full makeup, and the
 * average rises. Restoring the AVERAGE instead gives back only what was lost on
 * average, which by construction leaves the file exactly as loud as it started
 * — a compressor that cannot make anything louder.
 *
 * Blocks more than 40 dB below the loudest are dropped, so pauses and room tone
 * cannot drag the percentile down on a sparsely-voiced take.
 */
/** Peak sample magnitude across every channel. */
function peakOfChannels(channels) {
  let peak = 0
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i] < 0 ? -ch[i] : ch[i]
      if (v > peak) peak = v
    }
  }
  return peak
}

function loudPartDb(x, sampleRate) {
  const W = Math.round(sampleRate * 0.1)
  if (x.length < W * 4) {
    // Too short to have a level distribution; fall back to plain RMS.
    let s = 0
    for (let i = 0; i < x.length; i++) s += x[i] * x[i]
    return 10 * Math.log10(s / Math.max(1, x.length) + 1e-30)
  }
  const blocks = []
  for (let off = 0; off + W <= x.length; off += W) {
    let s = 0
    for (let i = 0; i < W; i++) s += x[off + i] * x[off + i]
    blocks.push(10 * Math.log10(s / W + 1e-30))
  }
  const loudest = Math.max(...blocks)
  const voiced = blocks.filter(v => v > loudest - 40)
  voiced.sort((a, b) => a - b)
  return voiced[Math.floor((voiced.length - 1) * 0.95)]
}

/**
 * Measure the three numbers the blend needs from the audio itself.
 *
 * `trimDb` is the wet-path makeup: the gain that puts the compressed copy's
 * LOUD PARTS back where the dry signal's are. See `loudPartDb` for why the loud
 * parts and not the average — matching the average is what made this plugin
 * incapable of making anything louder, which is not what a compressor is for.
 *
 * `densityDb` is what that buys: how much louder the wet copy's average is than
 * the dry one's, once its loud parts are level. It is the compression's actual
 * yield, and it is modest here — 1.6 dB on real narration, stable to
 * 0.013 dB across 27 dB of input level — because an opto
 * cell with a multi-second release applies nearly constant gain reduction
 * rather than selectively ducking peaks. A fast peak compressor would hand back
 * far more. The mix law passes this through rather than flattening it, so
 * pushing Mix does gently increase loudness, which is the whole point of
 * blending a compressed copy in.
 *
 * ⚠ THIS SAID "0.6 to 0.8 dB" UNTIL IT WAS MEASURED AGAIN, and the ⚠ note
 * below on the reference statistic predicted exactly that: moving to the shared
 * sample percentile moves the trim, "and therefore `densityDb` and the mix law
 * it feeds". The prediction was right and the number here was not updated with
 * it. Re-measured on 43 s of real narration.
 *
 * ALL THREE ARE MEASURED IN THE SPEECH BAND, not broadband — see `speechWeight`
 * for the measurement that forced that. Broadband energy is free to rise faster
 * than `densityDb`, because the character adds weight underneath the voice, and
 * making that weight pay for itself out of the midrange is what went wrong
 * before.
 *
 * `correlation` is the zero-lag Pearson correlation between dry and wet, in the
 * same band, so the mix law's compensation holds the same quantity the trim
 * does — see `mixGains`.
 *
 * All are measured over the region the user has selected, so they follow the
 * material rather than a table of assumptions about it.
 */
export function computeSchepsAutoTrim(channelData, sampleRate, params = {}) {
  const dryBand = channelData.map(c => speechWeight(c, sampleRate))
  // Trim must follow the same stereo picture the energy and correlation do: if
  // one side of a stereo pair is hotter, match the loudest channel rather than
  // silently measuring channel 0 alone.
  /**
   * ⚠ THE REFERENCE IS THE SHARED SAMPLE PERCENTILE NOW, NOT `loudPartDb`, so
   * both compressors answer the same question with the same statistic. It moves
   * the number a long way — on narration the dry reads -6.48 dB here against
   * -13.19 from the old P95-of-100 ms-blocks — because a sample percentile is a
   * PEAK-ish measure and a block-rms percentile is a LOUDNESS one. The trim, and
   * therefore `densityDb` and the mix law it feeds, move with it.
   *
   * ⚠ THE SPEECH BAND STAYS, and that is not an inconsistency. The statistic is
   * what the two plugins share; WHICH SIGNAL it is taken on is this plugin's own
   * problem, and Scheps has large Pultec low-frequency moves either side of the
   * compressor. Matching broadband would let those dominate the wet/dry match
   * and defeat the reason `speechWeight` exists. See `loudPartDb`, kept below
   * for the density measurement.
   *
   * Loudest channel, not channel 0: if one side of a stereo pair is hotter, the
   * trim has to follow the same stereo picture the energy and correlation do.
   */
  // ⚠ MEASURED ONCE. This ran the percentile TWICE — once for the guard and
  // again for the conversion — and each call copies and partially orders every
  // sample in the band. It is called on the dry signal and then on every
  // iteration of the trim solve, so the wasted half was a real cost, not a
  // tidiness point.
  const loudestBandDb = (bands) => {
    const level = percentileOfChannels(bands, MAKEUP_PERCENTILE)
    return level > 0 ? 20 * Math.log10(level) : -Infinity
  }
  const dryLoudDb = loudestBandDb(dryBand)

  let dryEnergy = 0
  for (const d of dryBand) for (let i = 0; i < d.length; i++) dryEnergy += d[i] * d[i]
  if (dryEnergy <= 0) {
    return { trimDb: 0, correlation: 0, densityDb: 0, ceilingDb: null, ceilingKneeDb: null }
  }

  // ITERATED, because the makeup is now the compressor's own Gain and that sits
  // BEFORE the tube stage, as on the hardware. Raising it drives the tube a
  // little harder, which moves the output level, so each pass re-measures at
  // the corrected operating point. Same reason and the same shape as
  // computeAutoMakeupDb; two passes is normally enough.
  let trimDb = 0
  let wet = null
  /**
   * The un-ceilinged BROADBAND peak of the last wet render, for sizing the
   * ceiling's knee, and the trim it was rendered at.
   *
   * ⚠ THE WET RENDER IS THE Mix 1 OUTPUT, WHICH IS WHY THIS IS FREE AND WHY IT
   * IS THE RIGHT MIX TO MEASURE. `renderWetPath` runs at `mix: 1`,
   * `correlation: 0`, `outputDb: 0`, and at Mix 1 the blend's compensation is
   * 1, so its output IS what this plugin puts out at Mix 1. That matters
   * because Mix moves AFTER the solve: measured across the knob, the
   * un-ceilinged peak runs -2.80 / -3.11 / -3.05 / -2.92 / -2.62 / -2.22 dBFS
   * at Mix 0 / .2 / .35 / .5 / .75 / 1, so Mix 1 is the worst case and Mix 0 is
   * pinned at the input peak by the bit-exact dry path. Sizing the knee at the
   * worst case means the knob cannot walk out from under it.
   *
   * ⚠ BROADBAND, NOT `speechWeight`, for the same reason `ceilingDb` below is:
   * the speech band is the right domain for MATCHING two paths and the wrong
   * one for a statement about the samples that actually leave.
   */
  let lastWetPeak = 0
  let lastTrimDb = 0
  for (let pass = 0; pass < 4; pass++) {
    const rendered = renderWetPath(channelData, sampleRate, params, trimDb)
    lastWetPeak = peakOfChannels(rendered)
    lastTrimDb = trimDb
    wet = rendered.map(c => speechWeight(c, sampleRate))
    const wetLoudDb = loudestBandDb(wet)
    if (!Number.isFinite(wetLoudDb)) break
    const correctionDb = dryLoudDb - wetLoudDb
    trimDb = clamp(trimDb + correctionDb, -24, 24)
    if (Math.abs(correctionDb) < 0.05) break
  }

  let wetEnergy = 0
  let crossEnergy = 0
  for (let ch = 0; ch < dryBand.length; ch++) {
    const d = dryBand[ch]
    const w = wet[ch]
    for (let i = 0; i < d.length; i++) {
      wetEnergy += w[i] * w[i]
      crossEnergy += d[i] * w[i]
    }
  }
  if (wetEnergy <= 0) {
    return { trimDb: 0, correlation: 0, densityDb: 0, ceilingDb: null, ceilingKneeDb: null }
  }

  // The rendered wet path ALREADY carries the makeup, so the density is the
  // straight energy ratio — no trim term to add back, unlike when the makeup
  // was a separate multiply after the post EQ.
  const densityDb = clamp(10 * Math.log10(wetEnergy / dryEnergy), -12, 12)
  // Scaling by a positive gain cannot change a normalised correlation.
  const correlation = clamp(crossEnergy / Math.sqrt(dryEnergy * wetEnergy), -1, 1)

  /**
   * ⚠ THE CEILING TRAVELS WITH THE TRIM, for the same reason it travels with
   * OptoSmooth's makeup: the percentile reference gives up the arithmetic
   * guarantee that the output cannot exceed the source, and this is what puts it
   * back. Returning them together is what stops a caller taking the level and
   * skipping the enforcement. Measured BROADBAND and on the raw input — the
   * speech band is the right domain for MATCHING two paths and the wrong one for
   * a guarantee about the samples that actually leave.
   */
  const inputPeak = peakOfChannels(channelData)
  if (!(inputPeak > 0)) {
    return { trimDb, correlation, densityDb, ceilingDb: null, ceilingKneeDb: null }
  }
  const ceilingDb = 20 * Math.log10(inputPeak)
  // One step stale, and carried forward rather than re-rendered — same
  // reasoning as computeAutoMakeupPlan's.
  const wetPeakDb = lastWetPeak > 0
    ? 20 * Math.log10(lastWetPeak) + (trimDb - lastTrimDb) : -Infinity
  return {
    trimDb,
    correlation,
    densityDb,
    ceilingDb,
    ceilingKneeDb: ceilingKneeDbFor(wetPeakDb - ceilingDb),
  }
}

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  class SchepsWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new SchepsKernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params)
      }
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
      }
      this.frame = 0
    }

    process(inputs, outputs) {
      const input = inputs[0]
      const output = outputs[0]
      if (!output || output.length === 0) return true

      const n = output[0].length
      if (!input || input.length === 0) {
        for (const ch of output) ch.fill(0)
        return true
      }

      this.kernel.process(input, output, n)

      // Gain reduction for the panel's meter, at roughly 60 Hz.
      this.frame += n
      if (this.frame >= 735) {
        this.frame = 0
        this.port.postMessage({ type: 'gr', grDb: this.kernel.getReduction() })
      }
      return true
    }
  }

  registerProcessor('scheps-processor', SchepsWorkletProcessor)
}
