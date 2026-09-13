/**
 * VOCAL CHAIN — DYNAMICS SOLVE.
 *
 * Turns one macro (Density) into the dynamics section's device settings, by
 * measuring the material rather than by mapping knob to knob.
 *
 * ── ⚠ THE "DESCENDING CREST LADDER" IN THE SPEC IS WRONG, AND THIS IS WHY ───
 *
 * The design said: one crest budget, allocated down a ladder — clipper takes a
 * fixed shave, FET the fast component, opto the syllabic residue. That assumes
 * the three devices move the same number in the same direction. Measured, they
 * do not. Crest is `peak - gated body`, and it is invariant under gain, so
 * makeup cannot explain any of this.
 *
 *   FET, drive 0 -> 100      peak -29.9 -> -6.2   body -40.2 -> -16.5
 *                            p99.9 - body   9.29 -> 7.70   monotonic DOWN
 *
 *   Opto, squash 0 -> 100    peak -10.5 -> -18.5  body -21.4 -> -41.1
 *                            crest          8.45 -> 15.87  monotonic UP
 *
 * ⚠ THE OPTO INCREASES PEAK-TO-BODY, AND THAT IS THE T4 WORKING CORRECTLY. Its
 * attack is ~10 ms, so it does not catch transients at all — it rides the body
 * and lets onsets through. At squash 100 it pulls the body down 19.7 dB while
 * the peak falls 8.2. A compressor that reduced crest would be a different
 * compressor; this one reduces LEVEL VARIANCE, which is what it is for.
 *
 * ⚠ AND IT IS NOT A LEVELLER IN THIS CHAIN AT ALL — MEASURED ON REAL NARRATION,
 * WHICH OVERTURNED HOW THIS SOLVE FIRST WORKED.
 *
 * The opto was originally SEARCHED for the squash that minimised block-level
 * spread, on synthetic material where that curve had a clean minimum at ~50.
 * On 35 s of real narration there is no minimum and no improvement anywhere:
 *
 *   post-FET spread          3.663 dB
 *   opto at squash 0         4.774      <- worse before it does anything
 *   opto at squash 15        4.771      <- the "best" the search could find
 *   opto at squash 50        5.660
 *
 * Two causes, both real. The Pultec POST stage's low boost dominates the
 * statistic — pre-only reads 2.609 against 5.449 for pre+post, with no opto in
 * either — and the opto itself raises spread monotonically from ~20 upward
 * because it rides the body and lets onsets through. The synthetic minimum was
 * an artifact of a stimulus carrying a slow sinusoidal amplitude envelope,
 * which is exactly the long-term variation an opto CAN track and is not what
 * narration's variance looks like.
 *
 * ⚠ SO SQUASH IS A CALIBRATED CONSTANT, NOT A SEARCH. Evening out phrase-to-
 * phrase level is the LEVEL section's job and it does it far better (spread sd
 * 5.75 -> 1.60 where this cannot improve it at all). What the opto contributes
 * here is a parallel glue layer, whose depth is a character decision — and the
 * quantity that expresses it is the wet path's gain reduction, which
 * `optoAlignDb` now makes mean the same thing on every file.
 *
 * ── WHAT THIS SOLVE DOES INSTEAD ────────────────────────────────────────────
 *
 * Each device is solved on the statistic it actually controls:
 *
 *   Soft Clip   crest            bisect threshold, hard-capped depth
 *   FET Punch   p99.9 - body     bisect drive
 *   Opto        (not solved)     a calibrated depth per voicing, scaled by Density
 *
 * ⚠ AND THE HEAD IS RENDERED STAGE BY STAGE, WHICH IS NOT AN IMPLEMENTATION
 * DETAIL. Both compressors drive a fixed internal threshold, so each needs its
 * own input aligned to nominal — and in a serial chain they do not share an
 * input. Measured, the opto's input sits ~6 dB lower in gated terms than the
 * section's, and aligning it from the raw file leaves it doing 0.25 dB where
 * its own input gives 2.98. So alignment and the solve are ONE pass: every
 * stage is measured where it actually sits. See dynamicsProcessor.js.
 *
 * ⚠ EVERY TARGET NUMBER BELOW IS PROVISIONAL. They are reachable operating
 * points measured on synthetic narration, not values chosen by listening. The
 * voicings exist so that choice has somewhere to live, not because these are
 * the right numbers.
 */

import { SoftClipperKernel } from './softClipperProcessor.js'
import { FET1176Kernel } from './fet1176Processor.js'
import { LA2AKernel } from './la2aProcessor.js'
import { BiquadCascade } from './dsp/biquad.js'
import {
  clipParamsFor, fetParamsFor, optoParamsFor, pultecPairFor,
  DYNAMICS_KERNEL_DEFAULTS,
} from './dynamicsProcessor.js'
import { gatedRmsOfChannels, inputAlignDbFor } from './dsp/inputAlign.js'
import { percentileOfChannels, MAKEUP_PERCENTILE } from './dsp/makeupReference.js'
import { speechWeight } from './dsp/speechBand.js'
import { clamp } from './dsp/parallelMix.js'

const DB_FLOOR = -120

/**
 * Halvings per knob solve.
 *
 * ⚠ EACH ONE IS A FULL RENDER OF THE ANALYSIS WINDOW, so this is where the
 * solve's time goes. Seven halvings of a 0-100 drive is 0.8 of a knob unit,
 * which is finer than the panel's own step and far finer than the difference
 * anyone can hear; ten cost 40 % more for resolution nothing consumes.
 */
const BISECT_PASSES = 7

