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
 *   Opto        (not solved)     one calibrated depth, scaled by Density
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
 * targets exist so that choice has somewhere to live, not because these are
 * the right numbers.
 */

import { SoftClipperKernel } from './softClipperProcessor.js'
import { FET1176Kernel } from './fet1176Processor.js'
import { LA2AKernel } from './la2aProcessor.js'
import { BiquadCascade } from './dsp/biquad.js'
import {
  clipParamsFor, fetParamsFor, optoParamsFor, pultecPairFor, fetEnabled,
  DYNAMICS_KERNEL_DEFAULTS,
} from './dynamicsProcessor.js'
import { gatedRmsOfChannels, inputAlignDbFor } from './dsp/inputAlign.js'
import { percentileOfChannels, MAKEUP_PERCENTILE } from './dsp/makeupReference.js'
import { speechWeight } from './dsp/speechBand.js'
import { clamp, mixGains } from './dsp/parallelMix.js'

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
/**
 * ⚠ A NULL DRIVE IS A BYPASS AND HAS TO BE ONE HERE TOO. `fetParamsFor` reads
 * a missing `fetDrive` as the kernel default (50), so rendering a bypassed
 * stage through this helper returned a signal the kernel will never produce —
 * and everything measured downstream of it (the opto's alignment, the blend,
 * the makeup) described that phantom render instead of the real path. The
 * kernel's own bypass is bit-exact, so this one is too.
 */
