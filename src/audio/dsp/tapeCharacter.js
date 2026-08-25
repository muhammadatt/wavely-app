/**
 * TAPE CHARACTER — the medium-colouring components, kept together and kept
 * measured, ahead of the plugin that will use them.
 *
 * ⚠ THIS MODULE IS NOT WIRED TO ANY PANEL. Only `HfLossShelf` has a live
 * caller (Tube Saturation). The rest is here because it was built, measured
 * and paid for, and because the place it used to live — the soft clipper — is
 * a stage whose identity is transparency and which should not own colour. Same
 * arrangement as `bandSplitLimiter.js`: built, measured, tested, unwired.
 * Tests are what stop it rotting, not callers.
 *
 * ⚠ THE DOCUMENTATION IS THE ASSET, not the code. The code here is about fifty
 * executable lines; the measurements and the four recorded mistakes behind them
 * cost far more than that to obtain. Anyone assembling a Tape Saturation or a
 * combined Saturation/Distortion plugin should read the notes before reusing
 * the lines, because three of the four components have a structural constraint
 * that is invisible from the code itself.
 *
 * ── WHAT THESE FOUR THINGS ARE ─────────────────────────────────────────────
 *
 *   Asymmetry    a DC offset around a waveshaper. The ONLY source of EVEN
 *                harmonics — the warmth people mean by "tube" or "tape".
 *   Skew tracker chooses the offset's sign from the material's own waveform
 *                lean. Worth up to 7.9 dB of OTHER distortion; buys none of
 *                the warmth. The hardest-won piece here by a wide margin.
 *   Soften       a limit on how fast the waveform may move, inside an
 *                oversampled path. Softens the top end and rounds an edge
 *                before a nonlinearity sees it.
 *   HF Loss      a first-order high shelf. The medium's bandwidth.
 *
 * ── THE TWO STRUCTURAL FINDINGS, both learned the expensive way ────────────
 *
 * (1) ASYMMETRY IS NOT A STAGE. It is `curve(x + off) - off`: add an offset,
 *     run a waveshaper, subtract it. Where the curve is transparent that
 *     expression is `(x + off) - off = x` — add-then-subtract is the identity
 *     function — so THE OFFSET HAS NO EFFECT OF ITS OWN WHATSOEVER. Every
 *     harmonic it produces belongs to the curve it wraps, generated
 *     off-centre. It cannot be "moved" between plugins: it can only be
 *     re-applied around a different curve, which changes the harmonics, the
 *     bound argument and every recorded number. `asymmetryOffset()` therefore
 *     returns a number, not a processor, and the caller wraps its own curve.
 *
 * (2) SOFTEN NEEDS FOUR THINGS AT ONCE and most topologies supply none of
 *     them: a CLEAN, BROADBAND signal, at the OVERSAMPLED rate, just ahead of
 *     ONE nonlinearity, with its allowance referenced near the level that
 *     nonlinearity acts at. Measured while trying to move it into Tube
 *     Saturation, whose three-band split offers no broadband oversampled point
 *     until AFTER the three transfer curves:
 *
 *       placement                          tilt at full knob
 *       after the summed curves            +0.66 / +1.38 dB   (HF RISING)
 *       high band only, before its curve   -0.13 dB           (inert)
 *       all three bands, before curves     -0.11 to -0.21 dB, turning positive
 *
 *     Its ceiling there was about -0.2 dB against -3.31 dB in a topology that
 *     suited it, and every route to more inverted the sign. THE MECHANISM:
 *     slew-limiting an already-saturated, low-frequency-dominated signal makes
 *     it triangular, and a triangle is harmonics — past a certain depth it
 *     stops being a softener and becomes a distortion generator.
 *
 * ── AND THE THREE MEASUREMENT TRAPS ────────────────────────────────────────
 *
 *   - A slew limiter placed inside a wet path that is level-matched afterwards
 *     reads POSITIVE on an absolute band measurement, because the match hands
 *     the removed energy back as broadband gain. MEASURE TILT (the band
 *     against the broadband) or you are measuring the level match.
 *   - Anything whose depth scales with a TRACKED level cannot be compared
 *     between a live preview and an offline region render: the tracker starts
 *     cold offline. That defect shipped once — preview came out 1.5-2.3 dB
 *     more softened than the applied audio. Reference colour to something
 *     motionless, or accept that the two will never agree.
 *   - Sustained noise cannot probe any of this. The noise floor is a valley
 *     follower, so on continuous material it settles at the signal's own level
 *     and a gated tracker never updates. Probes need pauses.
 */

