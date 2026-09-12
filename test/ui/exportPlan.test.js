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
  estimatedBytes, totalBytes, formatSize, archiveBytes, exportSizeLimit, uniqueNames,
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

test('a generated name cannot collide with one the user already chose', () => {
  // The bug this pins: counting occurrences of the ORIGINAL name handed the
  // second "chapter.wav" the suffix "(2)", and the file genuinely called
  // "chapter (2).wav" kept its own name — two identical entries in the zip.
  // The third keeps ITS OWN name as the base and suffixes that, rather than
  // being renumbered into the generated sequence: "chapter (2).wav" is the name
  // the user gave it, and quietly turning it into "chapter (3).wav" would claim
  // it is the third copy of chapter. Ugly, unique, and it does not rewrite what
  // the user chose.
  assert.deepEqual(
    uniqueNames([doc('chapter.wav'), doc('chapter.wav'), doc('chapter (2).wav')]),
    ['chapter.wav', 'chapter (2).wav', 'chapter (2) (2).wav'],
  )
  // ...and it holds when the taken name comes first.
  assert.deepEqual(
    uniqueNames([doc('chapter (2).wav'), doc('chapter.wav'), doc('chapter.wav')]),
    ['chapter (2).wav', 'chapter.wav', 'chapter (3).wav'],
  )
})

test('names that do not collide are left exactly as the user set them', () => {
  assert.deepEqual(
    uniqueNames([doc('chapter01.wav'), doc('chapter02.wav')]),
    ['chapter01.wav', 'chapter02.wav'],
  )
})

test('an ordinary selection is not refused', () => {
  assert.equal(exportSizeLimit([doc('a.wav', 60)]), null)
  assert.equal(exportSizeLimit([doc('a.wav', 60), doc('b.wav', 60)]), null)
  assert.equal(exportSizeLimit([]), null)
})

test('a single WAV over 4 GB is refused too — RIFF has 32-bit size fields', () => {
  // Skipping the archive does not save it: `RIFF` at offset 4 and `data` at 40
  // both wrap, and the file reads back as garbage in every player.
  const huge = doc('long.wav', 40000, { channels: 2 })
  assert.ok(estimatedBytes(huge) > ZIP_SIZE_LIMIT)
  const refusal = exportSizeLimit([huge])
  assert.ok(refusal, 'a 7 GB WAV must be refused, not written')
  assert.match(refusal.message, /WAV/)
})

test('the zip limit counts the archive, not just the audio in it', () => {
  // Every entry costs a 30-byte local header, a 46-byte central record and two
  // copies of its name; the archive then ends with a 22-byte record. A
  // selection measured at just under the limit crosses it once written.
  const docs = [doc('a.wav', 10), doc('b.wav', 20)]
  const names = ['a.wav', 'b.wav']
  const overhead = names.reduce((sum, n) => sum + 30 + 46 + 2 * n.length, 0) + 22
  assert.equal(archiveBytes(docs), totalBytes(docs) + overhead)
  assert.ok(archiveBytes(docs) > totalBytes(docs))
})

test('the refusal message says which ceiling was hit', () => {
  const huge = doc('long.wav', 40000, { channels: 2 })
  assert.match(exportSizeLimit([huge]).message, /Split it/)
  assert.match(exportSizeLimit([huge, huge]).message, /smaller batches/)
})

test('sizes read in the unit the number deserves', () => {
  assert.equal(formatSize(4_200_000_000), '4.20 GB')
  assert.equal(formatSize(5_300_000), '5.3 MB')
  assert.equal(formatSize(12_000), '12 KB')
  // Never "0 KB" for a file that exists — a 44-byte header is still a file.
  assert.equal(formatSize(44), '1 KB')
})
