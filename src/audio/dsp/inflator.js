/**
 * INFLATOR — the transfer curve and the three-band split.
 *
 * Ported from Kiriki-liszt/JS_Inflator (`source/JSIF_processor.cpp`), a
 * VST3 reimplementation of the Sonnox Inflator. The polynomial, its
 * coefficient law, the fold-back region and the 240/2400 Hz crossovers are
 * that project's, read verbatim; what is ours is the surrounding kernel, the
 * fixed oversampling profile and the guarantees pinned in the tests.
 *
 * The arithmetic lives here rather than in the kernel for the reason
 * selectionDrag.js does: the numbers that decide the sound should be testable
 * without an AudioContext, and a curve that is subtly wrong looks exactly like
 * a curve that is right.
 *
 * ── WHAT THE CURVE IS ──────────────────────────────────────────────────────
 *
 * Odd-symmetric: the sign is stripped, a quartic in s = |x| is applied, the
 * sign is restored. So it generates ODD harmonics only — the same family the
 * soft clipper produces, and for the same structural reason.
 *
 *   f(s) = A·s + B·s² + C·s³ − D·(s² − 2s³ + s⁴)
 *        = A·s + B·s² + C·s³ − D·s²(1 − s)²
 *
 * with p = Curve/100 in [−0.5, +0.5]:
 *
 *   A = 1.5 + p        B = −2p        C = p − 0.5        D = 0.0625 − p/4 + p²/4
 *
 * ── FOUR PROPERTIES, ALL ALGEBRAIC RATHER THAN FITTED ──────────────────────
 *
 * These are what make the curve worth porting rather than approximating, and
 * each is pinned in test/dsp/inflator.test.js.
 *
 * 1. f(1) = 1 AT EVERY CURVE SETTING. The D term carries the factor s²(1−s)²,
 *    which is zero at s = 1, so f(1) = A + B + C = (1.5+p) + (−2p) + (p−0.5) = 1
 *    identically. **Curve changes the shape and never the ceiling** — which is
 *    what lets it be presented as a character control rather than a second
 *    depth control, the failure this codebase has shipped twice (the soft
 *    clipper's KNEE switch and its HF Emphasis knob).
 *
 * 2. THE SMALL-SIGNAL GAIN IS f'(0) = A = 1.5 + p. That is +3.52 dB at the
 *    default Curve 0, unity at Curve −50 and +6.02 dB at Curve +50. This lift
 *    is the whole effect: quiet material comes up, the ceiling does not move,
 *    and the difference is the density people buy the box for. ⚠ It also means
 *    the plugin is LOUDER than its input at any Curve above −50 — Output is
 *    there to take that back, and an A/B against bypass is decided by level
 *    unless it is used.
 *
 * 3. THE CURVE IS MONOTONIC ON [0, 1] at every setting — verified by sweep,
 *    not by argument — so there is no instantaneous fold in the region the
 *    signal normally occupies. Above 1 there deliberately is one; see below.
 *
 * 4. f'(1) = 0 AT EVERY SETTING, and the fold-back region meets it there.
 *    A + 2B + 3C = (1.5+p) + (−4p) + (3p−1.5) = 0 identically. So the curve
 *    arrives at full scale FLAT rather than at an angle, and 2s − s² leaves at
 *    the same value with the same slope — the two pieces are C¹ continuous at
 *    the join. There is no corner at 0 dBFS to generate a burst of high-order
 *    content, which is why this reads as density rather than as clipping.
 *
 * ── THE FOLD-BACK, AND WHY IT IS GUARDED ───────────────────────────────────
 *
 * Above full scale the curve is `2s − s²`, independent of Curve, falling from
 * 1 at s = 1 to 0 at s = 2. That is a FOLD-BACK, not a clip: a sample 6 dB over
 * comes out at zero, and one 3 dB over comes out quieter than one exactly at
 * full scale. On sustained overload that is gross distortion, which is what the
 * Clip switch exists to prevent — see the ±1 pre-clip in the kernel.
 */

/** Curve is presented as a percentage; these are its ends. */
export const CURVE_MIN_PCT = -50
export const CURVE_MAX_PCT = 50

/**
 * The reference's hard-coded crossovers, in Hz. Not parameters there and not
 * here: they are chosen against the voice (240 Hz sits under the fundamental
 * region, 2400 Hz under the presence band), and a curve applied per band is a
 * different effect at every other placement rather than a tunable one.
 */
export const SPLIT_LOW_HZ = 240
export const SPLIT_HIGH_HZ = 2400

/**
 * Coefficients for a Curve setting given as a PERCENTAGE (−50…+50), which is
 * what the panel shows. The reference stores the normalised 0…1 form and
 * subtracts 0.5; those are the same number and the percentage is the one a
 * reader can check against the faceplate.
 */
export function inflatorCoefficients(curvePct) {
  const p = clamp(curvePct, CURVE_MIN_PCT, CURVE_MAX_PCT) / 100
  return {
    p,
    a: 1.5 + p,
    b: -(p + p),
    c: p - 0.5,
    d: 0.0625 - p * 0.25 + p * p * 0.25,
  }
}