/**
 * ⚠ THE SOLVE RENDERS WITHOUT OVERSAMPLING, AND THE AUDIBLE PATH NEVER DOES.
 *
 * Oversampling exists to stop the gain multiply folding aliasing into the
 * AUDIO. This solve measures level statistics — peak, a percentile, a gated
 * RMS, a block spread — and the fold does not move any of them enough to change
 * a knob. Measured on narration at Density 75, every solved value is identical
 * to three decimals with it on and off:
 *
 *   clip threshold -11.72 / -11.72   FET drive 40.23 / 40.23
 *   squash 37.50 / 37.50             rho 0.956 / 0.956   density -0.15 / -0.15
 *
 * and the FET render, which is where the solve's time goes, is 261 ms against
 * 81.5 ms for sixteen seconds of audio. `computeFET1176AutoMakeupDb` and
 * `npm run la2a:align` already measure this way for the same reason.
 *
 * ⚠ IT IS A RENDER OVERLAY AND NEVER REACHES THE RETURNED PARAMS. Those drive
 * the real kernel, which always oversamples; a solve that leaked this flag
 * would silently downgrade what the user hears.
 */
const SOLVE_RENDER = Object.freeze({ oversample: false })
const toDb = (v) => (v > 0 ? 20 * Math.log10(v) : DB_FLOOR)

/** Block length for the level-spread statistic, seconds. */
export const SPREAD_BLOCK_S = 0.4
/** How far below the 95th-percentile block the spread measurement gates. */
export const SPREAD_GATE_DB = 30

// ── Measurement ─────────────────────────────────────────────────────────────

function peakOf(channels) {
  let m = 0
  for (const c of channels) for (let i = 0; i < c.length; i++) {
    const a = c[i] < 0 ? -c[i] : c[i]
    if (a > m) m = a
  }
  return m
}

/**
 * Spread of block levels over the blocks that survive a gate, in dB — how
 * UNEVEN the material is.
 *
 * ⚠ THIS IS THE OPTO'S STATISTIC AND NOTHING ELSE'S. It is a statement about
 * level over seconds, which is what a slow opto acts on; crest is a statement
 * about one sample against the body, which is what the clipper and the FET act
 * on. Solving any device against the wrong one of these is what the ladder in
 * the spec did.
 *
 * Gated for the same reason `gatedRmsOfChannels` is: 30 s of head and tail room
 * tone would otherwise read as enormous unevenness that no compressor can or
 * should fix.
 */
export function levelSpreadDb(channels, sampleRate) {
  const block = Math.max(1, Math.round(sampleRate * SPREAD_BLOCK_S))
  const n = channels[0]?.length ?? 0
  const count = Math.floor(n / block)
  if (count < 2) return 0

  const levels = new Float64Array(count)
  for (let b = 0; b < count; b++) {
    let sum = 0
    for (const c of channels) {
      for (let i = b * block; i < (b + 1) * block; i++) sum += c[i] * c[i]
    }
    levels[b] = Math.sqrt(sum / (block * channels.length))
  }
  const sorted = Float64Array.from(levels).sort()
  const ref = sorted[Math.min(count - 1, Math.round(0.95 * (count - 1)))]
  const gate = ref * Math.pow(10, -SPREAD_GATE_DB / 20)

  const kept = []
  for (const v of levels) if (v > gate) kept.push(toDb(v))
  if (kept.length < 2) return 0
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length
  return Math.sqrt(kept.reduce((a, b) => a + (b - mean) ** 2, 0) / kept.length)
}

/**
 * Everything the solve and the report read off a signal.
 *
 * `crestDb` and `impactDb` are both peak-to-body, and they are NOT the same
 * measure: `crestDb` uses the true peak — one sample, which is what a clipper
 * acts on — and `impactDb` the 99.9th percentile, which is where a fast
 * compressor's detector actually lives. Measured on the FET's sweep, the
 * percentile one falls monotonically and the true-peak one does not.
 */
export function measureDynamics(channels, sampleRate) {
  const peak = peakOf(channels)
  const gated = gatedRmsOfChannels(channels, sampleRate)
  const p999 = percentileOfChannels(channels, MAKEUP_PERCENTILE)
  const peakDb = toDb(peak)
  const gatedDb = toDb(gated)
  return {
    peakDb,
    gatedDb,
    p999Db: toDb(p999),
    crestDb: peakDb - gatedDb,
    impactDb: toDb(p999) - gatedDb,
    spreadDb: levelSpreadDb(channels, sampleRate),
  }
}

// ── Stage rendering ─────────────────────────────────────────────────────────

function runKernel(kernel, channels) {
  const out = channels.map(c => new Float32Array(c.length))
  const n = channels[0].length
  for (let off = 0; off < n; off += 128) {
    const len = Math.min(128, n - off)
    kernel.process(
      channels.map(c => c.subarray(off, off + len)),
      out.map(c => c.subarray(off, off + len)),
      len,
    )
  }
  return out
}

const renderClip = (channels, sampleRate, p) => {
  p = { ...p, ...SOLVE_RENDER }
  const k = new SoftClipperKernel(sampleRate)
  k.setParams(clipParamsFor(p))
  return { out: runKernel(k, channels), metering: k.getMetering() }
}
const renderFet = (channels, sampleRate, p) => {
  p = { ...p, ...SOLVE_RENDER }
  const k = new FET1176Kernel(sampleRate)
  k.setParams(fetParamsFor(p))
  return { out: runKernel(k, channels), metering: k.getMetering() }
}
/**
 * Pultec pre -> opto -> Pultec post: the opto block's wet path, at Mix 1.
 *
 * Returns the opto's latency alongside the audio, because the caller has to
 * align against it — see `measureBlend`.
 */
const renderWet = (channels, sampleRate, p) => {
  p = { ...p, ...SOLVE_RENDER }
  const { pre, post } = pultecPairFor(p, sampleRate)
  const a = new BiquadCascade(pre.length, channels.length)
  a.setSections(pre)
  const wet = channels.map((c, ch) => {
    const y = new Float32Array(c.length)
    a.process(c, y, c.length, ch)
    return y
  })
  const k = new LA2AKernel(sampleRate)
  k.setParams(optoParamsFor(p))
  const out = runKernel(k, wet)
  const b = new BiquadCascade(post.length, channels.length)
  b.setSections(post)
  out.forEach((c, ch) => b.process(c, c, c.length, ch))
  return { out, metering: k.getMetering(), latencySamples: k.latencySamples }
}

