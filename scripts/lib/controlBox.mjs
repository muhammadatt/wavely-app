/**
 * Where a control VISIBLY sits: the union of the element carrying
 * `data-help` and every descendant that can actually be seen. Run in the
 * browser (`locator.evaluate(measureControlBox)`), so it is self-contained.
 *
 * A lamp or label positioned outside its wrapper's box still belongs in the
 * crop, which is why it is a union. But a plain union also took in what the
 * page never shows: a layer clipped away by an `overflow: hidden` ancestor
 * (the LA Vintage 2A VU meter's lamp glow reaches 14 % past each side of the
 * bezel and 52 px above it, inside a window that clips it — the hotspot came
 * out 349 × 223 for a 292 × 172 meter), and fully transparent elements. Each
 * descendant's rect is therefore clipped by every clipping ancestor up to and
 * including the control, and skipped when it or an ancestor is invisible.
 *
 * And only elements that PAINT count: a wrapper that only lays its children
 * out adds nothing of its own. LA Vintage 2A's HF Emph knob sits in an 80 × 80
 * layout box around a 56 px knob, so the box (and the tour's outline) read
 * well wider and taller than anything on screen.
 *
 * Returns `{ x, y, width, height }` in viewport CSS pixels, or null.
 */
export function measureControlBox(node) {
  const CLIPS = new Set(['hidden', 'clip', 'scroll', 'auto'])
  const REPLACED = new Set(['IMG', 'SVG', 'svg', 'CANVAS', 'VIDEO', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'])
  const transparent = c => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c)
  function paints(n, cs) {
    if (REPLACED.has(n.tagName) || n instanceof SVGElement) return true
    if (!transparent(cs.backgroundColor) || cs.backgroundImage !== 'none') return true
    if (cs.boxShadow !== 'none') return true
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none' && !transparent(cs[`border${side}Color`])) return true
    }
    for (const t of n.childNodes) if (t.nodeType === 3 && t.textContent.trim()) return true
    return false
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const n of [node, ...node.querySelectorAll('*')]) {
    const r = n.getBoundingClientRect()
    if (r.width < 1 || r.height < 1 || !paints(n, getComputedStyle(n))) continue
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom
    let seen = true
    for (let p = n; p; p = p === node ? null : p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) { seen = false; break }
      if (p !== n && (CLIPS.has(cs.overflowX) || CLIPS.has(cs.overflowY))) {
        const pr = p.getBoundingClientRect()
        if (CLIPS.has(cs.overflowX)) { left = Math.max(left, pr.left); right = Math.min(right, pr.right) }
        if (CLIPS.has(cs.overflowY)) { top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom) }
      }
    }
    if (!seen || right - left < 1 || bottom - top < 1) continue
    x0 = Math.min(x0, left); y0 = Math.min(y0, top)
    x1 = Math.max(x1, right); y1 = Math.max(y1, bottom)
  }
  return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
