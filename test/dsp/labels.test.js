/**
 * Audacity label files in and out.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatAudacityLabels,
  parseAudacityLabels,
  toLabelFileName,
} from '../../src/audio/labels.js'
import { createMarker } from '../../src/audio/markers.js'

const rows = text => text.trimEnd().split('\n').map(l => l.split('\t'))
const times = markers => markers.map(m => m.time)

// ── Export ───────────────────────────────────────────────────────────────────

test('a file with no markers exports as one row covering the whole thing', () => {
  const out = rows(formatAudacityLabels([], 10))
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].slice(0, 2), ['0.000000', '10.000000'])
})

test('two markers export as three labelled spans', () => {
  const markers = [
    createMarker(3, { name: 'Two' }),
    createMarker(7, { name: 'Three' }),
  ]
  const out = rows(formatAudacityLabels(markers, 10))
  assert.deepEqual(out.map(r => [r[0], r[1], r[2]]), [
    ['0.000000', '3.000000', ''],
    ['3.000000', '7.000000', 'Two'],
    ['7.000000', '10.000000', 'Three'],
  ])
})

test('every row is exactly three tab-separated fields', () => {
  const text = formatAudacityLabels([createMarker(2, { name: 'x' })], 5)
  for (const line of text.trimEnd().split('\n')) {
    assert.equal(line.split('\t').length, 3, `bad row: ${JSON.stringify(line)}`)
  }
})

test('the text ends with a newline, as a line-oriented file should', () => {
  assert.ok(formatAudacityLabels([], 5).endsWith('\n'))
})

test('tabs and newlines in a name cannot break the row apart', () => {
  const nasty = createMarker(2, { name: 'Ch\t3\nsecond half' })
  const text = formatAudacityLabels([nasty], 5)
  for (const line of text.trimEnd().split('\n')) {
    assert.equal(line.split('\t').length, 3)
  }
  assert.ok(text.includes('Ch 3 second half'))
})

// ── Import ───────────────────────────────────────────────────────────────────

test('contiguous regions import as the boundaries between them', () => {
  const { markers, skipped } = parseAudacityLabels(
    '0.000000\t3.000000\t\n3.000000\t7.000000\tTwo\n7.000000\t10.000000\tThree\n'
  )
  assert.equal(skipped, 0)
  // The 0 and the 10 are the ends of the file, not internal boundaries, but
  // they are still legal marker positions — markerSpans is what drops them.
  assert.deepEqual(times(markers), [0, 3, 7, 10])
  assert.deepEqual(markers.map(m => m.name), ['', 'Two', 'Three', ''])
})

test('sparse regions keep the boundary at each end', () => {
  // Two regions with a gap between them: 1–2 and 5–6. All four edges matter.
  const { markers } = parseAudacityLabels('1\t2\tA\n5\t6\tB\n')
  assert.deepEqual(times(markers), [1, 2, 5, 6])
  assert.deepEqual(markers.map(m => m.name), ['A', '', 'B', ''])
})

test('point labels import as single markers', () => {
  const { markers } = parseAudacityLabels('2.5\t2.5\tHere\n')
  assert.deepEqual(times(markers), [2.5])
  assert.equal(markers[0].name, 'Here')
})

test('blank lines are ignored, not counted as skipped', () => {
  const { markers, skipped } = parseAudacityLabels('\n\n1\t2\tA\n\n   \n')
  assert.equal(skipped, 0)
  assert.deepEqual(times(markers), [1, 2])
})

test('a bad row is skipped and counted, and the good rows still load', () => {
  const { markers, skipped } = parseAudacityLabels(
    '1\t2\tA\nnonsense\n \tx\tB\n-4\t-3\tC\n5\t6\tD\n'
  )
  assert.equal(skipped, 3, 'one unsplittable, one non-numeric, one negative')
  assert.deepEqual(times(markers), [1, 2, 5, 6])
})

test('a name containing a tab is rejoined rather than dropped', () => {
  const { markers } = parseAudacityLabels('1\t2\tChapter\tThree\n')
  assert.equal(markers[0].name, 'Chapter Three')
})

test('rows out of order come back sorted', () => {
  const { markers } = parseAudacityLabels('8\t9\tLate\n1\t2\tEarly\n')
  assert.deepEqual(times(markers), [1, 2, 8, 9])
})

test('imported markers are all ordinary user markers', () => {
  const { markers } = parseAudacityLabels('1\t2\tA\n')
  assert.deepEqual([...new Set(markers.map(m => m.kind))], ['user'])
})

// ── Round trip ───────────────────────────────────────────────────────────────

test('export then import gives back the same boundaries and names', () => {
  const markers = [
    createMarker(3, { name: 'Two' }),
    createMarker(7.25, { name: 'Three' }),
  ]
  const { markers: back } = parseAudacityLabels(formatAudacityLabels(markers, 10))

  // The 0 and the 10 come along as the outer edges of the first and last span.
  // markerSpans ignores markers on the ends, so the spans are unchanged, which
  // is what "stable" has to mean here.
  const inner = back.filter(m => m.time > 0 && m.time < 10)
  assert.deepEqual(times(inner), [3, 7.25])
  assert.deepEqual(inner.map(m => m.name), ['Two', 'Three'])
})

test('a second round trip changes nothing further', () => {
  const once = formatAudacityLabels(
    [createMarker(3, { name: 'Two' }), createMarker(7, { name: 'Three' })],
    10
  )
  const twice = formatAudacityLabels(parseAudacityLabels(once).markers, 10)
  assert.equal(twice, once)
})

// ── Naming ───────────────────────────────────────────────────────────────────

test('the label file is named after the audio file', () => {
  assert.equal(toLabelFileName('chapter-03.wav'), 'chapter-03.labels.txt')
  assert.equal(toLabelFileName('no-extension'), 'no-extension.labels.txt')
  assert.equal(toLabelFileName('two.dots.mp3'), 'two.dots.labels.txt')
  assert.equal(toLabelFileName(''), 'untitled.labels.txt')
  assert.equal(toLabelFileName(null), 'untitled.labels.txt')
})
