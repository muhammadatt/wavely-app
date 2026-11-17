/**
 * Geometry and keyboard rules for the tour (`PanelTour.vue`), kept out of the
 * component so they can be tested without a DOM.
 *
 * Boxes are `{ x, y, w, h }` in the screenshot's CSS pixels (`at` in the
 * manifest).
 */

/** Whether box `a` holds box `b` entirely (Gain's box holds the AUTO lamp). */
export function contains(a, b) {
  return a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h
}

/**
 * Stacking: smaller boxes sit ABOVE larger ones, so a nested control can
 * always be reached. Returns a z-index per spot (1 = bottom).
 */
export function stackOrder(boxes) {
  const order = boxes.map((b, i) => [b.w * b.h, i]).sort((p, q) => q[0] - p[0])
  const z = new Array(boxes.length)
  order.forEach(([, i], rank) => { z[i] = rank + 1 })
  return z
}

/**
 * Where a box's number goes: inside a large box's corner, beside a short one
 * (it would cover a lamp or a switch), or inside on the left when the short
 * box starts at the image's edge and there is no room outside.
 */
export const SHORT_BOX_PX = 48
export const SIDE_ROOM_PX = 26
export function badgePlace(box) {
  if (box.h >= SHORT_BOX_PX) return 'corner'
  return box.x >= SIDE_ROOM_PX ? 'side' : 'inside'
}

/**
 * The area that answers the pointer for each box: the box itself, grown to at
 * least `minSize` (image pixels) in each direction, centred on it.
 *
 * A lamp is 19 px tall on a desktop screenshot and 9 px on a phone, which no
 * one hits reliably. Growing it must not take a neighbour's control away, so
 * each side grows at most HALF the gap to the nearest box beside it (and not
 * at all into a box it overlaps). A box nested in another (AUTO in Gain)
 * ignores its parent: the stacking already puts it on top. The result is
 * clamped to the image.
 */
export function hitBoxes(boxes, size, minSize) {
  return boxes.map((s, i) => {
    const ex = Math.max(0, minSize - s.w) / 2
    const ey = Math.max(0, minSize - s.h) / 2
    let left = ex, right = ex, top = ey, bottom = ey
    boxes.forEach((o, j) => {
      if (j === i || contains(o, s) || contains(s, o)) return
      const vOverlap = o.y < s.y + s.h + ey && o.y + o.h > s.y - ey
      const hOverlap = o.x < s.x + s.w + ex && o.x + o.w > s.x - ex
      if (vOverlap) {
        if (o.x + o.w <= s.x) left = Math.min(left, (s.x - (o.x + o.w)) / 2)
        else if (o.x >= s.x + s.w) right = Math.min(right, (o.x - (s.x + s.w)) / 2)
      }
      if (hOverlap) {
        if (o.y + o.h <= s.y) top = Math.min(top, (s.y - (o.y + o.h)) / 2)
        else if (o.y >= s.y + s.h) bottom = Math.min(bottom, (o.y - (s.y + s.h)) / 2)
      }
    })
    const x0 = Math.max(0, s.x - left), y0 = Math.max(0, s.y - top)
    const x1 = Math.min(size.w, s.x + s.w + right), y1 = Math.min(size.h, s.y + s.h + bottom)
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  })
}

/**
 * Arrow keys through the numbered controls: ← ↑ back, → ↓ on (wrapping),
 * Home / End to the ends. Returns the new index, or null for any other key.
 */
export function stepIndex(key, i, n) {
  if (!n) return null
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return (i + 1) % n
    case 'ArrowLeft': case 'ArrowUp': return (i - 1 + n) % n
    case 'Home': return 0
    case 'End': return n - 1
    default: return null
  }
}
