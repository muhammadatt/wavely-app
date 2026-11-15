/**
 * Timeline edits refuse while the active document has an apply in flight.
 *
 * An apply captures its region's start and end when it begins and splices the
 * render back at those times when it commits. `pin.check()` catches only a
 * switch to another file, so an edit to the SAME file mid-render (a Trim from
 * the selection bar or the right-click menu, an Undo from the header) would
 * move the timeline under it. The guard sits in the editor's edit functions,
 * so every surface that calls them is covered at once.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useEditorState } from '../../src/composables/useEditorState.js'

function fakeBuffer(duration = 4) {
  return { duration, sampleRate: 48000, numberOfChannels: 1 }
}

function lastToast(editor) {
  const toasts = editor.appState.toasts
  return toasts.length ? toasts[toasts.length - 1].message : null
}

const EDITS = {
  performTrimToSelection: e => e.performTrimToSelection(),
  performTrimBefore: e => e.performTrimBefore(),
  performTrimAfter: e => e.performTrimAfter(),
  performSilence: e => e.performSilence(),
  performSplit: e => e.performSplit(),
  performSplitAtSelectionEdges: e => e.performSplitAtSelectionEdges(),
  performCut: e => e.performCut(),
  performPaste: e => e.performPaste(0.5),
}

for (const [name, run] of Object.entries(EDITS)) {
  test(`${name} refuses while the document is processing, and runs once it ends`, () => {
    const editor = useEditorState()
    const { docId } = editor.createDocument(`${name}.wav`, fakeBuffer())
    editor.state.selection = { start: 1, end: 2 }
    editor.performCopy() // gives Paste something to insert
    editor.state.playhead = 1.5

    editor.startProcessing('Rendering', docId)
    const doc = editor.getDocument(docId)
    const segments = doc.segments
    const revision = doc.revision
    assert.equal(run(editor), false)
    assert.equal(doc.segments, segments, 'the timeline must not move under the apply')
    assert.equal(doc.revision, revision)
    assert.equal(lastToast(editor), 'Wait for the current process to finish')

    editor.endProcessing(docId)
    editor.state.selection = { start: 1, end: 2 }
    assert.equal(run(editor), true)
    assert.notEqual(doc.revision, revision)
  })
}

test('undo and redo refuse while the document is processing', () => {
  const editor = useEditorState()
  const { docId } = editor.createDocument('history.wav', fakeBuffer())
  editor.state.selection = { start: 1, end: 2 }
  editor.performCut()
  const doc = editor.getDocument(docId)

  editor.startProcessing('Rendering', docId)
  const segments = doc.segments
  editor.undo()
  assert.equal(doc.segments, segments)
  assert.equal(lastToast(editor), 'Wait for the current process to finish')
  editor.endProcessing(docId)

  editor.undo()
  assert.notEqual(doc.segments, segments)
  editor.startProcessing('Rendering', docId)
  const undone = doc.segments
  editor.redo()
  assert.equal(doc.segments, undone)
  editor.endProcessing(docId)
})

test('another file rendering does not block edits on the active one', () => {
  const editor = useEditorState()
  const { docId: busy } = editor.createDocument('busy.wav', fakeBuffer())
  editor.startProcessing('Rendering', busy)
  const { docId: free } = editor.createDocument('free.wav', fakeBuffer())
  editor.setActiveDocument(free)
  editor.state.selection = { start: 1, end: 2 }
  assert.equal(editor.performSilence(), true)
  editor.endProcessing(busy)
})
