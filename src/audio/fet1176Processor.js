/**
 * 1176-style FET limiting amplifier emulation ("FET Punch") — worklet kernel.
 *
 * Companion to la2aProcessor.js (OptoSmooth). Same contract: this file is
 * BOTH a normal ES module (exports FET1176Kernel and processFET1176Buffer for
 * offline use and Node-based verification) AND an AudioWorklet module
 * (registers 'fet1176-processor' when loaded into an AudioWorkletGlobalScope).
 * Its loader goes through `?worker&url`, which bundles whatever it imports into
 * one self-contained chunk — see fet1176WorkletLoader.js.
 *
 * The same kernel therefore runs in three places with identical results:
 * real-time preview (AudioContext), offline apply (OfflineAudioContext), and
 * Node verification scripts.
 *
 * Where the LA-2A is slow, optical and self-effacing, this one is the
 * opposite, and the model is built around the differences that matter:
 *
 * 1. FET gain element, not a light bulb
 *    - Attack is user-set from 800 us (dial 1) down to 20 us (dial 7), which
 *      is short enough that the gain cell tracks individual waveform peaks
 *      rather than an envelope. That is where the "grab" comes from.
 *    - Release runs 1.1 s (dial 1) to 50 ms (dial 7).
 *    - Both dials are REVERSED on the hardware: 7 is the fastest position,
 *      not the slowest. Modeled the same way so the UI can print the dial
 *      number the way the panel does.
 *
 * 2. Program-dependent release
 *    - The control-voltage network does not discharge on a single time
 *      constant. A minority share of the reduction hangs on a slower tail,
 *      so dense program recovers more slowly than isolated peaks.
 *
 * 3. Input as the only threshold control
 *    - Like the LA-2A there is no threshold knob. Input is an attenuator
 *      ahead of a fixed internal threshold, and it feeds the audio path as
 *      well as the detector, so turning it up raises level AND compression
 *      together. Output then brings it back down. That interaction is the
 *      whole gain-staging feel of the unit and is modeled directly.
 *    - The threshold is referenced to nominal analog operating level
 *      (0 VU = -18 dBFS), matching the LA-2A model's NOMINAL_DBFS.
 *
 * 4. Ratio buttons, including all-buttons-in
 *    - 4:1, 8:1, 12:1 and 20:1 select progressively tighter knees.
 *    - Pressing every button at once ("British mode") is not a ratio at all:
 *      it drops the effective threshold, bends the curve so the ratio climbs
 *      with level, lags the attack, lengthens the release tail and pushes the
 *      FET much harder. Modeled as its own mode rather than as a number.
 *
 * 5. Detector and output stage
 *    - Broadband detector (the hardware has no sidechain filter); an optional
 *      one-pole sidechain high-pass is offered as a modern extension so
 *      plosives and rumble don't duck a narration track.
 *    - Asymmetric tanh waveshaper standing in for the FET plus class-A output
 *      amp, followed by a DC blocker.
 *
 * OVERSAMPLING. The gain cell and the FET stage run at OVERSAMPLE_FACTOR times
 * the base rate; the detector, the ballistics and the gain computer stay at the
 * base rate, where their time constants were tuned.
 *
 * This unit has two things generating content above Nyquist, not one. The
 * obvious one is the waveshaper. The other is the gain signal itself: the
 * detector is deliberately unsmoothed and at attack dial 7 the cell tracks the
 * waveform, so the gain sequence is a broadband nonlinear function of the input
 * and multiplying by it folds. At 44.1 kHz that showed up as -47 dBc of folded
 * product on a 9 kHz tone at the default fetDrive, and -80 dBc with the FET
 * stage switched off entirely — the residue of the multiply alone.
 *
 * Forming the product at the oversampled rate addresses both. What it cannot
 * recover is detail already lost in computing the gain at the base rate; taking
 * the detector up as well would change the ballistics, which is the sound.
 *
 * The cost is OVERSAMPLE_LATENCY_SAMPLES of latency. Both the dry side of the
 * wet/dry blend and the gain envelope are delay-compensated inside the kernel,
 * so a parallel setting still lines up; the offline apply path compensates the
 * whole-plugin delay via `latencySamples`.
 */

import {
  Oversampler, DelayLine, OVERSAMPLE_FACTOR,
  OVERSAMPLE_LATENCY_SAMPLES, UPSAMPLE_DELAY_SAMPLES,
} from './dsp/oversample.js'

export { OVERSAMPLE_FACTOR, OVERSAMPLE_LATENCY_SAMPLES }

// ── Level reference ─────────────────────────────────────────────────────────

// Nominal operating level (0 VU = +4 dBu). The internal threshold sits at
// line level on the hardware, so Input is referenced to that rather than to
// digital full scale — see the same constant in la2aProcessor.js.
// Output-gain smoothing time. Short enough to feel immediate under a knob,
// long enough that a step of tens of dB cannot click. Matches the soft
// clipper's PARAM_SMOOTH_MS.
const OUT_SMOOTH_MS = 8

const NOMINAL_DBFS = -18
const THRESHOLD_DBFS = NOMINAL_DBFS

// Input knob 0-100 -> drive into the fixed threshold, spanning 40 dB
// (-24 dB at knob 0, +16 dB at knob 100). IN_TAPER < 1 models the hardware's
// stepped audio-taper attenuator: level rises quickly off zero and flattens
// toward the top.
const IN_DRIVE_MIN_DB = -24
const IN_DRIVE_SPAN_DB = 40
const IN_TAPER = 0.8

/**
 * Extra drive above the knee, so the top of the knob reaches the reference.
 *
 * ⚠ THE PLAIN FIX — RAISING `IN_DRIVE_SPAN_DB` — MOVES EVERY KNOB POSITION, and
 * that is not a cosmetic objection. `inputDrive` is a value presets SAVE, so a
 * wider span silently re-voices all five factory presets and every patch a user
 * has stored: at span 47 the knob's midpoint runs 3.4 dB hotter than the number
 * beside it used to mean. The Scheps inheritance bug, which shipped 4x the
 * intended gain reduction because a change landed on shared defaults, is the
 * precedent.
 *
 * So the extra travel is added ON TOP of the existing law, weighted by a
 * smoothstep that is zero at the knee with zero slope there. Below knob 80 the
 * drive is bit-identical to before — which covers every factory preset, the
 * hottest of which is 75 — and the curve has no kink at the join. At knob 100 it
 * reaches +24 dB, which puts a -12 dBFS source at 22.5 dB of reduction against
 * the 16.3 it managed before. FETish sat at 21.86 dB in the capture our own knob
 * could not follow, so the top of the travel now clears the reference rather
 * than landing just under it — 7 dB of extra drive stopped 0.13 dB short, which
 * is inside the scatter on the source level and not a margin worth shipping.
 *
 * ⚠ A USER PATCH SAVED ABOVE KNOB 80 WILL GET HOTTER. That is a real break and
 * there is no way to both extend the top and leave the top unchanged; the knee
 * is placed to make the affected band as small as it can be.
 */
/**
 * 0 below `a`, 1 at `b`, with ZERO SLOPE AT BOTH ENDS.
 *
 * ⚠ THE ZERO SLOPE AT `a` IS THE WHOLE POINT and a linear ramp will not do. A
 * ramp joins the existing taper with a step change in slope — the knob would
 * visibly accelerate at one position, which is exactly the artefact a hardware
 * attenuator does not have. The zero slope at `b` is the existing law's own
 * behaviour, which already flattens toward the top.
 */
