/**
 * Undo/redo history labels and the message they produce.
 *
 * Every edit in the app announces itself with a toast; undo used to be the one
 * step in that loop that said nothing, which is why history entries now carry
 * the name of the operation that created them.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useEditorState } from '../../src/composables/useEditorState.js'

// A one-second mono buffer is all makeDocument reads off an AudioBuffer.
function fakeBuffer(duration = 4) {
  return { duration, sampleRate: 48000, numberOfChannels: 1 }
}

function freshDocument(editor, name) {
  const { docId } = editor.createDocument(name, fakeBuffer())
  return docId
}

function lastToast(editor) {
  const toasts = editor.appState.toasts
  return toasts.length ? toasts[toasts.length - 1].message : null
}

test('undo names the operation it took back', () => {
  const editor = useEditorState()
  freshDocument(editor, 'labels.wav')

  editor.state.selection = { start: 1, end: 2 }
  editor.performCut()
  assert.equal(editor.canUndo.value, true)

  editor.undo()
  assert.equal(lastToast(editor), 'Undid cut')

  editor.redo()
  assert.equal(lastToast(editor), 'Redid cut')
})

test('the label is used verbatim, so a proper name keeps its capitals', () => {
  const editor = useEditorState()
  freshDocument(editor, 'proper.wav')

  // No case is derived from the label. It cannot be: "Scheps" and "Silence"
  // are the same shape, and an earlier attempt at a rule turned "VoiceRx" into
  // "voiceRx" and "Scheps Parallel" into "scheps Parallel".
  for (const label of ['LA Classic 76 compression', 'VoiceRx', 'Scheps Parallel', 'AirBoost', 'Soft Clip']) {
    editor.pushUndo(label)
    editor.undo()
    assert.equal(lastToast(editor), `Undid ${label}`)
  }
})

test('an unlabelled entry still reports that something was undone', () => {
  const editor = useEditorState()
  freshDocument(editor, 'bare.wav')

  editor.pushUndo()
  editor.undo()
  assert.equal(lastToast(editor), 'Undone')
})

test('undo with nothing on the stack says nothing at all', () => {
  const editor = useEditorState()
  freshDocument(editor, 'empty.wav')
  editor.appState.toasts = []

  editor.undo()
  assert.equal(editor.appState.toasts.length, 0, 'no history, no message')
})

test('undo restores the timeline, not only the message', () => {
  const editor = useEditorState()
  freshDocument(editor, 'restore.wav')

  const before = editor.totalDuration.value
  editor.state.selection = { start: 1, end: 3 }
  editor.performCut()
  assert.ok(editor.totalDuration.value < before, 'the cut shortened the timeline')

  editor.undo()
  assert.equal(editor.totalDuration.value, before)
})

test('history is per document — undo reports the active document’s last edit', () => {
  const editor = useEditorState()
  const a = freshDocument(editor, 'a.wav')
  editor.state.selection = { start: 0, end: 1 }
  editor.performSilence()

  freshDocument(editor, 'b.wav')
  editor.state.selection = { start: 0, end: 1 }
  editor.performTrimToSelection()

  editor.undo()
  assert.equal(lastToast(editor), 'Undid trim to selection')

  editor.setActiveDocument(a)
  editor.undo()
  assert.equal(lastToast(editor), 'Undid silence')
})

// ── Selection across undo / redo ─────────────────────────────────────────────
// Undo used to clear the selection, so "apply, Undo, change a setting, apply
// again" meant re-selecting by hand. Each entry now carries the selection that
// belongs to its timeline.

test('undoing an effect puts back the selection it was applied to', () => {
  const editor = useEditorState()
  freshDocument(editor, 'effect.wav')

  editor.state.selection = { start: 1, end: 2 }
  editor.replaceRegion(1, 2, fakeBuffer(1), 'LA Vintage 2A compression')
  editor.undo()
  assert.deepEqual(editor.state.selection, { start: 1, end: 2 })

  // Re-applying to the same span and undoing again lands in the same place.
  editor.replaceRegion(1, 2, fakeBuffer(1), 'LA Vintage 2A compression')
  editor.undo()
  assert.deepEqual(editor.state.selection, { start: 1, end: 2 })
})

test('undoing a cut selects the restored audio; redo leaves none', () => {
  const editor = useEditorState()
  freshDocument(editor, 'cut.wav')

  editor.state.selection = { start: 1, end: 2 }
  editor.performCut()
  assert.equal(editor.state.selection, null)

  editor.undo()
  assert.deepEqual(editor.state.selection, { start: 1, end: 2 })

  editor.redo()
  assert.equal(editor.state.selection, null)
})

test('a selection made after an edit is not carried onto the undone timeline', () => {
  const editor = useEditorState()
  freshDocument(editor, 'shift.wav')

  editor.state.selection = { start: 1, end: 2 }
  editor.performCut()
  // Made on the shortened timeline: after undo, 2.5–3 s would be other audio.
  editor.state.selection = { start: 2.5, end: 3 }

  editor.undo()
  assert.deepEqual(editor.state.selection, { start: 1, end: 2 })

  // Redo returns to the shortened timeline, and with it the selection made there.
  editor.redo()
  assert.deepEqual(editor.state.selection, { start: 2.5, end: 3 })
})

test('undo restores "no selection" when there was none', () => {
  const editor = useEditorState()
  freshDocument(editor, 'none.wav')

  editor.state.selection = null
  editor.replaceRegion(0, 4, fakeBuffer(4), 'Peak Normalize')
  editor.state.selection = { start: 0, end: 1 }
  editor.undo()
  assert.equal(editor.state.selection, null)
})

test('a restored selection is a copy, not shared with the history entry', () => {
  const editor = useEditorState()
  freshDocument(editor, 'copy.wav')

  editor.state.selection = { start: 1, end: 2 }
  editor.pushUndo('silence')
  editor.state.selection.end = 3   // mutate after the snapshot
  editor.undo()
  assert.deepEqual(editor.state.selection, { start: 1, end: 2 })
  editor.state.selection.start = 0
  editor.redo()
  editor.undo()
  assert.deepEqual(editor.state.selection, { start: 0, end: 2 })
})

test('undo restores the span an apply processed, even if the selection moved while it rendered', () => {
  const editor = useEditorState()
  freshDocument(editor, 'async.wav')

  // Apply started on 1–2 s; the user reselected while the render ran, and the
  // commit (replaceRegion) lands afterwards with the original span.
  editor.state.selection = { start: 1, end: 2 }
  editor.state.selection = { start: 3, end: 3.5 }
  editor.replaceRegion(1, 2, fakeBuffer(1), 'De-Esser')

  editor.undo()
  assert.deepEqual(editor.state.selection, { start: 1, end: 2 })

  // Redo returns to the selection that was in place when Undo was pressed.
  editor.redo()
  assert.deepEqual(editor.state.selection, { start: 3, end: 3.5 })
})

test('a whole-file apply with nothing selected undoes to no selection', () => {
  const editor = useEditorState()
  freshDocument(editor, 'whole.wav')

  // Nothing selected at Apply; a selection made during the render is not it.
  editor.state.selection = null
  editor.state.selection = { start: 0.5, end: 1 }
  editor.replaceRegion(0, 4, fakeBuffer(4), 'Peak Normalize')
  editor.undo()
  assert.equal(editor.state.selection, null)

  // Select all, then apply: Undo brings Select all back.
  editor.selectAll()
  editor.replaceRegion(0, 4, fakeBuffer(4), 'Peak Normalize')
  editor.state.selection = null
  editor.undo()
  assert.deepEqual(editor.state.selection, { start: 0, end: 4 })
})

test('undo moves a stopped playhead into the restored selection', () => {
  const editor = useEditorState()
  freshDocument(editor, 'playhead.wav')

  // Trim to selection puts the playhead at 0, outside 2–3 s once undone.
  editor.state.selection = { start: 2, end: 3 }
  editor.performTrimToSelection()
  assert.equal(editor.state.playhead, 0)

  editor.undo()
  assert.deepEqual(editor.state.selection, { start: 2, end: 3 })
  assert.equal(editor.state.playhead, 2)
})

test('undo leaves a playhead already inside the restored selection where it is', () => {
  const editor = useEditorState()
  freshDocument(editor, 'inside.wav')

  editor.state.selection = { start: 1, end: 3 }
  editor.replaceRegion(1, 3, fakeBuffer(2), 'AirBoost')
  editor.state.playhead = 2.5
  editor.undo()
  assert.equal(editor.state.playhead, 2.5)
})

test('undo clamps the playhead onto a timeline it shortened', () => {
  const editor = useEditorState()
  freshDocument(editor, 'clamp.wav')

  // Copy 1 s and paste it at the end: 5 s long. Park the playhead at 4.8 s and
  // undo the paste — the timeline is 4 s again.
  editor.state.selection = { start: 0, end: 1 }
  editor.performCopy()
  editor.state.selection = null
  editor.performPaste(4)
  assert.equal(editor.totalDuration.value, 5)
  editor.state.playhead = 4.8

  editor.undo()
  assert.equal(editor.totalDuration.value, 4)
  assert.equal(editor.state.playhead, 4)
})
