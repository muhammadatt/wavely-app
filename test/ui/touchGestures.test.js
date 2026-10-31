/**
 * Touch gestures on the waveform: pinch geometry and the touch constants.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pinchView,
  pinchSpan,
  pinchMidX,
  scrollForAnchor,
  MIN_PINCH_SPAN_PX,
  TOUCH_EDGE_GRAB_PX,
  TOUCH_DRAG_THRESHOLD_PX,
} from '../../src/audio/touchGestures.js'
import { SELECTION_EDGE_GRAB_PX, hitSelectionEdge } from '../../src/audio/selectionDrag.js'

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

test('spreading the fingers to twice the span doubles the zoom', () => {
  const v = pinchView({ startSpanPx: 100, startPps: 50, anchorTime: 10, spanPx: 200, midPx: 300 })
  close(v.pixelsPerSecond, 100)
})

test('the time under the starting midpoint stays under the midpoint', () => {
  // View at 4 s, 50 px/s: the midpoint at 300 px is 10 s.
  const anchorTime = 4 + 300 / 50
  const v = pinchView({ startSpanPx: 100, startPps: 50, anchorTime, spanPx: 250, midPx: 300 })
  close(v.scrollLeft + 300 / v.pixelsPerSecond, anchorTime)
})

test('moving both fingers together pans without zooming', () => {
  const anchorTime = 10
  const v = pinchView({ startSpanPx: 120, startPps: 50, anchorTime, spanPx: 120, midPx: 400 })
  close(v.pixelsPerSecond, 50)
  // The anchor followed the fingers 100 px to the right: 2 s less scroll.
  close(v.scrollLeft, scrollForAnchor(anchorTime, 300, 50) - 2)
})

test('a near-zero starting span cannot blow the zoom up', () => {
  const v = pinchView({ startSpanPx: 1, startPps: 50, anchorTime: 0, spanPx: MIN_PINCH_SPAN_PX * 2, midPx: 0 })
  close(v.pixelsPerSecond, 100)
})

test('span and midpoint', () => {
  close(pinchSpan({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)
  close(pinchMidX({ x: 100, y: 0 }, { x: 300, y: 50 }), 200)
})

test('a finger grabs an edge from further away than a mouse', () => {
  assert.ok(TOUCH_EDGE_GRAB_PX > SELECTION_EDGE_GRAB_PX)
  assert.ok(TOUCH_DRAG_THRESHOLD_PX > 4)
  const sel = { start: 2, end: 5 }
  const at = (xPx, grabPx) => hitSelectionEdge({ selection: sel, xPx, scrollLeft: 0, pixelsPerSecond: 100, grabPx })
  assert.equal(at(214, SELECTION_EDGE_GRAB_PX), null)
  assert.equal(at(214, TOUCH_EDGE_GRAB_PX), 'start')
})
