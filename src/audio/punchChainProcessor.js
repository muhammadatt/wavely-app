/**
 * Punch Chain — FET Punch into OptoSmooth, as one effect.
 *
 *   in ─ FET1176Kernel ─ LA2AKernel ─ output trim ─ soft ceiling ─ out
 *        (peaks, fast)   (body, slow)
 *
 * Two dials on one plate: the FET's Input and the Opto's Peak Reduction. That
 * is the whole panel. Everything else — both units' ballistics, the FET's ratio
 * button, the Opto's R37, the two side-chain alignments, the makeup and the
 * ceiling — is fixed or measured, because none of it is a decision the person
 * mastering a voice take should have to make twice.
 *
 * ⚠ IT HOLDS BOTH KERNELS RATHER THAN COPYING EITHER, the same way Scheps holds
 * the LA-2A. Every module constant in fet1176Processor.js and la2aProcessor.js
 * — the knee law, the ballistics ladders, the taper, the cell and tube curves —
 * reaches this chain with no conforming change, and a re-fit on either side
 * lands here by construction. The cost is the same one Scheps pays: a change to
 * either kernel's DEFAULTS silently re-voices this plugin, which is why
 * `PUNCH_CHAIN_KERNEL_DEFAULTS` derives the two dials from those defaults
 * rather than restating them, and why a test pins the round trip.
 *
 * ⚠ THE TWO DIALS ARE NOT TWO KNOBS ON ONE AXIS, WHICH IS WHY BOTH ARE HERE.
 * Measured on three narration clips (density = gated RMS - P99.9, higher is
 * denser; spread = P90-P10 of phrase RMS, lower is more consistent):
 *
 *   Greenberg, FET drive 25          PR 0     PR 40    PR 60    PR 75
 *     density                       -11.70   -11.43   -11.73   -12.09
 *     phrase spread                   6.48     5.23     2.99     2.88
 *
 * The Opto's density contribution is flat to PR ~30 and NEGATIVE past ~40,
 * while its levelling keeps paying to PR ~75. It is not a second density
 * control and it never was; it buys consistency, and past its own turnover it
 * buys consistency by spending density. That trade is the plugin. The panel
 * prints both numbers rather than hiding the trade behind one macro knob.
 *
 * This file is BOTH a normal ES module (exports PunchChainKernel and
 * processPunchChainBuffer) AND an AudioWorklet module (registers
 * 'punch-chain-processor'). Its loader goes through `?worker&url` so Vite
 * bundles both kernels into one self-contained chunk — see
 * punchChainWorkletLoader.js.
 */

import {
  FET1176Kernel, FET1176_KERNEL_DEFAULTS, processFET1176Buffer,
} from './fet1176Processor.js'
import {
  LA2AKernel, LA2A_KERNEL_DEFAULTS, processLA2ABuffer,
} from './la2aProcessor.js'
import {
  CEILING_KNEE_DB, softCeiling, float32AtOrBelow, ceilingKneeDbFor,
  percentileOfChannels, peakOfChannels, MAKEUP_PERCENTILE,
} from './dsp/makeupReference.js'
import {
  inputAlignDbFor, gatedRmsOfChannels, ALIGN_MAX_DB,
} from './dsp/inputAlign.js'
import { detectPhrases, measureChainMetrics } from './dsp/densityMetrics.js'

const LN10_OVER_20 = Math.LN10 / 20

/**
 * FET Punch settings this chain fixes, and why none of them is on the plate.
 *
 * `ratio: '4'` — the gentlest button, and the one the measurements say to use.
 * Higher ratios at low drive do reduce onset overshoot a little (Greenberg at
 * drive 25: 1.99 dB at ratio 4, 1.16 at ratio 20) but only by doing less of
 * everything — phrase spread goes 6.08 -> 7.76 over the same change. The button
 * is a character control, not a density or a peak-duty one.
 *
 * ⚠ AND IT IS NOT A FREE CHOICE ANY MORE: `ratioThreshold: 'moving'` ships, so
 * the button moves the threshold 1.712 dB per octave. Putting it on this plate
 * would mean a third control that shifts what the Input dial does, which is the
 * interaction this design exists to remove.
 *
 * `attack: 4` / `release: 4` — the kernel's own defaults, and the measured
 * answer to "should the chain auto-set a fast attack so the FET does peak
 * duty". It should not. Onset overshoot at drive 25 / ratio 4 across the attack
 * dial, three clips:
 *
 *   dial               1       4       7
 *   Messy and Bright  3.45    3.89    4.05
 *   art_test          0.49    1.15    1.59
 *   Greenberg         1.27    1.74    1.99
 *
 * A faster attack ducks more body behind an onset that still gets through the
 * first few hundred microseconds, so overshoot goes UP, monotonically, on every
 * file. Nothing in either kernel reduces onset overshoot without lookahead; see
 * the note on LA2A_FIXED.
 */