/**
 * The transfer curve, one sample. `co` comes from inflatorCoefficients.
 *
 * ⚠ THE s ≥ 2 BRANCH RETURNS ZERO, which is the reference's behaviour and
 * looks like a bug until you follow it: 2s − s² is already zero at s = 2, so
 * the branch is continuous with the region below it. It is a guard against
 * the parabola turning back up past its own root, not a special case.
 */
export function inflatorCurve(x, co) {
  // ⚠ `Math.abs` AND `x < 0`, NOT `x > 0 ? 1 : -1`, AND THAT IS NOT A STYLE
  // CHOICE. The reference writes `if (in > 0) sign = 1; else sign = -1;`, which
  // hands x = 0 a sign of -1 and returns NEGATIVE ZERO — so a transfer curve
  // that should map 0 to 0 maps it to -0, and `Object.is(0, -0)` is false.
  //
  // It never reached the audio: the blend's `dry*(1-effect) + wet*effect` sums
  // it against a positive zero, and IEEE gives `+0 + -0 = +0`, as does the
  // downsampler's tap sum — verified, zero -0 samples in a silent region's
  // output at any setting. But `inflatorCurve` is exported and the tests call
  // it directly, and this file's guarantees are asserted bit-exactly all over
  // the suite, so a -0 sitting in the public API is a trap laid for the next
  // person to write `assert.equal(f(0), 0)` with Object.is semantics.
  //
  // `Math.abs` rather than `x < 0 ? -x : x` because the latter leaves s = -0
  // for an input of -0, which propagates through the polynomial and puts the
  // problem back.
  const s = Math.abs(x)
  const sign = x < 0 ? -1 : 1

  let y
  if (s >= 2) {
    // Returned rather than falling through to `y * sign`, which would hand a
    // negative input back -0 for the same reason the sign expression did.
    return 0
  } else if (s > 1) {
    y = 2 * s - s * s
  } else {
    const s2 = s * s
    const s3 = s2 * s
    const s4 = s2 * s2
    y = co.a * s + co.b * s2 + co.c * s3 - co.d * (s2 - 2 * s3 + s4)
  }
  return y * sign
}

/**
 * THE THREE-BAND SPLIT — two one-pole TPT lowpasses, and the bands are
 * DIFFERENCES of them rather than three separate filters.
 *
 *   low  = LP240(x)
 *   mid  = LP2400(x) − LP240(x)
 *   high = x − LP2400(x)
 *
 * So the three sum to exactly x, sample for sample, by construction — no
 * crossover design, no allpass correction, no magnitude-flatness to verify.
 * That is a stronger reconstruction guarantee than the LR4 split in
 * bandSplitLimiter.js manages (0.06 dB), and it is why this topology is worth
 * keeping rather than replacing with the house one: the plugin's promise is
 * that Effect 0 is the dry signal, and a split that reconstructs exactly is
 * what makes that true at the sample level rather than to within a tolerance.
 *
 * ⚠ THE COST IS SELECTIVITY. One pole is 6 dB/octave, so the bands overlap
 * heavily and "low" still contains a good deal of midrange. That is the
 * reference's design and it is the right trade here: a steep split would make
 * each band's saturation audible AS a band, where a gentle one weights the
 * curve's drive across the spectrum without ever sounding split.
 *
 * ⚠ THE MID BAND IS DRIVEN HARDER, and by a rate-dependent amount. The
 * reference pre-multiplies it by G and post-divides by G, where
 * `G = HP.C·(1 − LP.C) / (HP.C − LP.C)`. At 44.1 kHz × 4 that is 1.1110,
 * about +0.91 dB. It is not a taste constant — it falls out of the two filter
 * coefficients — but it DOES move with the sample rate the split runs at
 * (1.1099 at the base rate), so it is computed rather than pinned.
 */
export class InflatorBandSplit {
  /** @param {number} sampleRate the rate the split RUNS at — oversampled. */
  constructor(sampleRate) {
    this.lowC = tptCoefficient(SPLIT_LOW_HZ, sampleRate)
    this.highC = tptCoefficient(SPLIT_HIGH_HZ, sampleRate)
    // Mid drive, and its exact inverse so the band comes back at unity.
    this.g = (this.highC * (1 - this.lowC)) / (this.highC - this.lowC)
    this.gInv = 1 / this.g
    this.reset()
  }

  reset() {
    this.lowState = 0
    this.highState = 0
  }

  /**
   * Split one sample. Returns the three bands, which sum to `x` exactly.
   *
   * The integrator update is the reference's verbatim:
   *   R = I + C·(x − I);  I = 2R − I
   * which is the trapezoidal (TPT) one-pole — unconditionally stable and, more
   * usefully here, exact at DC, so a sustained offset does not leak between
   * bands.
   */
  process(x) {
    const lowR = this.lowState + this.lowC * (x - this.lowState)
    this.lowState = 2 * lowR - this.lowState

    const highR = (1 - this.highC) * this.highState + this.highC * x
    this.highState = 2 * highR - this.highState

    return { low: lowR, mid: highR - lowR, high: x - highR }
  }
}

/** The reference's coefficient law, `0.5·tan(π(fc/Fs − ¼)) + 0.5`. */
function tptCoefficient(freqHz, sampleRate) {
  return 0.5 * Math.tan(Math.PI * (freqHz / sampleRate - 0.25)) + 0.5
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}
