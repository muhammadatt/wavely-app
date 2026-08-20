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
  for (const label of ['FET Punch compression', 'VoiceRx', 'Scheps Parallel', 'AirBoost']) {
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
