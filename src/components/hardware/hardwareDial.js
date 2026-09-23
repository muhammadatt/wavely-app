/**
 * Geometry for the hardware-style faceplates: where a value sits on a dial,
 * where the engraving goes, and how the VU face lays out its scale.
 *
 * Kept out of the components so the numbers that decide what a dial SAYS can
 * be pinned without a DOM (see `test/ui/hardwareDial.test.js`).
 */

/** Pointer angle at the two stops, degrees from straight up. */
export const DIAL_MIN_DEG = -140
export const DIAL_MAX_DEG = 140

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Fraction of travel -> pointer angle. */
export function pctToDeg(pct, a0 = DIAL_MIN_DEG, a1 = DIAL_MAX_DEG) {
  return a0 + (a1 - a0) * clamp01(pct)
}

/** Value -> pointer angle, for a knob that turns linearly in its value. */
export function valueToDeg(value, min, max, a0 = DIAL_MIN_DEG, a1 = DIAL_MAX_DEG) {
  return pctToDeg(max === min ? 0 : (value - min) / (max - min), a0, a1)
}

/** `n` angles spread evenly across the travel, stops included. */
export function evenAngles(n, a0 = DIAL_MIN_DEG, a1 = DIAL_MAX_DEG) {
  if (n <= 1) return [a0]
  return Array.from({ length: n }, (_, i) => a0 + (a1 - a0) * i / (n - 1))
}

/**
 * Engraving for a dial with `labels.length` numbered positions and one bare
 * dot between each pair — the pattern on both large knobs. A blank label
 * still gets its dot; it just prints nothing.
 */
export function engraving(labels, a0 = DIAL_MIN_DEG, a1 = DIAL_MAX_DEG) {
  const majors = evenAngles(labels.length, a0, a1)
  const dots = []
  majors.forEach((a, i) => {
    dots.push(a)
    if (i < majors.length - 1) dots.push((a + majors[i + 1]) / 2)
  })
  return {
    dots,
    labels: majors.map((angle, i) => ({ angle, text: labels[i] })),
  }
}

/** Offset of a point at `angle` and `radius` from the dial's centre. */
export function polar(angle, radius) {
  const rad = angle * Math.PI / 180
  return { x: Math.sin(rad) * radius, y: -Math.cos(rad) * radius }
}

/**
 * Signed dB with a real minus sign, the way the Output readout prints it.
 * Rounded before the sign is chosen, so -0.04 reads "0.0 dB", not "−0.0 dB".
 */
export function formatSignedDb(db, digits = 1) {
  const r = Number(db.toFixed(digits))
  const sign = r > 0 ? '+' : r < 0 ? '−' : ''
  return `${sign}${Math.abs(r).toFixed(digits)} dB`
}

/**
 * The VU face's scale: VU reading -> fraction of the needle's travel. The
 * table is the design's engraving, which crowds the top of the scale the way
 * a moving-coil movement does.
 */
export const VU_SCALE = [
  [-20, 0], [-10, 0.25], [-7, 0.34], [-5, 0.42], [-3, 0.52], [-2, 0.57],
  [-1, 0.63], [0, 0.70], [1, 0.80], [2, 0.90], [3, 1],
]
export const VU_SWEEP_DEG = 48

export function vuFraction(vu) {
  if (!(vu > VU_SCALE[0][0])) return 0
  for (let i = 0; i < VU_SCALE.length - 1; i++) {
    const [a, fa] = VU_SCALE[i]
    const [b, fb] = VU_SCALE[i + 1]
    if (vu <= b) return fa + (fb - fa) * (vu - a) / (b - a)
  }
  return 1
}

export function vuFractionToDeg(f) {
  return -VU_SWEEP_DEG + f * VU_SWEEP_DEG * 2
}

/**
 * Gain reduction on the VU face, as the hardware's GR switch position reads
 * it: the needle rests on 0 and falls left, one VU division per dB.
 */
export function grToVuFraction(reductionDb) {
  return vuFraction(-Math.max(0, reductionDb))
}
