/**
 * The marker model: ordering, near-duplicate collapse, the spans a marker set
 * defines, and how markers follow a timeline edit.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MARKER_EPSILON,
  createMarker,
  normalizeMarkers,
  addMarker,
  removeMarker,
  moveMarker,
  renameMarker,
  setMarkerKind,
  markerSpans,
  markersAfterDelete,
  markersAfterTrimTo,
  markersAfterInsert,
  clampMarkers,
} from '../../src/audio/markers.js'

/** Markers with predictable ids, so assertions can name them. */
const at = (time, id = `m${time}`, extra = {}) => ({
  id,
  time,
  name: '',
  kind: 'user',
  ...extra,
})

const times = markers => markers.map(m => m.time)
const ids = markers => markers.map(m => m.id)

// ── Ordering and collapse ────────────────────────────────────────────────────

test('markers come back in time order however they went in', () => {
  assert.deepEqual(times(normalizeMarkers([at(5), at(1), at(3)])), [1, 3, 5])
})

test('markers closer than MARKER_EPSILON collapse to one', () => {
  const pair = [at(2, 'first'), at(2 + MARKER_EPSILON / 2, 'second')]
  const out = normalizeMarkers(pair)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'first', 'the earlier marker survives by default')
})

test('markers a comfortable distance apart both survive', () => {
  const pair = [at(2), at(2 + MARKER_EPSILON * 10)]
  assert.equal(normalizeMarkers(pair).length, 2)
})

test('preferId decides which of a colliding pair survives', () => {
  // This is what makes dragging a marker onto its neighbour remove the
  // neighbour rather than the marker under the pointer.
  const pair = [at(2, 'sitting'), at(2 + MARKER_EPSILON / 2, 'dragged')]
  assert.equal(normalizeMarkers(pair, 'dragged')[0].id, 'dragged')
})

test('createMarker defaults to an unnamed user marker with a unique id', () => {
  const a = createMarker(1)
  const b = createMarker(1)
  assert.equal(a.name, '')
  assert.equal(a.kind, 'user')
  assert.notEqual(a.id, b.id)
})

// ── The small editors ────────────────────────────────────────────────────────

test('add, remove, rename and re-kind leave the input array untouched', () => {
  const original = [at(1), at(3)]
  const frozen = [...original]

  addMarker(original, at(2))
  removeMarker(original, 'm1')
  renameMarker(original, 'm1', 'Chapter 1')
  setMarkerKind(original, 'm1', 'gap')
  moveMarker(original, 'm1', 9)

  assert.deepEqual(original, frozen, 'every operation is pure')
})

test('addMarker inserts in order', () => {
  assert.deepEqual(times(addMarker([at(1), at(5)], at(3))), [1, 3, 5])
})

test('addMarker on top of an existing marker does not create a second one', () => {
  const out = addMarker([at(3, 'existing')], at(3 + MARKER_EPSILON / 4, 'new'))
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'existing')
})

test('moveMarker re-sorts, and cannot push a marker below zero', () => {
  assert.deepEqual(times(moveMarker([at(1), at(5)], 'm1', 9)), [5, 9])
  assert.deepEqual(times(moveMarker([at(1)], 'm1', -4)), [0])
})

test('setMarkerKind ignores a kind that is not a kind', () => {
  const out = setMarkerKind([at(1)], 'm1', 'nonsense')
  assert.equal(out[0].kind, 'user')
})

// ── Spans ────────────────────────────────────────────────────────────────────

test('no markers means one span covering the whole timeline', () => {
  assert.deepEqual(
    markerSpans([], 10).map(s => [s.start, s.end]),
    [[0, 10]]
  )
})

test('two markers cut the timeline into three spans, head and tail included', () => {
  const spans = markerSpans([at(3), at(7)], 10)
  assert.deepEqual(
    spans.map(s => [s.start, s.end]),
    [[0, 3], [3, 7], [7, 10]]
  )
})

test('a span takes the name and kind of the marker that opens it', () => {
  const spans = markerSpans(
    [at(3, 'a', { name: 'Two', kind: 'gap' }), at(7, 'b', { name: 'Three' })],
    10
  )
  assert.deepEqual(spans.map(s => s.name), ['', 'Two', 'Three'])
  assert.deepEqual(spans.map(s => s.kind), ['user', 'gap', 'user'])
})

test('markers on the very ends define no span', () => {
  // Legal positions — they can be dragged back inside — but a zero-length
  // slice would export as an empty file and split into an empty segment.
  const spans = markerSpans([at(0), at(10)], 10)
  assert.deepEqual(spans.map(s => [s.start, s.end]), [[0, 10]])
})

test('spans are indexed in order', () => {
  assert.deepEqual(markerSpans([at(3), at(7)], 10).map(s => s.index), [0, 1, 2])
})

test('an empty timeline has no spans', () => {
  assert.deepEqual(markerSpans([at(3)], 0), [])
})

// ── Edit-following ───────────────────────────────────────────────────────────

test('a cut before a marker pulls it earlier by the length removed', () => {
  // Delete [1,3) — 2 s gone — from markers at 5 and 8.
  assert.deepEqual(times(markersAfterDelete([at(5), at(8)], 1, 3)), [3, 6])
})

test('a cut after a marker leaves it alone', () => {
  assert.deepEqual(times(markersAfterDelete([at(1)], 5, 7)), [1])
})

test('a marker inside a cut goes with the audio it marked', () => {
  const out = markersAfterDelete([at(2, 'before'), at(6, 'inside'), at(9, 'after')], 5, 7)
  assert.deepEqual(ids(out), ['before', 'after'])
  assert.deepEqual(times(out), [2, 7])
})

test('the two edges of a cut become one marker', () => {
  // Markers sitting on both ends of the removed span land on the same point.
  const out = markersAfterDelete([at(5, 'start'), at(7, 'end')], 5, 7)
  assert.equal(out.length, 1)
  assert.equal(out[0].time, 5)
})

test('a zero-width or inverted cut changes nothing', () => {
  const m = [at(4)]
  assert.deepEqual(times(markersAfterDelete(m, 2, 2)), [4])
  assert.deepEqual(times(markersAfterDelete(m, 6, 2)), [4])
})

test('trimming to a selection keeps the markers inside it and rebases to zero', () => {
  const out = markersAfterTrimTo([at(1), at(4), at(6), at(12)], 3, 8)
  assert.deepEqual(times(out), [1, 3])
})

test('an insert pushes everything at or after it later', () => {
  // Paste 2 s at t=4, with a marker sitting exactly on the paste point.
  assert.deepEqual(times(markersAfterInsert([at(1), at(4), at(9)], 4, 2)), [1, 6, 11])
})

test('an insert of nothing changes nothing', () => {
  assert.deepEqual(times(markersAfterInsert([at(4)], 2, 0)), [4])
})

test('clampMarkers drops what has fallen off the end', () => {
  assert.deepEqual(times(clampMarkers([at(-1), at(2), at(12)], 10)), [2])
})
