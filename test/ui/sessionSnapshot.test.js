/**
 * Session autosave's snapshot rules (src/audio/sessionSnapshot.js) and the
 * editor's restoreDocument. The OPFS store and the recovery flow run in a real
 * browser only; see scripts/autosave-check.mjs.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  MANIFEST_VERSION, buildManifest, bufferIdsOf, hasUnsavedEdits, isRestorableManifest,
  orphanedBufferIds, restoreSegments, snapshotDocument,
} from '../../src/audio/sessionSnapshot.js'
import { useEditorState } from '../../src/composables/useEditorState.js'

const buf = (duration = 4) => ({ duration, sampleRate: 1000, numberOfChannels: 1, length: duration * 1000 })

function doc({ revision = 2, savedRevision = 1, segments } = {}) {
  return {
    id: 'd1', name: 'Ch 04.wav', revision, savedRevision,
    currentFile: { sourceFormat: { container: 'wav' } },
    selection: { start: 1, end: 2 }, playhead: 1.5,
    selectedPreset: 'acx_audiobook', selectedOutputProfile: 'acx',
    segments: segments ?? [
      { id: 's1', sourceBuffer: buf(), sourceBufferId: 'A', sourceStart: 0, sourceEnd: 2, outputStart: 0 },
      { id: 's2', sourceBuffer: null, duration: 0.5, outputStart: 2 },
      { id: 's3', sourceBuffer: buf(), sourceBufferId: 'B', sourceStart: 1, sourceEnd: 3, outputStart: 2.5 },
    ],
  }
}

test('a snapshot keeps the timeline by buffer id, without the audio', () => {
  const s = snapshotDocument(doc())
  assert.deepEqual(s.segments[0], { id: 's1', sourceBufferId: 'A', sourceStart: 0, sourceEnd: 2, outputStart: 0 })
  assert.deepEqual(s.segments[1], { id: 's2', silence: true, duration: 0.5, outputStart: 2 })
  assert.equal(JSON.stringify(s).includes('sourceBuffer"'), false, 'no AudioBuffer in the JSON')
  assert.deepEqual(s.selection, { start: 1, end: 2 })
  assert.equal(s.selectedPreset, 'acx_audiobook')
})

test('only files with unsaved edits go into the manifest', () => {
  const saved = { ...doc({ revision: 3, savedRevision: 3 }), id: 'd2' }
  assert.equal(hasUnsavedEdits(saved), false)
  const m = buildManifest({ sessionId: 'x', documents: [doc(), saved], describe: id => ({ kind: 'pcm', id }), now: 5 })
  assert.equal(m.version, MANIFEST_VERSION)
  assert.deepEqual(m.docs.map(d => d.id), ['d1'])
  assert.deepEqual(Object.keys(m.buffers).sort(), ['A', 'B'])
  assert.equal(m.savedAt, 5)
})

test('a manifest naming a buffer it does not describe is not restorable', () => {
  const m = buildManifest({ sessionId: 'x', documents: [doc()], describe: id => ({ kind: 'pcm', id }) })
  assert.equal(isRestorableManifest(m), true)
  delete m.buffers.B
  assert.equal(isRestorableManifest(m), false)
  assert.equal(isRestorableManifest({ ...m, version: 999 }), false)
  assert.equal(isRestorableManifest(null), false)
})

test('restoring puts the buffers back and clamps an edge a re-decode shortened', () => {
  const s = snapshotDocument(doc())
  const A = buf(4)
  const B = buf(2.999)
  const segs = restoreSegments(s, new Map([['A', A], ['B', B]]))
  assert.equal(segs[0].sourceBuffer, A)
  assert.equal(segs[1].sourceBuffer, null)
  assert.equal(segs[2].sourceEnd, 2.999)
  assert.throws(() => restoreSegments(s, new Map([['A', A]])), /missing buffer B/)
})

test('a stored buffer is an orphan only when no manifest names it', () => {
  const m1 = { buffers: { A: {} } }
  const m2 = { buffers: { B: {} } }
  assert.deepEqual(orphanedBufferIds(['A', 'B', 'C'], [m1, m2, null]), ['C'])
})

test('bufferIdsOf skips silence', () => {
  assert.deepEqual([...bufferIdsOf([snapshotDocument(doc())])].sort(), ['A', 'B'])
})

// ── The editor ───────────────────────────────────────────────────────────────

test('restoreDocument opens the stored timeline as an unsaved file', () => {
  const editor = useEditorState()
  const snapshot = snapshotDocument(doc())
  const A = buf(4)
  const B = buf(4)
  const file = new File([new Uint8Array(4)], 'Ch 04.wav')
  const id = editor.restoreDocument(snapshot, new Map([['A', A], ['B', B]]), {
    sourceFiles: new Map([['A', file]]), activate: true,
  })
  const restored = editor.getDocument(id)
  assert.equal(restored.name, 'Ch 04.wav')
  assert.equal(editor.documentHasUnsavedWork(id), true, 'edits not on disk read as unsaved')
  assert.equal(editor.totalDuration.value, 4.5)
  assert.deepEqual(restored.selection, { start: 1, end: 2 })
  assert.equal(editor.canUndo.value, false, 'a fresh history')
  assert.equal(editor.bufferPool.get('A'), A)
  assert.equal(editor.getBufferSourceFile('A'), file, 'the stored bytes stand in for the original file')
  assert.equal(editor.getBufferSourceFile('B'), null)
  editor.closeDocument(id)
  assert.equal(editor.bufferPool.has('A'), false)
  assert.equal(editor.getBufferSourceFile('A'), null)
})

test('import passes the file so autosave can keep its bytes', () => {
  const src = readFileSync(new URL('../../src/composables/useFileImport.js', import.meta.url), 'utf8')
  assert.match(src, /sourceFile: file,/)
})
