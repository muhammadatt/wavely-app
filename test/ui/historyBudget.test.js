/**
 * Undo history budgeted by the audio it keeps alive (src/audio/historyBudget.js),
 * and the buffer pool releasing what nothing reaches any more.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { historyTrim, segmentBufferIds, unreferencedBufferIds } from '../../src/audio/historyBudget.js'
import { useEditorState, setHistoryBudgetBytes, HISTORY_BUDGET_SHARE } from '../../src/composables/useEditorState.js'

// ── The pure rules ───────────────────────────────────────────────────────────

const entry = (...ids) => ({ segments: ids.map(id => ({ sourceBufferId: id })) })
const bytes = { a: 100, b: 100, c: 100, d: 100 }
const bytesOf = id => bytes[id] ?? 0

test('silence segments have no buffer and are skipped', () => {
  assert.deepEqual([...segmentBufferIds([{ sourceBufferId: 'a' }, { type: 'silence' }, null])], ['a'])
})

test('history is trimmed from the oldest step until what only it holds fits', () => {
  // Oldest first. Each step holds one buffer the timeline no longer plays.
  const undo = [entry('a'), entry('b'), entry('c')]
  const r = historyTrim({ undo, liveIds: new Set(['d']), bytesOf, budgetBytes: 250 })
  assert.equal(r.drop, 1, 'a goes; b and c (200 bytes) fit')
  assert.equal(r.heldBytes, 200)
})

test('audio the timeline still plays costs history nothing', () => {
  // Cuts and pastes rearrange the same open buffer: every step references "a".
  const undo = Array.from({ length: 40 }, () => entry('a'))
  const r = historyTrim({ undo, liveIds: new Set(['a']), bytesOf, budgetBytes: 1 })
  assert.equal(r.drop, 0)
  assert.equal(r.heldBytes, 0)
})

test('a buffer shared by several steps is counted once', () => {
  const undo = [entry('a'), entry('a', 'b'), entry('b')]
  const r = historyTrim({ undo, liveIds: new Set(), bytesOf, budgetBytes: 200 })
  assert.equal(r.drop, 0)
  assert.equal(r.heldBytes, 200)
})

test('the newest step is kept however large it is', () => {
  const r = historyTrim({ undo: [entry('a'), entry('b')], liveIds: new Set(), bytesOf, budgetBytes: 0 })
  assert.equal(r.drop, 1)
  assert.equal(r.heldBytes, 100)
})

test('redo is counted first and never dropped', () => {
  const r = historyTrim({
    undo: [entry('a'), entry('b')], redo: [entry('c')], liveIds: new Set(), bytesOf, budgetBytes: 250,
  })
  // c (100, redo) + b (100) fit; a would make 300.
  assert.equal(r.drop, 1)
  assert.equal(r.heldBytes, 200)
})

test('unreferencedBufferIds names pool entries no segment list reaches', () => {
  const out = unreferencedBufferIds(['a', 'b', 'c'], [[{ sourceBufferId: 'a' }], [{ sourceBufferId: 'c' }]])
  assert.deepEqual(out, ['b'])
})

// ── Through the editor ───────────────────────────────────────────────────────

const SECONDS = 4
const RATE = 1000
/** Shaped like an AudioBuffer for everything the editor reads: 4 s mono, 16 kB. */
function fakeBuffer() {
  return { duration: SECONDS, sampleRate: RATE, numberOfChannels: 1, length: SECONDS * RATE }
}
const BUFFER_BYTES = SECONDS * RATE * 4

/** A fresh editor with one open file and the history budget set for the test. */
function setup(t, budgetBytes) {
  const editor = useEditorState()
  // Other tests' files would count as live and as pool bytes: start clean.
  for (const d of [...editor.appState.documents]) editor.closeDocument(d.id)
  editor.appState.clipboard = null
  const prev = setHistoryBudgetBytes(budgetBytes)
  t.after(() => setHistoryBudgetBytes(prev))
  const { docId } = editor.createDocument(`budget-${Math.random()}.wav`, fakeBuffer())
  editor.appState.toasts = []
  return { editor, docId }
}

/** An apply over the whole file: a new buffer replaces the old one. */
function applyWhole(editor, docId, label = 'Gain') {
  editor.replaceRegion(0, SECONDS, fakeBuffer(), label, docId, null)
}

test('applies past the budget let go of their oldest steps and their audio', (t) => {
  const { editor, docId } = setup(t, 2.5 * BUFFER_BYTES)
  for (let i = 0; i < 5; i++) applyWhole(editor, docId)
  // History may hold 2.5 buffers: two steps survive.
  assert.equal(editor.state.undoCount, 2)
  // Current + the two the surviving steps hold. Without the release the pool
  // kept all six buffers until the file closed.
  assert.equal(editor.poolBytes.value, 3 * BUFFER_BYTES)
  editor.undo()
  editor.undo()
  assert.equal(editor.canUndo.value, false)
})

test('the user is told once per file that older steps were cleared', (t) => {
  const { editor, docId } = setup(t, 1.5 * BUFFER_BYTES)
  for (let i = 0; i < 4; i++) applyWhole(editor, docId)
  const notes = editor.appState.toasts.filter(x => /Older undo steps were cleared/.test(x.message))
  assert.equal(notes.length, 1)
})

test('the last apply can always be undone, even over the budget', (t) => {
  const { editor, docId } = setup(t, 0)
  applyWhole(editor, docId)
  applyWhole(editor, docId)
  assert.equal(editor.state.undoCount, 1)
  assert.equal(editor.undo(), true)
})

test('edits that only rearrange audio keep their whole history', (t) => {
  const { editor } = setup(t, 1)
  for (let i = 0; i < 10; i++) {
    editor.state.selection = { start: 0, end: 0.1 }
    editor.performCut()
  }
  assert.equal(editor.state.undoCount, 10)
})

test('a new edit after Undo releases the buffer only redo held', (t) => {
  const { editor, docId } = setup(t, 100 * BUFFER_BYTES)
  applyWhole(editor, docId)
  assert.equal(editor.poolBytes.value, 2 * BUFFER_BYTES)
  editor.undo()
  // Redo still holds the applied buffer.
  assert.equal(editor.poolBytes.value, 2 * BUFFER_BYTES)
  editor.state.selection = { start: 0, end: 1 }
  editor.performCut()
  // Redo is gone, and with it the only reference to the applied buffer.
  assert.equal(editor.poolBytes.value, BUFFER_BYTES)
})

test('steps past the 50-step cap now free their audio too', (t) => {
  const { editor, docId } = setup(t, Infinity)
  for (let i = 0; i < 55; i++) applyWhole(editor, docId)
  assert.equal(editor.state.undoCount, 50)
  assert.equal(editor.poolBytes.value, 51 * BUFFER_BYTES)
})

test('a buffer on the clipboard is kept even when no timeline uses it', (t) => {
  const { editor, docId } = setup(t, 0)
  editor.state.selection = { start: 0, end: 1 }
  editor.performCopy()
  applyWhole(editor, docId)
  applyWhole(editor, docId)
  // The original is held by the clipboard, so it costs history nothing and stays.
  assert.equal(editor.poolBytes.value, 3 * BUFFER_BYTES)
  editor.state.selection = null
  editor.performPaste(0)
  assert.ok(editor.totalDuration.value > SECONDS)
})

test('the history budget is half the device budget', () => {
  assert.equal(HISTORY_BUDGET_SHARE, 0.5)
})