import { riseCoeff } from './envelope.js'
import { highpass, BiquadCascade } from './biquad.js'

// ── Asymmetry ──────────────────────────────────────────────────────────────

/**
 * Largest offset, as a fraction of the reference level.
 *
 * ⚠ 1 IS A PROVABLE CEILING, NOT A TASTE, and the proof needs the reference to
 * be bounded by the curve's own threshold. The offset is `frac * reference`;
 * with `reference <= t` that gives `off <= frac * t`. A curve monotone with
 * `f(t) = t` returns at least `t - off` for any input past the crossing, which
 * is non-negative exactly when `frac <= 1`. Above that the stage FOLDS —
 * measured at frac 1.2, real samples change sign, which is the one failure
 * this control exists to avoid.
 *
 * ⚠ SO A REUSER MUST CLAMP THE REFERENCE TO THE CURVE'S THRESHOLD. Leaving it
 * unbounded was a real defect: with a threshold at -30 dBFS under speech at
 * -3, the offset reached eight times the threshold and pinned the curve at its
 * reduction bound for a whole file — measured, 121 dB of attenuation. A medium
 * whose colour is referenced above the level the signal may reach is
 * incoherent.
 *
 * ⚠ IT WAS 0.35 WHEN THE REFERENCE WAS THE THRESHOLD ITSELF. Against a
 * reference a Headroom lower, 0.35 spanned about 1 dB of added content across
 * the whole knob on three real narrators — a control that does nothing. The
 * fraction and the reference must be re-derived together.
 */
export const ASYM_MAX_FRACTION = 1

/** Below this the offset is treated as zero and the whole path is bypassed. */
export const ASYM_EPSILON = 1e-4

/**
 * How far asymmetry relaxes a curve's own reduction bound, in dB.
 *
 * ⚠ THE BOUND IS ON THE CURVE, AND THE OFFSET MOVES THE STAGE OFF IT. The
 * curve still reduces by at most its own maximum relative to what it SEES,
 * which is `x + off`; the stage's attenuation is measured against `x`, and
 * subtracting the offset afterwards makes those two slightly different. Swept
 * across every shape and four decades of input, against a 6 dB bound:
 *
 *   asymmetry    15     30     60    100
 *   worst red   6.008  6.036  6.109  6.249 dB
 *
 * ⚠ AT `ASYM_MAX_FRACTION = 1` THIS IS NO LONGER A PROOF, only a regression
 * tracker. The output past the crossing can reach zero, so the attenuation
 * measured against the raw sample has no finite dB bound in principle.
 * Measured it stays well inside — 1.52 dB over on a synthetic probe and below
 * the curve's own bound entirely on three real narrators.
 *
 * THE FAILURE THAT WOULD MATTER DOES NOT HAPPEN: the output never changes sign
 * relative to the input. That is the provable guarantee; this constant is not.
 */
export const ASYM_MAX_BOUND_EXCESS_DB = 1.6

