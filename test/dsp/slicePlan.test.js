/**
 * Turning a marked-up timeline into one exportable document per slice.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sliceName,
  exportableSpans,
  sliceDocuments,
  MAX_SLICES,
} from '../../src/audio/slicePlan.js'
import { getTimelineDuration } from '../../src/audio/operations.js'

const marker = (time, name = '', kind = 'user') => ({ id: `m${time}`, time, name, kind })

/** A ten-second document over one buffer. */
function doc(markers, { duration = 10, name = 'chapter-03.wav' } = {}) {
  const buffer = { duration, sampleRate: 48000, numberOfChannels: 1, getChannelData: () => new Float32Array(1) }
  return {
    name,
    markers,
    totalDuration: duration,
    currentFile: { name, duration, sampleRate: 48000, channels: 1 },
    segments: [{
      id: 's', sourceBuffer: buffer, sourceBufferId: 'b',
      sourceStart: 0, sourceEnd: duration, outputStart: 0,
    }],
  }
}

const names = d => sliceDocuments(d).map(s => s.name)

// ── Naming ───────────────────────────────────────────────────────────────────

test('a slice is numbered, and named after its marker when it has one', () => {
  assert.equal(sliceName('chapter-03.wav', 0, 3, 'Intro'), 'chapter-03 1 Intro')
  assert.equal(sliceName('chapter-03.wav', 1, 3, ''), 'chapter-03 2')
})

test('the number is padded to the width of the count, so files sort in order', () => {
  // The whole job for a narrator handing over chapters: 10 must not sort
  // between 1 and 2.
  assert.equal(sliceName('ch', 0, 12, ''), 'ch 01')
  assert.equal(sliceName('ch', 9, 12, ''), 'ch 10')
  assert.equal(sliceName('ch', 0, 100, ''), 'ch 001')
})

test('path separators in a marker name cannot make a directory in the zip', () => {
  assert.equal(sliceName('book', 0, 1, 'Act 1/Scene 2'), 'book 1 Act 1-Scene 2')
  assert.equal(sliceName('book', 0, 1, 'a\\b'), 'book 1 a-b')
})

test('characters a file system refuses become spaces, not deletions', () => {
  // The character was a word boundary: "bad:name" reads "bad name", not
  // "badname".
  assert.equal(sliceName('bad:name.wav', 0, 1, ''), 'bad name 1')
  assert.equal(sliceName('ch', 0, 1, 'tab\there'), 'ch 1 tab here')
  // Legal characters inside the junk still survive — only the illegal ones go.
  assert.equal(sliceName('ch', 0, 1, 'q?"<>|*'), 'ch 1 q')
})

test('a nameless or unusable base still produces a file name', () => {
  assert.equal(sliceName('', 0, 1, ''), 'untitled 1')
  assert.equal(sliceName(null, 0, 1, 'Intro'), 'untitled 1 Intro')
  assert.equal(sliceName('...', 0, 1, ''), 'untitled 1')
})

test('a marker named only with junk leaves the slice numbered, not half-named', () => {
  assert.equal(sliceName('ch', 0, 1, '???'), 'ch 1')
  assert.equal(sliceName('ch', 0, 1, '   '), 'ch 1')
})

// ── Which spans become files ─────────────────────────────────────────────────

test('an unmarked file is one slice covering the whole thing', () => {
  const spans = exportableSpans([], 10)
  assert.deepEqual(spans.map(s => [s.start, s.end]), [[0, 10]])
})

test('gap spans are excluded — that is what flagging one is for', () => {
  // 0-2 content, 2-3 dead air, 3-10 content.
  const spans = exportableSpans([marker(2, '', 'gap'), marker(3)], 10)
  assert.deepEqual(spans.map(s => [s.start, s.end]), [[0, 2], [3, 10]])
})

test('excluding a gap renumbers the files around it, leaving no hole', () => {
  const d = doc([marker(2, '', 'gap'), marker(3), marker(6)])
  assert.deepEqual(names(d), ['chapter-03 1', 'chapter-03 2', 'chapter-03 3'])
})

test('a file that is all gap exports nothing rather than an empty archive', () => {
  assert.deepEqual(exportableSpans([marker(0.0001, '', 'gap')], 10).length, 0)
})

// ── The documents ────────────────────────────────────────────────────────────

test('each slice carries only its own audio, rebased to zero', () => {
  const slices = sliceDocuments(doc([marker(3), marker(7)]))
  assert.equal(slices.length, 3)
  assert.deepEqual(slices.map(s => getTimelineDuration(s.segments)), [3, 4, 3])
  for (const s of slices) {
    assert.equal(s.segments[0].outputStart, 0, 'a slice starts at 0, not where it was')
  }
})

test('the slices add up to the original, so nothing is lost or doubled', () => {
  const d = doc([marker(1.5), marker(4), marker(9)])
  const total = sliceDocuments(d)
    .reduce((sum, s) => sum + getTimelineDuration(s.segments), 0)
  assert.ok(Math.abs(total - d.totalDuration) < 1e-9, `got ${total}`)
})

test('building slices does not renumber the document they came from', () => {
  // trimToSelection runs recalcOutputStarts, which writes outputStart on the
  // objects it is given — on the live array that would renumber the open
  // timeline once per slice.
  const d = doc([marker(3), marker(7)])
  const before = d.segments.map(s => ({ ...s }))
  sliceDocuments(d)
  assert.deepEqual(d.segments.map(s => ({ ...s })), before)
})

test('a slice is shaped like a document, which is what export consumes', () => {
  const [slice] = sliceDocuments(doc([marker(5)]))
  assert.ok(Array.isArray(slice.segments))
  assert.equal(typeof slice.name, 'string')
  assert.equal(slice.currentFile.sampleRate, 48000)
  assert.equal(slice.currentFile.channels, 1)
})

test('the source buffer is shared, not copied', () => {
  const d = doc([marker(5)])
  const original = d.segments[0].sourceBuffer
  for (const s of sliceDocuments(d)) {
    assert.equal(s.segments[0].sourceBuffer, original)
  }
})

test('an empty or unopened document yields no slices', () => {
  assert.deepEqual(sliceDocuments({ segments: [], markers: [], totalDuration: 0, currentFile: null, name: 'x' }), [])
  assert.deepEqual(sliceDocuments(doc([], { duration: 0 })), [])
})

test('the slice ceiling is well past any real chapter list', () => {
  assert.ok(MAX_SLICES >= 200, 'a long audiobook must not be refused')
})
