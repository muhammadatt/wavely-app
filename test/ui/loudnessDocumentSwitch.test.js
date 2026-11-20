import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

/**
 * Loudness Normalize's measurement across a tab switch
 * (src/composables/useLoudnessNormalize.js).
 *
 * The measurement is single-flight: a request that arrives while a pass is in
 * the worker only queues one re-run. So a pass still measuring the file just
 * LEFT lands after the switch — and must be thrown away, not shown as the new
 * file's reading (which would also enable Apply with the other file's plan).
 *
 * `measureRegionLoudness` is stubbed so the test decides when each pass lands;
 * everything else is the real composable.
 */
const HOOKS = `
const SRC = ${JSON.stringify(new URL('../../src/', import.meta.url).href)}
const STUB = 'data:text/javascript,' + encodeURIComponent(
  'export const measureRegionLoudness = (...a) => globalThis.__loudnessMeasure(...a);' +
  'export const loudnessNormalizeRegion = () => { throw new Error("not in this test") };' +
  'export const computePeakCache = async () => null;')
export async function resolve(specifier, context, next) {
  if (/\\?(worker|url|raw)\\b/.test(specifier)) {
    return { url: 'data:text/javascript,export default "stub:asset"', shortCircuit: true }
  }
  if (specifier.endsWith('/audio/processing.js')) return { url: STUB, shortCircuit: true }
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

/** Each call parks here until the test resolves it with that file's reading. */
const pending = []
globalThis.__loudnessMeasure = segments => new Promise((resolve) => {
  pending.push({ file: segments.file, resolve })
})
const settle = () => new Promise(r => setTimeout(r, 0))

const { effectScope, nextTick } = await import('vue')
const { useEditorState } = await import('../../src/composables/useEditorState.js')
const { useLoudnessNormalize } = await import('../../src/composables/useLoudnessNormalize.js')

/** A reading as measureRegionLoudness returns it. */
const reading = lufs => ({ lufs, truePeakDb: -1, rmsDb: lufs, samplePeakDb: -1, short: false, silent: false })

function doc(id) {
  // `segments` carries the file's id so the stub knows which file a pass measures.
  const segments = Object.assign([], { file: id })
  return {
    id, name: id, segments, selection: { start: 0, end: 10 }, revision: 0,
    currentFile: { sampleRate: 44100, channels: 1 },
  }
}

test('a pass still measuring the file left behind is thrown away', async () => {
  const { appState } = useEditorState()
  appState.documents.push(doc('loud-a'), doc('quiet-b'))
  appState.activeDocumentId = 'loud-a'
  const scope = effectScope()
  const ln = scope.run(() => useLoudnessNormalize())

  assert.equal(pending.length, 1, 'opening measures the active file')
  assert.equal(pending[0].file, 'loud-a')

  // Switch while A's pass is still in the worker.
  appState.activeDocumentId = 'quiet-b'
  await nextTick()

  // A's pass lands late.
  pending.shift().resolve(reading(-14))
  await settle()
  assert.equal(ln.measurement.value, null, 'A\'s reading must not be shown as B\'s')
  assert.equal(ln.canApply.value, false, 'nor enable Apply with A\'s plan')

  // The queued re-run measures B.
  assert.equal(pending.length, 1, 'B is measured next')
  assert.equal(pending[0].file, 'quiet-b')
  pending.shift().resolve(reading(-30))
  await settle()
  assert.equal(ln.measurement.value.lufs, -30, 'B\'s own reading')
  assert.equal(ln.canApply.value, true)

  scope.stop()
  appState.activeDocumentId = null
  appState.documents.splice(0)
})
