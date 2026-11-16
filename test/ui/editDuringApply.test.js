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
import { useEditorState, DocumentEditedError, DocumentSwitchedError } from '../../src/composables/useEditorState.js'

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
  assert.equal(editor.undo(), false)
  assert.equal(doc.segments, segments)
  assert.equal(lastToast(editor), 'Wait for the current process to finish')
  editor.endProcessing(docId)

  assert.equal(editor.undo(), true)
  assert.notEqual(doc.segments, segments)
  editor.startProcessing('Rendering', docId)
  const undone = doc.segments
  assert.equal(editor.redo(), false)
  assert.equal(doc.segments, undone)
  editor.endProcessing(docId)
  assert.equal(editor.redo(), true)
  assert.equal(editor.redo(), false, 'nothing left to redo')
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

// Several applies measure BEFORE they call startProcessing, so the guard is
// not up yet and an edit can land. pin.check() is the backstop: it refuses the
// commit when the pinned file's timeline moved since the pin.
test('pin.check refuses a commit when the file was edited since the pin', () => {
  const editor = useEditorState()
  editor.createDocument('edited.wav', fakeBuffer())
  editor.state.selection = { start: 1, end: 2 }
  const pin = editor.pinActiveDocument('LA Vintage 2A')
  pin.check()
  assert.equal(editor.performTrimToSelection(), true) // before startProcessing
  assert.throws(() => pin.check(), (err) => {
    assert.ok(err instanceof DocumentEditedError)
    assert.ok(err instanceof DocumentSwitchedError, 'existing catch sites show its message')
    assert.equal(err.message, 'LA Vintage 2A was not applied: the file was edited while it rendered')
    return true
  })
})

test('pin.check refuses after an undo, and passes when nothing moved', () => {
  const editor = useEditorState()
  editor.createDocument('undone.wav', fakeBuffer())
  editor.state.selection = { start: 1, end: 2 }
  editor.performCut()
  const still = editor.pinActiveDocument('EQ')
  editor.state.selection = { start: 0, end: 1 } // selection changes are not edits
  editor.state.playhead = 0.5
  still.check()
  const pin = editor.pinActiveDocument('EQ')
  editor.undo()
  assert.throws(() => pin.check(), DocumentEditedError)
})

test('an apply’s own commit does not trip its pin (check runs before replaceRegion)', () => {
  const editor = useEditorState()
  const { docId } = editor.createDocument('own.wav', fakeBuffer())
  const pin = editor.pinActiveDocument('Fade')
  editor.startProcessing('Rendering', pin.docId)
  pin.check()
  const fakeRender = { duration: 1, sampleRate: 48000, numberOfChannels: 1, length: 48000, getChannelData: () => new Float32Array(48000) }
  assert.notEqual(editor.replaceRegion(1, 2, fakeRender, 'fade', pin.docId, pin.selection), null)
  editor.endProcessing(docId)
})