/**
 * The offset to add before a waveshaper and subtract after it.
 *
 * A NUMBER, NOT A PROCESSOR, and deliberately — see finding (1) in the header.
 * The caller owns the curve:
 *
 *     const off = asymmetryOffset(amount, skew.direction, reference)
 *     const y = curve(x + off) - off
 *
 * @param {number} amount 0-100 from a knob.
 * @param {number} direction signed, from SkewTracker — see its notes for why
 *   only the SIGN may come from the material and the magnitude may not.
 * @param {number} reference level the offset scales to, in linear amplitude.
 *   MUST be clamped to the curve's threshold; see ASYM_MAX_FRACTION.
 *
 * SCALED TO A LEVEL, NEVER ABSOLUTE — that is what keeps a stage using it
 * level-invariant, and a fixed offset destroys it.
 *
 * WHAT IT BUYS, measured on a 220 Hz tone 6 dB over a threshold:
 *
 *   asym   H2       H3      H4       even/odd
 *   0     -144.3   -22.7   -164.2     -121.7 dB
 *   0.05   -38.8   -22.7    -76.1      -15.9
 *   0.20   -26.8   -23.0    -67.1       -3.7
 *   0.35   -22.2   -23.7    -86.6       +1.6   <- H2 overtakes H3
 *
 * IT IS ADDITIVE, NOT A REBALANCING, which is what makes it a character
 * control rather than a second depth control: H3 moves by at most 1 dB across
 * the entire sweep. On real narration the even-order content lands at -50 dBc
 * at asymmetry 15 rising to -34 at 100, within 2 dB across three very
 * different files, with output level moving 0.04-0.16 dB.
 *
 * ⚠ IT NEEDS A DC BLOCKER AFTER THE CURVE — see makeDcBlocker.
 */
export function asymmetryOffset(amount, direction, reference) {
  const frac = (clamp(amount, 0, 100) / 100) * ASYM_MAX_FRACTION
  return frac <= ASYM_EPSILON ? 0 : frac * direction * reference
}

/**
 * DC blocker corner, Hz.
 *
 * ⚠ LOAD-BEARING, AND IT WAS NEARLY DROPPED ON A MEASUREMENT TAKEN AT ONE
 * OPERATING POINT. At an ordinary setting the DC an offset leaves is 70-90 dB
 * below peak and looks like nothing. Under drive it is a different quantity:
 * with the threshold 30 dB down and no blocker, a 120 Hz tone left -45.2 dBFS
 * of DC, and an input that ALREADY carries DC came out 5.1 dB below its own
 * peak — which shifts the waveform bodily and corrupts the peak measurement
 * ACX compliance is built on.
 *
 * 2 Hz: rejection is total at any corner, so the corner only trades settling
 * against disturbance. 2 Hz leaves -123.5 dBFS in 0.04 s while costing
 * -35.1 dBc against -29.9 at 5 Hz and -17.2 at 20.
 *
 * ⚠ RUN IT ONLY WHILE THE OFFSET IS ENGAGED. An always-on filter costs a stage
 * its bit-transparency for every user who never touches the control.
 */
export const DC_BLOCK_HZ = 2

/**
 * A DC blocker sized for the offset above. Q is left at the Butterworth
 * default: a Butterworth highpass has no passband overshoot, which is what
 * keeps a "never boosts" guarantee intact through the blocker.
 *
 * Place it AFTER the curve (and after any de-emphasis), so it blocks the DC
 * that reaches the output rather than one a later filter would reshape.
 */
export function makeDcBlocker(sampleRate) {
  const c = new BiquadCascade(1, 1)
  c.setSections([highpass(sampleRate, DC_BLOCK_HZ)])
  return c
}

// ── The skew tracker: which way the offset should lean ─────────────────────

/**
 * Time constant for the waveform-skew estimate, seconds.
 *
 * Skew is a property of a recording rather than of a moment — a microphone
 * does not change polarity mid-file — so this converges once and holds.
 */
export const SKEW_TAU_S = 3.0

