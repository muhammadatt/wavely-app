/**
 * Hit-testing for the selection's own edges in the waveform.
 *
 * A selection that can only be made in one gesture is a selection that has to
 * be remade from scratch every time it lands a few pixels off — which, at any
 * useful zoom, is most times. Grabbing an edge and dragging it is how every
 * audio editor lets the user close in on a word boundary, and it is the same
 * gesture as making the selection: the *opposite* edge becomes the anchor and
 * the rest of the drag path is identical.
 *
 * The geometry lives here rather than in the component so it can be tested
 * without a canvas: the numbers that decide whether a click lands on an edge
 * are the whole of the feature's feel.
 */

/**
 * How close the pointer has to be to an edge to grab it, in pixels either side.
 *
 * Wider than the 1.5 px line the renderer draws, because a hit target the
 * width of its own graphic is a hit target that misses. Kept under half of
 * SELECTION_DRAG_THRESHOLD_PX * 2 so an ordinary click just inside a selection
 * still starts a fresh one rather than silently resizing the old.
 */
export const SELECTION_EDGE_GRAB_PX = 6

/**
 * Which edge of the selection, if either, sits under `xPx`.
 *
 * @param {Object} opts
 * @param {{start: number, end: number}|null} opts.selection - in seconds
 * @param {number} opts.xPx - pointer offset from the canvas's left edge
 * @param {number} opts.scrollLeft - horizontal scroll, in seconds
 * @param {number} opts.pixelsPerSecond - zoom
 * @param {number} [opts.grabPx] - hit radius, defaults to SELECTION_EDGE_GRAB_PX
 * @returns {'start'|'end'|null}
 */
export function hitSelectionEdge({
  selection,
  xPx,
  scrollLeft,
  pixelsPerSecond,
  grabPx = SELECTION_EDGE_GRAB_PX,
}) {
  if (!selection || !(pixelsPerSecond > 0)) return null

  const startPx = (selection.start - scrollLeft) * pixelsPerSecond
  const endPx = (selection.end - scrollLeft) * pixelsPerSecond

  const dStart = Math.abs(xPx - startPx)
  const dEnd = Math.abs(xPx - endPx)

  if (dStart > grabPx && dEnd > grabPx) return null
  // Zoomed out far enough, or on a short enough selection, both edges are
  // inside the hit radius at once. Take the nearer; on an exact tie take the
  // end, so dragging away from a hairline selection extends it forward rather
  // than turning it inside out.
  return dStart < dEnd ? 'start' : 'end'
}

/**
 * The fixed point for a drag that is adjusting `edge`.
 *
 * Anchoring on the opposite edge is what makes the adjust gesture identical to
 * the create gesture downstream — including dragging one edge clean past the
 * other, which setSelection normalises rather than inverting.
 *
 * @param {{start: number, end: number}} selection
 * @param {'start'|'end'} edge
 * @returns {number} anchor time, in seconds
 */
export function selectionDragAnchor(selection, edge) {
  return edge === 'start' ? selection.end : selection.start
}

/**
 * How far one tap of a nudge button moves a selection edge, for a waveform
 * drawn at `pps` px per second: about NUDGE_PX on screen, rounded to a 1-2-5
 * step (1 ms, 2 ms, 5 ms, 10 ms…) so the readout moves in round numbers.
 * Zooming in makes it finer, down to NUDGE_MIN_S; never coarser than NUDGE_MAX_S.
 */
export const NUDGE_PX = 3
export const NUDGE_MIN_S = 0.001
export const NUDGE_MAX_S = 1

export function nudgeStep(pps) {
  if (!(pps > 0)) return NUDGE_MAX_S
  const raw = NUDGE_PX / pps
  const exp = Math.floor(Math.log10(raw))
  const base = 10 ** exp
  const step = [1, 2, 5, 10].map(m => m * base).find(s => s >= raw * 0.999)
  return Math.min(NUDGE_MAX_S, Math.max(NUDGE_MIN_S, step))
}

/**
 * The selection with one `edge` moved by `delta` seconds, kept inside
 * [0, `duration`] and never closer than `minLength` to the other edge (an edge
 * nudged into the other stops there rather than swapping sides).
 *
 * @param {{start: number, end: number}} selection
 * @param {'start'|'end'} edge
 * @returns {{start: number, end: number}}
 */
export function nudgedSelection(selection, edge, delta, duration, minLength = NUDGE_MIN_S) {
  let { start, end } = selection
  if (edge === 'start') start = Math.max(0, Math.min(end - minLength, start + delta))
  else end = Math.min(duration, Math.max(start + minLength, end + delta))
  return { start, end }
}
