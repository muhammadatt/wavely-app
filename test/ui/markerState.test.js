/**
 * Markers as document state: that they survive undo, and that they follow the
 * timeline when it is edited underneath them.
 *
 * The second half is the part worth having. The marker transforms themselves
 * are covered in test/dsp/markers.test.js; what this checks is that every
 * `perform*` in the composable actually calls the right one. A transform that
 * is correct and never invoked looks identical from the unit tests.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useEditorState } from '../../src/composables/useEditorState.js'

/** What makeDocument reads off an AudioBuffer, plus silent sample data. */
function fakeBuffer(duration = 10) {
  const sampleRate = 48000
  const data = new Float32Array(Math.round(duration * sampleRate))
  return {
    duration,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  }
}

/**
 * A document with snapping off.
 *
 * Snap-to-zero is on by default in the app, and correctly so, but it would
 * move every marker these tests place to somewhere they did not ask for. The
 * snap itself is covered in test/dsp/zeroCross.test.js.
 */
function freshDocument(editor, name, duration = 10) {
  const { docId } = editor.createDocument(name, fakeBuffer(duration))
  editor.appState.snapToZero = false
  return docId
}

const times = editor => editor.state.markers.map(m => m.time)

// ── State and undo ───────────────────────────────────────────────────────────

test('a new document opens with no markers', () => {
  const editor = useEditorState()
  freshDocument(editor, 'fresh.wav')
  assert.deepEqual(editor.state.markers, [])
})

test('dropping a marker puts it at the playhead and is undoable', () => {
  const editor = useEditorState()
  freshDocument(editor, 'drop.wav')

  editor.setPlayhead(3)
  editor.dropMarker()
  assert.deepEqual(times(editor), [3])

  editor.undo()
  assert.deepEqual(times(editor), [], 'undo takes the marker back')

  editor.redo()
  assert.deepEqual(times(editor), [3], 'redo puts it back')
})

test('dropping a marker where one already sits does nothing, and costs no undo step', () => {
  const editor = useEditorState()
  freshDocument(editor, 'dupe.wav')

  editor.dropMarker(4)
  const depth = editor.state.undoCount
  assert.equal(editor.dropMarker(4), null)
  assert.equal(editor.state.markers.length, 1)
  assert.equal(editor.state.undoCount, depth, 'a no-op must not push history')
})

test('markers are per-document, not global', () => {
  const editor = useEditorState()
  const a = freshDocument(editor, 'a.wav')
  editor.dropMarker(2)

  const b = freshDocument(editor, 'b.wav')
  assert.deepEqual(times(editor), [], 'the new document starts clean')

  editor.setActiveDocument(a)
  assert.deepEqual(times(editor), [2], 'the first document kept its marker')
  editor.setActiveDocument(b)
})

test('marking the selection edges drops one marker at each end', () => {
  const editor = useEditorState()
  freshDocument(editor, 'edges.wav')

  editor.setSelection(2, 6)
  assert.equal(editor.markSelectionEdges(), 2)
  assert.deepEqual(times(editor), [2, 6])
})

test('rename, re-kind and delete each undo cleanly', () => {
  const editor = useEditorState()
  freshDocument(editor, 'edit.wav')

  const id = editor.dropMarker(5)
  editor.renameMarkerById(id, 'Chapter 2')
  assert.equal(editor.state.markers[0].name, 'Chapter 2')

  editor.toggleGapMarker(id)
  assert.equal(editor.state.markers[0].kind, 'gap')
  editor.undo()
  assert.equal(editor.state.markers[0].kind, 'user')

  editor.deleteMarker(id)
  assert.deepEqual(times(editor), [])
  editor.undo()
  assert.deepEqual(times(editor), [5])
  assert.equal(editor.state.markers[0].name, 'Chapter 2', 'the name came back too')
})

// ── Following the timeline ───────────────────────────────────────────────────

test('cutting before a marker pulls it earlier, and undo restores its old time', () => {
  const editor = useEditorState()
  freshDocument(editor, 'cut.wav')

  editor.dropMarker(6)
  editor.setSelection(1, 3)
  editor.performCut()
  assert.deepEqual(times(editor), [4], 'a 2 s cut before it moved it 2 s earlier')

  editor.undo()
  assert.deepEqual(times(editor), [6], 'undo puts the marker back where it was')
})

test('a marker inside a cut goes with the audio, and comes back with undo', () => {
  const editor = useEditorState()
  freshDocument(editor, 'inside.wav')

  editor.dropMarker(2)
  editor.dropMarker(5)
  editor.setSelection(4, 7)
  editor.performCut()
  assert.deepEqual(times(editor), [2], 'the marker at 5 was inside the cut')

  editor.undo()
  assert.deepEqual(times(editor), [2, 5])
})

test('pasting pushes the markers after the insertion point later', () => {
  const editor = useEditorState()
  freshDocument(editor, 'paste.wav')

  editor.dropMarker(8)
  editor.setSelection(0, 2)
  editor.performCopy()
  editor.performPaste(4)
  assert.deepEqual(times(editor), [10], '2 s inserted at 4 moved the marker at 8')
})

