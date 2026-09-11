/**
 * The rules an export follows before a single sample is rendered.
 *
 * These matter more now than when export had one surface: the files panel
 * exports its ticked files directly and the export dialog exports its checked
 * ones, and both go through this module. A divergence here is one surface
 * quietly producing a different file from the other — the failure mode the
 * shared module exists to prevent, which is only worth sharing if the rules are
 * pinned.
 *
 * ⚠ NOT `useExport` ITSELF. That module imports the render chain, which reaches
 * every AudioWorklet through `?worker&url` specifiers only Vite resolves, and
 * fails at load under `node --test`. The split is what makes any of this
 * testable; see the header of exportPlan.js.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimatedBytes, totalBytes, formatSize, overZipLimit, uniqueNames,
} from '../../src/audio/exportPlan.js'
import { ZIP_SIZE_LIMIT } from '../../src/audio/zip.js'

/** A document whose timeline is one audio segment of `duration` seconds. */
function doc(name, duration = 60, { sampleRate = 44100, channels = 1 } = {}) {
  return {
    name,
    segments: [{ outputStart: 0, sourceBuffer: 'buf', sourceStart: 0, sourceEnd: duration }],
    currentFile: { sampleRate, channels },
  }
}

test('a size estimate is the PCM arithmetic, not a guess', () => {
  // 60 s × 44100 × 1 channel × 2 bytes + 44-byte header.
  assert.equal(estimatedBytes(doc('a.wav', 60)), 60 * 44100 * 2 + 44)
  assert.equal(estimatedBytes(doc('a.wav', 60, { channels: 2 })), 60 * 44100 * 2 * 2 + 44)
})

test('an empty timeline, or a document with no file behind it, estimates zero', () => {
  assert.equal(estimatedBytes({ name: 'a.wav', segments: [], currentFile: { sampleRate: 44100, channels: 1 } }), 0)
  assert.equal(estimatedBytes({ ...doc('a.wav', 5), currentFile: null }), 0)
})

test('the total is the sum of the selection', () => {
  const docs = [doc('a.wav', 10), doc('b.wav', 20)]
  assert.equal(totalBytes(docs), estimatedBytes(docs[0]) + estimatedBytes(docs[1]))
  assert.equal(totalBytes([]), 0)
})

test('colliding names disambiguate rather than overwriting each other in the zip', () => {
  // Same name from two folders, and a .flac that becomes the same .wav — both
  // are ordinary, and inside an archive the second would replace the first.
  const names = uniqueNames([doc('chapter01.wav'), doc('chapter01.wav'), doc('chapter01.flac')])
  assert.deepEqual(names, ['chapter01.wav', 'chapter01 (2).wav', 'chapter01 (3).wav'])
})

test('names that do not collide are left exactly as the user set them', () => {
  assert.deepEqual(
    uniqueNames([doc('chapter01.wav'), doc('chapter02.wav')]),
    ['chapter01.wav', 'chapter02.wav'],
  )
})

test('the zip limit applies to archives only — one huge file still exports', () => {
  // The writer is not zip64: over 4 GB the archive comes out corrupt rather
  // than refused, so the check happens before anything is built. A lone file
  // is downloaded as-is and never reaches the writer.
  const huge = doc('long.wav', 40000, { channels: 2 })
  assert.ok(totalBytes([huge, huge]) > ZIP_SIZE_LIMIT)
  assert.equal(overZipLimit([huge]), false)
  assert.equal(overZipLimit([huge, huge]), true)
  assert.equal(overZipLimit([doc('a.wav', 60), doc('b.wav', 60)]), false)
})

test('sizes read in the unit the number deserves', () => {
  assert.equal(formatSize(4_200_000_000), '4.20 GB')
  assert.equal(formatSize(5_300_000), '5.3 MB')
  assert.equal(formatSize(12_000), '12 KB')
  // Never "0 KB" for a file that exists — a 44-byte header is still a file.
  assert.equal(formatSize(44), '1 KB')
})
