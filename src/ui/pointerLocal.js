/**
 * A pointer position in an element's own LAYOUT pixels.
 *
 * `getBoundingClientRect()` and `clientX` are in screen (visual) pixels; an
 * element's `offsetWidth`, its canvas drawing and every constant a control is
 * laid out with (a 32 px handle, a 10 px pad) are in layout pixels. The two
 * agree only while nothing scales the element — and on a phone the plugin
 * faceplate is scaled with CSS `zoom` to fit the screen (FloatingWindow's
 * sheet, `ui/windowSheet.js`). Mixing them there put a new EQ band 117 px from
 * the finger at zoom 0.59. The window's open animation (a transform) scales
 * it too, briefly.
 *
 * So: offset into the rectangle in screen pixels, then scaled by the
 * element's layout size over its on-screen size. A ratio of two numbers in the
 * same units needs none of this (`(x - r.left) / r.width` is already right).
 */

/**
 * Pure form, for tests and for callers that already hold the numbers.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @param {{left: number, top: number, width: number, height: number}} rect - on screen
 * @param {number} layoutW - the element's layout width (offsetWidth)
 * @param {number} layoutH - the element's layout height (offsetHeight)
 * @returns {{x: number, y: number, sx: number, sy: number}} sx/sy: layout px per screen px
 */
export function toLayoutPoint(clientX, clientY, rect, layoutW, layoutH) {
  // No layout size (an SVG child, a detached node) or no rectangle: assume
  // unscaled rather than divide by zero.
  const sx = rect.width > 0 && layoutW > 0 ? layoutW / rect.width : 1
  const sy = rect.height > 0 && layoutH > 0 ? layoutH / rect.height : 1
  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy, sx, sy }
}

/**
 * `e`'s position relative to `el`, in `el`'s layout pixels.
 *
 * @param {{clientX: number, clientY: number}} e
 * @param {Element} el
 * @param {DOMRect} [rect] - pass it when the caller already measured
 */
export function localPoint(e, el, rect = el.getBoundingClientRect()) {
  return toLayoutPoint(e.clientX, e.clientY, rect, el.offsetWidth ?? 0, el.offsetHeight ?? 0)
}

/** Layout pixels per screen pixel along x, for turning a drag delta into layout pixels. */
export function layoutScaleX(el, rect = el.getBoundingClientRect()) {
  const w = el.offsetWidth ?? 0
  return rect.width > 0 && w > 0 ? w / rect.width : 1
}
