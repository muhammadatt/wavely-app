/**
 * Pointer positions in layout pixels, under a scaled (zoomed) element.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toLayoutPoint } from '../../src/ui/pointerLocal.js'

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

test('unscaled: the offset into the rectangle, unchanged', () => {
  const p = toLayoutPoint(150, 80, { left: 100, top: 50, width: 400, height: 200 }, 400, 200)
  close(p.x, 50); close(p.y, 30); close(p.sx, 1)
})

test('zoomed faceplate: a point on screen maps back to the layout pixel under it', () => {
  // The EQ plot on an iPhone 16 sheet: 636 layout px drawn 376.4 px wide.
  const zoom = 376.4375 / 636
  const rect = { left: 8, top: 120, width: 636 * zoom, height: 200 * zoom }
  // A finger 75 % of the way across, on screen.
  const p = toLayoutPoint(rect.left + rect.width * 0.75, rect.top + rect.height * 0.25, rect, 636, 200)
  close(p.x, 636 * 0.75, 1e-6)
  close(p.y, 200 * 0.25, 1e-6)
})

test('no layout size or no rectangle falls back to unscaled', () => {
  const p = toLayoutPoint(10, 10, { left: 0, top: 0, width: 0, height: 0 }, 0, 0)
  assert.equal(p.sx, 1); assert.equal(p.sy, 1)
  close(p.x, 10); close(p.y, 10)
})
