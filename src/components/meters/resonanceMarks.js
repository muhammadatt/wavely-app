/**
 * Which parts of a display frame are notable, as pure functions.
 *
 * Split out of the component for the reason the zone geometry is: picking the
 * wrong feature, or placing one at the wrong frequency, looks exactly like
 * picking the right one. None of it can be reviewed by looking at the plot.
 *
 * ⚠ THE MARKS HALF IS GONE. `findResonanceMarks` named the deepest few cuts with
 * a frequency and a depth — "1.75 kHz -9.5" — as dots on the reduction trace.
 * Both it and the trace's peak-hold outline said where the reduction HAS been,
 * and the FOUND strip now answers that in a band of its own, at true depth over
 * the threshold and without stacking two histories on one curve. The marks, the
 * pills, their hit test, their keyboard walk and their four constants went with
 * it, and so did the tests that pinned them.
 *
 * Deleted rather than left unwired, which is the opposite of the call made for
 * `bandSplitLimiter.js`. The difference is what the code is worth: that module
 * carries measurements nobody wants to repeat, and its tests are the record. The
 * marks were a display decision that has been reversed, and everything worth
 * keeping about them is the sentence above.
 */

/**
 * The shallowest crossing worth shading.
 *
 * IT IS A PIXEL BUDGET AGAIN, having twice not been one. The spectrum's window
 * is 85 dB over a band of about 139 px, so a decibel is 1.6 px and this floor is
 * 0.8 — right at the point where a fill becomes thinner than the strokes around
 * it, which is where it started life against a different window. That is
 * coincidence rather than derivation; the value has not moved.
 *
 * ⚠ THE CLUTTER ARGUMENT IT CARRIED IS VOID. It read that the floor guards
 * against ghosts, "and only because the shading is held" — the shading here is
 * LIVE, and has been since the crossing history moved into the FOUND band. A bin
 * hovering either side of the line now flickers rather than accumulating, which
 * is a smaller problem and still worth suppressing.
 *
 * ⚠ AND IT IS ONE FLOOR FOR ONE SPACE, not two. It used to be shared with the
 * margin lane, on the argument that two overlays must not disagree about what is
 * happening. That lane is gone, and the FOUND band that replaced it applies no
 * floor of its own — it draws the held excess as a silhouette, where a shallow
 * crossing is simply a low one rather than a thin sliver that needs suppressing.
 * So this governs the spectrum's crossings and nothing else.
 *
 * ⚠ 0.5 dB IS A JUDGEMENT, NOT A MEASUREMENT — the first thing to tune by eye,
 * in both directions: too low and the display silts up, too high and a genuine
 * shallow resonance never appears. It is compared against a run's PEAK, so a
 * broad resonance keeps its shallow flanks either way.
 */
export const EXCEEDANCE_MIN_DB = 0.5

/**
 * Contiguous spans where the input rises above the detection threshold, with
 * the crossings located BETWEEN bins.
 *
 * This is what the detector is responding to, and until it was shaded it was
 * the least visible thing on the plot: a gap between two 1 px strokes, both of
 * them wandering, at ~3 px per dB — against a reduction trace drawn at ~20 px
 * per dB near zero. Same event, seven times the size, on the curve that is the
 * consequence rather than the cause.
 *
 * THE CROSSINGS ARE INTERPOLATED rather than snapped to the nearest bin. At a
 * true crossing the two curves meet, so the shaded region has to close to a
 * point there; starting it at the first bin already over the line opens the
 * shape with a vertical step several pixels tall, which on a 3 px feature is
 * most of what would be drawn. `pos` is therefore a FRACTIONAL bin index, and
 * `db` is the level at that position — the same on both curves, which is what
 * makes it a crossing.
 *
 * A run that reaches either end of the spectrum is clamped there rather than
 * extrapolated: there is no crossing off the edge of the analysed band, and
 * inventing one would draw a taper that is not in the data.
 *
 * Split out of the component for the same reason the marks and the zone
 * geometry are — a span shaded across the wrong frequencies looks exactly like
 * one shaded across the right frequencies.
 */
export function findExceedanceRuns(mag, threshold, bins, minDb = EXCEEDANCE_MIN_DB) {
  const runs = []
  if (!(bins > 1)) return runs

  const excess = d => mag[d] - threshold[d]

  let start = -1
  let peak = 0
  for (let d = 0; d < bins; d++) {
    const e = excess(d)
    if (e > 0) {
      if (start < 0) { start = d; peak = e }
      else if (e > peak) peak = e
      if (d < bins - 1) continue
    }
    if (start < 0) continue

    // `d` is the first bin back under the line, or one past the end.
    const end = e > 0 ? d : d - 1
    if (peak >= minDb) runs.push(edges(mag, threshold, bins, start, end))
    start = -1
  }
  return runs
}

/** One run's fractional endpoints. See the note on interpolation above. */
function edges(mag, threshold, bins, start, end) {
  const before = cross(mag, threshold, bins, start - 1, start)
  const after = cross(mag, threshold, bins, end + 1, end)
  return {
    startBin: start,
    endBin: end,
    startPos: before ? before.pos : start,
    startDb: before ? before.db : mag[start],
    endPos: after ? after.pos : end,
    endDb: after ? after.db : mag[end],
  }
}

/**
 * Where the two curves meet between `outside` (under the line) and `inside`
 * (over it), or null when `outside` is off the end of the band.
 *
 * Linear in the DIFFERENCE, which is the quantity that has a zero. Interpolating
 * the two curves separately and intersecting them is the same answer with two
 * more steps to get wrong.
 */
function cross(mag, threshold, bins, outside, inside) {
  // ⚠ BOUNDED BY `bins`, NOT BY `mag.length`. The display's frame buffers are
  // reused across frames and are sized for the largest bin count seen, so a run
  // reaching the last bin would otherwise interpolate toward a stale value left
  // over from an earlier, wider frame — and draw a taper off the end of the
  // analysed band that nothing in this frame supports.
  if (outside < 0 || outside >= bins) return null
  const a = mag[outside] - threshold[outside]
  const b = mag[inside] - threshold[inside]
  const span = a - b
  // Guard the degenerate case: if the outside bin is exactly on the line the
  // crossing IS that bin, and if both are equal there is no crossing to find.
  const t = span === 0 ? 0 : a / span
  return {
    pos: outside + t * (inside - outside),
    db: mag[outside] + t * (mag[inside] - mag[outside]),
  }
}
