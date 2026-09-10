/**
 * TUBE SATURATION'S TRANSFER CURVE, AS A STANDALONE MEMORYLESS STAGE.
 *
 * WHY THIS FILE EXISTS. OptoSmooth's valve stage and its T4 cell both wanted
 * the character Tube Saturation was tuned to by ear, and the alternative to
 * this module was pasting `shape`/`splitShape` into `la2aProcessor.js`. That is
 * the copy Scheps deliberately does NOT make of the LA-2A kernel, for the
 * reason CLAUDE.md gives: a copy means the next tuning pass on Tube Saturation
 * silently stops reaching everything else that was voiced against it. So the
 * curve functions are imported from `vocalSatProcessor.js` — one definition,
 * and Tube Saturation remains their owner.
 *
 * ⚠ THIS IS THE CURVE, NOT THE PLUGIN, AND THE DIFFERENCE IS DELIBERATE.
 * Tube Saturation's panel patch is a whole chain: a 3-band split, a pre/de-
 * emphasis pair, a slew limiter, a lookahead peak trim, and a gated dual-RMS
 * drive normaliser. Four of those five carry state, and one of them —
 * `autoDrive` — is by construction an EXPANDER (its own notes measure it
 * handing back 6.8 dB of the crest the curve removed). Putting an expander
 * inside a compressor's gain path is not importing a sound, it is wiring two
 * controllers against each other. What comes across here is the memoryless
 * part: the curve, its SPLIT asymmetry, and the wet/dry crossfade.
 *
 * ⚠ WHICH MEANS THIS IS NOT YET BIT-FOR-BIT "TUBE SAT AT DEFAULTS" AND MUST
 * NOT BE DESCRIBED AS THOUGH IT WERE. The emphasis pair in particular is not a
 * garnish — Tube Saturation's own notes call it "what makes a waveshaper absorb
 * rather than excite", and it is absent here. If the imported character sounds
 * brighter or more forward than the plugin it came from, that pair is the first
 * thing to reach for, and it is portable (two shelves, no latency) at the cost
 * of the closed-form makeup inverse below.
 */

import {
  shape, splitShape, splitKnees, cubicShape,
} from '../vocalSatProcessor.js'
import {
  VOCAL_SAT_DEFAULTS, CURVE_CUBIC, ASYM_MODE_SPLIT,
} from '../vocalSatParams.js'

/**
 * THE OPERATING DRIVE, AND THE ONE NUMBER HERE THAT IS DERIVED RATHER THAN
 * INHERITED.
 *
 * Tube Saturation does not have a single drive. Its curve sees
 * `drive * bandMult * autoDriveGain * x`, and `autoDriveGain` is whatever
 * normalises the programme to `AUTO_REFERENCE_RMS` (0.1). So the level the
 * curve actually acts at is fixed by a follower, not by the patch — which is
 * exactly the machinery that cannot come across (see the header).
 *
 * The equivalent has to be reconstructed from the level OptoSmooth already
 * standardises on. At the panel defaults `drive` is 1 and the band multipliers
 * are 3 / 3 / 2.5, so a broadband stand-in is 3. Material at OptoSmooth's
 * NOMINAL_DBFS sits at 0.1259 RMS, so the drive normaliser would be
 * 0.1 / 0.1259 = 0.794, and the curve input is 3 x 0.794:
 *
 *   VOCAL_SAT_CURVE_DRIVE = 2.38
 *
 * ⚠ SO THIS IS NOT THE PANEL'S `drive` AND MUST NEVER BE LABELLED AS THOUGH IT
 * WERE. Tube Saturation's Drive knob reads 1 at its defaults; this is the
 * EFFECTIVE drive its curve sees once the band multiplier and the auto-drive
 * normaliser have been folded in. Anyone matching this against the plugin knob
 * by eye will set it to 1 and land 7.5 dB short of where the plugin's curve
 * actually sits. The tuning panel calls it "Valve sat drive" and says so.
 *
 * ⚠ IT IS ONLY RIGHT AT NOMINAL, AND THAT IS WHY `inputAlignDb` IS LOAD-
 * BEARING HERE RATHER THAN MERELY HELPFUL. Tube Saturation's follower tracks
 * the programme, so its curve sits at the same place on the transfer for a
 * quiet file and a loud one. This constant is a fixed drive, so an unaligned
 * file lands somewhere else on the curve and sounds like a different stage.
 * OptoSmooth measures gated RMS and offsets to nominal by default, which is
 * what makes a fixed drive defensible at all — on a plugin without that, this
 * approach would not be sound.
 *
 * ⚠ AND IT IS A BROADBAND STAND-IN FOR A 3-BAND SPLIT, so it cannot be right
 * for all three bands at once. 3 / 3 / 2.5 is a narrow spread, which is what
 * makes one number tolerable; if the low band's multiplier is ever moved away
 * from the other two, this stops being a stand-in and starts being wrong.
 */
export const VOCAL_SAT_CURVE_DRIVE = 2.38