/**
 * Bisect a monotonic knob for a target value of `measure`.
 *
 * `decreasing` says which way the measure moves as the knob rises, so the
 * search does not have to guess — and guessing wrong silently returns an
 * endpoint rather than failing.
 */
function bisect({ lo, hi, target, measure, decreasing, passes = BISECT_PASSES }) {
  let a = lo
  let b = hi
  for (let i = 0; i < passes; i++) {
    const mid = (a + b) / 2
    const v = measure(mid)
    const tooLittle = decreasing ? v > target : v < target
    if (tooLittle) a = mid
    else b = mid
  }
  return (a + b) / 2
}

// ── Voicings ────────────────────────────────────────────────────────────────

/**
 * ⚠ PROVISIONAL, AND DELIBERATELY SHAPED SO A LISTENING DECISION CAN REPLACE
 * THEM WITHOUT TOUCHING THE SOLVE. Each voicing states, at Density 100:
 *
 *   clipShaveDb  how much crest the clipper may take (its hard cap is separate)
 *   impactDb     the peak-to-body the FET is asked to reach
 *   squash       the opto block's calibrated layer depth
 *   mix          the opto block's blend
 *
 * Density scales the first three from "do nothing" toward these.
 */
export const VOICINGS = Object.freeze({
  audiobook: { clipShaveDb: 2.0, impactDb: 8.5, squash: 33, mix: 0.30 },
  podcast: { clipShaveDb: 3.0, impactDb: 7.5, squash: 40, mix: 0.40 },
  natural: { clipShaveDb: 1.0, impactDb: 9.5, squash: 26, mix: 0.20 },
})

/**
 * ⚠ THE SQUASH VALUES ARE ANCHORED ON A MEASURED OPERATING POINT, NOT COPIED
 * FROM SCHEPS' KNOB. Scheps' calibrated layer depth is peak gain reduction 7.64
 * dB / average 1.23 on its own wet path — a number arrived at by listening, and
 * the only calibrated reference in this codebase for how deep a parallel opto
 * layer should sit. Measured on 35 s of real narration through this chain's
 * head, at the opto's own-input alignment:
 *
 *   squash   30     32     33     34     36     40
 *   GR peak  6.51   7.18   7.52   7.86   8.53   9.87
 *   GR avg   0.94   1.12   1.23   1.34   1.61   2.27
 *
 * so 33 reproduces that operating point here. Scheps reaches it at 40 because
 * its cell sees the raw signal; here it sees one already clipped and already
 * FET-compressed, so there is less left to grab — the transfer this spec
 * predicted would not hold, quantified.
 *
 * Podcast and Natural are that anchor moved deliberately, not measured: 40 for
 * a denser layer, 26 for a lighter one.
 *
 * ⚠ CALIBRATED AT 48 kHz ON A PRODUCT THAT RESAMPLES TO 44.1. Re-declaring the
 * same samples at 44.1 kHz moves the same squash to GR peak 6.96 / avg 1.02 —
 * about half a dB. That probe time-stretches the content, so it bounds the
 * sensitivity rather than measuring it; a real 44.1 kHz resample should re-check
 * this before the number is treated as settled. `npm run dynamics:calibrate`
 * reproduces the whole table against any file.
 */

/**
 * ── THE TARGETS ─────────────────────────────────────────────────────────────
 *
 * ⚠ SHARED BY THE BISECT SOLVE AND THE SWEEP, AND THAT IS THE POINT. The two
 * paths differ only in HOW they find the knob that reaches a target — one
 * searches, one interpolates a sampled curve. If each spelled the target
 * arithmetic out for itself they would drift, and the drift would look like an
 * interpolation error rather than a second copy of a formula. The sweep bench
 * scores one against the other, so a divergence here would be scored as noise.
 */

/** How much crest the clipper may take at this Density, before its hard cap. */
export function clipShaveFor(voicing, density) {
  return Math.min(voicing.clipShaveDb * density, CLIP_MAX_DEPTH_DB)
}

/**
 * The peak-to-body the FET is asked to reach.
 *
 * Interpolated from what the audio ALREADY IS toward the voicing's target, so
 * Density 0 really is "leave it alone" rather than "hit 8.5 dB regardless".
 */
export function fetTargetImpactFor(voicing, density, afterClipImpactDb) {
  return afterClipImpactDb - (afterClipImpactDb - voicing.impactDb) * density
}

/** The opto's depth: a calibrated constant scaled by Density. See VOICINGS. */
export function squashFor(voicing, density) {
  return voicing.squash * density
}

/**
 * ⚠ THE CLIPPER'S HARD CAP, AND THE ONE RULE THAT OVERRIDES THE MACRO.
 *
 * Measured stock depth on two narrators is 2.77-3.21 dB; past that, speech
 * starts to distort audibly. If the solve wants more, Density backs off and the
 * report says so — the same rule the server's noise reduction follows on its
 * floor: report the shortfall, never force the pass.
 */
export const CLIP_MAX_DEPTH_DB = 3

// ── The solve ───────────────────────────────────────────────────────────────

/**
 * Solve the dynamics section for a region.
 *
 * @param {Float32Array[]} channelData the region (or whole file) to measure
 * @param {number} sampleRate
 * @param {object} [options]
 * @param {number} [options.density=50] the macro, 0-100
 * @param {string} [options.voicing='audiobook'] key into VOICINGS
 * @param {object} [options.patch] fixed params (ballistics, character) to honour
 * @returns {{ params: object, report: object }}
 */
