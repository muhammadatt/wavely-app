/**
 * Which resonances the display names, and where.
 *
 * Design 1c marks the deepest cuts with a pill carrying a frequency and a
 * depth — "1.75 kHz  −9.5". That is the one thing the per-zone readouts cannot
 * say: a zone number tells you which BAND is being worked, and a mark tells you
 * which FREQUENCY, which is what someone reaches for the EQ with.
 *
 * Split out of the component for the same reason the zone geometry is: picking
 * the wrong peak, or labelling a peak at the wrong frequency, looks exactly
 * like picking the right one.
 */

/** A cut shallower than this is not a resonance worth naming. */
export const MARK_MIN_DB = 2.2
/**
 * Minimum separation between two marks, as a fraction of the log-frequency
 * axis. A resonance is a few bins wide and its shoulders are local maxima too,
 * so without this the four slots fill with one peak's flanks.
 */
export const MARK_MIN_SEPARATION = 0.05
/** How many marks the plot will carry. More than this and the pills collide. */
export const MARK_MAX = 4

/**
 * Local maxima of the reduction curve, deepest first, thinned by separation,
 * returned in frequency order.
 *
 * ±1 AND ±3 BINS. Comparing only against immediate neighbours accepts every
 * ripple on a broad cut as its own peak; ±3 requires the peak to still be the
 * largest thing across roughly the width of a real resonance on this grid. The
 * ends are skipped rather than clamped — a "peak" at the first or last bin has
 * no shoulder on one side and cannot be shown to be a maximum of anything,
 * which is the same rule the F0 tracker's edge-peak guard applies.
 *
 * Returned sorted by FREQUENCY, not by depth, because the caller lays the pills
 * out left to right and alternates their vertical offset to avoid collisions —
 * an ordering by depth would make that alternation arbitrary.
 */
export function findResonanceMarks(reduction, bins, minHz, maxHz, opts = {}) {
  const minDb = opts.minDb ?? MARK_MIN_DB
  const separation = opts.separation ?? MARK_MIN_SEPARATION
  const max = opts.max ?? MARK_MAX
  if (!reduction || bins < 7) return []

  const found = []
  for (let i = 3; i < bins - 3; i++) {
    const v = reduction[i]
    if (v < minDb) continue
    if (v >= reduction[i - 1] && v >= reduction[i + 1]
      && v >= reduction[i - 3] && v >= reduction[i + 3]) {
      found.push({ bin: i, db: v, pos: i / (bins - 1) })
    }
  }
  found.sort((a, b) => b.db - a.db)

  const kept = []
  for (const m of found) {
    if (kept.every(k => Math.abs(k.pos - m.pos) > separation)) kept.push(m)
    if (kept.length === max) break
  }

  const octaves = Math.log2(maxHz / minHz)
  for (const m of kept) m.hz = minHz * Math.pow(2, m.pos * octaves)
  return kept.sort((a, b) => a.hz - b.hz)
}
