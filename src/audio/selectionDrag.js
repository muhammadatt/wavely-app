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
