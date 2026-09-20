/**
 * THE LA-2A OUTPUT STAGE AS A MEMORYLESS POLYNOMIAL, IDENTIFIED FROM A CAPTURE.
 *
 *   g(u) = u + c3·u³ + c4·u⁴          c3 = 1.1017e-3, c4 = 0.032812
 *
 * WHY THIS EXISTS. OptoSmooth's shipping saturation is Tube Saturation's curve,
 * chosen by ear, and CLAUDE.md is explicit that no measurement backs it. This is
 * the alternative the references actually support: Analog Obsession LALA's
 * output stage, read out of the harmonic columns already in the ledger.
 *
 * ── THE IDENTIFICATION ──────────────────────────────────────────────────────
 *
 * From `docs/claude-dev-log.md`, LALA at Gain 0 (its Gain is post-curve, so the
 * level sweep carries the whole of its level dependence):
 *
 *   H2 −89.7 / H3 −107.2 / H4 −101.8 dBc at −18 dBFS            (line 312)
 *   H2 −155.7 / −89.7 / −38.7 / −8.1 at −40 / −18 / −1 / +9.2   (line 316)
 *   slopes, dB per dB of input: H2 3.06, H3 1.95                (line 316)
 *
 * A term of order n makes harmonics rising (n−1) dB per dB, so H2 at 3.06 reads
 * as order 4 and H3 at 1.95 as order 3. The confirming ratio is H4−H2, which
 * measures −12.10 dB against a pure x⁴ term's −12.04.
 *
 * ⚠⚠ THE IDENTIFICATION IS NOT ORIGINAL TO THIS MODULE AND WAS REDISCOVERED BY
 * ACCIDENT. The dev-log entry "THE LALA HAS AN OUTPUT STAGE TOO, AND IT IS A
 * POLYNOMIAL WITH NO QUADRATIC TERM" had already recovered `x + a₃x³ + a₄x⁴`
 * from 21 measured numbers, at a₄ = 3.281e−2 and a₃ = 1.102e−3. This module's
 * constants were derived later from the same log's columns, fitting c4 to the
 * −18 dBFS H2 row alone, and land on the same four figures. Treat the original as
 * the citation: it recovered a₄ from H2 and H4 INDEPENDENTLY (0.7 % apart), pinned
 * H2:H4 at 12.00–12.10 dB at every level against cos⁴'s 12.041, and established
 * the memoryless class from a frequency sweep flat to 0.3 dB over 50 Hz–5 kHz.
 * The later pass is corroboration from a different subset, not the source.
 *
 * `npm run la2a:curve` re-derives the constants on every run rather than asking
 * anyone to trust the two numbers below.
 *
 * ⚠⚠ IT IDENTIFIES THE OUTPUT STAGE, AND THE CELL IS A DIFFERENT STAGE. Both
 * sweeps behind it were captured at Gain 0 / PEAK REDUCTION 0 — cell idle — so
 * nothing here measures what the T4 should do, and LALA's own under-compression
 * captures read ratio, taper, ballistics and side-chain rather than harmonics.
 * Selecting this curve at the VALVE puts a reference curve in the stage the
 * reference measured. Selecting it at the CELL does not: there it is an ear
 * choice wearing a borrowed shape, in the same category as the Tube Sat cell
 * curve it would replace. The pedigree does not cross the stage boundary.
 *
 * ⚠ ONE REFERENCE, AND CHOOSING IT IS CHOOSING A SIDE — but a narrower side than
 * the ledger's "any refit picks one" (line 317). That warning is about MAGNITUDE,
 * where the two emulations disagree by 10–77 dB. On SHAPE there is only one
 * usable reference: CLA-2A's H2/H3 slopes of 0.77/0.66 are not reachable by any
 * memoryless polynomial at all, since a genuine third-order term goes as level²
 * and a sub-unity slope over 39 dB is not a curve being driven. CLA-2A abstains
 * from this question rather than answering it differently.
 *
 * ⚠ THE SIGN OF c4 IS NOT DETERMINED. Harmonic magnitudes carry no phase, so
 * which polarity expands is unknown from the transcribed readings — the same
 * standing unknown as `VOCAL_SAT_CURVE_LEAN_POSITIVE`, and exposed the same way,
 * as `leanPositive`. Settling it needs the captures, which are gitignored.
 *
 * ⚠ NEITHER IS THE DEPTH. c4 is LALA's, and LALA is 25.9 dB cleaner at nominal
 * than the Moore paper's six hardware units. `drive` is what spans that, and it
 * is an ear decision, not a measurement. Drive 2.70 puts H2 on the paper's
 * −63.80 dBc median; 1.0 is LALA's own.
 *
 * ── THE DOMAIN GUARD, AND WHY IT IS IN u AND NOT IN x ───────────────────────
 *
 * ⚠⚠ THIS IS THE LOAD-BEARING DETAIL AND GETTING IT WRONG LOOKS LIKE A PROPERTY
 * OF THE CURVE. Following `makeVocalSatCurve`'s convention the stage is
 * `g(d·x)/d`, so the polynomial's own input is u = d·x, and the measured domain
 * — LALA's readings reach a peak of 0.891, so |u| ≤ 1 — is a bound on u. A first
 * pass guarded |x| ≤ 1 instead, which lets the coefficients grow as d² and d³
 * over a fixed x range, and that curve FOLDS: it reported a monotonicity ceiling
 * at drive 1.976, a depth ceiling 8 dB below the Moore anchor, and the
 * conclusion that the shape could not carry the hardware's magnitude without
 * borrowing the FET kernel's partner term. All three were artifacts of the
 * wrong guard.
 *
 * Guarded in u the stage is monotone at EVERY drive, with no cap and no invented
 * knee: inside the domain the slope never falls below 0.8721, and outside it the
 * continuation is a straight line at the edge slope (0.8721 low side, 1.1346
 * high). Raising drive moves the corner to |x| = 1/d, so deeper drive spends
 * more of the waveform on the straight line — the stage soft-clips harder as it
 * is driven, which is the behaviour wanted, arrived at by construction.
 *
 * ⚠ BEYOND |u| = 1 THE STRAIGHT LINE IS OURS, NOT LALA'S. Same reasoning and
 * same value as `POLY_XMAX` in the FET kernel: past the measured domain a
 * polynomial is extrapolating, and a C1-continuous line at the edge slope is the
 * honest extension. It is also what keeps `inverse()` solvable — a bare quartic
 * outruns every bracket.
 *
 * ⚠ MONOTONE IS NOT A NICETY HERE. `inverse()` is what `computeAutoMakeupPlan`
 * and the live tracker solve the makeup through; a curve that folds has no
 * inverse and auto makeup silently stops having an answer.
 */

