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
 * ⚠ AND ITS KNOB IS NOT MONOTONIC IN THAT EITHER — IT HAS A MINIMUM. Measured
 * on material with phrase-to-phrase level variation, block-level spread:
 *
 *   input 3.653 -> after FET 2.647 -> squash 30: 2.605, 40: 2.326,
 *   50: 2.082, 60: 2.093, 70: 2.148, 80: 2.225
 *
 * Past ~50 it gets WORSE, because the transients it lets through start
 * dominating the block levels it is trying to even out. So the opto is a
 * bounded SEARCH, not a bisection, and "more squash" is not "more levelling".
 *
 * ── WHAT THIS SOLVE DOES INSTEAD ────────────────────────────────────────────
 *
 * Each device is solved on the statistic it actually controls:
 *
 *   Soft Clip   crest            bisect threshold, hard-capped depth
 *   FET Punch   p99.9 - body     bisect drive
 *   Opto        block spread     bounded search for the minimum
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
 *   squashMax    how far the opto's search is allowed to run
 *   mix          the opto block's blend
 *
 * Density scales the first three from "do nothing" toward these.
 */
export const VOICINGS = Object.freeze({
  audiobook: { clipShaveDb: 2.0, impactDb: 8.5, squashMax: 55, mix: 0.30 },
  podcast: { clipShaveDb: 3.0, impactDb: 7.5, squashMax: 65, mix: 0.40 },
  natural: { clipShaveDb: 1.0, impactDb: 9.5, squashMax: 45, mix: 0.20 },
})

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
  const wantShave = Math.min(voicing.clipShaveDb * density, CLIP_MAX_DEPTH_DB)
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
  const targetImpact = afterClip.impactDb
    - (afterClip.impactDb - voicing.impactDb) * density
  const fetDrive = bisect({
    lo: 0, hi: 100, target: targetImpact, decreasing: true,
    measure: (d) => measureDynamics(
      renderFet(clipped, sampleRate, { ...patch, fetDrive: d, fetAlignDb }).out, sampleRate,
    ).impactDb,
  })
  const fetRun = renderFet(clipped, sampleRate, { ...patch, fetDrive, fetAlignDb })
  const dry = fetRun.out
  const afterFet = measureDynamics(dry, sampleRate)

  // ── 3. Opto: aligned at ITS OWN input, then SEARCHED for least spread ────
  const optoAlignDb = inputAlignDbFor(dry, sampleRate)
  /**
   * ⚠ A SCAN, NOT A BISECTION, because the spread curve has a minimum rather
   * than a slope — see the header. Coarse then fine: the curve is smooth, and a
   * render per probe is the cost here.
   */
  const squashCeiling = voicing.squashMax
  const probe = (sq) => levelSpreadDb(
    renderWet(dry, sampleRate, { ...patch, squash: sq, optoAlignDb }).out, sampleRate,
  )
  let bestSquash = 0
  let bestSpread = probe(0)
  for (let sq = 10; sq <= squashCeiling; sq += 10) {
    const v = probe(sq)
    if (v < bestSpread) { bestSpread = v; bestSquash = sq }
  }
  for (let sq = Math.max(0, bestSquash - 8); sq <= Math.min(squashCeiling, bestSquash + 8); sq += 4) {
    const v = probe(sq)
    if (v < bestSpread) { bestSpread = v; bestSquash = sq }
  }
  /**
   * Density scales toward the minimum rather than jumping to it, so the macro
   * still means something and Density 0 really is "leave it alone".
   */
  const squash = bestSquash * density
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
      opto: { squash, alignDb: optoAlignDb, bestSquash, bestSpreadDb: bestSpread, peakDb: wetRun.metering.maxGainReductionDb },
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