function smoothstepFrom(v, a, b) {
  if (v <= a) return 0
  if (v >= b) return 1
  const t = (v - a) / (b - a)
  return t * t * (3 - 2 * t)
}

const IN_DRIVE_EXTRA_DB = 8
const IN_DRIVE_KNEE = 80

// ── Ballistics ──────────────────────────────────────────────────────────────

// Dial 1 (slowest) and dial 7 (fastest) endpoints; positions in between are
// interpolated geometrically, as the hardware's switched resistor ladder does.
const ATTACK_SLOWEST_S = 0.0008
const ATTACK_FASTEST_S = 0.00002
const RELEASE_SLOWEST_S = 1.1
const RELEASE_FASTEST_S = 0.05

// Program-dependent release: this share of the reduction recovers on a tail
// this many times slower than the dial setting.
/**
 * Depth-scheduled release — OFF BY DEFAULT, and off is bit-identical to before.
 *
 * ⚠ THIS IS A DIFFERENT MECHANISM FROM `TAIL_FRACTION`, NOT A RETUNE OF IT. The
 * tail makes recovery depend on how LONG the cell was held down; this makes it
 * depend on how DEEP the reduction is. Measured on FETish with one release
 * setting and only the Input moving, release t63 runs 30 / 70 / 93 / 139 ms at
 * 6.2 / 14.0 / 17.5 / 21.9 dB — 4.6x — while it reads flat on both the exposure
 * and the density plans. Our own kernel with the tail off reads 233 ms at every
 * depth to the millisecond, which is what a fixed exponential must do, so the
 * measurement is clean and the effect is the reference's.
 *
 * ⚠ THE SCHEDULE READS THE CURRENT REDUCTION, NOT THE DEPTH AT RELEASE ONSET.
 * That is the physical choice — a cap network's recovery rate follows its present
 * state — and it is why the recovery is NOT a pure exponential and why measured
 * t63 is no longer the constant behind it. Fitting `k` by regressing the numbers
 * above is therefore wrong; it has to go through the kernel and the same
 * analysis, as everything else here does.
 */
const RELEASE_DEPTH_REF_DB = 10
const RELEASE_DEPTH_K = 0.098
const RELEASE_DEPTH_MAX_DB = 36
const RELEASE_LUT_STEP_DB = 0.25

const TAIL_FRACTION = 0.22
const TAIL_MULT = 4

// All-buttons-in holds far more of the reduction on the slow tail, which is
// what makes it pump and breathe instead of releasing cleanly.
const ALL_TAIL_FRACTION = 0.45
const ALL_TAIL_MULT = 6

// ── Gain computer ───────────────────────────────────────────────────────────

// Tighter knees as the ratio climbs — 4:1 is a comparatively gentle curve,
// 20:1 is nearly a corner.
const RATIO_VALUES = { 4: 4, 8: 8, 12: 12, 20: 20 }
const RATIO_KNEE_DB = { 4: 10, 8: 8, 12: 6, 20: 3 }

// All-buttons-in: a wide, badly-behaved knee whose effective ratio climbs
// with overshoot, over a threshold pulled down by ALL_THRESHOLD_DROP_DB.
const ALL_KNEE_DB = 16
const ALL_THRESHOLD_DROP_DB = 6
const ALL_RATIO_MIN = 6
const ALL_RATIO_SPAN = 14
const ALL_RATIO_HALF_DB = 12 // overshoot at which the ratio sits mid-range
// The famously late attack: the dial still sets the rate, but everything
// arrives slower than the number says.
const ALL_ATTACK_LAG = 2.5
// ...and the FET is driven much harder, which is most of the "sound".
const ALL_FET_BOOST = 1.6

/**
 * THE STATIC CURVE, MEASURED — Analog Obsession FETish, `npm run fet:curve`.
 *
 *   f(x) = x − 0.0100·x⁴ + 0.0100·x⁵   =   x − 0.01·x⁴·(1 − x)
 *
 * Fitted jointly over five tone levels spanning 24 dB and verified by rendering
 * the fitted curve back through the same tones: H2 matches to 0.1 dB at EVERY
 * level, worst error 1.39 dB over 17 usable harmonic readings. Held out the
 * loudest tone, refitted without it, and asked it to predict that tone: 1.41 dB.
 *
 * ⚠ THE ORDERS ARE MEASURED, NOT CHOSEN. A term of order n makes harmonics that
 * rise (n−1) dB per dB of level, of its own parity, at or below n. FETish reads
 * H2 3.00, H3 4.04, H4 3.02, H5 4.09 — orders 4 and 5 — and H6 through H9 sit
 * at the float noise floor, which is what a degree-5 polynomial and nothing else
 * looks like. H4/H2 measures −12.04 dB against a pure x⁴ term's −12.04.
 *
 * ⚠ AND THIS IS WHY THE `tanh` COULD NOT BE RETUNED INTO IT. A tanh is
 * cubic-dominant: its H2 rises about 1 dB per dB. No value of `fetDrive` moves
 * that to 3. The shape had to change, not the drive.
 *
 * ⚠ THE COEFFICIENTS ARE ±0.01 TO FOUR FIGURES, which is almost certainly the
 * reference's own design constants rather than anything our fit invented.
 */
const POLY_C4 = -0.0100
const POLY_C5 = 0.0100

/**
 * ⚠ THE POLYNOMIAL IS UNBOUNDED AND THE `tanh` IT REPLACES WAS NOT. Deviation
 * from linear is 0.00 at x = 1 and 0.02 at x = −1, but +0.16 at x = 2 and
 * +7.70 at x = 4 — and `inputDrive` can push the shaper's input well past
 * unity. Beyond this magnitude the curve continues LINEARLY at its own edge
 * slope, which is C1-continuous (no corner to alias) and grows no faster than
 * the input.
 *
 * 1.0 rather than something larger because the fit's own data only reaches a
 * peak of 0.5 (the −6 dBFS tone): past unity we would be extrapolating a
 * measurement by more than 6 dB, and a straight line is the honest extension.
 */
const POLY_XMAX = 1.0

const LN10_OVER_20 = Math.LN10 / 20