/**
 * How much lean is needed before the sign moves.
 *
 * ⚠ SCALING THE MAGNITUDE BY THE SKEW WAS THE FIRST ATTEMPT AND IT SILENTLY
 * TURNS THE KNOB OFF. `direction = -tanh(skew / scale)` reads as an elegant
 * continuous sign, commits properly on real material and can never step. It
 * also gives ZERO offset on symmetric material, so the control does nothing at
 * any setting. Caught only because even-harmonic energy went to exactly zero
 * on synthetic probes, which are sums of sines and symmetric to the last bit.
 *
 * ONLY THE SIGN COMES FROM THE SKEW. The magnitude is the feature and must not
 * depend on the material.
 *
 * 0.15 commits on every real narrator measured — |skew| 0.58, 1.47, 1.48 — and
 * holds on anything flatter, where the penalty it exists to avoid has vanished
 * anyway (the two signs differ by 7.9 dB at |skew| 1.47 and 0.6 dB at 0.58).
 */
export const SKEW_DEADBAND = 0.15

/**
 * Gated evidence required before the sign is decided at all, seconds.
 *
 * ⚠ THE ESTIMATE IS NOT MERELY IMPRECISE EARLY ON, IT IS LARGE AND WRONG, and
 * because the decision is sticky one early excursion latches for the whole
 * file. Traced on a probe whose settled skew is 0.002:
 *
 *   t      0.5s   1.0s   1.5s   2.0s   3.0s   4.0s
 *   skew   1.15   0.27   0.12   0.05   0.027  0.011
 *
 * Off by three orders of magnitude at half a second. That is estimator
 * variance, not bias: a ratio of two one-pole averages of x^2 and x^3 over
 * half a second of syllables says almost nothing. A build that decided at a
 * 500 ms warm-up duly latched the WRONG SIGN on symmetric material.
 */
export const SKEW_EVIDENCE_S = SKEW_TAU_S

/**
 * How long the direction takes to travel when the decision changes, ms.
 *
 * The first decision is a step from the startup sign and later flips should
 * never happen. Either way the offset must not jump: it only touches material
 * already over the threshold, so a discontinuity lands mid-syllable on exactly
 * the loud samples the stage is working on.
 */
export const SKEW_FLIP_MS = 200

/**
 * Tracks a signal's waveform lean and reports the direction an asymmetry
 * offset should take.
 *
 * WHY THE SIGN IS MEASURED RATHER THAN PICKED. Even-order content is IDENTICAL
 * for a positive and a negative offset (-37.4 dBc either way at asymmetry 60,
 * on all three real narrators), so the sign buys none of the warmth. What it
 * changes is how much OTHER distortion is paid for that warmth:
 *
 *   file            skew    total distortion, offset -0.2 / +0.2
 *   A (normalised)  -0.58        -30.5 / -31.1 dBc
 *   B (raw)         -1.47        -25.3 / -33.2      <- 7.9 dB
 *   C (mastered)    +1.48        -32.8 / -27.9      <- 4.9 dB
 *
 * The offset should OPPOSE the lean. Speech is asymmetric by nature — the
 * glottal waveform is — and which way it points depends on the speaker, the
 * microphone and any polarity flip in the chain, so it cannot be assumed. A
 * fixed positive offset is right on A and B and costs C 4.9 dB for nothing.
 *
 * ⚠ FEED IT THE SIGNAL THE CURVE ACTUALLY SEES, post any emphasis or shelving,
 * because a shelf changes a waveform's skew.
 *
 * ⚠ FEED IT ONLY VOICED SAMPLES. A pause contributes room tone to the second
 * moment and almost nothing to the third, which drags the estimate toward zero
 * for reasons that have nothing to do with the voice. The caller owns the gate.
 *
 * A useful side effect: a polarity-flipped recording is processed identically,
 * since flipping the input flips its skew and therefore the chosen offset.
 * ⚠ That also means `F_even = (F(x) + F(-x))/2` STOPS being a valid way to
 * measure even-harmonic content on skewed material — the negated run is not the
 * same processing. Use symmetric probes, where the deadband holds the sign
 * still, for that decomposition.
 */
