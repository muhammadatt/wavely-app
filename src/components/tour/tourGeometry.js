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
 * Where each box's number goes: `[{ x, y }]`, the badge's top-left in image
 * pixels, for a badge `size` image pixels square with `gap` between it and its
 * box.
 *
 * The first rule — inside a large box's top-left corner, just outside the left
 * edge of a short one — looked at no neighbours. Rolled out to every help page
 * (November 2026) it covered what it pointed at: the first letters of
 * VoxPressor's "PEAK REDUCTION" and "BODY LEVELER" titles, the EQ's meter
 * readouts, the De-Esser's LIVE switch, and three side badges on the EQ band's
 * ON / S / × chips piled onto their neighbours. So each badge tries places in
 * turn — beside its box on the left (by the top of a tall box, centred beside a
 * short one), on its top-left corner, then (by kind, see below) inside, above,
 * below or right — and takes the first that stays on the image and clear of
 * every other control's box and every badge already placed. A box's
 * own parent (Gain round its AUTO lamp) does not count as in the way.
 */
export const SHORT_BOX_PX = 48
export function placeBadges(boxes, image, size, gap = 2) {
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  const placed = []
  return boxes.map((s, i) => {
    const short = s.h < SHORT_BOX_PX
    const midY = s.y + (s.h - size) / 2
    const besideY = short ? midY : s.y
    const left = { x: s.x - gap - size, y: besideY }
    const corner = { x: s.x - size / 2, y: s.y - size / 2 }
    const inside = { x: s.x + 3, y: short ? midY : s.y + 3 }
    const above = { x: s.x, y: s.y - gap - size }
    const below = { x: s.x, y: s.y + s.h + gap }
    const right = { x: s.x + s.w + gap, y: besideY }
    // A tall box (a knob in its frame, a meter) has empty space in its top-left
    // corner, so it uses that before going ABOVE, where panel titles sit
    // (VoxPressor's DE-ESS over its two knobs). A short box — a chip, a switch,
    // a one-line setter — is covered by a badge inside it, so it goes above or
    // below its left edge and only falls back inside.
    const candidates = short
      ? [left, corner, above, below, right, inside]
      : [left, corner, inside, above, right, below]
    const others = boxes.filter((o, j) => j !== i && !contains(o, s))
    const pad = gap / 2
    const free = (c) => {
      const r = { x: c.x - pad, y: c.y - pad, w: size + 2 * pad, h: size + 2 * pad }
      if (c.x < 0 || c.y < 0 || c.x + size > image.w || c.y + size > image.h) return false
      return !others.some(o => overlaps(r, o)) && !placed.some(p => overlaps(r, p))
    }
    const c = candidates.find(free) ?? candidates[candidates.length - 1]
    placed.push({ x: c.x, y: c.y, w: size, h: size })
    return { x: c.x, y: c.y }
  })
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
