/**
 * The shared render-and-commit behind Peak / Loudness Normalize, Volume and
 * Fade (src/composables/regionApply.js), against a fake editor — and the rules
 * that moved out of their panels with it.
 *
 * Same loader stub as pluginSettings.test.js: the composables' imports reach
 * Vite-only `?worker&url` specifiers.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

const HOOKS = `
const SRC = ${JSON.stringify(new URL('../../src/', import.meta.url).href)}
export async function resolve(specifier, context, next) {
  if (/\\?(worker|url|raw)\\b/.test(specifier)) {
    return { url: 'data:text/javascript,export default "stub:asset"', shortCircuit: true }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  const out = await next(url, context)
  if (url.startsWith(SRC) && out.format === 'module') {
    out.source = 'if (!import.meta.env) import.meta.env = {};\\n' + String(out.source)
  }
  return out
}`
register('data:text/javascript,' + encodeURIComponent(HOOKS))

const { applyToRegion } = await import('../../src/composables/regionApply.js')
const { DocumentSwitchedError, DocumentEditedError } = await import('../../src/composables/useEditorState.js')
const { fadeEdgeWarning } = await import('../../src/composables/useFade.js')
const { loudnessToast } = await import('../../src/composables/useLoudnessNormalize.js')

/** A fake editor recording what was called, in order. */
function fakeEditor({ busy = false, check = () => {} } = {}) {
  const log = []
  const editor = {
    state: { currentFile: { sampleRate: 48000, channels: 2 }, segments: ['seg'] },
    editBlockedByProcessing: () => { log.push('blocked?'); return busy },
    pinActiveDocument: (what) => {
      log.push(`pin ${what}`)
      return { docId: 'doc-1', selection: { start: 1, end: 2 }, check: () => { log.push('check'); check() } }
    },
    startProcessing: (msg, docId) => log.push(`start ${msg} ${docId}`),
    endProcessing: docId => log.push(`end ${docId}`),
    getAudioContext: () => 'ctx',
    replaceRegion: (s, e, buf, label, docId, sel) => { log.push(`replace ${s}-${e} ${buf} ${label} ${docId} ${sel.start}-${sel.end}`); return 'buf-id' },
    setPeakCache: (id, cache) => log.push(`cache ${id} ${cache}`),
    showToast: msg => log.push(`toast ${msg}`),
  }
  return { editor, log }
}

const peakCache = async buf => `peaks(${buf})`

const opts = (render, extra = {}) => ({
  what: 'The thing', label: 'the thing', busy: 'Working...', start: 1, end: 2, render, ...extra,
})

test('renders from the timeline as it is, then checks the pin, then commits to the pinned file', async () => {
  const { editor, log } = fakeEditor()
  let seen
  const out = await applyToRegion(opts(async (r) => { seen = r; return { buffer: 'B', extra: 7 } }), { editor, peakCache })
  assert.deepEqual(out, { buffer: 'B', extra: 7 })
  assert.deepEqual(seen, { segments: ['seg'], start: 1, end: 2, ctx: 'ctx', sampleRate: 48000, channels: 2 })
  assert.deepEqual(log, [
    'blocked?',
    'pin The thing',
    'start Working... doc-1',
    'check',
    'replace 1-2 B the thing doc-1 1-2',
    'cache buf-id peaks(B)',
    'end doc-1',
  ])
})

test('refuses while the file is already processing, before pinning or rendering', async () => {
  const { editor, log } = fakeEditor({ busy: true })
  let rendered = false
  const out = await applyToRegion(opts(async () => { rendered = true; return { buffer: 'B' } }), { editor, peakCache })
  assert.equal(out, null)
  assert.equal(rendered, false)
  assert.deepEqual(log, ['blocked?'])
})

for (const [name, Err] of [['switched files', DocumentSwitchedError], ['edited the file', DocumentEditedError]]) {
  test(`commits nothing when the user ${name} during the render, and says why`, async () => {
    const { editor, log } = fakeEditor({ check: () => { throw new Err('The thing') } })
    const out = await applyToRegion(opts(async () => ({ buffer: 'B' })), { editor, peakCache })
    assert.equal(out, null)
    assert.ok(!log.some(l => l.startsWith('replace')), 'nothing replaced')
    assert.ok(log.includes(`toast ${new Err('The thing').message}`))
    assert.equal(log.at(-1), 'end doc-1', 'the pinned file stops processing')
  })
}

test('a failed render reports its own message and releases the file', async () => {
  const { editor, log } = fakeEditor()
  const out = await applyToRegion(
    opts(async () => { throw new Error('boom') }, { failed: err => `Thing failed: ${err.message}` }),
    { editor, peakCache },
  )
  assert.equal(out, null)
  assert.ok(log.includes('toast Thing failed: boom'))
  assert.equal(log.at(-1), 'end doc-1')
})

test('an empty region does nothing at all', async () => {
  const { editor, log } = fakeEditor()
  assert.equal(await applyToRegion(opts(async () => ({ buffer: 'B' }), { start: 2, end: 2 }), { editor, peakCache }), null)
  assert.deepEqual(log, [])
})

test('a fade warns where it meets audio at full level, and only there', () => {
  assert.equal(fadeEdgeWarning('in', { start: 0, end: 3 }, 10), '')
  assert.match(fadeEdgeWarning('in', { start: 2, end: 3 }, 10), /before the selection/)
  assert.equal(fadeEdgeWarning('out', { start: 7, end: 10 }, 10), '')
  assert.match(fadeEdgeWarning('out', { start: 2, end: 3 }, 10), /after the selection/)
  assert.equal(fadeEdgeWarning('in', null, 10), '')
})

test('the loudness toast names how a render fell short', () => {
  assert.equal(loudnessToast({ shortfallDb: 0, converged: true, achievedDb: -16 }, 'LUFS'), 'Loudness normalized')
  assert.match(loudnessToast({ shortfallDb: 2.4, converged: true, achievedDb: -18.4 }, 'LUFS'), /2\.4 dB short of target/)
  assert.match(loudnessToast({ shortfallDb: 0, converged: false, achievedDb: -17 }, 'RMS'), /would not allow more/)
})