export function solveDynamics(channelData, sampleRate, options = {}) {
  const density = clamp(options.density ?? 50, 0, 100) / 100
  const voicing = VOICINGS[options.voicing] ?? VOICINGS.audiobook
  const patch = { ...DYNAMICS_KERNEL_DEFAULTS, ...(options.patch ?? {}) }

  const input = measureDynamics(channelData, sampleRate)

  // ── 1. Clipper: bisect the threshold for a bounded crest shave ───────────
  const wantShave = clipShaveFor(voicing, density)
  let clipThresholdDb = null
  let clipDepthDb = 0
  let clipped = channelData
  let clipCapped = false
  if (wantShave > 0.05) {
    const targetCrest = input.crestDb - wantShave
    /**
     * ⚠ ONE SEARCH AGAINST TWO CONSTRAINTS, NOT TWO SEARCHES. Lowering the
     * threshold reduces crest AND deepens the clip, monotonically in both, so
     * the thresholds that satisfy "reached the crest target" and "still inside
     * the depth cap" form one interval and its deepest point is what is wanted.
     * Solving them separately cost a second full bisect — seven more renders —
     * every time the cap bound, which on this material is most of the macro's
     * range.
     */
    let hiTh = input.peakDb // does nothing
    let loTh = input.peakDb - 24 // clips hard
    for (let i = 0; i < BISECT_PASSES; i++) {
      const mid = (hiTh + loTh) / 2
      const r = renderClip(channelData, sampleRate, { ...patch, clipThresholdDb: mid })
      const deeper = measureDynamics(r.out, sampleRate).crestDb > targetCrest
        && r.metering.maxReductionDb < CLIP_MAX_DEPTH_DB
      if (deeper) hiTh = mid
      else loTh = mid
    }
    /**
     * ⚠ THE LAST FEASIBLE THRESHOLD, NOT THE BRACKET'S MIDPOINT. `hiTh` only
     * ever moves to a probe that satisfied BOTH constraints, so it is always
     * inside the cap; the midpoint is not, and returning it overshot — measured
     * at 3.06 dB against a 3.00 cap. On a hard bound "close enough" is a bound
     * that does not hold.
     */
    clipThresholdDb = hiTh
    const final = renderClip(channelData, sampleRate, { ...patch, clipThresholdDb })
    clipped = final.out
    clipDepthDb = final.metering.maxReductionDb
    /**
     * ⚠ REPORTED WHEN THE CAP IS WHAT STOPPED IT, not when the target was met.
     * The design's one hard rule is that the clipper is never asked for more
     * than it can give without audible distortion — so when Density wants more,
     * Density backs off and the panel says so. The same rule the server's noise
     * reduction follows on its floor: report the shortfall, never force it.
     */
    clipCapped = measureDynamics(clipped, sampleRate).crestDb > targetCrest + 0.05
  }
  const afterClip = measureDynamics(clipped, sampleRate)

  // ── 2. FET: aligned at ITS OWN input, then bisected on peak-to-body ──────
  const fetAlignDb = inputAlignDbFor(clipped, sampleRate)
  const targetImpact = fetTargetImpactFor(voicing, density, afterClip.impactDb)
  const fetDrive = bisect({
    lo: 0, hi: 100, target: targetImpact, decreasing: true,
    measure: (d) => measureDynamics(
      renderFet(clipped, sampleRate, { ...patch, fetDrive: d, fetAlignDb }).out, sampleRate,
    ).impactDb,
  })
  const fetRun = renderFet(clipped, sampleRate, { ...patch, fetDrive, fetAlignDb })
  const dry = fetRun.out
  const afterFet = measureDynamics(dry, sampleRate)

  // ── 3. Opto: aligned at ITS OWN input, then set to its calibrated depth ──
  const optoAlignDb = inputAlignDbFor(dry, sampleRate)
  /**
   * ⚠ NO SEARCH. This used to scan squash for the minimum block-level spread,
   * which measured well on synthetic material and does nothing on real
   * narration — see the header. Density scales the voicing's calibrated depth,
   * so Density 0 really is "leave it alone" and the knob still means something
   * in between.
   */
  const squash = squashFor(voicing, density)
  const wetRun = renderWet(dry, sampleRate, { ...patch, squash, optoAlignDb })
  const wet = wetRun.out

  // ── 4. The blend's measured inputs, against THIS section's dry path ──────
  const blend = measureBlend(dry, wet, sampleRate, wetRun.latencySamples)

  const params = {
    ...patch,
    clipThresholdDb,
    fetDrive,
    fetAlignDb,
    squash,
    optoAlignDb,
    mix: options.mix ?? voicing.mix,
    correlation: blend.correlation,
    densityDb: blend.densityDb,
    outputDb: blend.trimDb,
  }

  return {
    params,
    report: {
      input,
      afterClip,
      afterFet,
      afterWet: measureDynamics(wet, sampleRate),
      clip: { thresholdDb: clipThresholdDb, depthDb: clipDepthDb, capped: clipCapped },
      fet: { drive: fetDrive, alignDb: fetAlignDb, peakDb: fetRun.metering.maxGainReductionDb, targetImpactDb: targetImpact },
      opto: {
        squash,
        alignDb: optoAlignDb,
        peakDb: wetRun.metering.maxGainReductionDb,
        avgDb: wetRun.metering.avgGainReductionDb,
        /** The depth this voicing is calibrated to, before Density scales it. */
        calibratedSquash: voicing.squash,
      },
      blend,
      /**
       * ⚠ SURFACED, NOT HIDDEN. The opto raises peak-to-body by design — it
       * rides the body and lets onsets through — so at high Density the section
       * can hand the chain's delivery solve MORE peak than it received. That is
       * a real trade (evenness bought with headroom), and the limiter
       * downstream is where it is paid for.
       */
      crestRoseBy: measureDynamics(wet, sampleRate).crestDb - input.crestDb,
    },
  }
}

