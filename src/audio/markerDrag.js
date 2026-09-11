/**
 * Hit-testing markers in the waveform's ruler gutter.
 *
 * ── THE GUTTER IS THE MARKER LANE, THE BODY IS THE SELECTION LANE ──────────
 * A marker draws as a hairline down the full height of the canvas, but only
 * its flag — the part inside RULER_GUTTER_HEIGHT — is grabbable. That split is
 * what lets this feature be added without touching the existing selection
 * gesture at all: in the body, every pointer event behaves exactly as it did
 * before, and a marker can never swallow a click meant to start a selection or
 * to drag a selection edge.
 *
 * The alternative — making the whole hairline grabbable — puts a 10 px-wide
 * dead zone through the waveform at every marker, in exactly the place a user
 * most wants to select from (the boundary they just marked).
 *
 * Geometry lives here rather than in the component so it can be tested without
 * a canvas, the same reason selectionDrag.js exists.
 */

/**
 * How close the pointer has to be to a marker's flag to grab it, in pixels
 * either side.
 *
 * Wider than SELECTION_EDGE_GRAB_PX because markers are dragged from a 18 px
 * strip rather than the full canvas height — the target is short, so it has to
 * be correspondingly forgiving horizontally.
 */
export const MARKER_GRAB_PX = 7

/**
 * Which marker, if any, sits under `xPx`.
 *
 * Nearest wins, so two markers closer together than the grab radius are both
 * still individually reachable by aiming at one of them.
 *
 * @param {Object} opts
 * @param {{id: string, time: number}[]} opts.markers
 * @param {number} opts.xPx - pointer offset from the canvas's left edge
 * @param {number} opts.scrollLeft - horizontal scroll, in seconds
 * @param {number} opts.pixelsPerSecond - zoom
 * @param {number} [opts.grabPx] - hit radius, defaults to MARKER_GRAB_PX
 * @returns {string|null} the marker's id
 */
export function hitMarker({
  markers,
  xPx,
  scrollLeft,
  pixelsPerSecond,
  grabPx = MARKER_GRAB_PX,
}) {
  if (!markers?.length || !(pixelsPerSecond > 0)) return null

  let bestId = null
  let bestDist = Infinity

  for (const m of markers) {
    const px = (m.time - scrollLeft) * pixelsPerSecond
    const d = Math.abs(xPx - px)
    if (d <= grabPx && d < bestDist) {
      bestDist = d
      bestId = m.id
    }
  }

  return bestId
}

/**
 * Whether a pointer at `yPx` is in the marker lane.
 *
 * Takes the gutter height rather than importing RULER_GUTTER_HEIGHT so this
 * module stays free of the renderer — the component passes the same constant
 * it already passes to `renderWaveform`.
 */
export function inMarkerLane(yPx, gutterHeight) {
  return yPx >= 0 && yPx <= gutterHeight
}