export class SkewTracker {
  constructor(sampleRate, {
    tauS = SKEW_TAU_S,
    deadband = SKEW_DEADBAND,
    evidenceS = SKEW_EVIDENCE_S,
    flipMs = SKEW_FLIP_MS,
  } = {}) {
    this.m2 = 0
    this.m3 = 0
    // Starts positive — the behaviour that shipped before the skew was
    // measured — so material too symmetric to have an opinion is unchanged.
    this.sign = 1
    this._direction = 1
    this.evidence = 0
    this.deadband = deadband
    this.coef = riseCoeff(tauS * 1000, sampleRate)
    this.flipCoef = riseCoeff(flipMs, sampleRate)
    this.evidenceTarget = Math.max(1, Math.round(evidenceS * sampleRate))
  }

  /** One VOICED sample of the signal the curve sees. Two multiply-adds. */
  update(x) {
    this.m2 += this.coef * (x * x - this.m2)
    this.m3 += this.coef * (x * x * x - this.m3)
    this._direction += this.flipCoef * (this.sign - this._direction)
    if (this.evidence < this.evidenceTarget) {
      this.evidence++
    } else if (this.m2 > 1e-12) {
      const skew = this.m3 / Math.pow(this.m2, 1.5)
      // Sticky: the sign moves only once the lean is unambiguous, and holds
      // whatever it had inside the deadband.
      if (skew < -this.deadband) this.sign = 1
      else if (skew > this.deadband) this.sign = -1
    }
  }

  /** Smoothed, in [-1, 1]. Hand this to asymmetryOffset. */
  get direction() {
    return this._direction
  }

  /** The raw estimate, for diagnostics. Meaningless before `evidenceTarget`. */
  get skew() {
    return this.m2 > 1e-12 ? this.m3 / Math.pow(this.m2, 1.5) : 0
  }
}

// ── Soften ─────────────────────────────────────────────────────────────────

/**
 * Bernstein's bound, as a fraction of the reference level, per oversampled
 * sample.
 *
 * A signal bandlimited to the BASE rate's Nyquist and bounded by A cannot move
 * more than `(pi/L)*A` per oversampled sample, L being the oversampling factor.
 * That is what makes "at scale 1 the limit provably cannot bind on material at
 * or below the reference" exact rather than approximate — and it is exact only
 * when the reference IS the bound the claim is about. Referenced to anything
 * else it bounds a different quantity and the guarantee is approximate in a
 * direction nobody has measured.
 *
 * Independent of sample rate by construction: the base Nyquist is fs/2, so
 * `2*pi*(fs/2)/(L*fs) = pi/L`.
 */
export function softenRef(oversampleFactor) {
  return Math.PI / oversampleFactor
}

/**
 * Allowed slope at the top of the knob, as a fraction of the reference.
 *
 * The mapping is geometric — `pow(SOFTEN_MIN_SCALE, amount/100)` — because the
 * interesting range is all near the bottom: half the knob is already down at
 * 0.14 of the reference.
 *
 * ⚠ THIS CONSTANT AND THE REFERENCE MUST BE DERIVED TOGETHER. The allowance is
 * proportional to the reference, so changing what the reference IS rescales the
 * whole knob. Moving from a speech-level reference to a threshold about 3 dB
 * above it made the same position 1.4x more permissive overnight and took full
 * knob from -8.08 dB above 4 kHz to -6.12; 0.014 restored it. A reuser
 * choosing a different reference must re-derive this or the knob will mean
 * something else.
 */
export const SOFTEN_MIN_SCALE = 0.014

export const SOFTEN_EPSILON = 1e-4

/** Knob (0-100) to the fraction of the reference the slope may reach. */
export function softenScale(amount) {
  const a = clamp(amount, 0, 100) / 100
  return a <= SOFTEN_EPSILON ? 1 : Math.pow(SOFTEN_MIN_SCALE, a)
}