/**
 * Fitted to the −18 dBFS row. Stated to the precision the readings support —
 * they are given to 0.1 dB, about 1 % on a coefficient, so the fifth figure is
 * arithmetic rather than measurement.
 */
export const QUARTIC_C3 = 1.1017e-3
export const QUARTIC_C4 = 0.032812

/** Edge of the measured domain, in u. See the note above. */
export const QUARTIC_XMAX = 1.0

/** Drive that puts H2 at nominal on the Moore paper's −63.80 dBc median. */
export const QUARTIC_MOORE_DRIVE = 2.702

/** Below this drive the stage is the identity rather than 0/0. */
const DRIVE_EPSILON = 1e-6

/**
 * Build the stage, to the same contract as `makeVocalSatCurve`.
 *
 * `{transfer, transferAt, inverse, drive}` is what the kernel's cell path (which
 * needs `transferAt`, its drive moving per sample with gain reduction) and the
 * valve path (`transfer`, plus `inverse` for makeup) already consume, so this is
 * a drop-in for either stage.
 *
 * @returns {{transfer, transferAt, inverse, drive, minSlope}}
 */
export function makeQuarticSatCurve(opts = {}) {
  const drive = Number.isFinite(opts.drive) && opts.drive > 0 ? opts.drive : 1
  const sign = opts.leanPositive === false ? -1 : 1
  const c3 = (Number.isFinite(opts.c3) ? opts.c3 : QUARTIC_C3) * sign
  const c4 = (Number.isFinite(opts.c4) ? opts.c4 : QUARTIC_C4) * sign
  const xmax = Number.isFinite(opts.xmax) && opts.xmax > 0 ? opts.xmax : QUARTIC_XMAX

  // Edge values and slopes, per side: the curve is not odd, so the two ends
  // carry different values AND different slopes.
  const poly = u => u + c3 * u * u * u + c4 * u * u * u * u
  const slope = u => 1 + 3 * c3 * u * u + 4 * c4 * u * u * u
  const ep = poly(xmax); const sp = slope(xmax)
  const en = poly(-xmax); const sn = slope(-xmax)

  /** The polynomial in its own variable, with both continuations. */
  const g = (u) => {
    if (u > xmax) return ep + (u - xmax) * sp
    if (u < -xmax) return en + (u + xmax) * sn
    return poly(u)
  }

  const transferAt = (x, d) => (d > DRIVE_EPSILON ? g(d * x) / d : x)
  const transfer = x => g(drive * x) / drive

  /**
   * Smallest slope the stage can present, over the whole real line.
   *
   * Drive-independent, because `g(d·x)/d` has slope `g'(d·x)` — the drive
   * cancels. That is the whole reason no cap is needed, so it is computed and
   * exposed rather than asserted in a comment.
   */
  const minSlope = (() => {
    let m = Math.min(sp, sn)
    for (let i = 0; i <= 2000; i++) m = Math.min(m, slope(-xmax + (2 * xmax * i) / 2000))
    return m
  })()

  /**
   * Inverse, by bracket and bisection.
   *
   * ⚠ BRACKETED ON THE SIGNED VALUE, NOT ON |y|. The quartic term is precisely
   * what makes this curve not odd, so folding the search through `Math.abs`
   * would invert the wrong branch on one side — the bug `makeVocalSatCurve`'s
   * own inverse carries a warning about.
   *
   * Returns null where no finite input reaches `y`, matching the contract the
   * other curves' inverses already have.
   */
  const inverse = (y) => {
    if (!Number.isFinite(y)) return null
    if (y === 0) return 0
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

  return { transfer, transferAt, inverse, drive, minSlope }
}