export const FET1176_KERNEL_DEFAULTS = {
  inputDrive: 50, // 0-100, drive into the fixed threshold (hardware Input knob)
  outputGainDb: 0, // makeup (hardware Output knob)
  attack: 4, // dial 1-7, 7 = fastest (hardware markings)
  release: 4, // dial 1-7, 7 = fastest (hardware markings)
  ratio: '4', // '4' | '8' | '12' | '20' | 'all'
  /**
   * Release-time schedule.
   *   'none'  — one constant per knob position, whatever the reduction. Ships,
   *             and is bit-identical to every render made before this existed.
   *   'depth' — the constant scales with the CURRENT reduction, which is the
   *             limb FETish actually has. See RELEASE_DEPTH_K.
   */
  releaseSchedule: 'none',
  /** dB⁻¹ slope of that schedule. Only read when releaseSchedule is 'depth'. */
  releaseDepthK: RELEASE_DEPTH_K,
  /**
   * FET / output-amp saturation amount, 0-1.
   *
   * ⚠ 1 IS THE MEASURED FETish CURVE, not an arbitrary top of travel, and the
   * default sits there deliberately: shipping 0.35 meant shipping 35 % of the
   * curve we had just gone and measured — 9 dB less H2 than the reference at
   * −6 dBFS. The old default of 0.35 was calibrated for the `tanh`, where the
   * knob also moved the asymmetry bias and the whole travel was far dirtier
   * (H2 −38 dBc at 0.35 against this curve's −73).
   */
  fetDrive: 1,
  /**
   * Which static curve the FET stage uses.
   *   'poly' — the measured FETish curve (see POLY_C4). `fetDrive` scales it,
   *            so 1 IS the reference curve and 0.35 is 35 % of it.
   *   'tanh' — the fitted asymmetric tanh this shipped with before the capture.
   * ⚠ `fetDrive` MEANS A DIFFERENT THING IN EACH. On 'tanh' it set a drive into
   * a fixed shaper; on 'poly' it is a fraction of a measured curve. A stored
   * preset value carries across numerically and NOT in voicing.
   */
  fetCurve: 'poly',
  /**
   * Where the static curve sits among the two gain stages.
   *
   *   'preInput' — ahead of the input attenuator: the shaper sees the SOURCE,
   *                so saturation is a property of the file and does not move
   *                when the Input knob does.
   *   'preCell'  — after the attenuator, before the cell. The topology measured
   *                on FETish (rms error 0.00 dB against 26.09 for the other).
   *   'postCell' — after the cell, on the compressed signal. What this kernel
   *                did before, and what CLA-76 measures (0.07 against 3.94).
   *
   * ⚠⚠ 'preCell' IS FETish's TOPOLOGY AND IS *NOT* FETish's BEHAVIOUR HERE, and
   * the difference is our Input knob. FETish's Input is internally compensated,
   * so its audio path sits at source level whatever the knob does and its
   * shaper sees a FIXED drive. Ours is a real gain. Bolting FETish's topology
   * onto our Input contract gives the shaper the knob's full travel with nothing
   * regulating it — measured on a −6 dBFS tone across Input 10→90, H2 moves:
   *
   *     preCell   79.6 dB        postCell  36.4 dB        FETish  0.0 dB
   *
   * So 'preCell' is the FURTHEST of the three from the reference it was taken
   * from. 'postCell' does better only by accident — the cell pulls down what
   * reaches the shaper as the knob pushes it up, regulating about half of it.
   *
   * 'preInput' reproduces FETish's saturation behaviour EXACTLY (0 dB of swing)
   * while leaving the Input knob a real gain and the makeup architecture
   * untouched. It is not physical — the hardware's attenuator comes first — but
   * neither is FETish's compensation, and this is the arrangement that matches
   * what the reference actually does. Same reasoning as `inputAlign.js`: make
   * the character a property of the FILE, not of a knob position.
   */
  fetPosition: 'preInput',
  scHpfHz: 0, // 0 = off (stock), or sidechain high-pass corner in Hz
  mix: 1, // wet/dry blend — parallel compression
  /**
   * Run the gain cell and FET stage oversampled. Always true for anything
   * anyone listens to; see `computeFET1176AutoMakeupDb` for the one caller
   * that turns it off and why that is sound.
   */
  oversample: true,
}

/**
 * ⚠ EVERY FET PUNCH RENDER MADE BEFORE THE FETish CAPTURE SOUNDS DIFFERENT NOW.
 * This patch reproduces the previous kernel exactly — the fitted asymmetric
 * `tanh`, sitting after the gain cell — and `test/dsp/fet1176Curve.test.js`
 * pins it bit-for-bit against a render, so it cannot rot.
 *
 * Same arrangement, and the same reason, as `LA2A_LEGACY_PATCH`: a measurement
 * that changes the voicing must leave the old voicing reachable, or there is no
 * way to A/B the change and no way back for anyone who preferred it.
 */
export const FET_LEGACY_PATCH = { fetCurve: 'tanh', fetPosition: 'postCell' }

/**
 * How much audio the live makeup tracker must hear before it will report.
 *
 * ⚠ WITHOUT IT A FRESHLY-RESET TRACKER REPORTS FROM ALMOST NO EVIDENCE, and
 * every compression-knob change resets it. Measured on a drag: the live value
 * came back as 4.6 / 4.1 / 12.1 / 8.5 / 8.1 dB from the first few blocks and
 * fought the offline measurement all the way down the knob. A quarter second is
 * long enough to hold several syllables and short enough that the tracker takes
 * over almost as soon as the hand stops.
 */
const MAKEUP_TRACKER_WARMUP_S = 0.25

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** Geometric interpolation between the dial-1 and dial-7 endpoints. */
function dialToSeconds(dial, slowestS, fastestS) {
  const t = (clamp(dial, 1, 7) - 1) / 6
  return slowestS * Math.pow(fastestS / slowestS, t)
}

/**
 * Attack/release time actually modeled at a given dial position. Exported so
 * the panel can print the real number under the knob instead of carrying a
 * second, drift-prone copy of the table.
 */
export function attackSecondsForDial(dial) {
  return dialToSeconds(dial, ATTACK_SLOWEST_S, ATTACK_FASTEST_S)
}

export function releaseSecondsForDial(dial) {
  return dialToSeconds(dial, RELEASE_SLOWEST_S, RELEASE_FASTEST_S)
}

/**
 * Stateful block processor. Feed it consecutive blocks of any length and it
 * behaves identically to processing the concatenation in one pass (block size
 * affects nothing — every coefficient is fixed at setParams time).
 */