const FET_FIXED = {
  ratio: FET1176_KERNEL_DEFAULTS.ratio,
  attack: FET1176_KERNEL_DEFAULTS.attack,
  release: FET1176_KERNEL_DEFAULTS.release,
  /**
   * ⚠ PINNED TO ZERO AND NULL BECAUSE THE COMPOSITE OWNS BOTH. A makeup inside
   * the FET would be re-compressed by the Opto behind it, so the two stages
   * would fight over the same level; a ceiling inside the FET would be undone
   * by the Opto and the trim that come after it. `makeupReference.js` states
   * the rule for the ceiling — it has to be the LAST thing before the output —
   * and this chain is the case that rule was written against.
   */
  outputGainDb: 0,
  ceilingDb: null,
  ceilingKneeDb: null,
}

/**
 * OptoSmooth settings this chain fixes.
 *
 * `mode: 'compress'` because this is levelling. `mix: 1` because there is no
 * parallel blend here — that plugin is Scheps.
 *
 * `r37: 100` (flat side-chain, the factory position) and NOT Scheps' `r37: 0`.
 * The trick there is to make the cell ride the presence band so it stops
 * ducking on plosives, and it is the thing that plugin is named for. Measured
 * here it does not pay: at PR 60 behind the FET, r37 0 vs 100 moves density
 * +0.09 dB and phrase spread 3.15 -> 4.69 on Greenberg, 3.08 -> 3.48 on
 * art_test. It costs the levelling that is the Opto's entire job in this chain.
 *
 * `lookaheadMs: 0` — the hardware, and NOT what the measurements want long
 * term. ⚠ THIS IS THE ONE KNOWN-UNFINISHED DECISION IN THE PLUGIN. Lookahead
 * is the only thing in either kernel that reduces onset overshoot, and at 10 ms
 * it is drastic: behind the FET at PR 60, overshoot goes 3.73 -> -7.48 dB on
 * Greenberg and 4.71 -> -7.63 on Messy and Bright, i.e. the onset ends up
 * QUIETER than the body it introduces, which is over-control and will sound
 * sucked. It also recovers 0.5-0.6 dB of the density the Opto gives away past
 * its turnover and improves phrase spread, so it is not a bad idea — it is an
 * untuned one. Some smaller value (2-5 ms) is the follow-up; shipping 10 would
 * re-voice the plugin on a number nobody has listened to.
 *
 * ⚠ CHANGING IT IS NOT A ONE-LINE EDIT: `lookaheadMs` moves the LA-2A kernel's
 * latency, so `PUNCH_CHAIN_LATENCY_SAMPLES` would have to become per-patch
 * first — the same blocker Scheps records against its own copy of this note.
 */
const LA2A_FIXED = {
  mode: 'compress',
  r37: LA2A_KERNEL_DEFAULTS.r37,
  mix: 1,
  lookaheadMs: 0,
  /** Pinned for the same reason as the FET's — see FET_FIXED. */
  gainDb: 0,
  ceilingDb: null,
  ceilingKneeDb: null,
}

/**
 * Pre-roll for the offline apply path, seconds. See applyWorkletRegion.
 *
 * The max of the two kernels' own pre-rolls, which are both 2 s and both
 * measured — FET1176_PREROLL_S is bit-exact since `ALL_TAIL_FRACTION` went to
 * 0, LA2A_PREROLL_S is bit-exact on the adversarial probe. Running them in
 * series does not lengthen either one's memory: the FET settles within its own
 * pre-roll and hands the Opto a settled signal, so the Opto's 2 s is measured
 * against exactly the input it will see.
 */
