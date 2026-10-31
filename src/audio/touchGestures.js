/**
 * Touch gestures on the waveform: the numbers and geometry, kept out of the
 * component so they can be tested without a canvas or a touch screen.
 *
 * A finger is not a mouse. It is ~40 px wide, it jitters several pixels while
 * held still, it has no hover and no right button, and two of them at once are
 * a gesture of their own. So the touch path differs from the mouse path in
 * four ways, all decided here:
 *
 *  - a wider edge grab and a wider tap-vs-drag threshold;
 *  - a long press opens the edit menu (the mouse's right-click);
 *  - two fingers pinch to zoom, and moving them together pans;
 *  - nothing happens on touch DOWN. The mouse path seeks and clears the
 *    selection the instant the button goes down, which on a phone would throw
 *    the selection away every time a second finger arrived to pinch, or a long
 *    press was meant to open the menu that acts on it. A touch only commits once
 *    it is read as a tap (on lift), a drag (past the threshold) or a long press.
 */

/** Edge hit radius for a finger, px either side. The mouse's is 6. */
export const TOUCH_EDGE_GRAB_PX = 18

/** How far a finger must travel before a touch is a drag, not a tap. The mouse's is 4. */
export const TOUCH_DRAG_THRESHOLD_PX = 10

/** Hold time that turns a still touch into a long press (the edit menu). */
export const LONG_PRESS_MS = 500

/**
 * Floor on a pinch's starting finger spread. Two fingers landing almost on top
 * of each other would make the ratio explode on the first move.
 */
export const MIN_PINCH_SPAN_PX = 24

/** Distance between two points `{x, y}`. */
export function pinchSpan(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Horizontal midpoint between two points `{x, y}`. */
export function pinchMidX(a, b) {
  return (a.x + b.x) / 2
}

/**
 * The view a pinch asks for. The time that was under the fingers' midpoint
 * when the pinch started stays under their midpoint now, so spreading the
 * fingers magnifies what they are on and moving them together pans.
 *
 * Unclamped: the caller runs the zoom through its own bounds first and then
 * re-solves the scroll against the zoom it actually got (use `scrollForAnchor`).
 *
 * @param {Object} opts
 * @param {number} opts.startSpanPx - finger spread when the pinch began
 * @param {number} opts.startPps - pixels per second when the pinch began
 * @param {number} opts.anchorTime - timeline seconds under the starting midpoint
 * @param {number} opts.spanPx - finger spread now
 * @param {number} opts.midPx - midpoint now, px from the canvas's left edge
 * @returns {{ pixelsPerSecond: number, scrollLeft: number }}
 */
export function pinchView({ startSpanPx, startPps, anchorTime, spanPx, midPx }) {
  const from = Math.max(MIN_PINCH_SPAN_PX, startSpanPx)
  const to = Math.max(MIN_PINCH_SPAN_PX, spanPx)
  const pixelsPerSecond = startPps * (to / from)
  return { pixelsPerSecond, scrollLeft: scrollForAnchor(anchorTime, midPx, pixelsPerSecond) }
}

/** The scroll that puts `anchorTime` at `anchorPx` at zoom `pps`. */
export function scrollForAnchor(anchorTime, anchorPx, pps) {
  return anchorTime - anchorPx / pps
}