test('trimming to a selection keeps the markers inside and rebases them', () => {
  const editor = useEditorState()
  freshDocument(editor, 'trim.wav')

  editor.dropMarker(1)
  editor.dropMarker(5)
  editor.dropMarker(9)
  editor.setSelection(3, 8)
  editor.performTrimToSelection()
  assert.deepEqual(times(editor), [2], 'only the marker at 5 survives, now at 2')
})

test('trimming the head and the tail each move the right markers', () => {
  const editor = useEditorState()
  freshDocument(editor, 'ends.wav')

  editor.dropMarker(4)
  editor.dropMarker(8)
  editor.setSelection(2, 3)
  editor.performTrimBefore()
  assert.deepEqual(times(editor), [2, 6], 'removing the first 2 s pulled both back')

  editor.setSelection(4, 5)
  editor.performTrimAfter()
  assert.deepEqual(times(editor), [2], 'the marker past the trim point is gone')
})

test('silencing a region leaves markers exactly where they were', () => {
  const editor = useEditorState()
  freshDocument(editor, 'silence.wav')

  editor.dropMarker(2)
  editor.dropMarker(8)
  editor.setSelection(4, 6)
  editor.performSilence()
  assert.deepEqual(times(editor), [2, 8], 'silence preserves length, so nothing moves')
})

// ── Spans and splitting ──────────────────────────────────────────────────────

test('with no markers the whole file is one span', () => {
  const editor = useEditorState()
  freshDocument(editor, 'spans.wav')
  assert.deepEqual(editor.spans.value.map(s => [s.start, s.end]), [[0, 10]])
})

test('markers cut the timeline into spans, head and tail included', () => {
  const editor = useEditorState()
  freshDocument(editor, 'spans2.wav')

  editor.dropMarker(3)
  editor.dropMarker(7)
  assert.deepEqual(
    editor.spans.value.map(s => [s.start, s.end]),
    [[0, 3], [3, 7], [7, 10]]
  )
})

test('splitting at markers cuts the timeline without moving the markers', () => {
  const editor = useEditorState()
  freshDocument(editor, 'split.wav')

  editor.dropMarker(3)
  editor.dropMarker(7)
  assert.equal(editor.state.segments.length, 1)

  assert.equal(editor.performSplitAtMarkers(), 2)
  assert.equal(editor.state.segments.length, 3, 'two markers make three segments')
  assert.deepEqual(times(editor), [3, 7], 'a split changes no durations')

  editor.undo()
  assert.equal(editor.state.segments.length, 1)
})

test('splitting with no markers does nothing at all', () => {
  const editor = useEditorState()
  freshDocument(editor, 'nosplit.wav')
  const depth = editor.state.undoCount
  assert.equal(editor.performSplitAtMarkers(), 0)
  assert.equal(editor.state.undoCount, depth)
})

test('dropping gaps removes every gap span in one undoable step', () => {
  const editor = useEditorState()
  freshDocument(editor, 'gaps.wav')

  // Two gaps: 2–3 and 6–8. Marking a marker as a gap makes the span it opens
  // dead air, so the closing marker of each gap is an ordinary one.
  const g1 = editor.dropMarker(2)
  editor.dropMarker(3)
  const g2 = editor.dropMarker(6)
  editor.dropMarker(8)
  editor.toggleGapMarker(g1)
  editor.toggleGapMarker(g2)

  assert.equal(editor.performDropGaps(), 2)
  assert.equal(editor.totalDuration.value, 7, '1 s + 2 s of gap removed from 10 s')
  // Both gap spans collapse to a point, so the four markers become two.
  assert.deepEqual(times(editor), [2, 5])

  editor.undo()
  assert.equal(editor.totalDuration.value, 10)
  assert.deepEqual(times(editor), [2, 3, 6, 8])
})

test('dropping gaps when there are none does nothing', () => {
  const editor = useEditorState()
  freshDocument(editor, 'nogaps.wav')
  editor.dropMarker(4)
  const depth = editor.state.undoCount
  assert.equal(editor.performDropGaps(), 0)
  assert.equal(editor.state.undoCount, depth)
})

// ── Snapping ─────────────────────────────────────────────────────────────────

test('with snap on, a dropped marker lands on a rising zero-crossing', () => {
  const editor = useEditorState()
  const sampleRate = 48000
  const duration = 1
  const data = new Float32Array(sampleRate * duration)
  // 100 Hz: rising crossings every 10 ms.
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.sin((2 * Math.PI * 100 * i) / sampleRate)
  }
  editor.createDocument('snap.wav', {
    duration,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  })
  editor.appState.snapToZero = true

  editor.dropMarker(0.0503)
  assert.ok(
    Math.abs(editor.state.markers[0].time - 0.05) < 1e-4,
    `expected ~0.05, got ${editor.state.markers[0].time}`
  )

  editor.appState.snapToZero = false
})
