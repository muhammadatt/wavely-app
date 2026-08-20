/**
 * Grabbing and dragging the edges of an existing waveform selection.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hitSelectionEdge,
  selectionDragAnchor,
  SELECTION_EDGE_GRAB_PX,
} from '../../src/audio/selectionDrag.js'

// A selection from 2 s to 5 s at 100 px/s with the view at the start of the
// file puts its edges at 200 px and 500 px.
const SEL = { start: 2, end: 5 }
const VIEW = { scrollLeft: 0, pixelsPerSecond: 100 }

const hit = (xPx, opts = {}) =>
  hitSelectionEdge({ selection: SEL, xPx, ...VIEW, ...opts })

test('the edges are grabbable and the middle of the selection is not', () => {
  assert.equal(hit(200), 'start')
  assert.equal(hit(500), 'end')
  // Dead centre — a click here starts a fresh selection, as it always did.
  assert.equal(hit(350), null)
})

test('the hit target is symmetric and wider than the drawn line', () => {
  for (const [edge, px] of [['start', 200], ['end', 500]]) {
    assert.equal(hit(px - SELECTION_EDGE_GRAB_PX), edge)
    assert.equal(hit(px + SELECTION_EDGE_GRAB_PX), edge)
    assert.equal(hit(px - SELECTION_EDGE_GRAB_PX - 1), null)
    assert.equal(hit(px + SELECTION_EDGE_GRAB_PX + 1), null)
  }
  // The graphic is 1.5 px; a hit target that narrow is one that misses.
  assert.ok(SELECTION_EDGE_GRAB_PX > 1.5)
})

test('with no selection there is no edge to grab', () => {
  assert.equal(hitSelectionEdge({ selection: null, xPx: 200, ...VIEW }), null)
})

test('the hit test follows the view rather than the timeline', () => {
  // Scrolled 2 s in, the selection's start sits at the left edge of the canvas.
  assert.equal(hit(0, { scrollLeft: 2 }), 'start')
  assert.equal(hit(200, { scrollLeft: 2 }), null)
  // Zoomed out to 10 px/s the whole 3 s selection spans 30 px, so the edges
  // move to 20 and 50.
  assert.equal(hit(20, { pixelsPerSecond: 10 }), 'start')
  assert.equal(hit(50, { pixelsPerSecond: 10 }), 'end')
})

test('when both edges are in range the nearer one wins', () => {
  // Zoomed far enough out that a 3 s selection is 6 px wide: both edges are
  // inside the hit radius of every point on it.
  const near = { selection: SEL, pixelsPerSecond: 2, scrollLeft: 0 }
  assert.equal(hitSelectionEdge({ ...near, xPx: 4 }), 'start')   // edges at 4 and 10
  assert.equal(hitSelectionEdge({ ...near, xPx: 10 }), 'end')
  // Exactly between them, the end takes it, so dragging away from a hairline
  // selection extends it forward rather than turning it inside out.
  assert.equal(hitSelectionEdge({ ...near, xPx: 7 }), 'end')
})

test('the anchor is the edge that is not being dragged', () => {
  assert.equal(selectionDragAnchor(SEL, 'start'), 5)
  assert.equal(selectionDragAnchor(SEL, 'end'), 2)
})

test('dragging one edge past the other keeps a forward selection', () => {
  // The component hands the anchor and the pointer time to setSelection, which
  // normalises the pair — this is the arithmetic that makes crossing safe.
  const anchor = selectionDragAnchor(SEL, 'end')   // 2 s
  const pointer = 0.5                              // dragged left, past the start
  assert.deepEqual(
    { start: Math.min(anchor, pointer), end: Math.max(anchor, pointer) },
    { start: 0.5, end: 2 }
  )
})
