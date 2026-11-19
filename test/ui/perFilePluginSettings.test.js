import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

/**
 * Per-file plugin settings (perFilePluginSettings.js) on the REAL composables:
 * a tab switch saves the settings of the file being left and restores the ones
 * of the file being entered; a file with nothing saved keeps the last-used
 * settings (owner, November 2026). Same loader stub as pluginSettings.test.js.
 */
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

const { pluginSettingsIO } = await import('../../src/composables/pluginSettings.js')
const { pluginCopies } = await import('../../src/composables/pluginCopies.js')
const { useEditorState } = await import('../../src/composables/useEditorState.js')
const per = await import('../../src/composables/perFilePluginSettings.js')

const inflator = (copy = 'solo') => pluginSettingsIO('inflator', copy)
const effectOf = (copy = 'solo') => inflator(copy).read().effect
const setEffect = (v, copy = 'solo') => inflator(copy).write({ ...inflator(copy).read(), effect: v })

test('each file keeps its own settings; a new file inherits the last used', () => {
  per.resetPerFilePluginSettings()
  setEffect(20)                                        // tuned on A
  per.onActiveDocumentChanged('B', 'A', ['A', 'B'])
  assert.equal(effectOf(), 20, 'B has nothing saved: it inherits the last-used settings')
  setEffect(70)                                        // retuned on B
  per.onActiveDocumentChanged('A', 'B', ['A', 'B'])
  assert.equal(effectOf(), 20, 'back on A: its own settings')
  per.onActiveDocumentChanged('C', 'A', ['A', 'B', 'C'])
  assert.equal(effectOf(), 20, 'C inherits what was last used (on A)')
  per.onActiveDocumentChanged('B', 'C', ['A', 'B', 'C'])
  assert.equal(effectOf(), 70, 'back on B: its own settings')
})

test('chain copies are per file too', () => {
  per.resetPerFilePluginSettings()
  setEffect(10, 'chain-1')
  per.onActiveDocumentChanged('B', 'A', ['A', 'B'])
  setEffect(90, 'chain-1')
  per.onActiveDocumentChanged('A', 'B', ['A', 'B'])
  assert.equal(effectOf('chain-1'), 10)
  per.onActiveDocumentChanged('B', 'A', ['A', 'B'])
  assert.equal(effectOf('chain-1'), 90)
})

test('a closed file forgets its settings and is not saved on the way out', () => {
  per.resetPerFilePluginSettings()
  setEffect(30)
  per.onActiveDocumentChanged('B', 'A', ['A', 'B'])
  setEffect(60)
  // B is closed: the switch to A happens with B already gone from the list.
  per.onActiveDocumentChanged('A', 'B', ['A'])
  assert.equal(effectOf(), 30, 'A restored')
  setEffect(45)
  per.onActiveDocumentChanged('B', 'A', ['A', 'B'])  // a NEW file that reuses the id
  assert.equal(effectOf(), 45, 'the closed file\'s settings are gone; the new one inherits')
})

test('the installed watcher follows the editor\'s active document', () => {
  per.resetPerFilePluginSettings()
  const { appState } = useEditorState()
  appState.documents.push({ id: 'doc-x' }, { id: 'doc-y' })
  appState.activeDocumentId = 'doc-x'
  per.installPerFilePluginSettings()
  setEffect(15)
  appState.activeDocumentId = 'doc-y'
  setEffect(85)
  appState.activeDocumentId = 'doc-x'
  assert.equal(effectOf(), 15)
  appState.activeDocumentId = 'doc-y'
  assert.equal(effectOf(), 85)
  appState.documents.splice(0)
  appState.activeDocumentId = null
})

test('pluginCopies reports built copies and a new serial for a rebuilt copy', () => {
  const lives = new Map()
  const get = pluginCopies((copy, life) => { lives.set(copy, life); return {} })
  assert.deepEqual(get.built(), [])
  assert.equal(get.serial('chain-1'), 0)
  get('chain-1')
  assert.deepEqual(get.built(), ['chain-1'])
  const first = get.serial('chain-1')
  assert.ok(first > 0)
  lives.get('chain-1').dispose()   // the slot is removed…
  assert.deepEqual(get.built(), [])
  get('chain-1')                   // …and added again
  assert.notEqual(get.serial('chain-1'), first)
})
