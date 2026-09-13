/**
 * Pointer drag for the Modula controls.
 *
 * Relative, not absolute: the value is read at pointer-down and moved by the
 * distance travelled since, so grabbing a knob never jumps it to the cursor.
 * `len` is the pixel travel for the full 0..1 range. Listeners go on `window`
 * so a drag survives leaving the element, and `pointercancel` is handled so a
 * touch interrupted by the browser does not leave a drag armed.
 */
function track(e, onMove) {
  e.preventDefault()
  const up = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

/**
 * Continuous drag over a 0..1 fraction.
 *
 * @param {'x'|'y'} axis   'y' drags up to increase, 'x' drags right to increase
 * @param {number} len     pixels for the full range
 * @param {() => number} read      current fraction
 * @param {(f: number) => void} write
 * @param {() => boolean} [enabled]
 */
export function dragFraction(axis, len, read, write, enabled = () => true) {
  return (e) => {
    if (!enabled()) return
    const start = axis === 'y' ? e.clientY : e.clientX
    const base = read()
    track(e, (ev) => {
      const cur = axis === 'y' ? ev.clientY : ev.clientX
      const delta = (axis === 'y' ? start - cur : cur - start) / len
      write(Math.max(0, Math.min(1, base + delta)))
    })
  }
}

/**
 * Detented drag: one step per `stepPx` of vertical travel, over `count`
 * positions.
 */
export function dragSteps(stepPx, count, read, write, enabled = () => true) {
  return (e) => {
    if (!enabled()) return
    const startY = e.clientY
    const base = read()
    track(e, (ev) => {
      const idx = Math.round(base + (startY - ev.clientY) / stepPx)
      write(Math.max(0, Math.min(count - 1, idx)))
    })
  }
}

/** Snap `v` to `step` (0 = no snapping), without float dust. */
export function quantize(v, step) {
  if (!(step > 0)) return v
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)))
  return Number((Math.round(v / step) * step).toFixed(decimals))
}
