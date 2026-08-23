/**
 * Saving: what counts as unsaved work, and where a Save goes.
 *
 * The interesting half of this feature is not the write — it is the bookkeeping
 * that decides whether the dot is showing, whether closing a tab warns, and
 * whether Ctrl+S opens a dialog. That is all pure, so it is all testable here;
 * the FileSystemFileHandle calls around it are three lines of plumbing.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useEditorState } from '../../src/composables/useEditorState.js'
import { saveTargetKind } from '../../src/audio/fileSave.js'
import { documentStatus } from '../../src/utils/documentStatus.js'

function fakeBuffer(duration = 4) {
  return { duration, sampleRate: 48000, numberOfChannels: 1 }
}

function freshDocument(editor, name) {
  const { docId } = editor.createDocument(name, fakeBuffer())
  return docId
}

/**
 * The editor state is a module singleton, so documents opened by earlier tests
 * are still open here. Any assertion about the *app-wide* dirty flag has to
 * start from an empty workspace or it is reading someone else's leftovers.
 */
function closeAllDocuments(editor) {
  editor.closeDocuments(editor.documents.value.map(d => d.id))
}

test('a document opens clean — its bytes are what was read off disk', () => {
  const editor = useEditorState()
  closeAllDocuments(editor)
  const docId = freshDocument(editor, 'chapter01.wav')
  assert.equal(editor.documentHasUnsavedWork(docId), false)
  assert.equal(editor.anyUnsavedWork.value, false)
})

test('an edit dirties it and a save cleans it', () => {
  const editor = useEditorState()
  const docId = freshDocument(editor, 'chapter02.wav')

  editor.state.selection = { start: 1, end: 2 }
  editor.performCut()
  assert.equal(editor.documentHasUnsavedWork(docId), true)

  editor.markDocumentSaved(docId)
  assert.equal(editor.documentHasUnsavedWork(docId), false)

  editor.performSplit()
  assert.equal(editor.documentHasUnsavedWork(docId), true)
})

test('undoing back to the saved state reports clean again, and redo re-dirties', () => {
  // The reason revisions travel on history entries rather than being inferred
  // from stack depth: depth cannot come back down to a remembered value once
  // the 50-entry cap has shifted the bottom off.
  const editor = useEditorState()
  const docId = freshDocument(editor, 'chapter03.wav')

  editor.state.selection = { start: 0.5, end: 1 }
  editor.performCut()
  editor.markDocumentSaved(docId)

  editor.performSplit()
  assert.equal(editor.documentHasUnsavedWork(docId), true)

  editor.undo()
  assert.equal(editor.documentHasUnsavedWork(docId), false)

  editor.redo()
  assert.equal(editor.documentHasUnsavedWork(docId), true)
})

test('undoing past the save point is still unsaved work', () => {
  const editor = useEditorState()
  const docId = freshDocument(editor, 'chapter04.wav')

  editor.state.selection = { start: 1, end: 2 }
  editor.performCut()
  editor.performSplit()
  editor.markDocumentSaved(docId)

  editor.undo()
  editor.undo()
  assert.equal(editor.documentHasUnsavedWork(docId), true)
})

test('a saved document stops advertising itself as edited', () => {
  const editor = useEditorState()
  const docId = freshDocument(editor, 'chapter05.wav')
  const doc = editor.getDocument(docId)

  assert.equal(documentStatus(doc), null)

  editor.state.selection = { start: 1, end: 3 }
  editor.performCut()
  assert.equal(documentStatus(doc).kind, 'edited')
  assert.equal(documentStatus(doc).label, 'Unsaved')

  editor.markDocumentSaved(docId)
  assert.equal(documentStatus(doc), null)
})

test('documentStatus falls back to undo history for objects with no revisions', () => {
  // FilesPanel and the tab strip both render this, and neither should crash on
  // a document shape that predates revision tracking.
  assert.equal(documentStatus({ undoCount: 2 }).kind, 'edited')
  assert.equal(documentStatus({ undoCount: 0 }), null)
})

test('a save target is remembered per document and freed on close', () => {
  const editor = useEditorState()
  const docId = freshDocument(editor, 'chapter06.wav')
  const other = freshDocument(editor, 'chapter07.wav')

  assert.equal(editor.getSaveTarget(docId), undefined)
  editor.setSaveTarget(docId, { name: 'chapter06.wav' })
  assert.equal(editor.getSaveTarget(docId).name, 'chapter06.wav')
  // Targets do not leak between documents — Save As on one tab must not
  // silently retarget another.
  assert.equal(editor.getSaveTarget(other), undefined)

  editor.closeDocument(docId)
  assert.equal(editor.getSaveTarget(docId), undefined)
})

test('the first save is a Save As; later ones write straight through', () => {
  const handle = { name: 'chapter08.wav' }
  assert.equal(saveTargetKind(undefined, true), 'pick')
  assert.equal(saveTargetKind(handle, true), 'write')
  // No write API — a handle can never exist, so every save is a download.
  assert.equal(saveTargetKind(undefined, false), 'download')
  assert.equal(saveTargetKind(handle, false), 'download')
})

test('unsaved work is visible across documents, not just the active one', () => {
  const editor = useEditorState()
  closeAllDocuments(editor)
  const a = freshDocument(editor, 'chapter09.wav')
  const b = freshDocument(editor, 'chapter10.wav')

  editor.setActiveDocument(a)
  editor.state.selection = { start: 1, end: 2 }
  editor.performCut()

  editor.setActiveDocument(b)
  assert.equal(editor.documentHasUnsavedWork(b), false)
  // The beforeunload guard asks this question, and it has to see the tab the
  // user is not looking at.
  assert.equal(editor.anyUnsavedWork.value, true)

  editor.markDocumentSaved(a)
  assert.equal(editor.anyUnsavedWork.value, false)
})
