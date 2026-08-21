/**
 * Contiguous runs of scope columns whose peak stands above the threshold.
 *
 * WHY THIS IS ITS OWN FUNCTION. The scope's excess shading used to be drawn as
 * one path with a single `open` flag that was set on the first crossing and
 * never cleared. Every separate crossing after the first therefore continued
 * the same subpath from wherever the previous one ended, and the diagonal that
 * carried the pen across the gap — from the threshold line at the old event up
 * to the peak of the new one — closed into a large filled triangle spanning
 * audio that never crossed at all. Mirrored top and bottom, that is a pair of
 * orange wedges hanging off each clipped sample, over signal the stage did not
 * touch. Reported from use, and it is the one thing this display must never do:
 * claim the effect acted where it did not.
 *
 * Splitting the runs first makes the geometry impossible to get wrong — each
 * run is filled as its own closed polygon and the gaps are simply not drawn —
 * and it is the part worth testing, which a canvas path is not.
 *
 * @param {ArrayLike<number>} peak ring buffer of peak amplitudes
 * @param {number} start index in `peak` of the oldest column
 * @param {number} n number of columns to walk
 * @param {number} capacity ring length
 * @param {number} threshold linear amplitude
 * @returns {Array<[number, number]>} [firstColumn, lastColumn] inclusive, in order
 */
export function crossingRuns(peak, start, n, capacity, threshold) {
  const runs = []
  let from = -1
  for (let i = 0; i < n; i++) {
    const over = peak[(start + i) % capacity] > threshold
    if (over && from < 0) from = i
    else if (!over && from >= 0) {
      runs.push([from, i - 1])
      from = -1
    }
  }
  if (from >= 0) runs.push([from, n - 1])
  return runs
}
