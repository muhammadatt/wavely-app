/**
 * The console fader's travel law — the kit's CONSOLE FADERS.
 *
 * Unity sits at 78 % of the travel with +6 dB above it, and the bottom
 * quarter is spent on −30 … −80, where nothing is mixed: the shape every
 * console fader has, because the working range around unity is where the
 * resolution is wanted. Piecewise-linear between the kit's own points, so a
 * scale engraved from `faderPos` lands exactly where the cap reads it.
 */
export const FADER_POINTS = Object.freeze([
  [0, -80], [0.04, -60], [0.16, -40], [0.26, -30], [0.38, -20], [0.55, -10], [0.66, -5], [0.78, 0], [1, 6],
])

/** Fraction of travel → dB (−Infinity at the bottom stop). */
export function faderDb(p) {
  if (p <= 0) return -Infinity
  for (let i = 1; i < FADER_POINTS.length; i++) {
    const [p1, d1] = FADER_POINTS[i]
    const [p0, d0] = FADER_POINTS[i - 1]
    if (p <= p1) return d0 + (d1 - d0) * (p - p0) / (p1 - p0)
  }
  return FADER_POINTS[FADER_POINTS.length - 1][1]
}

/** dB → fraction of travel. */
export function faderPos(db) {
  if (!(db > FADER_POINTS[0][1])) return 0
  for (let i = 1; i < FADER_POINTS.length; i++) {
    const [p1, d1] = FADER_POINTS[i]
    const [p0, d0] = FADER_POINTS[i - 1]
    if (db <= d1) return p0 + (p1 - p0) * (db - d0) / (d1 - d0)
  }
  return 1
}

/** The taper object a Modula control takes, for a value in dB. */
export const CONSOLE_TAPER = Object.freeze({ toPct: faderPos, fromPct: faderDb })

/** The engraved marks. */
export const CONSOLE_MARKS = Object.freeze([6, 0, -5, -10, -20, -30, -40, -60])