/**
 * Which polarity gets the hard knee under SPLIT asymmetry.
 *
 * ⚠ THE ONE THING HERE THAT TUBE SATURATION MEASURES AND THIS DOES NOT. Its
 * `SkewTracker` decides the sign from the material — a sticky latch over a
 * voiced gate — because the asymmetry has to lean the same way the waveform
 * does or it fights it. A memoryless stage has no tracker, so the sign is a
 * constant, and `true` is a choice rather than a measurement. It is exposed in
 * the tuning panel for exactly that reason: if the imported character sounds
 * inverted against the plugin, this is the first switch to try.
 */
export const VOCAL_SAT_CURVE_LEAN_POSITIVE = true

/** Below this drive the blend is the identity — see `transferAt`. */
const DRIVE_EPSILON = 1e-6

/**
 * Build the memoryless transfer, with its inverse.
 *
 * Small-signal gain is normalised to unity — `shape` has unit slope at the
 * origin, so dividing the driven curve back by the drive makes the whole stage
 * transparent at low level and leaves the crossfade transparent too.
 *
 * ⚠ THAT IS A DEPARTURE FROM TUBE SATURATION AND IS THE RIGHT ONE HERE. The
 * plugin does not divide by its drive; it renormalises downstream against a
 * moving RMS follower. Inside OptoSmooth that job already belongs to auto
 * makeup, which solves for the output peak deterministically, and a second
 * level-restoring mechanism underneath it would be the makeup fighting a
 * follower — the same class of coupling the live tracker's note warns about.
 *
 * @returns {{transfer: (x:number)=>number, inverse: (y:number)=>number|null}}
 */
export function makeVocalSatCurve(overrides = {}) {
  const p = { ...VOCAL_SAT_DEFAULTS, ...overrides }
  const drive = Number.isFinite(p.curveDrive) && p.curveDrive > 0
    ? p.curveDrive : VOCAL_SAT_CURVE_DRIVE
  const lean = p.leanPositive !== false
  const wet = Math.min(Math.max(p.wetDry, 0), 1)
  const dry = 1 - wet
  const hardness = p.hardness

  // The driven curve, normalised back to unity small-signal gain.
  let curve
  if (p.curve === CURVE_CUBIC) {
    curve = x => cubicShape(x)
  } else if (p.asymMode === ASYM_MODE_SPLIT) {
    // Same knee pair the plugin computes, with the tracker's sign held fixed.
    const u = Math.min(Math.max(p.asymmetry, 0), 100) / 100
    const { nPos, nNeg } = splitKnees(hardness, u, lean)
    curve = x => splitShape(x, nPos, nNeg)
  } else {
    // OFFSET: run the curve off centre and subtract its operating point, which
    // is what `applyTransfer` does. Constant per patch, so it is hoisted.
    const off = (Math.min(Math.max(p.asymmetry, 0), 100) / 100) * (lean ? 1 : -1)
    const shapedOff = shape(off, hardness)
    curve = x => shape(x + off, hardness) - shapedOff
  }

  const transfer = x => dry * x + wet * curve(drive * x) / drive

  /**
   * The same blend at an arbitrary drive, for callers whose drive MOVES.
   *
   * The T4 cell's shaper is one: its drive tracks gain reduction, so it cannot
   * use the hoisted `transfer` above and rebuilding a closure per sample is not
   * an option in the inner loop. Below `DRIVE_EPSILON` the stage is the
   * identity rather than 0/0 — which is also the behaviour the cell needs at
   * zero gain reduction, where it must be absent by construction.
   */
  const transferAt = (x, d) => (
    d > DRIVE_EPSILON ? dry * x + wet * curve(d * x) / d : x
  )

  /**
   * Inverse, by Newton with a bisection guard.
   *
   * ⚠ NUMERIC RATHER THAN CLOSED FORM, AND THE CROSSFADE IS WHY. `splitShape`
   * alone inverts in closed form — `x = y / (1 - |y|^n)^(1/n)` — but
   * `dry*x + wet*g(x)` is a sum of a line and a curve and has no such solution.
   * It is still strictly monotone, which is the property auto makeup actually
   * needs, and this runs once per makeup query rather than per sample.
   *
   * Returns null where no finite input reaches `y`, matching the contract the
   * tanh inverse already had at saturation.
   */
  const inverse = (y) => {
    if (!Number.isFinite(y)) return null
    if (y === 0) return 0
    /**
     * ⚠ BRACKETED ON THE SIGNED VALUE, NOT ON `|y|`. A first pass folded the
     * search through `Math.abs` and mirrored the sign back, which is only valid
     * for an ODD curve — and SPLIT asymmetry exists precisely to make this one
     * not odd. It inverted the positive branch exactly and the negative branch
     * to 0.1 in absolute terms, i.e. it silently answered the wrong half of the
     * curve. `transfer` is monotone increasing over the whole line, so the
     * bracket search works directly on it and no symmetry is assumed.
     */
    let lo = 0
    let hi = 0
    if (y > 0) {
      hi = 1
      for (let i = 0; i < 200 && transfer(hi) < y; i++) hi *= 2
      if (transfer(hi) < y) return null
    } else {
      lo = -1
      for (let i = 0; i < 200 && transfer(lo) > y; i++) lo *= 2
      if (transfer(lo) > y) return null
    }
    for (let i = 0; i < 80; i++) {
      const mid = 0.5 * (lo + hi)
      if (transfer(mid) < y) lo = mid; else hi = mid
    }
    return 0.5 * (lo + hi)
  }

  return { transfer, transferAt, inverse, drive }
}
