/**
 * Plugin windows become full-screen sheets on a phone.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSheetViewport,
  sheetGeometry,
  SHEET_MIN_ZOOM,
} from '../../src/ui/windowSheet.js'

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

test('a desktop viewport keeps floating windows', () => {
  assert.equal(isSheetViewport({ viewportW: 1440, viewportH: 900, designW: 820 }), false)
})

test('a landscape phone, a portrait phone and a too-narrow window all get sheets', () => {
  assert.equal(isSheetViewport({ viewportW: 844, viewportH: 390, designW: 560 }), true)
  assert.equal(isSheetViewport({ viewportW: 390, viewportH: 844, designW: 560 }), true)
  assert.equal(isSheetViewport({ viewportW: 840, viewportH: 900, designW: 820 }), true)
})

test('a faceplate wider than the screen is zoomed to fit its width', () => {
  const g = sheetGeometry({ viewportW: 780, viewportH: 360, designW: 820 })
  close(g.zoom, 780 / 820)
  close(g.width * g.zoom, 780)
  close(g.height * g.zoom, 360)
  assert.ok(g.width >= 820)
})

test('a faceplate that fits is not enlarged, it gets the spare width', () => {
  const g = sheetGeometry({ viewportW: 844, viewportH: 390, designW: 560 })
  assert.equal(g.zoom, 1)
  assert.equal(g.width, 844)
  assert.equal(g.height, 390)
})

test('zoom has a floor', () => {
  const g = sheetGeometry({ viewportW: 320, viewportH: 640, designW: 1400 })
  assert.equal(g.zoom, SHEET_MIN_ZOOM)
})