/**
 * A level-scaled limit on how fast the waveform may move.
 *
 * ⚠ READ FINDING (2) IN THE HEADER BEFORE PLACING THIS. It needs a clean,
 * broadband, oversampled signal just ahead of ONE nonlinearity. Put it after a
 * nonlinearity, or on a band-split signal, and it becomes a distortion
 * generator instead of a softener — measured, with the sign of its effect
 * reversed.
 *
 * WHAT IT DOES, in a topology that suits it: two things, neither of them peak
 * reduction. Matched on output peak against a reference running the same
 * threshold, emphasis, oversampler and limiter with only the curve skipped, a
 * downstream curve's residual went -33.90 -> -37.79 dBc and its >8 kHz part
 * -52.96 -> -62.99, while 4-10 kHz program came down 0.00 -> -3.31 dB. So it
 * softens the top end AND cuts what the curve then has to do — about 3.9 dB
 * less distortion overall and 10 dB less above 8 kHz. Output peak does not move
 * at any setting.
 *
 * ⚠ IT IS A BROAD HF SHELF IN EFFECT, NOT A SIBILANCE-SELECTIVE DE-ESSER —
 * 4-10 kHz and >8 kHz come down together. Describe it as softening the top end.
 *
 * ⚠ IT FORFEITS "UNITY BELOW THE THRESHOLD". At scale 1 the limit provably
 * cannot bind on material at or below the reference — and measured, that means
 * it does exactly nothing on real narration, bit-identical at every setting,
 * because the fastest instant anywhere in a real file is slope/T 0.157 to 0.273
 * against a bound of 0.785. To do anything at all it must bind below the
 * threshold. A stage claiming bit-transparency below its threshold has to
 * qualify that claim once this is engaged.
 *
 * It cannot boost: the output only ever moves TOWARD the input, so
 * |y| <= max(|y_prev|, |x|) at every sample.
 *
 * ⚠ A MUTATION THAT SURVIVED FOUR ASSERTIONS: inverting the knob's mapping.
 * Every HF test still passed, because a tone probe sitting well over the
 * threshold binds even at scale 1 — Bernstein's promise covers material at or
 * below the reference only. Monotonicity across the knob is what catches it.
 */
export class SoftenLimiter {
  constructor(oversampleFactor) {
    this.ref = softenRef(oversampleFactor)
    this.state = 0
  }

  /**
   * One oversampled sample.
   * @param {number} x
   * @param {number} scale from softenScale()
   * @param {number} reference linear amplitude — see SOFTEN_MIN_SCALE for why
   *   this and the constant have to be chosen together, and the header for why
   *   a TRACKED reference makes preview and offline renders disagree.
   */
  process(x, scale, reference) {
    const S = this.ref * scale * reference
    const d = x - this.state
    this.state += d > S ? S : d < -S ? -S : d
    return this.state
  }

  reset() {
    this.state = 0
  }
}

// ── HF Loss ────────────────────────────────────────────────────────────────

/**
 * Shelf corner, Hz.
 *
 * WHAT IT MODELS, AND WHAT IT DELIBERATELY DOES NOT. Gap loss — the reproduce
 * head averaging flux across a finite gap — is `sinc(pi*g/lambda)`, a function
 * of gap width, tape speed and frequency and NOT of level. Modelled faithfully
 * it is an always-on shelf, which colours every sample of every file. What
 * actually makes tape lose top end when pushed is short-wavelength
 * self-erasure, which is level-dependent. This is the second one in spirit and
 * a fixed shelf in fact: the depth is a knob, not an envelope.
 *
 * ⚠ CONSTANT DEPTH, NOT ENVELOPE-FOLLOWING, and that was a correction rather
 * than a simplification. Following the envelope gives full depth on a loud
 * syllable and none through the pause after it — a room that BREATHES, which a
 * listener hears as pumping long before they hear the colour.
 */