/**
 * Correlation and density between the section's dry path (post-FET) and its wet
 * one, plus the trim that level-matches the sum.
 *
 * ⚠ MEASURED IN THE SPEECH BAND, LIKE SCHEPS' — the Pultec pair has large
 * low-frequency moves and matching broadband would let them decide the level
 * match. ⚠ AND MEASURED AGAINST THE POST-FET DRY, WHICH IS WHY SCHEPS' OWN
 * NUMBERS CANNOT BE REUSED: that dry path is already compressed, so it is more
 * like its wet copy and the compression's remaining yield is smaller.
 *
 * ⚠ THE TWO PATHS MUST BE ALIGNED BEFORE THEY ARE CORRELATED, AND THIS WAS
 * WRONG FIRST. The wet path carries the opto's oversampling latency; the kernel
 * delays the dry side by exactly that so the blend sums in phase, and a solve
 * that compares them unaligned is measuring a different pair of signals from
 * the one that renders. Measured on narration: rho 0.481 unaligned against
 * 0.956 aligned — and rho shapes the blend's loudness compensation directly, so
 * an unaligned measurement makes Mix drift in level across its sweep, which is
 * the exact failure the compensation exists to prevent.
 *
 * ⚠ IT SURFACED BY ACCIDENT, which is worth recording: the two numbers only
 * diverged when oversampling was switched off for speed, because that takes the
 * opto's latency to zero and the paths line up by coincidence. Nothing in the
 * solve's own output moved — every solved knob was identical — so the bug was
 * invisible in exactly the values anyone would have checked.
 *
 * @param {number} [wetLatencySamples=0] the wet path's latency, to align by
 */
export function measureBlend(dry, wet, sampleRate, wetLatencySamples = 0) {
  const lat = Math.max(0, Math.round(wetLatencySamples))
  const len = Math.max(0, Math.min(dry[0]?.length ?? 0, (wet[0]?.length ?? 0) - lat))
  if (len === 0) return { correlation: 0, densityDb: 0, trimDb: 0 }

  const dryBand = dry.map(c => speechWeight(c.subarray(0, len), sampleRate))
  const wetBand = wet.map(c => speechWeight(c.subarray(lat, lat + len), sampleRate))

  const dryLoud = percentileOfChannels(dryBand, MAKEUP_PERCENTILE)
  const wetLoud = percentileOfChannels(wetBand, MAKEUP_PERCENTILE)
  if (!(dryLoud > 0) || !(wetLoud > 0)) {
    return { correlation: 0, densityDb: 0, trimDb: 0 }
  }
  // Level-match the wet copy's loud parts to the dry one's before comparing.
  const matchLin = dryLoud / wetLoud

  let dryEnergy = 0
  let wetEnergy = 0
  let cross = 0
  for (let ch = 0; ch < dryBand.length; ch++) {
    const d = dryBand[ch]
    const w = wetBand[ch]
    for (let i = 0; i < d.length; i++) {
      const wm = w[i] * matchLin
      dryEnergy += d[i] * d[i]
      wetEnergy += wm * wm
      cross += d[i] * wm
    }
  }
  if (dryEnergy <= 0 || wetEnergy <= 0) return { correlation: 0, densityDb: 0, trimDb: 0 }

  return {
    correlation: clamp(cross / Math.sqrt(dryEnergy * wetEnergy), -0.98, 0.98),
    // How much louder the level-matched wet copy's AVERAGE is — the
    // compression's yield, which the mix law passes through rather than flattens.
    densityDb: clamp(10 * Math.log10(wetEnergy / dryEnergy), -12, 12),
    /**
     * The section's own output trim. Zero here and solved later: the blend law
     * already holds the sum's level constant across Mix, so what remains is the
     * level the FET's input attenuator took, which the chain's tone section and
     * delivery solve are better placed to give back than a number baked in now.
     */
    trimDb: 0,
  }
}

// ── The Density sweep ───────────────────────────────────────────────────────

/**
 * ── WHY A SWEEP EXISTS AT ALL ───────────────────────────────────────────────
 *
 * `solveDynamics` bisects two knobs, which is ~16 kernel renders and measures
 * 7.3–7.9 s on a 30 s window. Density and Voicing invalidate it, so the panel's
 * headline control was not a live knob — every move meant a progress spinner.
 *
 * ⚠ THE FIX IS NOT A FASTER SEARCH, IT IS NOT SEARCHING PER MOVE. Both knobs
 * are monotonic in the statistic they control, so the curves can be SAMPLED
 * once and every later Density or Voicing move is an interpolation with no
 * renders at all. Measured against the bisect it replaces (`npm run
 * dynamics:sweep`): **0.064 dB of achieved impact**, worst case over the whole
 * macro, for 12 + 12 renders costing ~11 s once.
 *
 * ⚠ THE KNOB POSITIONS DISAGREE BY MORE THAN THE RESULT DOES — up to 0.73 dB of
 * threshold and 0.7 of drive — and that is the expected shape rather than a
 * worry: both curves are shallow near the solution, so the bisect's last digits
 * were never load-bearing. Scoring the sweep on knob positions would reject a
 * result that is audibly identical.
 *
 * ⚠ AND THE FIRST ATTEMPT FAILED ITS OWN BENCH, which is the reusable lesson.
 * The inversion solved only the crest target and dropped the clipper's hard
 * depth cap, so above Density 80 it ran off the end of the sampled range and
 * cost 1.32 dB. The bisect it replaces satisfies BOTH constraints in one search
 * (see the note there); an interpolation has to invert both curves and take the
 * shallower threshold. A lookup table is not exempt from the rules the search
 * was obeying.
 *
 * ── WHAT IS EXACT AND WHAT IS APPROXIMATE ───────────────────────────────────
 *
 * The clipper's curve is measured on the RAW input, so it does not depend on
 * Density at all — Density only picks a target on it. That half is exact up to
 * interpolation.
 *
 * The FET's curve is measured on the CLIPPED signal, so it is a function of two
 * variables and is sampled at ONE clip setting. Measured directly across the
 * whole clip range the macro uses (−3.54 to −7.16 dB on the reference file),
 * the curve moves **0.09 dB** worst case. That invariance is what lets one
 * sample serve the macro.
 *
 * The opto's curve is sampled at one FET setting for the same reason, and its
 * invariance is STRUCTURAL rather than lucky: `optoAlignDb` normalises the
 * cell's input level, which is the entire purpose of `dsp/inputAlign.js`. A
 * curve sampled behind an alignment is a curve in knob position, not in level.
 *
 * The blend (`correlation`, `densityDb`) is measured ONCE. Across the whole
 * Density range it moves 0.0122 of correlation and 0.300 dB of density, which
 * costs **0.034 dB** of level through the mix law at the worst Mix position.
 *
 * ⚠ EVERY NUMBER ABOVE IS ONE NARRATOR. Re-run `npm run dynamics:sweep` against
 * another voice before treating them as settled — a more percussive source
 * disturbs the FET's operating point more than this one does.
 */

