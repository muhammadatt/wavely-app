/**
 * The clip-mark registry.
 *
 * Everything here is about not lying to the user about where a stage fired.
 * A mark is an annotation on the timeline, so the failure modes are stale
 * marks (from settings that no longer apply, or from another file) and
 * duplicated ones (from replaying a passage), and both are invisible on
 * screen — a wrong mark looks exactly like a right one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordClipMark, getClipMarks, getClipMarksVersion, clearClipMarks, setClipMarksScope,
} from '../../src/audio/clipMarks.js'

// Module singleton: every test starts from a known empty state, and from a
// scope that the test's own setClipMarksScope calls cannot collide with.
function reset() {
  setClipMarksScope('test-reset')
  clearClipMarks()
}

test('marks come back in time order regardless of arrival order', () => {
  reset()
  recordClipMark(2.0, 1)
  recordClipMark(0.5, 1)
  recordClipMark(1.25, 1)
  assert.deepEqual(getClipMarks().map(m => m.t), [0.5, 1.25, 2.0])
})

test('replaying a passage sharpens marks instead of duplicating them', () => {
  reset()
  // Two passes over the same event. The clock will not land on the same
  // microsecond twice, which is the whole reason the grid exists.
  recordClipMark(1.0000, 2.0)
  recordClipMark(1.0004, 3.5)
  recordClipMark(1.0009, 1.0)
  const marks = getClipMarks()
  assert.equal(marks.length, 1, `expected one mark, got ${marks.length}`)
  assert.equal(marks[0].db, 3.5, 'the loudest reading for a slot must win')
})

test('events far enough apart stay separate', () => {
  reset()
  // 5 ms grid: 20 ms apart is four slots and must not merge, or a run of
  // plosives would collapse into one mark.
  recordClipMark(1.00, 1)
  recordClipMark(1.02, 1)
  assert.equal(getClipMarks().length, 2)
})

test('nothing that is not a real event is recorded', () => {
  reset()
  recordClipMark(-0.5, 3)       // message arrived after the transport rewound
  recordClipMark(NaN, 3)        // transport origin was null
  recordClipMark(Infinity, 3)
  recordClipMark(1.0, 0)        // block did not clip
  recordClipMark(1.0, -1)
  assert.equal(getClipMarks().length, 0)
})

test('the version token moves on every change and only on a change', () => {
  reset()
  const v0 = getClipMarksVersion()
  recordClipMark(1.0, 2)
  const v1 = getClipMarksVersion()
  assert.notEqual(v1, v0)

  // A quieter reading in an occupied slot changes nothing, so it must not
  // invalidate the reader's cache — the overlay repaints on every playhead
  // tick and this token is what stops it rebuilding the list each time.
  recordClipMark(1.001, 1)
  assert.equal(getClipMarksVersion(), v1)

  clearClipMarks()
  assert.notEqual(getClipMarksVersion(), v1)
  // Clearing an already-empty map is not a change either.
  const v2 = getClipMarksVersion()
  clearClipMarks()
  assert.equal(getClipMarksVersion(), v2)
})

test('switching scope drops marks from the file that is no longer on screen', () => {
  reset()
  setClipMarksScope('doc-a')
  recordClipMark(1.0, 2)
  assert.equal(getClipMarks().length, 1)

  setClipMarksScope('doc-b')
  assert.equal(getClipMarks().length, 0, 'marks survived a document switch')

  // ...and re-asserting the same scope must NOT clear, or the overlay would
  // wipe the map on every single repaint, which is where this is called from.
  recordClipMark(2.0, 2)
  setClipMarksScope('doc-b')
  setClipMarksScope('doc-b')
  assert.equal(getClipMarks().length, 1)
})

test('a pathological setting cannot grow the map without bound', () => {
  reset()
  // Far more events than the cap, at distinct times so none of them dedupe.
  for (let i = 0; i < 6000; i++) recordClipMark(i * 0.01, 1)
  const n = getClipMarks().length
  assert.ok(n > 0 && n <= 4000, `mark count ${n} is outside the documented cap`)
})
