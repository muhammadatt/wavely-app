import test from 'node:test'
import assert from 'node:assert/strict'

import { stopIndexFromRatio } from '../../src/components/knobs/travelSlideGeometry.js'

/**
 * The travel slide's pointer mapping.
 *
 * The drag was added after the click-only version was reported as a slider that
 * would not slide, so what these guard is the inverse of the drawing: the thumb
 * is laid out at `left: i * 100/n %` and the labels are one flex child each, and
 * this has to land on the same stop the pointer is visibly over. Every failure
 * below still renders as a perfectly normal slider.
 *
 * ⚠ THE WIRING IS NOT TESTABLE HERE, and it is the half that fails silently —
 * this suite cannot mount a component (see `componentBindings.test.js` for why),
 * so a correct mapping that no handler ever calls passes everything below. The
 * drag was verified instead by driving real PointerEvents at the mounted
 * component in a browser: press, live update mid-gesture, release, no movement
 * after release, both clamps, label clicks still working, and `disabled`
 * ignoring the whole gesture.
 *
 * ⚠ AND A SYNCHRONOUS BURST OF DISPATCHED POINTERMOVES IS NOT A DRAG. That probe
 * reported a false failure — the left clamp "not working" — for a reason worth
 * knowing before anyone writes another one: emitting `update:modelValue` updates
 * the PARENT's ref synchronously, but the child's `props.modelValue` only
 * refreshes when it re-renders. Fire several moves in one task and `pick()`
 * compares each new stop against a stale prop, so it can skip an emit that was
 * genuinely needed. Real pointermoves arrive in separate tasks and Vue flushes
 * between them; the probe only had to await a tick between dispatches to agree.
 * The component was right and the harness was wrong.
 */

test('the pointer lands on the stop it is over', () => {
  // Four stops, so slot boundaries at .25 / .5 / .75.
  assert.equal(stopIndexFromRatio(0.10, 4), 0)
  assert.equal(stopIndexFromRatio(0.30, 4), 1)
  assert.equal(stopIndexFromRatio(0.60, 4), 2)
  assert.equal(stopIndexFromRatio(0.90, 4), 3)
})

test('each stop owns exactly its own slot, boundaries included', () => {
  // A boundary belongs to the slot it opens, so no ratio falls between stops
  // and no stop is one pixel wider than its neighbour.
  assert.equal(stopIndexFromRatio(0.2499, 4), 0)
  assert.equal(stopIndexFromRatio(0.25, 4), 1)
  assert.equal(stopIndexFromRatio(0.4999, 4), 1)
  assert.equal(stopIndexFromRatio(0.5, 4), 2)
})

test('both end stops are reachable, which is where off-by-one shows', () => {
  // The far ends are the whole risk: a `round()` instead of a `floor()` leaves
  // the last stop unreachable by pointer while every other stop still works.
  assert.equal(stopIndexFromRatio(0, 5), 0)
  assert.equal(stopIndexFromRatio(0.999, 5), 4)
  assert.equal(stopIndexFromRatio(1, 5), 4)
})

test('every stop is reachable at its own thumb centre', () => {
  // Stop i is drawn centred at (i + 0.5) / n. Pressing a thumb where it sits
  // must select the stop it is drawn for, at every count the panels use.
  for (const n of [2, 3, 4, 5]) {
    for (let i = 0; i < n; i++) {
      assert.equal(stopIndexFromRatio((i + 0.5) / n, n), i, `n=${n} i=${i}`)
    }
  }
})

test('a drag past either end clamps rather than wrapping', () => {
  // Pointer capture means the gesture continues off the track. Running off the
  // right edge means "the last one"; wrapping would jump the value the full
  // width of the control from one mouse movement.
  assert.equal(stopIndexFromRatio(-0.4, 4), 0)
  assert.equal(stopIndexFromRatio(-12, 4), 0)
  assert.equal(stopIndexFromRatio(1.4, 4), 3)
  assert.equal(stopIndexFromRatio(97, 4), 3)
})

test('a degenerate track cannot produce an out-of-range index', () => {
  // A zero-width track (a panel laid out but not yet visible) divides by zero
  // upstream, and an empty option list would index nothing.
  assert.equal(stopIndexFromRatio(NaN, 4), 0)
  assert.equal(stopIndexFromRatio(Infinity, 4), 0)
  assert.equal(stopIndexFromRatio(0.5, 0), 0)
  assert.equal(stopIndexFromRatio(0.5, NaN), 0)
})

test('a single stop absorbs the whole track', () => {
  assert.equal(stopIndexFromRatio(0, 1), 0)
  assert.equal(stopIndexFromRatio(0.5, 1), 0)
  assert.equal(stopIndexFromRatio(1, 1), 0)
})