/** Samples per curve. 12 is what the bench scored; fewer was not tested. */
export const SWEEP_POINTS = 12

/** How far below the region's peak the clipper's curve is sampled, in dB. */
export const CLIP_SWEEP_RANGE_DB = 24

/**
 * Points on the opto's DENSITY trajectory. Fewer than the knob curves because
 * each one is a full head render (clip -> FET -> wet), and because what it
 * feeds is the report rather than the audio.
 */
export const OPTO_SWEEP_POINTS = 6

/**
 * ⚠ THE TRAJECTORY IS WALKED FOR ONE VOICING, AND THE OTHERS READ OFF IT. Each
 * voicing bends the path differently — its own clip shave, impact target and
 * squash — so a per-voicing trajectory would triple the build. The audio is
 * unaffected either way (`squash` and `optoAlignDb` are computed per voicing);
 * what rides on this is the reported opto reduction. `npm run dynamics:sweep`
 * scores the other two against their own bisect.
 */
const TRAJECTORY_VOICING = VOICINGS.audiobook

/**
 * Interpolate `ys` at `xq`, given `xs` ASCENDING. Clamps at both ends.
 */
function lerpAt(xs, ys, xq) {
  const n = xs.length
  if (xq <= xs[0]) return ys[0]
  if (xq >= xs[n - 1]) return ys[n - 1]
  for (let i = 1; i < n; i++) {
    if (xq <= xs[i]) {
      const span = xs[i] - xs[i - 1]
      const t = span === 0 ? 0 : (xq - xs[i - 1]) / span
      return ys[i - 1] + t * (ys[i] - ys[i - 1])
    }
  }
  return ys[n - 1]
}

/**
 * The `x` at which a sampled `ys` FIRST falls through `target`, walking from
 * `xs[0]`.
 *
 * ⚠ IT TAKES THE FIRST CROSSING RATHER THAN ASSUMING THE CURVE IS MONOTONIC,
 * AND THE FIRST VERSION DID ASSUME IT. It short-circuited on the endpoints —
 * "target below the last sample means the knob cannot reach it" — which is only
 * sound if `ys` descends all the way.
 *
 * ⚠ THE CLIPPER'S CREST CURVE DOES NOT, and that is a fact about the device
 * rather than about the sampling. Measured over 24 dB of threshold on material
 * with a tight crest (12.45 dB): 12.71, 12.64, 11.92, 10.64, 9.62, **9.27**,
 * 9.49, 10.17, 10.94, 11.57, 12.02, 12.31. Crest falls to a minimum and then
 * RISES again, because past that point deep clipping pulls the BODY down faster
 * than it pulls the peak down. Crest is a difference of two things the clipper
 * moves, and the far end of the range is not a place any solve should go.
 *
 * The endpoint shortcut therefore fired on the wrong end and returned the
 * deepest threshold sampled — 24 dB below peak — where the first crossing was
 * 0.2 dB from where the bisect landed. It cost 0.65 dB of delivered impact on
 * that stimulus and nothing at all on the reference narration, whose crest is
 * 19.79 dB and whose curve does not turn inside the range. ⚠ A BENCH ON ONE
 * FILE WOULD NEVER HAVE FOUND IT.
 *
 * Walking from the shallow end and stopping at the first bracket gives the same
 * answer as the bisect on a monotonic curve, and the right one on this.
 */
function crossingOf(xs, ys, target) {
  const n = xs.length
  // Already at or below the target with the knob doing nothing.
  if (ys[0] <= target) return xs[0]
  for (let i = 1; i < n; i++) {
    if (target >= ys[i]) {
      const span = ys[i - 1] - ys[i]
      const t = span === 0 ? 0 : (ys[i - 1] - target) / span
      return xs[i - 1] + t * (xs[i] - xs[i - 1])
    }
  }
  // Never reached, anywhere in the sampled range — the same answer the bisect
  // gives by running to its own endpoint.
  return xs[n - 1]
}

/**
 * Sample every curve the section's knobs sit on, once.
 *
 * The result is a plain object — no buffers, no kernels — so it crosses the
 * worker boundary as a structured clone and can be held in panel state.
 *
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @param {object} [options]
 * @param {object} [options.patch] fixed params (ballistics, character) to honour
 */
