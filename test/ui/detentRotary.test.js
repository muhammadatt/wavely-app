import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detentIndexFromDrag, DETENT_DRAG_PX, DETENT_DRAG_THRESHOLD_PX,
} from '../../src/components/knobs/detentRotaryGeometry.js'

/**
 * The detent rotary's turn.
 *
 * ⚠ THE BUG THAT PROMPTED THIS WAS NOT IN THE MATHS — the detent buttons had no
 * `@click` at all, so clicking a position did nothing while the dial still
 * looked and screenshotted perfectly. Nothing here would have caught that, and
 * nothing here can: see `travelSlide.test.js` for why this suite cannot mount a
 * component, and the same in-browser pointer probe was used to verify that the
 * turn, the detent clicks and the cap advance are all actually wired.
 *
 * What these guard is the feel: a turn that drifts, cannot reach its end stops,
 * or is not reversible reads as a broken knob rather than as a wrong number.
 */

const N = 5 // the ratio switch this was designed against

test('an upward drag turns the dial up, a downward drag down', () => {
  // deltaY is startY - currentY, so up is positive — the direction every other
  // knob in the app already sweeps.
  assert.equal(detentIndexFromDrag(2, DETENT_DRAG_PX, N), 3)
  assert.equal(detentIndexFromDrag(2, -DETENT_DRAG_PX, N), 1)
})

test('one detent costs one DETENT_DRAG_PX of travel', () => {
  assert.equal(detentIndexFromDrag(0, 0, N), 0)
  assert.equal(detentIndexFromDrag(0, DETENT_DRAG_PX, N), 1)
  assert.equal(detentIndexFromDrag(0, DETENT_DRAG_PX * 2, N), 2)
  assert.equal(detentIndexFromDrag(0, DETENT_DRAG_PX * 4, N), 4)
})

test('it snaps to the nearest detent, not the one just passed', () => {
  // Just over half a detent of travel has arrived at the next one.
  assert.equal(detentIndexFromDrag(0, DETENT_DRAG_PX * 0.49, N), 0)
  assert.equal(detentIndexFromDrag(0, DETENT_DRAG_PX * 0.51, N), 1)
})

test('a turn is reversible — returning the pointer returns the dial', () => {
  // The property that fails when per-move deltas are accumulated instead of
  // being measured from the anchor: each step rounds, the error does not
  // cancel, and coming back leaves the dial somewhere else.
  const start = 2
  for (const d of [7, 19, -23, 41, -55, 3]) {
    assert.equal(detentIndexFromDrag(start, d, N), detentIndexFromDrag(start, d, N))
  }
  assert.equal(detentIndexFromDrag(start, 0, N), start)
  assert.equal(detentIndexFromDrag(start, DETENT_DRAG_PX * 2 - DETENT_DRAG_PX * 2, N), start)
})

test('both end stops are reachable and the turn clamps there', () => {
  // Dragging further than the dial has travel must sit on the end, not wrap —
  // a wrap would take the loudest ratio to the gentlest in one flick.
  assert.equal(detentIndexFromDrag(4, DETENT_DRAG_PX * 10, N), 4)
  assert.equal(detentIndexFromDrag(0, -DETENT_DRAG_PX * 10, N), 0)
  assert.equal(detentIndexFromDrag(2, DETENT_DRAG_PX * 99, N), 4)
  assert.equal(detentIndexFromDrag(2, -DETENT_DRAG_PX * 99, N), 0)
})

test('the drag threshold is small enough to turn and large enough to click', () => {
  // Under the threshold the component does not turn at all, so the cap stays
  // clickable; at the threshold a turn is still under half a detent, so the
  // gesture that starts a turn does not itself change the value.
  assert.ok(DETENT_DRAG_THRESHOLD_PX > 0)
  assert.ok(DETENT_DRAG_THRESHOLD_PX < DETENT_DRAG_PX / 2)
  assert.equal(detentIndexFromDrag(1, DETENT_DRAG_THRESHOLD_PX, N), 1)
})

test('a start index outside the dial is pulled onto it BEFORE the turn', () => {
  assert.equal(detentIndexFromDrag(-3, 0, N), 0)
  assert.equal(detentIndexFromDrag(99, 0, N), 4)
  // ⚠ THE ORDER IS WHAT MATTERS, and a zero-delta case cannot see it: the clamp
  // on the way out makes both orders agree at rest. Turn one detent down from an
  // out-of-range start and they part company — clamping first gives 4 - 1, and
  // clamping only at the end gives 99 - 1 flattened back to the top stop.
  assert.equal(detentIndexFromDrag(99, -DETENT_DRAG_PX, N), 3)
  assert.equal(detentIndexFromDrag(-99, DETENT_DRAG_PX, N), 1)
})

test('a degenerate dial cannot produce an out-of-range index', () => {
  assert.equal(detentIndexFromDrag(0, 10, 0), 0)
  assert.equal(detentIndexFromDrag(0, 10, NaN), 0)
  assert.equal(detentIndexFromDrag(2, NaN, N), 2)
  assert.equal(detentIndexFromDrag(2, 10, N, 0), 2)
  assert.equal(detentIndexFromDrag(2, 10, N, -5), 2)
})

test('a single position absorbs any turn', () => {
  assert.equal(detentIndexFromDrag(0, 500, 1), 0)
  assert.equal(detentIndexFromDrag(0, -500, 1), 0)
})
