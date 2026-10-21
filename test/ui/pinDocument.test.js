/**
 * Applies are pinned to the document they started on.
 *
 * File tabs stay usable while an apply renders, and `state` follows the active
 * tab, so the state API's docId defaults (the active document) would commit a
 * render into the file the user switched to and leave the original stuck on
 * "processing". Every apply passes the docId it captured; the plugins' applies
 * also refuse to commit at all if the active file changed (pinActiveDocument),
 * because their measurements and renders may have read either file.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { useEditorState, DocumentSwitchedError } from '../../src/composables/useEditorState.js'

const fakeBuffer = () => ({ duration: 4, sampleRate: 48000, numberOfChannels: 1 })

test('a pinned job passes while its document is active and refuses once the user switches', () => {
  const editor = useEditorState()
  const { docId: a } = editor.createDocument('a.wav', fakeBuffer())
  const pin = editor.pinActiveDocument('HF Limiter')
  assert.equal(pin.docId, a)
  pin.check()
  const { docId: b } = editor.createDocument('b.wav', fakeBuffer())
  assert.equal(editor.appState.activeDocumentId, b)
  assert.throws(() => pin.check(), (err) => {
    assert.ok(err instanceof DocumentSwitchedError)
    assert.equal(err.message, 'HF Limiter was not applied: you switched files while it rendered')
    return true
  })
  // Back on the original file, the job may commit again.
  editor.setActiveDocument(a)
  pin.check()
})

test('processing status lands on the pinned document, not the active one', () => {
  const editor = useEditorState()
  const { docId: a } = editor.createDocument('status-a.wav', fakeBuffer())
  editor.startProcessing('Applying...', a)
  const { docId: b } = editor.createDocument('status-b.wav', fakeBuffer())
  editor.endProcessing(a)
  assert.equal(editor.getDocument(a).isProcessing, false)
  assert.equal(editor.getDocument(b).isProcessing, false)
})

const ROOT = new URL('../../', import.meta.url).pathname
function sources(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(js|vue)$/.test(e.name) ? [p] : []
  })
}

test('no apply commits or clears status through the active-document default', () => {
  const offenders = []
  for (const f of sources('src')) {
    if (f.endsWith('useEditorState.js')) continue
    const src = readFileSync(join(ROOT, f), 'utf8')
    // Every call names its document: the line carries a docId (`docId`,
    // `pin.docId`, or a job's own id). A call without one relies on the default.
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      if (!/\b(startProcessing|endProcessing|replaceRegion)\(/.test(line)) return
      if (/^\s*(\*|\/\/)/.test(line) || /function (startProcessing|endProcessing|replaceRegion)\b/.test(line)) return
      // A call broken over lines ends on the line that closes it.
      let call = line
      for (let j = i + 1; j < lines.length && /\($|,$/.test(call.trimEnd()); j++) call += lines[j]
      if (!/docId/i.test(call)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [])
})