const renderFet = (channels, sampleRate, p) => {
  p = { ...p, ...SOLVE_RENDER }
  if (!fetEnabled(p)) {
    return { out: channels, metering: { maxGainReductionDb: 0, avgGainReductionDb: 0 } }
  }
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
 * THEM WITHOUT TOUCHING THE SOLVE. The section states, at Density 100:
 *
 *   clipShaveDb  how much crest the clipper may take (its hard cap is separate)
 *   impactDb     the peak-to-body the FET is asked to reach
 *   squash       the opto block's calibrated layer depth
 *   mix          the opto block's blend
 *
 * Density scales the first three from "do nothing" toward these.
 */
export const DYNAMICS_TARGET = Object.freeze({
  /** Peak-to-body the FET is asked to reach at Density 100. */
  impactDb: 12.2,
  /** The opto block's layer depth at Density 100. */
  squash: 26,
})

/**
 * ⚠ THERE USED TO BE THREE VOICINGS AND DENSITY MEANT A DIFFERENT THING IN EACH.
 *
 * Each voicing carried its own `impactDb`, `squash`, `clipShaveDb` and `mix`,
 * and Density interpolated from the material toward whichever set was selected.
 * So Density 55 was three different amounts of processing depending on a rotary
 * switch beside it — the macro's own number had no fixed meaning, and neither
 * did a saved patch that quoted it.
 *
 * Now there is ONE target set. Density means one thing: how far toward it. The
 * two knobs that were folded into the voicings have their own controls, where
 * their values are visible and mean what they say — Mix already had one, and
 * the clipper's shave is now a detent. Use-case starting points belong in
 * PRESETS, which save every control at once and say so.
 *
 * ⚠ THESE ARE THE AUDIOBOOK NUMBERS, which are the ones that were measured.
 * The other two voicings' targets were never anything but these moved by hand.
 * See the recalibration note above for the floor they had to clear.
 */

/**
 * How much crest the clipper may shave, in dB — the detent's positions.
 *
 * ⚠ `CLIP_MAX_DEPTH_DB` STILL CAPS WHAT IT ACTUALLY TAKES. These are requests,
 * and the solve reports when one cannot be met; the top detent sits AT the cap
 * deliberately, so the panel never offers a position that is quietly clamped.
 */
export const CLIP_SHAVE_DETENTS = Object.freeze([0, 1, 2, 3])

/** The blend the section ships at, when nothing has touched the Mix knob. */
export const DEFAULT_MIX = 0.30

/** The clipper detent the section ships at. */
export const DEFAULT_CLIP_SHAVE_DB = 2

/**
 * ── BALANCE: WHICH COMPRESSOR DOES THE WORK ─────────────────────────────────
 *
 * Density says HOW MUCH the section does. Balance says WHICH DEVICE does it —
 * −1 leans on the FET, +1 leans on the opto, 0 is the section as calibrated.
 *
 * ⚠ IT MOVES TWO VOICING NUMBERS AND NOTHING ELSE, which is what keeps it free
 * at runtime. `impactDb` is the FET's target and `squash` is the opto's depth;
 * both are read by lookups on the sampled curves, so Balance costs no renders
 * and never invalidates a sweep — exactly like Density and Voicing.
 *
 * ⚠ THE TWO MOVE IN OPPOSITE SENSES AND THE SIGNS ARE EASY TO GET BACKWARDS.
 * A HIGHER `impactDb` is a SLACKER target — it asks the FET to leave more
 * peak-to-body alone — so leaning toward the opto RAISES it. `squash` is a
 * depth, so leaning toward the opto raises that too. Both go up together; only
 * one of them means "do less".
 *
 * ⚠ THE CLIPPER AND THE BLEND ARE DELIBERATELY UNTOUCHED. The clipper is not
 * one of the two compressors this trades between, and it already has a hard cap
 * that Density backs off from; folding it in would give Balance a second way to
 * hit that cap for reasons the label does not suggest. Mix is a blend position
 * the user owns, not a distribution of work.
 *
 * Measured on narration, Density 60, audiobook — the range this was sized
 * against (FET peak GR / opto peak GR):
 *
 *   balance   0 (ships)      26.58 / 3.90
 *   balance +1 (opto)         9.43 / 5.80
 *
 * ⚠ AND IT ONLY BITES BELOW ROUGHLY DENSITY 60 ON THAT MATERIAL, because the
 * FET's drive pins at 100 above it and `impactDb` stops reaching. That is a
 * property of the macro, not of this knob: past the pin the top of the macro is
 * "FET flat out, opto scaling", and Balance can still move the opto half.
 */

/**
 * dB added to the FET's impact target at full opto lean.
 *
 * ⚠ THIS WAS BRIEFLY NARROWED TO 1.0 ON REASONING THAT DID NOT SURVIVE ITS OWN
 * BENCH, and the episode is worth more than the constant.
 *
 * The argument was that ±2.0 is a 4.0 dB span across a usable impact band
 * measured at 2.18-3.30 dB, so both ends must sit on the rail. That is wrong
 * about how the span is spent: Density already places the target INSIDE the
 * band, and Balance shifts from wherever that is. The shift only rails when it
 * pushes past an end.
 *
 * Measured at the shipping calibration, rails per five sampled positions
 * (bypassed or pinned), across Density 30/50/70/90:
 *
 *   span    narrator 1              narrator 2
 *   ±1.0    none, at any density    1-2 of 5 at every density
 *   ±2.0    1 of 5, at D90 only     2 of 5 (3 at D90)
 *   ±3.0    1-3 of 5 everywhere     2-3 of 5 everywhere
 *
 * and at Density 70 on narrator 1, ±2.0 spans FET reduction 17.3 -> 1.3 dB
 * against ±1.0's 9.0 -> 3.4. So ±2.0 buys roughly double the usable range for
 * one railed cell at the top of the macro, and ±3.0 is where it actually breaks.
 *
 * ⚠ NARRATOR 2 RAILS AT EVERY SPAN INCLUDING THE NARROWEST, which is the tell:
 * its input impact (13.21) sits ~1 dB from the target, so the lean-opto side
 * bypasses immediately whatever the span is. That is the absolute target's
 * material-dependence, not this constant's fault, and narrowing cannot fix it.
 *
 * The dead zone this knob originally had was the target sitting below the
 * floor — see DYNAMICS_TARGET. Fixing that implied nothing about the range.
 */
export const BALANCE_IMPACT_DB = 2.0

/** Fraction the opto's depth is scaled by at full lean, either way. */
export const BALANCE_SQUASH_SCALE = 0.45

/**
 * The target set as Balance leaves it. Everything downstream reads THIS, never
 * `DYNAMICS_TARGET` directly, so the two solve paths cannot disagree about what
 * the knob did.
 *
 * @param {number} balance −1 (lean FET) … 0 (as calibrated) … +1 (lean opto)
 */
export function effectiveTarget(balance = 0) {
  const b = clamp(Number.isFinite(balance) ? balance : 0, -1, 1)
  if (b === 0) return DYNAMICS_TARGET
  return {
    impactDb: DYNAMICS_TARGET.impactDb + BALANCE_IMPACT_DB * b,
    squash: DYNAMICS_TARGET.squash * (1 + BALANCE_SQUASH_SCALE * b),
  }
}

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
export function clipShaveFor(clipShaveDb, density) {
  return Math.min((clipShaveDb ?? 0) * density, CLIP_MAX_DEPTH_DB)
}

/**
 * How much impact the relative floor may ask for at Density 100, dB.
 *
 * ⚠ CHOSEN ON AN ASYMMETRIC DOWNSIDE, NOT ON A BEST SCORE. Too small is a
 * no-op on any file that already had room; too large RAILS the FET, which is
 * the failure this section shipped once already. Measured over 1.5 / 2.0 / 2.5 /
 * 3.0 on two stimuli (`npm run dynamics:target`):
 *
 *   - On the punchy stimulus (impact 14.89, 2.69 dB of room) 1.5 is IDENTICAL to
 *     the absolute target at every Density — the absolute binds throughout, so
 *     this changes nothing for material that was already being processed. Real
 *     narration measures 13.2-14.8, i.e. 1.0-2.6 dB of room, so it is in the
 *     same regime.
 *   - On the flat stimulus (impact 10.98, NO room — the FET bypasses at every
 *     Density under the absolute target) 1.5 gives drive 18.4-45.8 and 0.33-6.57
 *     dB of gain reduction across the macro, with nothing short of target.
 *   - 2.0 rails at Density 100 on that file; 2.5 rails from 70; 3.0 from 70 and
 *     costs 10.42 dB of gain reduction to come 1.24 dB short.
 *
 * ⚠ AND IT IS FITTED TO TWO SYNTHETIC STIMULI. The house rule on this section is
 * that one file is not a bench and synthetic material has overturned a
 * calibration twice. Re-score it on a corpus before treating it as settled.
 */
export const MAX_IMPACT_DROP_DB = 1.5

/**
 * The deepest drive the solve will ask the FET for.
 *
 * ⚠ THE DEVICE PLATEAUS AND THE SOLVE DOES NOT KNOW IT. Impact drop against
 * drive flattens out around 60 — past that the knob buys almost no further
 * impact and costs enormous gain reduction, because compressing the loud parts
 * pulls the body down with them. Measured on the flat stimulus, an unreachable
 * target took the drive to 100 and **20.49 dB of gain reduction** to buy the
 * last 0.3 dB of impact, which is the same "26 dB nobody asked for" this
 * section already shipped once.
 *
 * ⚠ IT IS NOT A WAY TO HIDE AN UNREACHABLE TARGET. `shortfallDb` still reports
 * the miss, and reports it LARGER for the cap — the contract is that the
 * section says what it could not do, not that it spends any amount of gain
 * reduction trying.
 */
export const FET_MAX_SOLVE_DRIVE = 60

/**
 * The peak-to-body the FET is asked to reach.
 *
 * Interpolated from what the audio ALREADY IS toward the target, so
 * Density 0 really is "leave it alone" rather than "hit 12.2 dB regardless".
 *
 * ⚠ THE ABSOLUTE TARGET MAKES DENSITY MEAN "DISTANCE TO 12.2", WHICH IS A
 * PROPERTY OF THE FILE AND NOT OF THE KNOB. A recording arriving at impact 14.9
 * has 2.7 dB of room and Density 100 spends all of it; one arriving at 10.7 has
 * none, so the FET bypasses at every Density and the macro does nothing. That is
 * the target working as specified, and it is also why the same Density buys
 * wildly different amounts of processing on two files.
 *
 * `maxDropDb` opts into a RELATIVE floor: Density also buys a guaranteed drop
 * from wherever the audio starts, and the absolute target still binds as a floor
 * so a punchy file is not driven past the house sound. Both forms agree exactly
 * at Density 0. Off by default until the bench says which ships.
 */
export function fetTargetImpactFor(impactDb, density, afterClipImpactDb, maxDropDb = null) {
  const absolute = afterClipImpactDb - (afterClipImpactDb - impactDb) * density
  if (!Number.isFinite(maxDropDb)) return absolute
  return Math.min(absolute, afterClipImpactDb - maxDropDb * density)
}

/**
 * The relative floor's drop for a solve's options, or null for the absolute
 * target. ⚠ BOTH SOLVE PATHS READ IT HERE — see the note above `clipShaveFor`.
 */
export function maxDropFor(options = {}) {
  if (options.relativeTarget === false) return null
  const d = options.maxImpactDropDb
  return Number.isFinite(d) ? d : MAX_IMPACT_DROP_DB
}

/**
 * ── THE SECTION'S AUTO MAKEUP ───────────────────────────────────────────────
 *
 * ⚠ IT SHIPPED WITHOUT ONE AND CAME OUT 16 dB QUIET. The FET's Input knob is an
 * attenuator on the AUDIO PATH as well as the detector, exactly as the hardware
 * wires it, so every drive the solve picks costs level. Measured on narration at
 * Density 70: output peak 15.86 dB below the input, body 11.93 below, with the
 * trim sitting at 0.
 *
 * ⚠ THE ZERO WAS DELIBERATE AND THE REASONING EXPIRED. The note said the level
 * the attenuator took was for "the chain's tone section and delivery solve" to
 * give back — but this section ships standalone and those do not exist, so the
 * deferral left the plugin unusable. Every other dynamics plugin here carries
 * auto makeup (`computeAutoMakeupPlan`, Scheps' auto trim, the clipper's).
 *
 * ⚠ REFERENCED TO THE 99.9th PERCENTILE, NOT THE PEAK, for the reason the house
 * already recorded: a peak reference lets one uncompressed onset pin the whole
 * file, and above ~Peak Reduction 50 the knob runs BACKWARDS. The percentile is
 * what OptoSmooth and Scheps use.
 *
 * ⚠ AND CAPPED SO THE OUTPUT CAN NEVER EXCEED THE INPUT PEAK — by ARITHMETIC,
 * not by a soft ceiling. The house rule is that a percentile makeup ships with a
 * ceiling because it can overshoot; that rule exists because OptoSmooth's makeup
 * is applied inside a running kernel where the overshoot is not knowable in
 * advance. Here the trim is a single solved gain on the output, so the safe
 * maximum is just `inputPeak − outputPeak` and the guarantee costs nothing. It
 * also keeps this section's "nothing inside holds a ceiling" property intact,
 * and avoids the knee cost Scheps pays at low Mix.
 *
 * ⚠ THE PEAK PREDICTION IS A LOOKUP AND IT UNDER-READS, SO THE CAP CARRIES A
 * MEASURED MARGIN. Level interpolates well — p99.9 tracks a Mix lerp to 0.04 dB
 * — but the PEAK does not, for two compounding reasons:
 *
 *   1. Output level against FET drive is strongly convex near zero (the Input
 *      knob is an attenuator: −26.03 / −20.97 / −18.50 dB at drives 0 / 9.1 /
 *      18.2). Monotone cubic interpolation takes that from 1.20 dB of error to
 *      0.96, and cannot remove it.
 *   2. The peak of a SUM is not the blend of two peaks. The triangle-inequality
 *      bound on the real blend gains is sound in principle but reads off two
 *      interpolated peaks, so it inherits (1) on both sides.
 *
 * Measured across 240 combinations of Density, Mix and Balance on two narrators,
 * the prediction under-reads the true output peak by at most **3.43 dB**, so
 * that is the margin. With it, zero of those 240 combinations exceed the input
 * peak; without it, 68 of them did, by up to 1.97 dB.
 *
 * ⚠ IT IS NOT FREE, AND AN EARLIER DRAFT OF THIS NOTE CLAIMED IT WAS. The cap
 * binds at ordinary settings, not just in the corner that motivated it: on the
 * reference narration at Density 70 the delivered body goes +2.63 dB without the
 * margin and +0.87 with it, so roughly 1.8 dB of makeup is given up to buy the
 * guarantee. The output is body-neutral-to-slightly-up with the peak ~3 dB down,
 * which is a reasonable compressor output — but it is quieter than the
 * percentile target alone would give, and that is the price.
 *
 * ⚠ THE MARGIN IS SIZED ON THE WORST CASE AND THE WORST CASE IS NOT TYPICAL —
 * the 3.43 dB comes from Density 5-10 at Mix 1, where the error is largest; at
 * Density 70 it is about 1.7. A margin that followed the error's own structure
 * would recover most of that, and is the obvious next improvement.
 *
 * ⚠ AN EXACT CAP WOULD NEED A RENDER, and a render is what this whole path
 * exists to avoid — Density, Balance and Mix are lookups precisely so the knobs
 * stay live. A measured margin buys the guarantee at the price of some makeup in
 * a corner; a render would buy it at the price of the live knobs.
 *
 * ⚠ AND THE GUARANTEE IS ON THE MEASURED WINDOW, not the whole region — a peak
 * later in a long selection than `analysisWindow` reaches is not seen, the same
 * approximation that note already documents for every measured parameter.
 *
 * ⚠ THE 240-COMBINATION SCORE WAS ALL FET-ENGAGED, AND THE BYPASS CORNER BROKE
 * THE GUARANTEE. On material whose impact already meets the target the FET is
 * out at every Density, and there the cap had nothing to bind: `Math.max(0, …)`
 * meant "never attenuate", so the opto block's own Pultec gain reached the blend
 * unopposed and the output ran up to 2.31 dB past the input peak at Mix 1.
 * The floor is now the predicted overshoot — see `makeupDbFor` — and the same
 * grid measures −0.10 dB worst, i.e. always under. Every FET-engaged cell is
 * bit-for-bit what it was.
 */

/**
 * Worst measured under-read of the output-peak lookup, dB. See `makeupDbFor`.
 */
export const MAKEUP_PEAK_MARGIN_DB = 3.43

/**
 * The same margin for the TRIM direction, dB.
 *
 * ⚠ IT IS NOT THE SAME NUMBER, BECAUSE IT IS NOT THE SAME LOOKUP. The 3.43
 * above is sized on the FET-engaged branch, whose wet peak comes off a bilinear
 * grid; the trim only ever fires on the bypass branch, where the wet peak is a
 * measured gain off one grid row and the prediction lands within 0.20 dB.
 * Reusing 3.43 there would charge a 3 dB attenuation to buy 0.2 dB of safety.
 */
export const MAKEUP_TRIM_MARGIN_DB = 0.3

/**
 * ⚠ THE FLOOR IS THE OVERSHOOT, NOT ZERO — and a hard zero cost up to 2.31 dB
 * past the input peak. `Math.max(0, ...)` says the section may never attenuate,
 * which is right as a statement about MAKEUP and wrong as the only thing
 * enforcing "never louder than the source": when the stages bypass there is no
 * makeup to withhold, and the opto block's own Pultec gain still reaches the
 * blend. So the result is clamped below by the predicted overshoot rather than
 * by zero — which is exactly 0 whenever the section is predicted under the
 * input peak, so every case that was already legal is untouched.
 */
export function makeupDbFor(inputP999Db, inputPeakDb, outP999Db, outPeakDb) {
  const wanted = inputP999Db - outP999Db
  const overshoot = inputPeakDb - outPeakDb
  const floor = Math.min(0, overshoot - MAKEUP_TRIM_MARGIN_DB)
  return Math.max(floor, Math.min(wanted, overshoot - MAKEUP_PEAK_MARGIN_DB))
}

/** The opto's depth: a calibrated constant scaled by Density. */
export function squashFor(squash, density) {
  return squash * density
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
 * @param {number} [options.balance=0] −1 lean FET … +1 lean opto
 * @param {number} [options.clipShaveDb] dB of crest the clipper may shave
 * @param {object} [options.patch] fixed params (ballistics, character) to honour
 * @returns {{ params: object, report: object }}
 */
export function solveDynamics(channelData, sampleRate, options = {}) {
  const density = clamp(options.density ?? 50, 0, 100) / 100
  const target = effectiveTarget(options.balance)
  const clipShaveDb = options.clipShaveDb ?? DEFAULT_CLIP_SHAVE_DB
  const patch = { ...DYNAMICS_KERNEL_DEFAULTS, ...(options.patch ?? {}) }

  const input = measureDynamics(channelData, sampleRate)

  // ── 1. Clipper: bisect the threshold for a bounded crest shave ───────────
  const wantShave = clipShaveFor(clipShaveDb, density)
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
  const targetImpact = fetTargetImpactFor(
    target.impactDb, density, afterClip.impactDb, maxDropFor(options),
  )
  /**
   * ⚠ BYPASS WHEN THERE IS NOTHING TO DO — DRIVE 0 IS A 24 dB ATTENUATOR, not
   * an idle compressor. See the note in `solveFromSweep`; the bisect has the
   * same exposure, because `lo: 0` is exactly where it lands when the material
   * already meets the target.
   */
  let fetDrive = null
  if (afterClip.impactDb - targetImpact > 0.05) {
    fetDrive = bisect({
      lo: 0, hi: FET_MAX_SOLVE_DRIVE, target: targetImpact, decreasing: true,
      measure: (d) => measureDynamics(
        renderFet(clipped, sampleRate, { ...patch, fetDrive: d, fetAlignDb }).out, sampleRate,
      ).impactDb,
    })
  }
  const fetRun = renderFet(clipped, sampleRate, { ...patch, fetDrive, fetAlignDb })
  const dry = fetRun.out
  const afterFet = measureDynamics(dry, sampleRate)
  /** Same reporting contract as the clipper's cap — see `solveFromSweep`. */
  const fetShortfallDb = Math.max(0, afterFet.impactDb - targetImpact)

  // ── 3. Opto: aligned at ITS OWN input, then set to its calibrated depth ──
  const optoAlignDb = inputAlignDbFor(dry, sampleRate)
  /**
   * ⚠ NO SEARCH. This used to scan squash for the minimum block-level spread,
   * which measured well on synthetic material and does nothing on real
   * narration — see the header. Density scales the calibrated depth,
   * so Density 0 really is "leave it alone" and the knob still means something
   * in between.
   */
  const squash = squashFor(target.squash, density)
  const wetRun = renderWet(dry, sampleRate, { ...patch, squash, optoAlignDb })
  const wet = wetRun.out

  // ── 4. The blend's measured inputs, against THIS section's dry path ──────
  const blend = measureBlend(dry, wet, sampleRate, wetRun.latencySamples)

  /** Same rule as the sweep's, measured from this path's own renders. */
  const mix = clamp(options.mix ?? DEFAULT_MIX, 0, 1)
  const atMix = (d, w) => d + (w - d) * mix
  const wetOut = [wet[0].subarray(wetRun.latencySamples)]
  const outP999Db = atMix(
    toDb(percentileOfChannels(dry, MAKEUP_PERCENTILE)),
    toDb(percentileOfChannels(wetOut, MAKEUP_PERCENTILE)),
  )
  const outPeakDb = atMix(afterFet.peakDb, measureDynamics(wetOut, sampleRate).peakDb)
  const makeupDb = makeupDbFor(input.p999Db, input.peakDb, outP999Db, outPeakDb)

  const params = {
    ...patch,
    clipThresholdDb,
    fetDrive,
    fetAlignDb,
    squash,
    optoAlignDb,
    makeupDb,
    mix,
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
      fet: {
        drive: fetDrive,
        alignDb: fetAlignDb,
        peakDb: fetRun.metering.maxGainReductionDb,
        targetImpactDb: targetImpact,
        /** The relative floor's drop, or null when the absolute target ran. */
        maxDropDb: maxDropFor(options),
        shortfallDb: fetShortfallDb,
        capped: fetShortfallDb > 0.05,
      },
      opto: {
        squash,
        alignDb: optoAlignDb,
        peakDb: wetRun.metering.maxGainReductionDb,
        avgDb: wetRun.metering.avgGainReductionDb,
        /** The section's calibrated depth, before Balance and Density move it. */
        /**
         * ⚠ THE VOICING'S OWN DEPTH, NOT THE ONE BALANCE ASKED FOR. This field
         * exists so a reader can see how far Density has scaled the calibrated
         * anchor; quoting the balanced value would make the anchor look like it
         * moves, which is the one thing it must not appear to do.
         */
        calibratedSquash: DYNAMICS_TARGET.squash,
        /** What Balance did to it, so the pair is readable together. */
        balancedSquash: target.squash,
      },
      blend,
      makeup: {
        db: makeupDb,
        outP999Db,
        outPeakDb,
        peakCapped: input.p999Db - outP999Db > input.peakDb - outPeakDb + 0.01,
      },
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
 * Grid resolution for the opto's reported reduction: drives x squash.
 *
 * Coarser than the knob curves because each cell is a wet render and what it
 * feeds is the REPORT, never the audio — `squash` is computed and `optoAlignDb`
 * comes off the FET curve. Both axes are smooth, so bilinear on 4x4 is enough;
 * the drive axis reuses one FET render per row.
 */
export const OPTO_GRID_DRIVES = 4
export const OPTO_GRID_SQUASH = 6

/**
 * The widest depth the section can ask for, Balance included — the squash axis
 * has to reach it or the grid clamps exactly where a leaned patch lives.
 *
 * ⚠ DERIVED, NOT TYPED. A retuned target or a wider Balance range must not
 * silently fall off the end of the grid.
 */
export const MAX_SQUASH = DYNAMICS_TARGET.squash * (1 + BALANCE_SQUASH_SCALE)

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
 * Monotone cubic (Fritsch–Carlson) lookup, for curves that are smooth and
 * strongly CURVED rather than nearly straight.
 *
 * ⚠ THE LEVEL CURVES NEED THIS AND THE KNOB CURVES DO NOT. Output level against
 * FET drive is convex at the low end because the Input knob is an attenuator:
 * measured −26.03 / −20.97 / −18.50 dB at drives 0 / 9.1 / 18.2, so the first
 * gap alone falls 5 dB and the next 2.5. A straight line across it under-read
 * the output peak by 1.20 dB at drive 5.2, which the auto makeup then handed
 * straight to the output as overshoot.
 *
 * ⚠ IT IS NOT USED FOR THE CROSSINGS THAT PICK KNOB POSITIONS. Those are scored
 * against the bisect at 0.136 dB of delivered impact and a change of basis would
 * move every number in that bench for no measured reason. This is a repair to a
 * REPORTED and APPLIED level, where the error was measured and is real.
 */
function pchipAt(xs, ys, xq) {
  const n = xs.length
  if (n < 3) return lerpAt(xs, ys, xq)
  if (xq <= xs[0]) return ys[0]
  if (xq >= xs[n - 1]) return ys[n - 1]
  let i = 1
  while (i < n - 1 && xq > xs[i]) i++
  const h = xs[i] - xs[i - 1]
  if (h === 0) return ys[i]
  // Secants either side, and the Fritsch–Carlson harmonic-mean slopes that
  // keep the interpolant monotone between samples.
  const d = (a, b) => (ys[b] - ys[a]) / (xs[b] - xs[a])
  const dk = d(i - 1, i)
  const slope = (k) => {
    if (k === 0) return d(0, 1)
    if (k === n - 1) return d(n - 2, n - 1)
    const a = d(k - 1, k)
    const b = d(k, k + 1)
    if (a * b <= 0) return 0
    const wa = 2 * (xs[k + 1] - xs[k]) + (xs[k] - xs[k - 1])
    const wb = (xs[k + 1] - xs[k]) + 2 * (xs[k] - xs[k - 1])
    return (wa + wb) / (wa / a + wb / b)
  }
  const m0 = slope(i - 1)
  const m1 = slope(i)
  const t = (xq - xs[i - 1]) / h
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * ys[i - 1]
    + (t3 - 2 * t2 + t) * h * m0
    + (-2 * t3 + 3 * t2) * ys[i]
    + (t3 - t2) * h * m1
}

/**
 * Bilinear lookup on `grid[i][j]`, sampled at `xs[i]` by `ys[j]`.
 *
 * Clamps at every edge: off the grid means the nearest cell, which for the
 * opto's report is "as deep as we sampled" rather than an extrapolation into a
 * region nothing was measured in.
 */
function bilinearAt(xs, ys, grid, xq, yq) {
  const span = (arr, q) => {
    const n = arr.length
    if (q <= arr[0]) return [0, 0, 0]
    if (q >= arr[n - 1]) return [n - 1, n - 1, 0]
    for (let i = 1; i < n; i++) {
      if (q <= arr[i]) {
        const d = arr[i] - arr[i - 1]
        return [i - 1, i, d === 0 ? 0 : (q - arr[i - 1]) / d]
      }
    }
    return [n - 1, n - 1, 0]
  }
  const [x0, x1, tx] = span(xs, xq)
  const [y0, y1, ty] = span(ys, yq)
  const a = grid[x0][y0] + ty * (grid[x0][y1] - grid[x0][y0])
  const b = grid[x1][y0] + ty * (grid[x1][y1] - grid[x1][y0])
  return a + tx * (b - a)
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
  const clipOutP999Db = []
  const clipOutPeakDb = []
  const clipOutAlignDb = []
  for (let i = 0; i < SWEEP_POINTS; i++) {
    const th = input.peakDb - CLIP_SWEEP_RANGE_DB
      + (CLIP_SWEEP_RANGE_DB * i) / (SWEEP_POINTS - 1)
    const r = renderClip(channelData, sampleRate, { ...patch, clipThresholdDb: th })
    const m = measureDynamics(r.out, sampleRate)
    thresholds.push(th)
    crest.push(m.crestDb)
    depth.push(r.metering.maxReductionDb)
    /**
     * ⚠ THE DRY PATH WHEN THE FET BYPASSES, which is not the same as the FET
     * curve at drive 0 — drive 0 is a 24 dB ATTENUATOR. Reading the FET curve
     * with a `?? 0` fallback made the makeup add back 24 dB of attenuation that
     * never happened: measured +24.16 dB over the input peak. Third time that
     * fallback has bitten; see `fetEnabled`.
     */
    clipOutP999Db.push(toDb(percentileOfChannels(r.out, MAKEUP_PERCENTILE)))
    clipOutPeakDb.push(m.peakDb)
    /**
     * ⚠ AND THE OPTO'S ALIGNMENT WHEN THE FET BYPASSES, for the same reason and
     * with a worse failure. `optoAlignDb` used to come off the FET curve
     * unconditionally, so a bypassed FET read the drive-0 row — the attenuator
     * — and handed the opto a +25 dB side-chain offset for a signal that was
     * never attenuated. Measured on a file whose impact already met the target
     * (so the FET bypasses at every Density): align 25.43 against a true 1.37,
     * and the opto did 10.29 dB of gain reduction at Density 30 where its
     * calibration asks for about one. That is audio, not a report.
     */
    clipOutAlignDb.push(inputAlignDbFor(r.out, sampleRate))
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
  const midShave = clipShaveFor(DEFAULT_CLIP_SHAVE_DB, 0.5)
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
  const fetOutP999Db = []
  const fetOutPeakDb = []
  for (let i = 0; i < SWEEP_POINTS; i++) {
    const drive = (100 * i) / (SWEEP_POINTS - 1)
    const r = renderFet(midClip, sampleRate, { ...patch, fetDrive: drive, fetAlignDb })
    drives.push(drive)
    fetImpact.push(measureDynamics(r.out, sampleRate).impactDb)
    fetPeakDb.push(r.metering.maxGainReductionDb)
    /**
     * ⚠ THE SECTION'S OUTPUT LEVEL AT MIX 0, WHICH IS EXACTLY THIS SIGNAL. The
     * blend's dry side is the post-FET path, so at Mix 0 the output IS the
     * delayed dry — measured, the two agree to 0.00 dB. See `makeupDb`.
     */
    fetOutP999Db.push(toDb(percentileOfChannels(r.out, MAKEUP_PERCENTILE)))
    fetOutPeakDb.push(measureDynamics(r.out, sampleRate).peakDb)
    // ⚠ See `fet.impactDrop` below for why the absolute curve is not what the
    // lookup uses.
    // ⚠ THE OPTO'S ALIGNMENT IS A CURVE IN THE FET'S DRIVE, because the opto's
    // input IS the FET's output and the FET moves it by many dB across its
    // range. Reading it from the section's input instead is the error the
    // staged-alignment note describes.
    fetOutAlignDb.push(inputAlignDbFor(r.out, sampleRate))
  }

  // ── 3. Opto, sampled on a (DRIVE x SQUASH) GRID ─────────────────────────
  /**
   * ⚠ A GRID, BECAUSE THE TWO THINGS THAT SET THE OPTO'S REDUCTION NOW MOVE
   * INDEPENDENTLY. This has been wrong twice, in opposite directions, and the
   * history is the argument for the shape.
   *
   * FIRST: a curve in SQUASH, sampled at one FET setting. It scored 0.80 dB of
   * error at Density 100 — the FET's drive rises with Density too, so the opto
   * ends up looking at a far more compressed signal than the sample point.
   *
   * ⚠ ALIGNMENT DOES NOT RESCUE THAT, and the reasoning that said it would is
   * worth keeping: `optoAlignDb` normalises the cell's input, so a curve behind
   * an alignment is a curve in knob position rather than in level. True of
   * LEVEL, false of SHAPE — alignment matches gated RMS, and gain reduction is
   * an integral over the envelope DISTRIBUTION, which the FET has been
   * flattening all the way up the macro. Same energy, different crest,
   * different reduction.
   *
   * SECOND: a curve in DENSITY, walked along the shipping trajectory.
   * That was right while Density was the only axis — and Balance broke it the
   * day it arrived, because it moves drive and squash in OPPOSITE directions at
   * a fixed Density. Measured, the reported reduction was out by up to 2.86 dB:
   * the panel read 3.90 dB where the opto was really doing 1.04.
   *
   * ⚠ THE AUDIO WAS CORRECT IN BOTH CASES — only the number the panel printed
   * was wrong. `squash` is computed, never interpolated, and the interpolated
   * `optoAlignDb` lands within 0.26 dB, so rendered reduction agrees to 0.009
   * dB. That is why this is scored by rendering both param sets and comparing
   * the RESULT: the bench's first version flagged an audio problem that did not
   * exist and hid a reporting one that did.
   *
   * So: sample the two axes that actually determine it. The grid is bilinear in
   * (drive, squash) and covers every Balance position,
   * because the squash axis runs to the widest any of them can ask for.
   */
  const gridDrives = []
  const gridSquash = []
  for (let i = 0; i < OPTO_GRID_DRIVES; i++) {
    gridDrives.push((100 * i) / (OPTO_GRID_DRIVES - 1))
  }
  for (let j = 0; j < OPTO_GRID_SQUASH; j++) {
    gridSquash.push((MAX_SQUASH * j) / (OPTO_GRID_SQUASH - 1))
  }

  // [driveIndex][squashIndex]
  const gridPeakDb = []
  const gridAvgDb = []
  const gridCrestDb = []
  const gridSpreadDb = []
  const gridOutP999Db = []
  const gridOutPeakDb = []
  const gridAlignDb = []
  let blend = { correlation: 0, densityDb: 0, trimDb: 0 }
  const midDrive = Math.floor(OPTO_GRID_DRIVES / 2)
  const midSquash = Math.floor(OPTO_GRID_SQUASH / 2)

  for (let i = 0; i < OPTO_GRID_DRIVES; i++) {
    const dry = renderFet(
      midClip, sampleRate, { ...patch, fetDrive: gridDrives[i], fetAlignDb },
    ).out
    const align = inputAlignDbFor(dry, sampleRate)
    gridAlignDb.push(align)
    const peak = []
    const avg = []
    const crest = []
    const spread = []
    /**
     * ⚠ THE SECTION'S OUTPUT LEVEL AT MIX 1, WHICH IS EXACTLY THIS RENDER. At
     * Mix 1 the blend law's dry gain is cos(π/2) = 0 and its compensation is
     * exactly 1, so the output is the wet path and nothing else.
     */
    const outP999 = []
    const outPeak = []
    for (let j = 0; j < OPTO_GRID_SQUASH; j++) {
      const r = renderWet(
        dry, sampleRate, { ...patch, squash: gridSquash[j], optoAlignDb: align },
      )
      const m = measureDynamics(r.out, sampleRate)
      peak.push(r.metering.maxGainReductionDb)
      avg.push(r.metering.avgGainReductionDb)
      crest.push(m.crestDb)
      spread.push(m.spreadDb)
      outP999.push(toDb(percentileOfChannels(r.out, MAKEUP_PERCENTILE)))
      outPeak.push(m.peakDb)
      /**
       * ⚠ MEASURED ONCE, MID-GRID. Across the whole Density range the blend
       * moves 0.0122 of correlation and 0.300 dB of density, which is 0.034 dB
       * of level through the mix law at its worst Mix position — below what the
       * sweep already concedes on impact, so sampling it per grid point would
       * buy nothing for a wet render each.
       */
      if (i === midDrive && j === midSquash) {
        blend = measureBlend(dry, r.out, sampleRate, r.latencySamples)
      }
    }
    gridPeakDb.push(peak)
    gridAvgDb.push(avg)
    gridCrestDb.push(crest)
    gridSpreadDb.push(spread)
    gridOutP999Db.push(outP999)
    gridOutPeakDb.push(outPeak)
  }

  return {
    sampleRate,
    patch,
    input,
    clip: {
      thresholds, crest, depth, impact,
      outP999Db: clipOutP999Db, outPeakDb: clipOutPeakDb, outAlignDb: clipOutAlignDb,
    },
    fet: {
      alignDb: fetAlignDb,
      drives,
      impact: fetImpact,
      peakDb: fetPeakDb,
      outAlignDb: fetOutAlignDb,
      /** Output level at Mix 0, per drive — see `makeupDb`. */
      outP999Db: fetOutP999Db,
      outPeakDb: fetOutPeakDb,
      /**
       * ⚠ HOW MUCH IMPACT EACH DRIVE REMOVES, AND THIS IS WHAT THE LOOKUP USES.
       * The absolute curve above is kept for the bench and for reading; asking
       * it "which drive reaches impact X" DOUBLE-COUNTS the clipper.
       *
       * The curve is sampled at ONE clip setting, so its drive-0 value is that
       * setting's post-clip impact. The target, though, is computed from the
       * post-clip impact of the threshold actually chosen — a different number.
       * Inverting an absolute curve therefore charges the FET for a clipper
       * difference the sweep has already accounted for.
       *
       * ⚠ A SECOND NARRATOR IS WHAT EXPOSED IT. On the first, absolute spread
       * across the clip range was 0.08 dB and the error was invisible. On the
       * second: absolute 0.62 dB, but measured as a DROP from each curve's own
       * drive-0 the same three curves spread only 0.44 — and at low drive,
       * where the macro's bottom end lives, 0.62 against 0.12. The mismatch
       * cost 0.25 dB of delivered impact at Density 10.
       */
      impactDrop: fetImpact.map(v => fetImpact[0] - v),
    },
    opto: {
      drives: gridDrives,
      squash: gridSquash,
      alignDb: gridAlignDb,
      peakDb: gridPeakDb,
      avgDb: gridAvgDb,
      crestDb: gridCrestDb,
      spreadDb: gridSpreadDb,
      /** Output level at Mix 1, per (drive, squash) — see `makeupDb`. */
      outP999Db: gridOutP999Db,
      outPeakDb: gridOutPeakDb,
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
  const target = effectiveTarget(options.balance)
  const clipShaveDb = options.clipShaveDb ?? DEFAULT_CLIP_SHAVE_DB
  const { input, patch } = sweep

  const thrDesc = [...sweep.clip.thresholds].reverse()
  const crestDesc = [...sweep.clip.crest].reverse()
  const depthDesc = [...sweep.clip.depth].reverse()

  // ── 1. Clipper: ONE inversion against TWO constraints, as the bisect has it
  const wantShave = clipShaveFor(clipShaveDb, density)
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
  /**
   * Where to read the clip curves for the signal the clipper actually handed
   * on. Its shallowest sample is the section's peak, i.e. a clipper that did
   * nothing — which is exactly what a null threshold means.
   */
  const clipAt = clipThresholdDb ?? sweep.clip.thresholds.at(-1)

  // ── 2. FET, on how much impact the drive REMOVES ────────────────────────
  /**
   * ⚠ THE DRIVE IS FOUND ON THE DROP CURVE, NOT THE ABSOLUTE ONE. Both describe
   * the same renders; the difference is what the clipper is charged for. See
   * `fet.impactDrop` — inverting the absolute curve makes the FET absorb a
   * clipper difference the lookup above has already measured.
   */
  const targetImpact = fetTargetImpactFor(
    target.impactDb, density, afterClipImpactDb, maxDropFor(options),
  )
  const wantDrop = afterClipImpactDb - targetImpact
  /**
   * ⚠ NOTHING TO DO MEANS BYPASS, NOT DRIVE 0 — AND DRIVE 0 IS A 24 dB
   * ATTENUATOR. The FET's Input knob attenuates the audio path as well as the
   * detector, exactly as the hardware wires it, so drive 0 delivers 0.07 dB of
   * gain reduction and takes the whole signal down 24.00 dB. Measured.
   *
   * `crossingOf` returns the first sampled drive when the target is already
   * met, which is 0 — correct as a curve lookup and catastrophic as a setting.
   * It never came up while the targets were unreachable; the recalibration
   * above made them reachable and exposed it immediately, against the file that
   * needed least.
   *
   * A null drive bypasses the stage (bit-exact, latency preserved), which is
   * the same contract the clipper's absent threshold has.
   */
  let fetDrive = null
  let afterFetImpactDb = afterClipImpactDb
  let fetShortfallDb = 0
  if (wantDrop > 0.05) {
    // The drop RISES with drive, and `crossingOf` walks a falling curve.
    fetDrive = Math.min(FET_MAX_SOLVE_DRIVE, crossingOf(
      sweep.fet.drives, sweep.fet.impactDrop.map(v => -v), -wantDrop,
    ))
    const gotDrop = lerpAt(sweep.fet.drives, sweep.fet.impactDrop, fetDrive)
    afterFetImpactDb = afterClipImpactDb - gotDrop
    /**
     * ⚠ REPORTED WHEN THE TARGET IS OUT OF REACH, for the same reason the
     * clipper reports its cap: impact has only ~3 dB of travel through this
     * device, so a target below the floor pins the drive at 100 and looks
     * exactly like a target that was met. Silence here is what let 26 dB of
     * gain reduction ship.
     */
    fetShortfallDb = Math.max(0, wantDrop - gotDrop)
  }

  // ── 3. Opto, at its own input's alignment ───────────────────────────────
  /**
   * ⚠ `squash` IS EXACT AND `optoAlignDb` IS THE INTERPOLATION. The depth is a
   * calibrated constant scaled by Density, so it needs no curve at all; what
   * has to be looked up is where the opto's input SITS, which the FET moves by
   * many dB across its range. Read from the FET's drive, not from the section's
   * input — that is the staged-alignment rule, and taking it from the raw file
   * gives 0.25 dB of reduction where the opto's own input gives 2.98.
   */
  const squash = squashFor(target.squash, density)
  /**
   * ⚠ AND FROM THE CLIP CURVE WHEN THE FET IS OUT — for the fifth time, a null
   * drive is not drive 0. Drive 0 is the 24 dB attenuator, so reading the FET's
   * alignment curve there told the opto its input was 24 dB down when the stage
   * had simply been skipped, and the opto was driven that much too hard. The
   * dry path with the FET out is the post-CLIP signal, whose own alignment the
   * clip sweep carries.
   */
  const optoAlignDb = fetDrive === null
    ? lerpAt(sweep.clip.thresholds, sweep.clip.outAlignDb, clipAt)
    : lerpAt(sweep.fet.drives, sweep.fet.outAlignDb, fetDrive)

  /**
   * ⚠ THE OUTPUT LEVEL IS LINEAR IN MIX, so two sampled ends are enough. The
   * blend's dry side is the post-FET path (Mix 0 output exactly) and its wet
   * side is the opto grid's render (Mix 1 output exactly). Measured across
   * Density 20-100, the true output tracks that interpolation to 0.04 dB;
   * reading the Mix-0 end alone — which the blend law's level compensation
   * makes tempting — is out by 1.88 dB at Mix 1, because the law holds POWER
   * constant and the wet path has a different crest.
   */
  const mix = clamp(options.mix ?? DEFAULT_MIX, 0, 1)
  const atMix = (dry, wet) => dry + (wet - dry) * mix
  /**
   * ⚠ A BYPASSED FET IS NOT THE FET CURVE AT DRIVE 0. Drive 0 is a 24 dB
   * attenuator (see `fetEnabled`), so a `?? 0` fallback here told the makeup
   * the output was 24 dB down when the stage had simply been skipped — measured
   * +24.16 dB over the input peak. When the FET is out, the dry path is the
   * post-CLIP signal, which the clipper's own curve carries.
   */
  const dryP999 = fetDrive === null
    ? pchipAt(sweep.clip.thresholds, sweep.clip.outP999Db, clipAt)
    : pchipAt(sweep.fet.drives, sweep.fet.outP999Db, fetDrive)
  const dryPeak = fetDrive === null
    ? pchipAt(sweep.clip.thresholds, sweep.clip.outPeakDb, clipAt)
    : pchipAt(sweep.fet.drives, sweep.fet.outPeakDb, fetDrive)
  // The wet grid is indexed by drive; with the FET out its input is the clipped
  // signal, which the grid's top row (drive 100) does not describe either — so
  // a bypassed FET reads the grid at the drive the solve would otherwise use.
  const gridDrive = fetDrive ?? 0
  /**
   * ⚠ WITH THE FET OUT, THE WET PATH IS NOT THE DRY PATH — and saying it was
   * cost up to 2.31 dB of overshoot past the input peak. The wet side is still
   * Pultec pre -> opto -> Pultec post, which has gain of its own; treating it as
   * equal to dry modelled the opto block as if it were not there, so the
   * predicted peak under-read and the makeup's cap had nothing to bind.
   *
   * The grid cannot be read for LEVEL at drive 0 the way `at()` reads it for
   * SHAPE, because its rows carry the attenuator's 24 dB in their absolute
   * levels. So the wet path is read as a GAIN — grid row minus the FET row that
   * fed it — which cancels the attenuation and leaves what the opto block does
   * to whatever arrives. Same lesson as `fet.impactDrop`: store the difference,
   * not the absolute, when the thing underneath it can move.
   */
  const wetGainDb = (grid, fetLevels) =>
    bilinearAt(sweep.opto.drives, sweep.opto.squash, grid, 0, squash) - fetLevels[0]
  const outP999Db = atMix(dryP999,
    fetDrive === null
      ? dryP999 + wetGainDb(sweep.opto.outP999Db, sweep.fet.outP999Db)
      : bilinearAt(sweep.opto.drives, sweep.opto.squash, sweep.opto.outP999Db, gridDrive, squash))
  /**
   * ⚠ PEAK DOES NOT INTERPOLATE, AND INTERPOLATING IT COST 1.97 dB OF OVERSHOOT.
   * Level does — the p99.9 above tracks a Mix lerp to 0.04 dB — but the peak of
   * a SUM is not the lerp of the two peaks: the blend adds two signals and their
   * loudest samples do not have to land in the same place or scale together.
   *
   * So the peak is BOUNDED rather than predicted, by the triangle inequality on
   * the actual blend gains: |dry·g_d + wet·g_w| ≤ (peak_d·g_d + peak_w·g_w)·comp.
   * That is a true upper bound at every Mix, so the cap below cannot be
   * undershot. It is nearly tight here because the two paths are the same voice
   * (measured rho 0.956), which is exactly why the blend law needs its
   * correlation term in the first place.
   */
  const wetPeak = fetDrive === null
    ? dryPeak + wetGainDb(sweep.opto.outPeakDb, sweep.fet.outPeakDb)
    : bilinearAt(sweep.opto.drives, sweep.opto.squash, sweep.opto.outPeakDb, gridDrive, squash)
  const g = mixGains(mix, sweep.blend.correlation, sweep.blend.densityDb)
  const lin = (db) => Math.pow(10, db / 20)
  const outPeakDb = 20 * Math.log10(Math.max(1e-9,
    (lin(dryPeak) * g.dry + lin(wetPeak) * g.wet) * g.compensation))
  const makeupDb = makeupDbFor(sweep.input.p999Db, input.peakDb, outP999Db, outPeakDb)

  const params = {
    ...patch,
    clipThresholdDb,
    fetDrive,
    fetAlignDb: sweep.fet.alignDb,
    squash,
    optoAlignDb,
    makeupDb,
    mix,
    correlation: sweep.blend.correlation,
    densityDb: sweep.blend.densityDb,
    outputDb: sweep.blend.trimDb,
  }

  /**
   * ⚠ THE REPORT'S OPTO FIGURES ARE BILINEAR IN (DRIVE, SQUASH), which are the
   * two things that actually set them — and which Balance moves in OPPOSITE
   * directions at a fixed Density. Indexing by squash alone was out by 0.80 dB
   * at the top of the macro; indexing by Density was out by 2.86 dB the moment
   * Balance existed. See the grid note in `sweepDynamics`.
   *
   * These are report values ONLY. Every param above is computed or read off the
   * knob curves; nothing here reaches the audio.
   */
  /**
   * ⚠ READ AT `gridDrive`, NOT AT A NULL. With the FET out the opto's input is
   * the post-clip signal, which no grid row renders — but the grid's rows differ
   * only in ENVELOPE SHAPE, level being normalised by the alignment, and drive
   * 0 does 0.07 dB of gain reduction, so its shape is the un-compressed one.
   * The row is the right proxy; relying on `bilinearAt` to clamp a null to it
   * was an accident that happened to land there.
   */
  const at = (grid) => bilinearAt(sweep.opto.drives, sweep.opto.squash, grid, gridDrive, squash)
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
        peakDb: fetDrive === null
          ? 0
          : lerpAt(sweep.fet.drives, sweep.fet.peakDb, fetDrive),
        targetImpactDb: targetImpact,
        /** The relative floor's drop, or null when the absolute target ran. */
        maxDropDb: maxDropFor(options),
        /** How far short of the target the drive ran out, dB. 0 when met. */
        shortfallDb: fetShortfallDb,
        capped: fetShortfallDb > 0.05,
      },
      opto: {
        squash,
        alignDb: optoAlignDb,
        peakDb: at(sweep.opto.peakDb),
        avgDb: at(sweep.opto.avgDb),
        calibratedSquash: DYNAMICS_TARGET.squash,
        balancedSquash: target.squash,
      },
      blend: sweep.blend,
      makeup: {
        db: makeupDb,
        /** What the section would have delivered without it. */
        outP999Db,
        outPeakDb,
        /** True when the peak cap bound rather than the percentile target. */
        peakCapped: input.p999Db - outP999Db > input.peakDb - outPeakDb + 0.01,
      },
      crestRoseBy: wetCrestDb - input.crestDb,
      /** ⚠ So a reader of the report knows which path produced it. */
      fromSweep: true,
    },
  }
}
