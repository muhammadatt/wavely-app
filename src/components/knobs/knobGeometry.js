/**
 * Where a knob's value sits along its arc, and where its fill starts from.
 *
 * Extracted for the reason `detentRotaryGeometry.js` and `travelSlideGeometry.js`
 * were: a knob whose fill originates from the wrong place still renders as a
 * perfectly good knob, so the fault is invisible in the template and invisible
 * in a screenshot of any knob whose range happens to be symmetric.
 */

/** Clamp to the closed unit interval. */
export function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

/**
 * Value → fraction of travel.
 *
 * `log` spreads travel evenly per octave instead of per unit, and requires a
 * positive `min` — a frequency knob over 20 Hz–20 kHz is unusable linear, since
 * everything below 200 Hz lands in the first degree of rotation.
 */
export function valueToPct(value, min, max, scale = 'linear') {
  if (scale === 'log' && min > 0 && max > min) {
    return clamp01(Math.log(value / min) / Math.log(max / min))
  }
  return clamp01((value - min) / (max - min))
}

/** Fraction of travel → value. The exact inverse of `valueToPct` in range. */
export function pctToValue(pct, min, max, scale = 'linear') {
  if (scale === 'log' && min > 0 && max > min) return min * (max / min) ** pct
  return min + pct * (max - min)
}

/**
 * Where along the arc a bipolar fill starts, as a fraction of travel.
 *
 * ⚠ IT IS WHERE **ZERO** FALLS, NOT THE ARC'S MIDPOINT, AND THE MIDPOINT IS
 * WHAT SHIPPED. A hardcoded 0.5 is right on every symmetric knob — Scheps
 * Output ±12, ResoTame Trim ±12, the Inflator's two, the EQ gain knobs ±18 —
 * and every bipolar knob in the app is symmetric today, so this returns 0.5
 * to the last bit for all of them and nothing that was already right moved.
 *
 * ⚠ SO THIS IS A GUARD, NOT A FIX, AND THE DEFECT THAT MOTIVATED IT WAS
 * ANSWERED A DIFFERENT WAY. The soft clipper's Output went from ±6 to
 * −12…+24 when auto makeup shipped (the old ±6 could not reach the makeup the
 * stage asks for: MEDIUM lands +9.9 dB, SQUASH +11.0), and the midpoint of
 * that range is +6 dB — so the arc and the lit ticks filled outward from +6
 * and a knob at a genuine 0 dB showed a third of its ring lit. Reported as an
 * unintuitive zero, which it was. That knob is now 0…+24 and unipolar: the
 * makeup can never be negative, because nothing in the stage raises the peak,
 * so the negative travel was unreachable and it pushed 0 dB round to about
 * 10 o'clock. The fill origin and the pointer angle are separate — only the
 * range moves the pointer, which is what the report was actually about.
 *
 * ⚠ A RANGE THAT DOES NOT CONTAIN ZERO CLAMPS TO ITS NEAREST END, so a bipolar
 * knob over an all-positive range degenerates to filling from its minimum —
 * which is the honest answer, since such a knob has no centre to fill from.
 */
export function bipolarOriginPct(min, max, scale = 'linear') {
  return valueToPct(0, min, max, scale)
}