export class FET1176Kernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate

    // DC blocker pole (~5 Hz) — the asymmetric shaper shifts the operating point
    this.dcR = 1 - 2 * Math.PI * 5 / sampleRate

    // Sidechain / detector state
    this.hpfLp1 = 0
    this.hpfLp2 = 0
    this.grMain = 0
    this.grTail = 0

    // Per-channel DC blocker state (grown on demand)
    this.dcX = []
    this.dcY = []

    // Per-channel oversamplers and dry-path delay lines (grown on demand).
    this.oversamplers = []
    this.dryLines = []

    // The gain envelope is computed once per block at the base rate and shared
    // by every channel, so it is delayed once, here, rather than per channel.
    //
    // One sample SHORT of the upsampler's delay, deliberately. Interpolating a
    // gain across the oversampled sub-samples needs both endpoints, and the
    // later one has to be in hand before the earlier one is used. Holding the
    // envelope one sample less makes `gain[i]` the newer endpoint and last
    // block's `gain[i-1]` the older one, which is exactly the pair the ramp in
    // `process` consumes.
    this.gainDelay = new DelayLine(Math.max(0, UPSAMPLE_DELAY_SAMPLES - 1))
    // Last gain of the previous block, for interpolating across the block seam.
    this.lastGain = 1

    // Metering
    this.grDb = 0
    this.maxGrDb = 0
    this.grSum = 0
    this.grActive = 0

    this.gainScratch = new Float32Array(128)
    this.wetScratch = new Float64Array(128)
    this.outScratch = new Float32Array(128)
    // null = not yet seeded. The first block adopts the target exactly so an
    // offline render carries its makeup from sample 0; see process().
    this.outLinSmoothed = null

    /**
     * LIVE AUTO-MAKEUP TRACKER — running extrema, O(1) per sample.
     *
     * The same affine identity the offline solve rests on: `out = a + b·g` with
     * `a = dry·(1−mix)` and `b = wet·mix`, because the output gain is the last
     * multiply on the wet path and the detector reads the INPUT. BOTH are
     * independent of `g`, which is what lets the panel write the answer back
     * onto the knob without the measurement chasing itself.
     *
     * ⚠ TWO SHAPES WERE TRIED AND BOTH FAILED. A running MINIMUM of the
     * per-sample bound LATCHES, because the bound is taken against an input
     * peak that grows and the earliest, smallest bound wins forever: measured,
     * it froze at −0.83 dB against a true 10.25. And tracking the largest |b|
     * is exact at Mix 1 and +2.4 dB too generous at Mix 0.3, in the too-loud
     * direction, because with a large dry share the wet peak is not the sample
     * that binds.
     *
     * WHAT IS TRACKED IS `max|a|` AND `max|b|` SEPARATELY, and the bound is
     * `(P − max|a|) / max|b|`. Since `|a_i + b_i·g| <= max|a| + max|b|·g` for
     * every sample, that bound PROVABLY keeps the output peak at or under `P` —
     * the guarantee the offline solve makes, kept by the live one. It is EXACT
     * at Mix 1, where `a` is zero, and conservative below it: the two maxima
     * need not fall on the same sample, so the live makeup can come out a
     * little small at parallel settings. Under-delivering is the safe
     * direction, and APPLY re-measures offline for the exact number anyway.
     *
     * ⚠ TWO TIGHTER SHAPES WERE TRIED AND BOTH BROKE THE GUARANTEE. A running
     * MINIMUM of the per-sample bound LATCHES — the bound is taken against an
     * input peak that grows, so the earliest and smallest wins forever, and it
     * froze at −0.83 dB against a true 10.25. And tracking the single sample
     * that maximises `|a| + |b|·ĝ` is not a bound at all: measured at Mix 0.4
     * it asked for 11.66 dB against a true 7.60 and drove the output 2.75 dB
     * hotter than its source.
     */
    this.trkInPeak = 0
    this.trkSamples = 0
    this.trkAAbs = 0     // largest |a| seen
    this.trkBAbs = 0     // largest |b| seen
    this.outSmoothCoef = 1 - Math.exp(-1 / (sampleRate * (OUT_SMOOTH_MS / 1000)))

    this.params = { ...FET1176_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Merge a partial param update and recompute derived coefficients. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    const sr = this.sampleRate

    this.isAllButtons = String(p.ratio) === 'all'
    if (this.isAllButtons) {
      this.kneeDb = ALL_KNEE_DB
      this.thresholdDb = THRESHOLD_DBFS - ALL_THRESHOLD_DROP_DB
      this.tailFraction = ALL_TAIL_FRACTION
      this.tailMult = ALL_TAIL_MULT
    } else {
      const ratioKey = RATIO_VALUES[p.ratio] ? p.ratio : '4'
      this.ratio = RATIO_VALUES[ratioKey]
      this.slope = 1 - 1 / this.ratio
      this.kneeDb = RATIO_KNEE_DB[ratioKey]
      this.thresholdDb = THRESHOLD_DBFS
      this.tailFraction = TAIL_FRACTION
      this.tailMult = TAIL_MULT
    }
    this.halfKnee = this.kneeDb / 2
    this.mainFraction = 1 - this.tailFraction

    // Ballistics. Attack is applied to the whole reduction; release splits
    // across a main stage and a slower tail.
    //
    // ⚠ THE SPLIT IS NOT A CLAIM THAT THE 1176 HAS TWO RELEASE CIRCUITS. It
    // has one, heavily program-dependent: recovery is quick after a transient
    // and lengthens under sustained compression. Two stages filling
    // proportionally on attack and decaying at different rates is how we
    // produce that observable — the longer the cell is held down, the more of
    // the reduction sits on the slow stage. Measured on our own kernel, release
    // t63 grows 21-25 % from a 50 ms hold to a 3 s one.
    let attackS = dialToSeconds(p.attack, ATTACK_SLOWEST_S, ATTACK_FASTEST_S)
    if (this.isAllButtons) attackS *= ALL_ATTACK_LAG
    const releaseS = dialToSeconds(p.release, RELEASE_SLOWEST_S, RELEASE_FASTEST_S)

    this.attackCoef = 1 - Math.exp(-1 / (sr * attackS))
    this.releaseCoef = 1 - Math.exp(-1 / (sr * releaseS))
    this.tailCoef = 1 - Math.exp(-1 / (sr * releaseS * this.tailMult))

    /**
     * \u26a0 A TABLE, NOT A `Math.exp` PER SAMPLE. The schedule reads the current
     * reduction, so a closed form would put two transcendentals in the envelope
     * loop at 4x oversampling. Quantising the DEPTH to 0.25 dB costs nothing
     * audible \u2014 the coefficient moves 2.4 % per step at k = 0.098 \u2014 and the
     * table is rebuilt only when a parameter changes.
     */
    this.releaseScheduled = p.releaseSchedule === 'depth'
    if (this.releaseScheduled) {
      const k = Number.isFinite(p.releaseDepthK) ? p.releaseDepthK : RELEASE_DEPTH_K
      const n = Math.round(RELEASE_DEPTH_MAX_DB / RELEASE_LUT_STEP_DB) + 1
      if (!this.releaseLut || this.releaseLut.length !== n) this.releaseLut = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        const depthDb = i * RELEASE_LUT_STEP_DB
        const tau = releaseS * Math.exp(k * (depthDb - RELEASE_DEPTH_REF_DB))
        this.releaseLut[i] = 1 - Math.exp(-1 / (sr * tau))
      }
    }

    // Input attenuator: audio path and detector both, as on the hardware.
    const knobPos = clamp(p.inputDrive, 0, 100)
    const knob = knobPos / 100
    this.inputDriveDb = IN_DRIVE_MIN_DB + IN_DRIVE_SPAN_DB * Math.pow(knob, IN_TAPER)
      + IN_DRIVE_EXTRA_DB * smoothstepFrom(knobPos, IN_DRIVE_KNEE, 100)
    this.inputLin = Math.exp(this.inputDriveDb * LN10_OVER_20)
    this.outputLin = Math.exp(p.outputGainDb * LN10_OVER_20)

    // Optional sidechain high-pass (0 = off, the stock broadband detector).
    // Two cascaded one-poles: a single pole leaves too much of a 60-80 Hz
    // plosive in the detector to be worth switching on.
    this.scHpfOn = p.scHpfHz > 0
    this.hpfLpCoef = this.scHpfOn
      ? 1 - Math.exp(-2 * Math.PI * p.scHpfHz / sr)
      : 0

    // FET + class-A output amp. Drive can go sub-unity (the slope is
    // normalized back to 1 below), so `fetDrive` sets harmonic content
    // without changing level.
    const amount = clamp(p.fetDrive, 0, 1)
    this.applyFet = amount > 0
    this.fetDriveLin = (0.3 + 2.2 * amount) * (this.isAllButtons ? ALL_FET_BOOST : 1)
    this.fetBias = 0.15 * amount
    this.tanhBias = Math.tanh(this.fetBias)
    // Normalize so the shaper has unity small-signal gain
    this.fetNorm = this.fetDriveLin * (1 - this.tanhBias * this.tanhBias)

    this.fetPoly = p.fetCurve !== 'tanh'
    // 0 = postCell, 1 = preCell, 2 = preInput. A number so the hot loop
    // branches on an integer rather than comparing strings per sample.
    this.fetPos = p.fetPosition === 'postCell' ? 0 : p.fetPosition === 'preCell' ? 1 : 2
    /**
     * The measured curve, scaled by the same amount the tanh path uses. All
     * buttons in drives it harder, exactly as it does the tanh.
     *
     * ⚠ THIS WAS CLAMPED AT 1 AND THE CLAMP WAS WRONG. The reasoning was "never
     * deeper than what was measured" — but the fitted range is a range of x,
     * which `POLY_XMAX` already guards, and scaling the coefficients only makes
     * the curve deeper, not wider. It stays monotonic there: at 1.6x depth
     * f'(x) = 1 + 4c₄x³ + 5c₅x⁴ bottoms out at 1.016 across [−1, 1].
     *
     * What the clamp actually did was flatten the top of the knob in
     * all-buttons mode from 0.625 upward — neutering the one mode whose whole
     * point is that the FET is driven harder.
     */
    const polyAmount = amount * (this.isAllButtons ? ALL_FET_BOOST : 1)
    this.polyC4 = POLY_C4 * polyAmount
    this.polyC5 = POLY_C5 * polyAmount
    // Edge value and slope at each end, for the linear continuation. Held
    // separately per side because the curve is asymmetric: f(−1) is −1.02 where
    // f(1) is exactly 1.
    const fAt = x => x + this.polyC4 * x ** 4 + this.polyC5 * x ** 5
    const dAt = x => 1 + 4 * this.polyC4 * x ** 3 + 5 * this.polyC5 * x ** 4
    this.polyEdgePos = fAt(POLY_XMAX)
    this.polySlopePos = dAt(POLY_XMAX)
    this.polyEdgeNeg = fAt(-POLY_XMAX)
    this.polySlopeNeg = dAt(-POLY_XMAX)
    // Lets the pre-cell path recover the cell's own gain from the folded
    // coefficient without a per-sample divide.
    this.invInputLin = 1 / this.inputLin

    this.wetMix = clamp(p.mix, 0, 1)
    this.dryMix = 1 - this.wetMix

    this.oversampleOn = p.oversample !== false
  }

  /**
   * Algorithmic latency, in samples. Reported to the offline apply path, which
   * renders long and trims.
   *
   * Constant across every setting a listener can reach — the oversampled path
   * runs even at `fetDrive: 0`, so switching the FET stage off cannot shift the
   * timeline underneath a running preview. It is zero only in the measurement
   * mode described on `oversample`, which nothing renders through.
   */
  get latencySamples() {
    return this.oversampleOn ? OVERSAMPLE_LATENCY_SAMPLES : 0
  }

  /**
   * The FET stage's static curve, whichever one is selected.
   *
   * ⚠ ONE ENTRY POINT FOR BOTH CURVES AND BOTH PATHS. The oversampled and
   * base-rate loops each used to carry their own copy of the tanh expression,
   * and a third copy would have made a curve change a three-place edit with two
   * chances to diverge. The measurement path (`oversample: false`) has to agree
   * with the render path exactly or the auto-makeup solves against a different
   * plugin than the one anybody hears.
   */
  _shapeFet(x) {
    if (!this.fetPoly) {
      return (Math.tanh(this.fetDriveLin * x + this.fetBias) - this.tanhBias) / this.fetNorm
    }
    if (x > POLY_XMAX) return this.polyEdgePos + (x - POLY_XMAX) * this.polySlopePos
    if (x < -POLY_XMAX) return this.polyEdgeNeg + (x + POLY_XMAX) * this.polySlopeNeg
    const x2 = x * x
    const x4 = x2 * x2
    return x + this.polyC4 * x4 + this.polyC5 * x4 * x
  }

  /** Static curve: overshoot in dB -> gain reduction in dB. */
  _grForOvershoot(over) {
    if (over <= -this.halfKnee) return 0
    const slope = this.isAllButtons
      ? 1 - 1 / (ALL_RATIO_MIN + ALL_RATIO_SPAN * (over > 0 ? over / (over + ALL_RATIO_HALF_DB) : 0))
      : this.slope
    if (over >= this.halfKnee) return slope * over
    const t = over + this.halfKnee
    return slope * t * t / (2 * this.kneeDb)
  }

  /**
   * Process one block.
   *
   * @param {Float32Array[]} inputChannels  - per-channel input (any count)
   * @param {Float32Array[]} outputChannels - per-channel output to fill
   * @param {number} n                      - samples in this block
   */
  process(inputChannels, outputChannels, n) {
    const nIn = inputChannels.length
    const nOut = outputChannels.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].fill(0, 0, n)
      return
    }

    if (this.gainScratch.length < n) this.gainScratch = new Float32Array(n)
    if (this.wetScratch.length < n) this.wetScratch = new Float64Array(n)
    if (this.outScratch.length < n) this.outScratch = new Float32Array(n)
    const gain = this.gainScratch
    const chScale = 1 / nIn

    /**
     * OUTPUT GAIN, SMOOTHED — it was applied as a bare step.
     *
     * `outputLin` was recomputed in setParams and multiplied in directly, so
     * every param message stepped the gain discontinuously. Inaudible for a
     * knob nudged by hand; a click for anything that writes this knob rapidly,
     * which is exactly what AUTO makeup does — reported as zippering on rapid
     * adjustment.
     *
     * ⚠ COMPUTED ONCE PER BLOCK, NOT PER CHANNEL. The smoother has to advance
     * with TIME, and a per-channel one advances N times faster on N channels —
     * the bug HfLossShelf's depth ramp already shipped once. Same arrangement
     * as the gain envelope above it, which is shared for the same reason.
     *
     * ⚠ SEEDED ON THE FIRST BLOCK rather than ramped from unity, so an offline
     * render carries its makeup from sample 0. Ramping in from 0 dB puts a
     * swell at the head of every applied region.
     */
    // The tracker's target: the loudest input sample heard so far.
    //
    // ⚠ THIS IS A RUNNING MAXIMUM WITH UNBOUNDED MEMORY, AND IT IS WHY THIS
    // STAGE CANNOT BE MADE PREVIEW/APPLY EXACT BY A PRE-ROLL. `trkInPeak` only
    // ever rises, so it carries the loudest sample of the entire preview
    // session, while an offline render sees only what it was handed. Measured
    // against a settled preview on an adversarial region (loud right up to the
    // boundary, then quiet), energy over the first 0.5 s:
    //
    //   pre-roll        0 s      0.5 s      1 s      2 s      4 s
    //   stock         -0.668    -0.253   -0.106   -0.022   -0.001
    //   attack/rel 1  -5.252    -1.784   -1.460   -0.998   -0.470
    //
    // A pre-roll helps a great deal and still does not converge; at the slowest
    // ballistics it is 0.47 dB out after four seconds, and the residue is
    // DATA-DEPENDENT — a loud passage anywhere earlier in the session raises
    // the preview's tracker and nothing the apply path renders can match it.
    //
    // OptoSmooth, Scheps and ResoTame all reach BIT-EXACT at 2 s because every
    // piece of their state is driven by the input and decays. The test that
    // separates them is simply: does anything LATCH, or does it all decay?
    // Tube Saturation fails it too (a sticky skew sign, a valley floor).
    //
    // Fixing this properly means giving the tracker a bounded reference — a
    // decaying peak, or a percentile over a window — which changes this
    // plugin's makeup behaviour and is a deliberate design decision, not a
    // pre-roll. No pre-roll is wired here for that reason.
    this.trkSamples += n
    for (let ch = 0; ch < nIn; ch++) {
      const src = inputChannels[ch]
      for (let i = 0; i < n; i++) {
        const a = src[i] < 0 ? -src[i] : src[i]
        if (a > this.trkInPeak) this.trkInPeak = a
      }
    }

    const outGain = this.outScratch
    if (this.outLinSmoothed === null) this.outLinSmoothed = this.outputLin
    let outLinSmoothed = this.outLinSmoothed
    for (let i = 0; i < n; i++) {
      outLinSmoothed += this.outSmoothCoef * (this.outputLin - outLinSmoothed)
      outGain[i] = outLinSmoothed
    }
    this.outLinSmoothed = outLinSmoothed

    let { hpfLp1, hpfLp2, grMain, grTail } = this

    for (let i = 0; i < n; i++) {
      // Mono sidechain tap, taken after the input attenuator
      let x = inputChannels[0][i]
      for (let ch = 1; ch < nIn; ch++) x += inputChannels[ch][i]
      x *= chScale * this.inputLin

      let sc = x
      if (this.scHpfOn) {
        hpfLp1 += (x - hpfLp1) * this.hpfLpCoef
        const hp1 = x - hpfLp1
        hpfLp2 += (hp1 - hpfLp2) * this.hpfLpCoef
        sc = hp1 - hpfLp2
      }

      // Full-wave rectified peak detector. There is deliberately no envelope
      // smoothing here: at the fast attack settings the gain cell is meant to
      // track the waveform itself, and the release network supplies the only
      // meaningful time constant on the way back down.
      const rect = sc < 0 ? -sc : sc
      const levelDb = rect > 1e-6 ? 20 * Math.log10(rect) : -120
      const grTarget = this._grForOvershoot(levelDb - this.thresholdDb)

      // Attack pulls both stages toward their share of the target together;
      // release lets each stage decay at its own rate, which is what makes
      // recovery depend on how dense the program was.
      const gr = grMain + grTail
      if (grTarget > gr) {
        const delta = (grTarget - gr) * this.attackCoef
        grMain += delta * this.mainFraction
        grTail += delta * this.tailFraction
      } else {
        /**
         * \u26a0 THE SCHEDULE IS INDEXED ON THE REDUCTION, WHICH IS FALLING, so the
         * constant shortens as the cell recovers and the trajectory is not an
         * exponential. That is the point \u2014 it is what produces a t63 that moves
         * with depth \u2014 and it is also why the fit for `k` cannot be a regression
         * on measured t63.
         */
        let rc = this.releaseCoef
        if (this.releaseScheduled) {
          let idx = (gr * (1 / RELEASE_LUT_STEP_DB) + 0.5) | 0
          if (idx < 0) idx = 0
          else if (idx >= this.releaseLut.length) idx = this.releaseLut.length - 1
          rc = this.releaseLut[idx]
        }
        grMain += (grTarget * this.mainFraction - grMain) * rc
        grTail += (grTarget * this.tailFraction - grTail) * this.tailCoef
      }

      const grNow = grMain + grTail
      if (grNow > this.maxGrDb) this.maxGrDb = grNow
      if (grNow > 0.05) {
        this.grSum += grNow
        this.grActive++
      }
      // Input attenuator and gain cell fold into one per-sample coefficient;
      // Output is applied after the saturator, where the hardware's output
      // control sits.
      //
      // Held back to meet the audio where it emerges inside the oversampled
      // section, which the upsampler has delayed by UPSAMPLE_DELAY_SAMPLES.
      // Without this the reduction would arrive early — a look-ahead the
      // hardware does not have, and one that would blunt the grab this unit is
      // bought for. In the base-rate measurement path there is nothing to meet,
      // so the delay would only misalign it.
      const g = this.inputLin * Math.exp(-grNow * LN10_OVER_20)
      gain[i] = this.oversampleOn ? this.gainDelay.push(g) : g
    }

    this.hpfLp1 = hpfLp1
    this.hpfLp2 = hpfLp2
    this.grMain = grMain
    this.grTail = grTail
    this.grDb = grMain + grTail

    while (this.dcX.length < nOut) {
      this.dcX.push(0)
      this.dcY.push(0)
    }
    // Built only when they will be used. The measurement path runs the whole
    // kernel several times over a selection and never touches them, and their
    // filter tables are not free to allocate.
    if (this.oversampleOn) {
      while (this.oversamplers.length < nOut) {
        this.oversamplers.push(new Oversampler())
        this.dryLines.push(new DelayLine(OVERSAMPLE_LATENCY_SAMPLES))
      }
    }

    const L = OVERSAMPLE_FACTOR
    const invL = 1 / L
    // Every channel interpolates from the same block-seam value, so it is read
    // before the loop and advanced once after it.
    const seamGain = this.lastGain
    const wet = this.wetScratch

    for (let ch = 0; ch < nOut; ch++) {
      const input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]

      if (!this.oversampleOn) {
        this._processChannelBaseRate(input, out, gain, n, ch)
        continue
      }

      const hi = this.oversamplers[ch].up(input, n)

      // The multiply is the other half of this unit's aliasing, not just a way
      // of applying the curve — at dial 7 the gain tracks the waveform. So the
      // gain is interpolated up to the oversampled rate rather than held in
      // steps, and the product is formed there.
      // The ramp starts AT gCur rather than one step past it. The halfband
      // upsampler's even branch is a pure delay, so sub-sample j = 0 is the
      // original input sample, not an interpolated point — it has to receive
      // the gain computed from it, exactly. Starting the ramp a step later left
      // that sample holding three quarters of the PREVIOUS gain, which at a
      // 20 us attack is most of the reduction a transient was supposed to get:
      // the first sample of every hard onset passed through nearly unattenuated
      // and read as a click.
      // ⚠ `gain[]` HOLDS `inputLin * cellGain` FOLDED TOGETHER, and the pre-cell
      // path needs them apart: the shaper sees the attenuator's output and the
      // cell follows it. Unfolding with `invInputLin` keeps the seam
      // interpolation and `lastGain` in the units they were already in, which
      // is a smaller change than splitting the array.
      const pos = this.fetPos
      let gCur = seamGain
      for (let i = 0; i < n; i++) {
        const gNext = gain[i]
        const step = (gNext - gCur) * invL
        for (let j = 0; j < L; j++) {
          const k = i * L + j
          const g = gCur + step * j
          let w
          if (!this.applyFet) w = hi[k] * g
          // preInput: the shaper sees the source, and the folded `inputLin *
          // cellGain` then applies as one multiply — the cheapest of the three.
          else if (pos === 2) w = this._shapeFet(hi[k]) * g
          else if (pos === 1) w = this._shapeFet(hi[k] * this.inputLin) * (g * this.invInputLin)
          else w = this._shapeFet(hi[k] * g)
          hi[k] = w
        }
        gCur = gNext
      }

      this.oversamplers[ch].down(wet, n)

      // Back at the base rate: the DC blocker and the Output control are both
      // linear and generate nothing, so they cost nothing to run down here.
      let dcX = this.dcX[ch]
      let dcY = this.dcY[ch]
      const dryLine = this.dryLines[ch]
      for (let i = 0; i < n; i++) {
        let w = wet[i]
        if (this.applyFet) {
          dcY = w - dcX + this.dcR * dcY
          dcX = w
          w = dcY
        }
        const wetUnity = w
        w *= outGain[i]
        // The dry side of the blend is the untouched input, delayed to meet the
        // wet side, so a parallel setting stays level-sane and phase-coherent
        // and bypass A/B compares like for like.
        const dry = dryLine.push(input[i])
        this._trackMakeup(dry, wetUnity)
        out[i] = dry * this.dryMix + w * this.wetMix
      }
      this.dcX[ch] = dcX
      this.dcY[ch] = dcY
    }

    if (n > 0) this.lastGain = gain[n - 1]
  }

  /**
   * Measurement-only path: the same arithmetic at the base rate, with no
   * resampling and therefore no latency.
   *
   * This exists because the auto-makeup measurement runs the whole kernel over
   * the selection several times to converge, and doing that through the
   * oversampled path made it about three times slower — slow enough that the
   * Output knob visibly lagged a drag, and slow enough that a stale Output
   * could be applied to a louder signal than it was measured for.
   *
   * It is sound because the measurement only ever asks one question: what is
   * the output's RMS. Oversampling changes that by at most 0.02 dB across the
   * whole control range — it removes folded harmonics, which carry almost no
   * energy. A test pins that bound so the shortcut cannot quietly stop being
   * true.
   *
   * Nothing that renders audio uses this. The worklet never sets `oversample`,
   * and the apply path trims a fixed latency that assumes the oversampled path.
   */
  _processChannelBaseRate(input, out, gain, n, ch) {
    // Filled once per block in process(); read rather than passed so the two
    // branches cannot drift apart on which gain they apply.
    const outGain = this.outScratch
    let dcX = this.dcX[ch]
    let dcY = this.dcY[ch]
    const pos = this.fetPos
    for (let i = 0; i < n; i++) {
      const dry = input[i]
      let w = dry * gain[i]
      if (this.applyFet) {
        const shaped = pos === 2
          ? this._shapeFet(dry) * gain[i]
          : pos === 1
            ? this._shapeFet(dry * this.inputLin) * (gain[i] * this.invInputLin)
            : this._shapeFet(w)
        dcY = shaped - dcX + this.dcR * dcY
        dcX = shaped
        w = dcY
      }
      const wetUnity = w
      w *= outGain[i]
      this._trackMakeup(dry, wetUnity)
      out[i] = dry * this.dryMix + w * this.wetMix
    }
    this.dcX[ch] = dcX
    this.dcY[ch] = dcY
  }

  /** Forget what has played — see the LA-2A kernel's note of the same name. */
  resetAutoMakeupTracker() {
    this.trkInPeak = 0
    this.trkSamples = 0
    this.trkAAbs = 0
    this.trkBAbs = 0
  }

  /**
   * The makeup the audio heard so far asks for, dB, or null before anything has
   * been heard. Only knows what has PLAYED; APPLY keeps the offline solve.
   */
  liveAutoMakeupDb() {
    if (this.trkSamples < this.sampleRate * MAKEUP_TRACKER_WARMUP_S) return null
    /**
     * ⚠ FULLY WET ONLY. Below Mix 1 the bound `(P − max|a|)/max|b|` is safe but
     * loose — the two maxima need not fall on the same sample — and measured on
     * a hard probe it came out 3.35 dB under the truth at Mix 0.3. A preview
     * several dB quieter than the render it is previewing is worse than no live
     * value at all, so the parallel settings keep the offline solve, which is
     * one render and exact. Reported rather than hidden: the panel shows the
     * offline number there, which is the right one.
     */
    if (this.dryMix > 0) return null
    const P = this.trkInPeak
    if (!(P > 0) || !(this.trkBAbs > 0)) return null
    const g = (P - this.trkAAbs) / this.trkBAbs
    if (!(g > 0) || !Number.isFinite(g)) return null
    return 20 * Math.log10(g)
  }

  /**
   * One sample's contribution to the tracker.
   *
   * `wetUnity` is the wet path BEFORE the output gain, so nothing here depends
   * on the makeup — see the constructor for why that is the whole design.
   */
  _trackMakeup(dry, wetUnity) {
    const aAbs = Math.abs(dry * this.dryMix)
    if (aAbs > this.trkAAbs) this.trkAAbs = aAbs
    const bAbs = Math.abs(wetUnity * this.wetMix)
    if (bAbs > this.trkBAbs) this.trkBAbs = bAbs
  }

  getMetering() {
    return {
      grDb: this.grDb,
      maxGainReductionDb: this.maxGrDb,
      avgGainReductionDb: this.grActive > 0 ? this.grSum / this.grActive : 0,
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh
 * kernel. Used by the auto-makeup measurement worker and by Node verification
 * scripts; the app itself renders through an OfflineAudioContext running the
 * worklet so preview and apply share the exact same code path.
 */
export function processFET1176Buffer(channelData, sampleRate, params = {}) {
  const kernel = new FET1176Kernel(sampleRate)
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

  const m = kernel.getMetering()
  return {
    channelData: output,
    latencySamples: kernel.latencySamples,
    metering: {
      maxGainReductionDb: m.maxGainReductionDb,
      avgGainReductionDb: m.avgGainReductionDb,
    },
  }
}

/**
 * RMS across every sample of every channel, optionally skipping a leading
 * stretch — see the counterpart in la2aProcessor.js for why.
 */
/**
 * Peak magnitude across every sample of every channel, in dB.
 *
 * The makeup reference. Peak rather than RMS, and the distinction is the whole
 * point of makeup gain: the compressor pulls the loud moments down, makeup
 * hands back what it took, the peaks land where they started and everything
 * underneath rises with them. That is a compressor made louder without being
 * merely turned up — which is the comparison a listener is actually running
 * when they A/B it.
 *
 * Matching RMS instead, as this did, returns only the average loss and
 * therefore leaves the output exactly as loud as the input: a compressor that
 * by construction cannot make anything louder.
 *
 * TRUE PEAK, not a high percentile, and that was measured. A percentile of
 * short-block peaks looks more robust and is worse where it matters: on real
 * speech a fast transient can survive compression almost intact while the p99
 * comes down several dB, so percentile-referenced makeup over-compensates and
 * pushes that survivor ABOVE the source — up to 5.5 dB above, measured. True
 * peak cannot do that; the guarantee it buys is exact.
 *
 * The cost is the opposite failure: a single uncompressed click sets the
 * reference and the makeup comes out small. That is the safe direction — never
 * louder than the source — and the manual trim is there for it.
 */
function peakOfChannels(channels, skip = 0) {
  let peak = 0
  for (const ch of channels) {
    for (let i = skip; i < ch.length; i++) {
      const v = ch[i] < 0 ? -ch[i] : ch[i]
      if (v > peak) peak = v
    }
  }
  return peak
}

function rmsOfChannels(channels, skip = 0) {
  let sumSq = 0
  let count = 0
  for (const ch of channels) {
    for (let i = skip; i < ch.length; i++) sumSq += ch[i] * ch[i]
    count += Math.max(0, ch.length - skip)
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0
}

/**
 * The Output gain that puts this compressor's output peak back on the input's.
 *
 * SOLVED IN ONE RENDER, EXACTLY — it used to be a fixed-point iteration capped
 * at three passes, and on any parallel setting that cap returned an answer
 * several dB short.
 *
 * ⚠ THE ITERATION DID NOT CONVERGE AT MIX < 1, AND TWO FACTORY PRESETS SHIP
 * THERE (0.4 and 0.5). Output gain scales the WET path only — the sum is
 * `dry*(1-mix) + wet*mix*g` — so `makeup += correction` converges at a rate set
 * by the wet share, which is slow exactly where the wet share is small.
 * Measured on 30 s of real narration at Input 55, makeup by iteration count:
 *
 *   mix 1.0   10.25 / 10.25 / 10.25 / 10.25          (one pass is already exact)
 *   mix 0.7    6.51 /  9.95 / 10.92 / 11.20
 *   mix 0.5    4.11 /  7.23 /  9.35 / 11.98   <- shipped cap returned 9.35
 *   mix 0.3    2.23 /  4.21 /  5.94 / 12.08   <- 6.1 dB short
 *
 * THE SOLVE IS A ONE-PASS SCAN, and it is exact rather than convergent. The
 * output is AFFINE in the makeup: `out[i] = a[i] + b[i]·g`, where
 * `a[i] = dry[i]·(1−mix)` and `b[i] = wet[i]·mix`, because `outputLin` is the
 * last multiply on the wet path and the detector reads the INPUT, so the wet
 * signal does not depend on g at all. Requiring `|a[i] + b[i]·g| <= P` for
 * every sample gives one interval per sample; their intersection's upper end is
 * the largest makeup that keeps the output peak at P, which is the answer. One
 * render (the wet path, taken at mix 1) plus one O(n) pass, against three to
 * twenty renders before.
 *
 * ⚠ `dry` IS THE UNDELAYED INPUT ONLY BECAUSE THE MEASUREMENT RUNS AT BASE
 * RATE. The oversampled path delays the dry side by OVERSAMPLE_LATENCY_SAMPLES
 * to meet the wet side; the base-rate path this measurement forces has no such
 * delay (`const dry = input[i]`). If the measurement ever moves to the
 * oversampled path, `a[i]` has to carry that delay or the two sides are
 * compared at different instants.
 *
 * PEAK, NOT RMS: makeup means handing back what came off the peaks. See
 * peakOfChannels for why a true peak rather than a percentile.
 *
 * Measured through the BASE-RATE path: oversampling removes folded harmonics,
 * which carry almost no energy, and measuring through it was about three times
 * slower — which the Output knob showed as lag behind a drag.
 *
 * @param {Float32Array[]} channelData Region to measure.
 * @param {number} sampleRate
 * @param {object} params Kernel params. `outputGainDb` is IGNORED — it is the
 *   quantity being solved for.
 * @returns {number} Makeup in dB, clamped to the Output knob's travel.
 */
export function computeFET1176AutoMakeupDb(channelData, sampleRate, params = {}, options = {}) {
  const { minDb = -36, maxDb = 36 } = options

  const inputPeak = peakOfChannels(channelData)
  if (inputPeak <= 0) return 0

  const mix = clamp(params.mix ?? FET1176_KERNEL_DEFAULTS.mix, 0, 1)
  // Mix 0 is the dry signal: there is nothing to make up, and the solve below
  // would be unconstrained (every b[i] is zero).
  if (mix <= 0) return 0

  /**
   * The wet path alone, at unity output gain. Taken at mix 1 so the render IS
   * `wet[i]`; mix feeds nothing but the final blend, so this changes no other
   * part of the kernel's behaviour.
   *
   * ⚠ IT IS RENDERED OVERSAMPLED — THE SAME WAY APPLY RENDERS IT — AND THAT WAS
   * NOT ALWAYS TRUE. This solve used to run `oversample: false`, which is a
   * cheaper and DIFFERENT algorithm from the one the timeline gets: the
   * oversampled path interpolates the gain across sub-samples and filters
   * through two halfbands, and on a transient it lands a lower peak. So the
   * makeup was solved against a render nobody hears, and the applied result
   * came out UNDER the target — measured on the narration-like fixture in
   * `liveMakeup.test.js`, **0.77 dB** of headroom left on the table, with the
   * live preview (which runs in the real oversampled path) reporting the higher
   * figure and apply delivering the lower one.
   *
   * ⚠ THE OLD `tanh` WAS HIDING IT: it squashed peaks hard enough that the two
   * paths agreed to 0.58 dB, just inside the test's 0.6 dB tolerance. The
   * measured polynomial that replaced it is nearly linear at these levels and
   * passes the difference straight through, which is what surfaced it.
   *
   * ⚠ AND THE LATENCY IS WHY IT WAS AVOIDED. Oversampled, the kernel delays by
   * `latencySamples`, and this solve pairs `dry[i]` with `wet[i]` sample for
   * sample — a 50-sample slip would compare a transient against the silence
   * before it. The input is padded by that many samples so the whole tail is
   * rendered, and the delay is dropped off the front.
   */
  const latency = new FET1176Kernel(sampleRate).latencySamples
  const padded = channelData.map(ch => {
    const out = new Float32Array(ch.length + latency)
    out.set(ch)
    return out
  })
  const { channelData: wetPadded } = processFET1176Buffer(padded, sampleRate, {
    ...params, outputGainDb: 0, mix: 1,
  })
  const wet = wetPadded.map(ch => ch.subarray(latency))

  const dryMix = 1 - mix
  // Largest g for which every sample satisfies |a + b·g| <= inputPeak.
  let gMax = Infinity
  for (let ch = 0; ch < wet.length; ch++) {
    const dry = channelData[ch]
    const w = wet[ch]
    for (let i = 0; i < w.length; i++) {
      const b = w[i] * mix
      if (b === 0) continue
      const a = dry[i] * dryMix
      // The binding end of this sample's interval is the one it moves toward.
      const bound = (b > 0 ? inputPeak - a : -inputPeak - a) / b
      if (bound < gMax) gMax = bound
    }
  }
  if (!Number.isFinite(gMax) || gMax <= 0) return 0

  return clamp(20 * Math.log10(gMax), minDb, maxDb)
}

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

// `registerProcessor` and the `sampleRate` global exist only inside an
// AudioWorkletGlobalScope. When this file is imported as a normal module
// (main bundle, Node), this block is skipped.
if (typeof registerProcessor === 'function') {
  // Post gain-reduction metering every ~21 ms at 44.1 kHz — enough for a
  // smooth needle without flooding the message port.
  const METER_INTERVAL_SAMPLES = 1024

  class FET1176WorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new FET1176Kernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params)
      }
      this.sinceMeter = 0
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
        // A new region is new material: the running extrema describe audio the
        // user has moved on from, so they are forgotten rather than diluted.
        else if (e.data?.type === 'resetMakeupTracker') this.kernel.resetAutoMakeupTracker()
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
        this.port.postMessage({
          type: 'gr',
          grDb: this.kernel.grDb,
          // The live auto-makeup, riding the ~46 Hz cadence the meter already
          // pays for. null until something has been heard.
          liveMakeupDb: this.kernel.liveAutoMakeupDb(),
        })
      }
      return true
    }
  }

  registerProcessor('fet1176-processor', FET1176WorkletProcessor)
}