export const PUNCH_CHAIN_PREROLL_S = 2

export const PUNCH_CHAIN_KERNEL_DEFAULTS = {
  /**
   * The FET's Input dial, 0-100 — drive into its fixed threshold.
   *
   * ⚠ NOT THE KERNEL'S OWN DEFAULT OF 50, AND THE DIFFERENCE IS MEASURED. 50 is
   * where the FET's density peaks on all three narration clips (turnover at
   * drive 50 on every one of them, which is input alignment doing its job), but
   * it is also where the FET has flattened the body so thoroughly that the Opto
   * behind it has nothing left to do — its density curve is dead flat from PR 0
   * to 30 there, and phrase spread is already down to 3.55 from a source 8.54.
   * A chain whose second stage is inert at the first stage's default is a chain
   * with one useful knob.
   *
   * 30 sits in the region where both dials still move the sound: on Greenberg
   * it delivers roughly -11.1 density against a -14.59 source with spread still
   * at ~6, which is the Opto's to take down.
   */
  drive: 30,
  /**
   * The Opto's Peak Reduction, 0-100.
   *
   * 40 is just past the point where the Opto starts doing anything at all
   * (its density curve is flat to ~30 on every clip) and short of where it
   * starts spending density for levelling in earnest. On Greenberg at drive 25
   * this is the one cell in the whole grid where the Opto ADDS density behind
   * the FET: -11.70 -> -11.43.
   */
  peakReduction: 40,
  /**
   * Manual trim on the summed output, dB. The measured makeup rides separately
   * in `makeupDb` so that AUTO can own one while the user owns the other —
   * the contract OptoSmooth's Gain knob already has.
   */
  outputDb: 0,
  /**
   * Solved makeup, dB — restores the chain's output to the source's level.
   * Measured per region by `computePunchChainPlan`; zero means unmeasured, not
   * "no makeup needed".
   */
  makeupDb: 0,
  /**
   * Side-chain drive offset for the FET, dB — the file's own level relative to
   * nominal. See dsp/inputAlign.js.
   */
  fetAlignDb: 0,
  /**
   * Side-chain drive offset for the Opto, dB, measured on THE FET'S OUTPUT.
   *
   * ⚠ THIS IS THE ONE THING THAT MAKES TWO DIALS ON ONE PLATE BEHAVE LIKE TWO
   * DIALS. The Opto's threshold is fixed, so what a Peak Reduction position
   * DOES is set by the level arriving at it — which the Input dial in front of
   * it moves. Without this, turning Input also turns the Opto, the two controls
   * interact through level, and the panel is unlearnable.
   *
   * It is not a small correction: measured on the three narration clips at the
   * FET's own turnover it runs +8.15, +9.49/+12.10 and +9.63/+12.50 dB. A
   * plugin that omitted it would have its second dial mean something different
   * on every file AND at every position of its first dial.
   *
   * ⚠ A DRIVE OFFSET, NOT A GAIN. It changes what the Opto's detector hears and
   * nothing else — no level is added to the audio, so there is no trim to
   * cancel downstream and the output tube is untouched. Same argument as
   * `inputAlignDb` on either kernel, which is the parameter it is passed as.
   */
  optoAlignDb: 0,
  /**
   * Output ceiling, dBFS, and its knee width — the source's own peak, measured
   * with the makeup. Null is off.
   *
   * ⚠ THESE AND THE MAKEUP ARE ONE MECHANISM, and at the COMPOSITE's output
   * rather than inside either kernel. See FET_FIXED.
   */
  ceilingDb: null,
  ceilingKneeDb: null,
  /**
   * Run both gain cells and both saturators oversampled. Always true for
   * anything anyone listens to; `computePunchChainPlan` is the one caller that
   * turns it off, for the reason `computeAutoMakeupPlan` documents — measuring
   * through the oversampled path was about three times slower and moved the
   * measured peak by ~0.001 dB.
   */
  oversample: true,
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Clamp, rejecting anything non-finite.
 *
 * Params reach this kernel over a message port from UI state, so one undefined
 * or NaN is always one bug away — and both embedded kernels hold persistent
 * envelope state, so a single non-finite push makes the effect silent until the
 * page is reloaded. `clamp` alone cannot catch it: `undefined < lo` and
 * `undefined > hi` are both false, so it returns undefined unchanged. Same
 * guard, same reason, as `finite` in schepsProcessor.js.
 */
function finite(v, fallback, lo, hi) {
  return Number.isFinite(v) ? clamp(v, lo, hi) : fallback
}

/**
 * ── THE THREE STAGES, AS PARAMS, IN ONE PLACE EACH ──────────────────────────
 *
 * ⚠ EXTRACTED BECAUSE TWO CALLERS NEED THEM AND A SECOND COPY WOULD DRIFT
 * SILENTLY. The kernel builds its two embedded compressors from these, and
 * `computePunchChainPlan` renders the same two stages SEPARATELY — it has to,
 * because the opto's alignment is a measurement of the FET's output and cannot
 * be known before the FET has run. Two descriptions of "what the opto stage is"
 * would let the measured plan and the audible render disagree about the plugin,
 * which is the one failure neither a listening test nor a render diff would
 * show: both would be internally consistent and describe different plugins.
 *
 * `test/dsp/punchChain.test.js` renders the audible path and re-measures it
 * against the plan's own readouts, so a drift here fails a test.
 */
function fetStageParams(p, oversample) {
  return {
    ...FET_FIXED,
    oversample,
    inputDrive: finite(p.drive, PUNCH_CHAIN_KERNEL_DEFAULTS.drive, 0, 100),
    inputAlignDb: finite(p.fetAlignDb, 0, -48, 48),
    ...(p.fetTuning ?? {}),
  }
}

function optoStageParams(p, oversample) {
  return {
    ...LA2A_FIXED,
    oversample,
    peakReduction: finite(
      p.peakReduction, PUNCH_CHAIN_KERNEL_DEFAULTS.peakReduction, 0, 100,
    ),
    inputAlignDb: finite(p.optoAlignDb, 0, -48, 48),
    /**
     * ⚠ NESTED RATHER THAN SPREAD FLAT, for the reason schepsParams.js records:
     * these are the embedded compressor's params, not this chain's, and
     * flattening would let a shared key name collide silently on whichever
     * spread came last.
     */
    ...(p.la2aTuning ?? {}),
  }
}

/**
 * The output stage — the makeup, the user's trim and the ceiling — as the three
 * linear coefficients that implement it.
 *
 * ⚠ THE WHOLE STAGE IS POINTWISE, WHICH IS WHAT MAKES THE MEASUREMENT PASS
 * CHEAP. Nothing here has memory, so applying it to an already-rendered buffer
 * is arithmetic rather than a second trip through two compressors. The plan
 * used to re-render the entire chain to find out what a scalar and a clamp
 * would do: 598 ms of the 2100 ms pass, for ~1 ms of work.
 */
function outputStageFor(p) {
  // The solved makeup and the user's trim are two different things that land on
  // the same multiply — see `outputDb` and `makeupDb`.
  const gainDb = finite(p.makeupDb, 0, -24, 24) + finite(p.outputDb, 0, -24, 24)
  const outputLin = Math.exp(gainDb * LN10_OVER_20)

  /**
   * ⚠ ROUNDED DOWN INTO FLOAT32 so the clamp is exactly representable and the
   * "never louder than the source" guarantee survives the store. See
   * `float32AtOrBelow`.
   */
  const ceilingLin = Number.isFinite(p.ceilingDb)
    ? float32AtOrBelow(Math.exp(finite(p.ceilingDb, 0, -96, 24) * LN10_OVER_20))
    : 0

  /**
   * ⚠ THE SOLVED KNEE IS WIDENED BY A POSITIVE MANUAL TRIM, exactly as Scheps
   * does. The knee was sized against the render the solve saw; a user who then
   * adds output gain pushes more into the ceiling than was measured, and
   * widening by that much is the right correction. A NEGATIVE trim is ignored —
   * it only moves the signal further under the ceiling, where a narrower knee
   * is already correct and free.
   */
  const solvedKneeDb = Number.isFinite(p.ceilingKneeDb)
    ? clamp(p.ceilingKneeDb, 0, CEILING_KNEE_DB) : CEILING_KNEE_DB
  const trimHeadroomDb = Math.max(0, finite(p.outputDb, 0, -24, 24))
  const ceilingKneeDb = Number.isFinite(p.ceilingKneeDb)
    ? clamp(solvedKneeDb + trimHeadroomDb, 0, CEILING_KNEE_DB)
    : CEILING_KNEE_DB
  const ceilingKneeLin = ceilingLin > 0
    ? ceilingLin * Math.exp(-ceilingKneeDb * LN10_OVER_20) : 0

  return { outputLin, ceilingLin, ceilingKneeLin }
}

/**
 * That stage, applied to an already-rendered buffer. New arrays; the input is
 * left alone because the plan measures both.
 */
function applyOutputStage(channels, { outputLin, ceilingLin, ceilingKneeLin }) {
  return channels.map((ch) => {
    const out = new Float32Array(ch.length)
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i] * outputLin
      out[i] = ceilingLin > 0 ? softCeiling(v, ceilingLin, ceilingKneeLin) : v
    }
    return out
  })
}