export function sweepDynamics(channelData, sampleRate, options = {}) {
  const patch = { ...DYNAMICS_KERNEL_DEFAULTS, ...(options.patch ?? {}) }
  const input = measureDynamics(channelData, sampleRate)

  // ── 1. Clipper: threshold -> crest, depth, impact. On the RAW input, so
  //       this curve is Density-independent and the half it answers is exact.
  const thresholds = []
  const crest = []
  const depth = []
  const impact = []
  for (let i = 0; i < SWEEP_POINTS; i++) {
    const th = input.peakDb - CLIP_SWEEP_RANGE_DB
      + (CLIP_SWEEP_RANGE_DB * i) / (SWEEP_POINTS - 1)
    const r = renderClip(channelData, sampleRate, { ...patch, clipThresholdDb: th })
    const m = measureDynamics(r.out, sampleRate)
    thresholds.push(th)
    crest.push(m.crestDb)
    depth.push(r.metering.maxReductionDb)
    // ⚠ SAMPLED TOO, or a Density move still costs a clip render (~600 ms) just
    // to read the impact its FET target is derived from. That is not a live
    // knob either.
    impact.push(m.impactDb)
  }
  // Both curves rise with the threshold, and `crossingOf` wants them falling.
  const thrDesc = [...thresholds].reverse()
  const crestDesc = [...crest].reverse()
  const depthDesc = [...depth].reverse()

  // ── 2. FET, sampled at the MIDDLE of the macro's clip range ──────────────
  const midShave = clipShaveFor(VOICINGS.audiobook, 0.5)
  const midThreshold = Math.max(
    crossingOf(thrDesc, crestDesc, input.crestDb - midShave),
    crossingOf(thrDesc, depthDesc.map(v => -v), -CLIP_MAX_DEPTH_DB),
  )
  const midClip = renderClip(
    channelData, sampleRate, { ...patch, clipThresholdDb: midThreshold },
  ).out
  const fetAlignDb = inputAlignDbFor(midClip, sampleRate)

  const drives = []
  const fetImpact = []
  const fetPeakDb = []
  const fetOutAlignDb = []
  for (let i = 0; i < SWEEP_POINTS; i++) {
    const drive = (100 * i) / (SWEEP_POINTS - 1)
    const r = renderFet(midClip, sampleRate, { ...patch, fetDrive: drive, fetAlignDb })
    drives.push(drive)
    fetImpact.push(measureDynamics(r.out, sampleRate).impactDb)
    fetPeakDb.push(r.metering.maxGainReductionDb)
    // ⚠ THE OPTO'S ALIGNMENT IS A CURVE IN THE FET'S DRIVE, because the opto's
    // input IS the FET's output and the FET moves it by many dB across its
    // range. Reading it from the section's input instead is the error the
    // staged-alignment note describes.
    fetOutAlignDb.push(inputAlignDbFor(r.out, sampleRate))
  }

  // ── 3. Opto, sampled along the DENSITY TRAJECTORY ───────────────────────
  /**
   * ⚠ INDEXED BY DENSITY, NOT BY SQUASH, AND THE FIRST VERSION GOT THIS WRONG.
   *
   * Sampling the opto's curve at one FET setting and looking it up by squash
   * scored 0.80 dB of error on reported gain reduction at Density 100 — the
   * bisect measured 8.35 dB where the sweep reported 7.56. The reason is that
   * squash is not the only thing moving: the FET's drive rises with Density
   * too, so by Density 100 the opto is looking at a far more compressed signal
   * than the mid setting the curve was sampled at, and it grabs more of it.
   *
   * ⚠ AND ALIGNMENT DOES NOT RESCUE IT, WHICH IS THE CORRECTION WORTH KEEPING.
   * The reasoning for sampling at one point was that `optoAlignDb` normalises
   * the cell's input, so a curve behind an alignment is a curve in knob
   * position rather than in level. That is true of LEVEL and false of SHAPE:
   * alignment matches gated RMS, and gain reduction is an integral over the
   * envelope DISTRIBUTION, which the FET has been flattening all the way up the
   * macro. Same energy, different crest, different reduction.
   *
   * ⚠ THE AUDIO WAS NEVER WRONG — only the number the panel printed. Rendered
   * through the real kernel, the two paths' opto reduction agrees to 0.009 dB,
   * because `squash` is `voicing.squash × density` in both and the interpolated
   * `optoAlignDb` lands within 0.26 dB. That is why this had to be scored by
   * rendering both param sets rather than by comparing a measured figure to an
   * interpolated one: the bench's first version flagged an audio problem that
   * did not exist and hid a reporting one that did.
   *
   * So the trajectory is walked directly: each point solves the head from the
   * curves above, renders it, and measures where the opto actually sits.
   */
  const optoDensities = []
  const optoSquash = []
  const optoAlign = []
  const optoPeakDb = []
  const optoAvgDb = []
  const wetCrestDb = []
  const wetSpreadDb = []
  let blend = { correlation: 0, densityDb: 0, trimDb: 0 }
  const midPoint = Math.floor(OPTO_SWEEP_POINTS / 2)
  for (let i = 0; i < OPTO_SWEEP_POINTS; i++) {
    const density = i / (OPTO_SWEEP_POINTS - 1)
    const shave = clipShaveFor(TRAJECTORY_VOICING, density)
    let head = channelData
    if (shave > 0.05) {
      const th = Math.max(
        crossingOf(thrDesc, crestDesc, input.crestDb - shave),
        crossingOf(thrDesc, depthDesc.map(v => -v), -CLIP_MAX_DEPTH_DB),
      )
      head = renderClip(channelData, sampleRate, { ...patch, clipThresholdDb: th }).out
    }
    const headAlign = inputAlignDbFor(head, sampleRate)
    const target = fetTargetImpactFor(
      TRAJECTORY_VOICING, density,
      measureDynamics(head, sampleRate).impactDb,
    )
    const drive = crossingOf(drives, fetImpact, target)
    const dry = renderFet(
      head, sampleRate, { ...patch, fetDrive: drive, fetAlignDb: headAlign },
    ).out
    const align = inputAlignDbFor(dry, sampleRate)
    const squash = squashFor(TRAJECTORY_VOICING, density)
    const r = renderWet(dry, sampleRate, { ...patch, squash, optoAlignDb: align })
    const m = measureDynamics(r.out, sampleRate)

    optoDensities.push(density)
    optoSquash.push(squash)
    optoAlign.push(align)
    optoPeakDb.push(r.metering.maxGainReductionDb)
    optoAvgDb.push(r.metering.avgGainReductionDb)
    wetCrestDb.push(m.crestDb)
    wetSpreadDb.push(m.spreadDb)
    /**
     * ⚠ MEASURED ONCE, MID-TRAJECTORY. Across the whole Density range the blend
     * moves 0.0122 of correlation and 0.300 dB of density, which is 0.034 dB of
     * level through the mix law at its worst Mix position — below the 0.06 dB
     * the sweep already concedes on impact, so sampling it per point would buy
     * nothing.
     */
    if (i === midPoint) blend = measureBlend(dry, r.out, sampleRate, r.latencySamples)
  }

  return {
    sampleRate,
    patch,
    input,
    clip: { thresholds, crest, depth, impact },
    fet: { alignDb: fetAlignDb, drives, impact: fetImpact, peakDb: fetPeakDb, outAlignDb: fetOutAlignDb },
    opto: {
      densities: optoDensities,
      squash: optoSquash,
      alignDb: optoAlign,
      peakDb: optoPeakDb,
      avgDb: optoAvgDb,
      crestDb: wetCrestDb,
      spreadDb: wetSpreadDb,
    },
    blend,
  }
}