export const HF_LOSS_CORNER_HZ = 4000

/**
 * Plateau depth at full knob, dB.
 *
 * The shelf SATURATES rather than deepening indefinitely: as depth grows the
 * output tends to the one-pole itself and no further, so the constant scales
 * the plateau and cannot steepen the slope. Measured shelf at 2k / 4k / 8k /
 * 16k: -0.63 / -1.87 / -2.28 / -3.51 at 6, -0.80 / -2.47 / -3.69 / -6.00 at 12,
 * -0.93 / -2.80 / -4.94 / -8.50 at 24. Returns halve between 12 and 18, so 12
 * is the knee.
 *
 * ⚠ DEEPER HF LOSS THAN THIS NEEDS A LOWER CORNER OR A STEEPER FILTER, NOT A
 * BIGGER CONSTANT.
 */
export const HF_LOSS_MAX_DB = 12

/** Depth smoothing, ms. Only so a knob drag does not click. */
export const HF_LOSS_SMOOTH_MS = 30

export const HF_LOSS_EPSILON = 1e-4

/**
 * A level-independent first-order high shelf, built as a blend.
 *
 * THE STRUCTURE IS A BLEND, NOT A RECOMPUTED FILTER:
 *   out = g*x + (1-g)*lowpass(x)
 * one fixed one-pole and a per-block `g`. That is exactly a first-order high
 * shelf — unity at DC, plateauing at `g` above the corner — with two properties
 * a moving biquad would not have. It is EXACTLY transparent at g = 1, so the
 * bypass is free rather than approximate. And it PROVABLY CANNOT BOOST:
 * |g + (1-g)*LP| <= g + (1-g)*|LP| <= 1 for any 0 <= g <= 1, since a one-pole
 * lowpass has magnitude at most 1 everywhere. That matters for a filter whose
 * depth moves.
 *
 * ⚠ THE DEPTH RAMP IS SHARED ACROSS CHANNELS AND THE FILTER STATE IS NOT.
 * Advancing the ramp inside a per-channel loop makes it converge N times faster
 * on N channels — inaudible on a 30 ms parameter ramp, but wrong, and it is the
 * kind of thing that becomes audible the moment someone lengthens the constant.
 * `advance()` is called once per block; `process()` once per channel.
 *
 * Mutations caught by its tests: making the shelf static (i.e. modelling gap
 * loss properly), and blending the wrong way round.
 */
export class HfLossShelf {
  constructor(sampleRate, {
    cornerHz = HF_LOSS_CORNER_HZ,
    smoothMs = HF_LOSS_SMOOTH_MS,
  } = {}) {
    this.lp = []
    this.depthDb = 0
    this.coef = riseCoeff(1000 / (2 * Math.PI * cornerHz), sampleRate)
    this.smoothCoef = riseCoeff(smoothMs, sampleRate)
  }

  /** Knob (0-100) to plateau depth in dB. */
  static depthFor(amount) {
    return (clamp(amount, 0, 100) / 100) * HF_LOSS_MAX_DB
  }

  static isActive(depthDb) {
    return depthDb > HF_LOSS_EPSILON
  }

  /**
   * Move the shared depth ramp forward by `n` samples and return the linear
   * gain for this block. Once per block, before the channel loop.
   */
  advance(targetDb, n) {
    for (let i = 0; i < n; i++) {
      this.depthDb += this.smoothCoef * (targetDb - this.depthDb)
    }
    return Math.pow(10, -this.depthDb / 20)
  }

  /** Apply at a fixed gain, in place. Once per channel. */
  process(buf, n, ch, gain) {
    while (this.lp.length <= ch) this.lp.push(0)
    let lp = this.lp[ch]
    const a = this.coef
    for (let i = 0; i < n; i++) {
      lp += a * (buf[i] - lp)
      buf[i] = gain * buf[i] + (1 - gain) * lp
    }
    this.lp[ch] = lp
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}