export class PunchChainKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.fet = new FET1176Kernel(sampleRate)
    this.la2a = new LA2AKernel(sampleRate)

    this.midScratch = [] // FET output, Opto input — grown on demand

    this.params = { ...PUNCH_CHAIN_KERNEL_DEFAULTS }
    this.outputLin = 1
    this.ceilingLin = 0
    this.ceilingKneeLin = 0
    this.setParams({})
  }

  setParams(params) {
    const p = { ...this.params, ...params }
    this.params = p

    const oversample = p.oversample !== false
    this.fet.setParams(fetStageParams(p, oversample))
    this.la2a.setParams(optoStageParams(p, oversample))

    const { outputLin, ceilingLin, ceilingKneeLin } = outputStageFor(p)
    this.outputLin = outputLin
    this.ceilingLin = ceilingLin
    this.ceilingKneeLin = ceilingKneeLin
  }

  /**
   * Algorithmic latency, in samples — both kernels', summed, because they are
   * in series. Read from the kernels rather than restated so a change to either
   * one's oversampling or lookahead lands here on its own.
   */
  get latencySamples() {
    return this.fet.latencySamples + this.la2a.latencySamples
  }

  /**
   * Gain reduction, in dB (positive), as the two stages' sum.
   *
   * ⚠ A SUM OF TWO INSTANTANEOUS READINGS, WHICH IS NOT THE SAME AS THE CHAIN'S
   * TOTAL REDUCTION AT ANY ONE SAMPLE — the Opto's figure is measured on audio
   * the FET already reduced, and the two envelopes move at very different
   * speeds. It is the right thing for a meter (it shows the chain working, and
   * each stage's share is visible on the panel separately) and the wrong thing
   * to compute a makeup from, which is why the makeup is solved on a render
   * instead.
   */
  getReduction() {
    return this.fet.grDb + this.la2a.getMetering().grDb
  }

  /** Each stage's current reduction, for the panel's two meters. */
  getStageReduction() {
    return { fetDb: this.fet.grDb, optoDb: this.la2a.getMetering().grDb }
  }

  _ensureChannels(count) {
    while (this.midScratch.length < count) this.midScratch.push(new Float32Array(128))
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
      if (this.midScratch[ch].length < n) this.midScratch[ch] = new Float32Array(n)
    }

    // Channels beyond the input count reuse the last one, matching the
    // convention in la2aProcessor.js.
    const mid = []
    for (let ch = 0; ch < nOut; ch++) {
      mid.push(this.midScratch[ch].subarray(0, n))
    }
    const fetIn = []
    for (let ch = 0; ch < nOut; ch++) fetIn.push(inputChannels[ch < nIn ? ch : nIn - 1])

    // One detector per stage across the whole bus, by both kernels' design, so
    // a stereo file's two sides move together.
    this.fet.process(fetIn, mid, n)
    this.la2a.process(mid, mid, n)

    const { outputLin, ceilingLin, ceilingKneeLin } = this
    for (let ch = 0; ch < nOut; ch++) {
      const m = mid[ch]
      const out = outputChannels[ch]
      for (let i = 0; i < n; i++) {
        const v = m[i] * outputLin
        out[i] = ceilingLin > 0 ? softCeiling(v, ceilingLin, ceilingKneeLin) : v
      }
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by the tests and by the measurement pass below; the app renders through
 * an OfflineAudioContext running the worklet, so preview and apply share the
 * same code path.
 */
export function processPunchChainBuffer(channelData, sampleRate, params = {}) {
  const kernel = new PunchChainKernel(sampleRate)
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
  return {
    channelData: output,
    latencySamples: kernel.latencySamples,
    metering: kernel.getStageReduction(),
  }
}

/**
 * Everything this plugin measures for a region, in one pass: the two side-chain
 * alignments, the makeup, the ceiling that makes the makeup safe, and the two
 * readouts the plate prints.
 *
 * ⚠ ONE FUNCTION RATHER THAN FIVE BECAUSE THEY ARE ORDERED AND EACH DEPENDS ON
 * THE LAST. The Opto's alignment cannot be measured until the FET has been
 * rendered, because it is a property of what the FET hands it — which moves
 * every time the Input dial does. The makeup cannot be solved until both
 * alignments are known, because they decide how much either stage compresses.
 * Handing these out as independent helpers would let a caller measure them in
 * the wrong order and get a plugin whose second dial drifts with its first.
 *
 * ⚠ THE READOUTS ARE MEASURED ON A RENDER CARRYING THE MAKEUP AND THE CEILING,
 * not predicted from the settings and not taken from the solve's last pass. The
 * makeup is a scalar and density is invariant to it, so it would be tempting to
 * measure before it — but the CEILING is not a scalar, and it lands on exactly
 * the samples the density reference is read from. The panel is telling the user
 * what came out; it has to measure what came out. Same rule the loudness
 * normalize panel holds.
 *
 * ⚠ THAT RENDER RUNS AT BASE RATE, WHICH IS THE ONE PLACE THIS PASS IS NOT THE
 * AUDIBLE PATH. Oversampling the two saturators costs 3x and moves neither
 * readout: measured on the three narration clips, density differs by 0.028,
 * 0.015 and 0.014 dB and spread by 0.014, 0.003 and 0.001 dB — an order of
 * magnitude below the 0.1 dB the plate prints. The solve above is base rate for
 * the same reason `computeAutoMakeupPlan` is.
 *
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * ⚠ NO ITERATION COUNT OR TOLERANCE ANY MORE. It used to take both, because
 * the makeup was solved by rendering repeatedly; the makeup is now closed form
 * and exact, so there is nothing for either to tune. See the note on the solve
 * below for why this chain gets to do that and OptoSmooth does not.
 *
 * @param {object} params  the two dials, plus any tuning overrides
 * @returns {{ fetAlignDb: number, optoAlignDb: number, makeupDb: number,
 *             ceilingDb: number|null, ceilingKneeDb: number|null,
 *             sourceDensityDb: number, sourceSpreadDb: number,
 *             densityDb: number, spreadDb: number }}
 */
export function computePunchChainPlan(channelData, sampleRate, params = {}) {
  const p = { ...PUNCH_CHAIN_KERNEL_DEFAULTS, ...params }

  /**
   * ⚠ TAKEN FROM THE CALLER WHEN IT HAS ONE, because alignment must see the
   * WHOLE FILE and this function is handed a capped analysis window. A
   * per-selection offset makes the plugin a different compressor on every
   * selection — compress a phrase, then the paragraph containing it, and the
   * phrase comes out differently the second time. `regionAlignDb` is the app's
   * whole-file measurement; offline callers and tests pass nothing and get the
   * buffer's own, which is the whole file for them.
   */
  const fetAlignDb = Number.isFinite(params.fetAlignDb)
    ? params.fetAlignDb
    : inputAlignDbFor(channelData, sampleRate)

  /**
   * The FET alone, to see what the Opto will actually be fed.
   *
   * ⚠ RENDERED RATHER THAN ESTIMATED. The FET's output level is not the input
   * level plus a knob — it is the input level after a program-dependent gain
   * cell and a saturator, which is exactly the quantity alignment exists to
   * read off real audio rather than infer.
   */
  const fetOnly = processFET1176Buffer(
    channelData, sampleRate, fetStageParams({ ...p, fetAlignDb }, false),
  ).channelData

  /**
   * The Opto's offset, as the FET's own offset MINUS what the FET did to the
   * level — not as a fresh measurement of the FET's output.
   *
   * ⚠ THE DIFFERENCE IS WHICH SPAN EACH HALF IS MEASURED OVER, AND IT IS THE
   * WHOLE POINT. Measuring the rendered window directly would anchor the Opto
   * to a 30-second excerpt while the FET in front of it is anchored to the
   * file, so the second dial would drift with the selection even though the
   * first one no longer does — the per-selection inconsistency, reintroduced
   * one stage downstream. A DELTA cancels the window's own level to first
   * order, so `fetAlignDb - delta` is the offset the whole file would have
   * produced, from a window-sized render.
   *
   * Identical arithmetic to measuring directly when the buffer IS the whole
   * file (delta is then taken over the same samples), so the offline path and
   * the tests are unaffected by the generalisation.
   */
  const srcRms = gatedRmsOfChannels(channelData, sampleRate)
  const fetRms = gatedRmsOfChannels(fetOnly, sampleRate)
  const deltaDb = srcRms > 0 && fetRms > 0
    ? 20 * Math.log10(fetRms / srcRms) : 0
  // Clamped like `alignDbForRms` does, which this arithmetic bypasses.
  const optoAlignDb = clamp(fetAlignDb - deltaDb, -ALIGN_MAX_DB, ALIGN_MAX_DB)

  /**
   * The chain's output with NO makeup, no trim and no ceiling — the one render
   * everything below is computed from.
   *
   * ⚠ THE OPTO STAGE ALONE, ON THE FET RENDER ABOVE, RATHER THAN THE COMPOSITE
   * OVER THE SOURCE. The composite would re-run the FET for a result that is
   * already in hand: its output cannot depend on the opto's dial, and the opto
   * cannot run until its alignment is known, which needs the FET's output. The
   * ordering is forced, so the staged render is not an optimisation of the
   * composite — it is what the composite would have to do anyway, minus the
   * duplicate.
   *
   * Base rate, and ceiling off, for the two reasons `computeAutoMakeupPlan`
   * gives: oversampling costs 3x and moves the measured peak by ~0.001 dB, and
   * a ceiling in the measurement takes the objective off its monotone branch.
   */
  const base = processLA2ABuffer(
    fetOnly, sampleRate, optoStageParams({ ...p, optoAlignDb }, false),
  ).channelData

  /**
   * ── THE MAKEUP, IN CLOSED FORM ──────────────────────────────────────────
   *
   * ⚠ ONE RENDER, NOT AN ITERATION, AND THE REASON IS STRUCTURAL RATHER THAN A
   * TOLERANCE JUDGEMENT. This chain's makeup is the LAST multiply, after both
   * saturators, so the output is exactly linear in it: measured,
   * `render(6 dB)` and `render(0 dB) * 10^(6/20)` agree to 1.5e-8, which is
   * float32 rounding. A scale factor commutes with a percentile, so the gain
   * that lands the render's reference on the source's is a division, and
   * iterating only spends a second render confirming it.
   *
   * ⚠ THIS IS EXACTLY THE DISTINCTION CLAUDE.md DRAWS BETWEEN THE TWO EMBEDDED
   * PLUGINS, and it decides which of them this chain resembles. OptoSmooth must
   * iterate because its output valve sits AFTER the makeup amp, so its output
   * is not affine in the gain; FET Punch's Output is the last multiply and one
   * render answers it. Ours is the FET case. If a stage is ever added after
   * this multiply — a saturator, a limiter, anything with a curve — this stops
   * being true and the iteration has to come back. `solveMakeupPlan` is still
   * the right tool for that day.
   *
   * ⚠ PERCENTILE, WHICH IS WHY THERE IS A CEILING AT ALL. A peak reference lets
   * one uncompressed onset pin the whole region's makeup, and on syllabic
   * narration that makes the dials run BACKWARDS — both embedded plugins
   * shipped that defect and both were fixed this way.
   */
  const inputRef = percentileOfChannels(channelData, MAKEUP_PERCENTILE)
  const baseRef = percentileOfChannels(base, MAKEUP_PERCENTILE)
  const makeupDb = inputRef > 0 && baseRef > 0
    ? clamp(20 * Math.log10(inputRef / baseRef), -24, 24)
    : 0

  /**
   * The ceiling is the source's own peak, and the knee is sized to the overshoot
   * this render actually has — which is the un-ceilinged peak, scaled by the
   * makeup, because the makeup is a scalar.
   *
   * ⚠ THE APP OVERWRITES `ceilingDb` WITH THE WHOLE REGION'S PEAK. This one is
   * measured over whatever buffer we were handed, which for the app is a capped
   * window; `processing.js` re-measures it over the whole region because "never
   * louder than the source" is a claim about the source, not about its first
   * thirty seconds. Kept here so the offline path and the tests get a complete
   * plan from one call.
   */
  const inputPeak = peakOfChannels(channelData)
  const basePeak = peakOfChannels(base)
  const ceilingDb = inputPeak > 0 ? 20 * Math.log10(inputPeak) : null
  const outPeakDb = basePeak > 0 ? 20 * Math.log10(basePeak) + makeupDb : -Infinity
  const ceilingKneeDb = ceilingDb === null
    ? null : ceilingKneeDbFor(outPeakDb - ceilingDb)

  /**
   * The readouts, measured on the audible render — reached by applying the
   * output stage to `base` rather than by rendering the chain again.
   *
   * ⚠ NOT AN APPROXIMATION OF THE RENDER, THE RENDER ITSELF. `applyOutputStage`
   * is the same arithmetic `PunchChainKernel.process` performs on its last
   * pass, from the same `outputStageFor`, and the stage is pointwise — so this
   * is bit-identical to re-running both compressors and then their output
   * stage, at none of the cost. The test suite renders the audible path and
   * re-measures it against these numbers rather than trusting that claim.
   */
  const phrases = detectPhrases(channelData, sampleRate)
  const source = measureChainMetrics(channelData, sampleRate, phrases)
  const rendered = applyOutputStage(
    base, outputStageFor({ ...p, makeupDb, ceilingDb, ceilingKneeDb }),
  )
  const out = measureChainMetrics(rendered, sampleRate, phrases)

  return {
    fetAlignDb,
    optoAlignDb,
    makeupDb,
    ceilingDb,
    ceilingKneeDb,
    sourceDensityDb: source.densityDb,
    sourceSpreadDb: source.spreadDb,
    densityDb: out.densityDb,
    spreadDb: out.spreadDb,
  }
}

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  // Post metering every ~21 ms at 44.1 kHz — enough for a smooth meter without
  // flooding the message port. Same cadence as the two embedded plugins.
  const METER_INTERVAL_SAMPLES = 1024

  class PunchChainWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new PunchChainKernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params)
      }
      this.sinceMeter = 0
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
      }
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

      this.sinceMeter += n
      if (this.sinceMeter >= METER_INTERVAL_SAMPLES) {
        this.sinceMeter = 0
        const { fetDb, optoDb } = this.kernel.getStageReduction()
        this.port.postMessage({ type: 'gr', grDb: fetDb + optoDb, fetDb, optoDb })
      }
      return true
    }
  }

  /**
   * Guarded for the reason la2aProcessor.js guards its own: this chunk bundles
   * a second copy of BOTH embedded kernels, and loading this worklet alongside
   * OptoSmooth's, FET Punch's or Scheps' puts two registrations of the same
   * name into one AudioContext. Already-registered is the desired state, so
   * swallow exactly that and nothing else.
   */
  try {
    registerProcessor('punch-chain-processor', PunchChainWorkletProcessor)
  } catch (err) {
    if (err?.name !== 'NotSupportedError') throw err
  }
}
