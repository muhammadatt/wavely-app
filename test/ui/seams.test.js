/**
 * Where the seams between segments land on screen.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seamPositions } from '../../src/audio/renderer.js'

/** A timeline cut into `starts.length` pieces at the given output times. */
const timeline = (...starts) => starts.map((outputStart, i) => ({
  id: `s${i}`,
  sourceBuffer: {},
  sourceStart: 0,
  sourceEnd: 1,
  outputStart,
}))

const VIEW = { scrollLeft: 0, pixelsPerSecond: 100, width: 1000 }
const at = (segments, v = VIEW) =>
  seamPositions(segments, v.scrollLeft, v.pixelsPerSecond, v.width)

test('an unsplit timeline has no seams', () => {
  // The one thing that must not happen: a seam drawn on every untouched file.
  assert.deepEqual(at(timeline(0)), [])
})

test('an empty or absent timeline has no seams', () => {
  assert.deepEqual(at([]), [])
  assert.deepEqual(at(undefined), [])
})

test('the cuts between segments are seams; the file edges are not', () => {
  // Three segments at 0 / 2 / 5 s means two cuts, at 2 s and 5 s. The start of
  // the first segment opens the file and is not a cut in it.
  assert.deepEqual(at(timeline(0, 2, 5)), [200, 500])
})

test('seams follow the scroll and the zoom', () => {
  const segs = timeline(0, 2, 5)
  assert.deepEqual(at(segs, { scrollLeft: 1, pixelsPerSecond: 100, width: 1000 }), [100, 400])
  assert.deepEqual(at(segs, { scrollLeft: 0, pixelsPerSecond: 50, width: 1000 }), [100, 250])
})

test('seams scrolled off either edge are dropped, not drawn at the margin', () => {
  // Scrolled past the first cut: 2 s is at −100 px and must not clamp to 0.
  const segs = timeline(0, 2, 5)
  assert.deepEqual(at(segs, { scrollLeft: 3, pixelsPerSecond: 100, width: 1000 }), [200])
  // Zoomed in far enough that both cuts are off the right edge.
  assert.deepEqual(at(segs, { scrollLeft: 0, pixelsPerSecond: 100, width: 150 }), [])
})

test('a seam exactly on either edge of the viewport still counts', () => {
  assert.deepEqual(at(timeline(0, 2), { scrollLeft: 2, pixelsPerSecond: 100, width: 1000 }), [0])
  assert.deepEqual(at(timeline(0, 2), { scrollLeft: 0, pixelsPerSecond: 100, width: 200 }), [200])
})

test('a zero zoom returns nothing rather than dividing by it', () => {
  assert.deepEqual(at(timeline(0, 2), { scrollLeft: 0, pixelsPerSecond: 0, width: 1000 }), [])
})

test('every cut in a densely split file gets a seam', () => {
  // Split at markers on a 40-chapter file: 40 cuts, 41 segments.
  const starts = Array.from({ length: 41 }, (_, i) => i)
  assert.equal(at(timeline(...starts), { scrollLeft: 0, pixelsPerSecond: 100, width: 5000 }).length, 40)
})