/**
 * Knob positions and the report for one Density and Voicing, from a sweep.
 *
 * ⚠ NO RENDERS, WHICH IS THE ENTIRE POINT — this is what Density and Voicing
 * call on every move. It returns the same `{ params, report }` shape
 * `solveDynamics` does, so the panel and the apply path cannot tell which
 * produced them.
 */
export function solveFromSweep(sweep, options = {}) {
  const density = clamp(options.density ?? 50, 0, 100) / 100
  const voicing = VOICINGS[options.voicing] ?? VOICINGS.audiobook
  const { input, patch } = sweep

  const thrDesc = [...sweep.clip.thresholds].reverse()
  const crestDesc = [...sweep.clip.crest].reverse()
  const depthDesc = [...sweep.clip.depth].reverse()

  // ── 1. Clipper: ONE inversion against TWO constraints, as the bisect has it
  const wantShave = clipShaveFor(voicing, density)
  let clipThresholdDb = null
  let clipDepthDb = 0
  let clipCapped = false
  let afterClipImpactDb = input.impactDb
  if (wantShave > 0.05) {
    const targetCrest = input.crestDb - wantShave
    clipThresholdDb = Math.max(
      crossingOf(thrDesc, crestDesc, targetCrest),
      // Negated so the cap reads as a descending curve too.
      crossingOf(thrDesc, depthDesc.map(v => -v), -CLIP_MAX_DEPTH_DB),
    )
    clipDepthDb = lerpAt(sweep.clip.thresholds, sweep.clip.depth, clipThresholdDb)
    clipCapped = lerpAt(sweep.clip.thresholds, sweep.clip.crest, clipThresholdDb)
      > targetCrest + 0.05
    afterClipImpactDb = lerpAt(sweep.clip.thresholds, sweep.clip.impact, clipThresholdDb)
  }

  // ── 2. FET ──────────────────────────────────────────────────────────────
  const targetImpact = fetTargetImpactFor(voicing, density, afterClipImpactDb)
  const fetDrive = crossingOf(sweep.fet.drives, sweep.fet.impact, targetImpact)
  const afterFetImpactDb = lerpAt(sweep.fet.drives, sweep.fet.impact, fetDrive)

  // ── 3. Opto, at its own input's alignment ───────────────────────────────
  /**
   * ⚠ `squash` IS EXACT AND `optoAlignDb` IS THE INTERPOLATION. The depth is a
   * calibrated constant scaled by Density, so it needs no curve at all; what
   * has to be looked up is where the opto's input SITS, which the FET moves by
   * many dB across its range. Read from the FET's drive, not from the section's
   * input — that is the staged-alignment rule, and taking it from the raw file
   * gives 0.25 dB of reduction where the opto's own input gives 2.98.
   */
  const squash = squashFor(voicing, density)
  const optoAlignDb = lerpAt(sweep.fet.drives, sweep.fet.outAlignDb, fetDrive)

  const params = {
    ...patch,
    clipThresholdDb,
    fetDrive,
    fetAlignDb: sweep.fet.alignDb,
    squash,
    optoAlignDb,
    mix: options.mix ?? voicing.mix,
    correlation: sweep.blend.correlation,
    densityDb: sweep.blend.densityDb,
    outputDb: sweep.blend.trimDb,
  }

  /**
   * ⚠ THE REPORT'S OPTO FIGURES READ OFF THE DENSITY TRAJECTORY, NOT OFF SQUASH.
   * Both the depth AND the opto's input move with Density, so a curve indexed
   * by squash alone mis-reported reduction by 0.80 dB at the top of the macro.
   * See the trajectory note in `sweepDynamics`. These are report values only —
   * every param above is computed, not interpolated from here.
   */
  const at = (ys) => lerpAt(sweep.opto.densities, ys, density)
  const wetCrestDb = at(sweep.opto.crestDb)
  return {
    params,
    report: {
      input,
      afterClip: { impactDb: afterClipImpactDb },
      afterFet: { impactDb: afterFetImpactDb },
      afterWet: { spreadDb: at(sweep.opto.spreadDb) },
      clip: { thresholdDb: clipThresholdDb, depthDb: clipDepthDb, capped: clipCapped },
      fet: {
        drive: fetDrive,
        alignDb: sweep.fet.alignDb,
        peakDb: lerpAt(sweep.fet.drives, sweep.fet.peakDb, fetDrive),
        targetImpactDb: targetImpact,
      },
      opto: {
        squash,
        alignDb: optoAlignDb,
        peakDb: at(sweep.opto.peakDb),
        avgDb: at(sweep.opto.avgDb),
        calibratedSquash: voicing.squash,
      },
      blend: sweep.blend,
      crestRoseBy: wetCrestDb - input.crestDb,
      /** ⚠ So a reader of the report knows which path produced it. */
      fromSweep: true,
    },
  }
}
