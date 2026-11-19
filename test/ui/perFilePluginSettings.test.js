import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

/**
 * Per-file plugin settings (perFilePluginSettings.js) on the REAL composables:
 * a tab switch saves the settings of the file being left and restores the ones
 * of the file being entered; a file with nothing saved keeps the last-used
 * settings (owner, November 2026). Same loader stub as pluginSettings.test.js.
 *
 * The CHAIN's per-file layout needs live audio nodes, so `npm run smoke`
 * drives it in Chromium (its "Per-file chain" step).
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
const { useLA2A } = await import('../../src/composables/useLA2A.js')
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

test('a manual INPUT trim belongs to its file, and a new file inherits it', () => {
  per.resetPerFilePluginSettings()
  const la2a = useLA2A('solo')
  const trim = () => (la2a.la2aInputAuto.value ? 'AUTO' : la2a.la2aInputDb.value)
  la2a.syncInput(6)                                    // dialled by hand on A
  per.onActiveDocumentChanged('B', 'A', ['A', 'B'])
  assert.equal(trim(), 6, 'B has nothing saved: it inherits the manual trim')
  la2a.syncInput(-4)                                   // re-dialled on B
  per.onActiveDocumentChanged('A', 'B', ['A', 'B'])
  assert.equal(trim(), 6, 'A keeps its own')
  la2a.resetInputAuto()                                // A handed back to AUTO
  per.onActiveDocumentChanged('B', 'A', ['A', 'B'])
  assert.equal(trim(), -4, 'B keeps its own')
  per.onActiveDocumentChanged('A', 'B', ['A', 'B'])
  assert.equal(trim(), 'AUTO', 'A is back on AUTO')
})

test('presets and saved chains still never carry the trim', async () => {
  const { pluginSettingsIO, chainSettingsOf } = await import('../../src/composables/pluginSettings.js')
  const la2a = useLA2A('solo')
  la2a.syncInput(9)
  const read = pluginSettingsIO('opto-smooth', 'solo').read()
  assert.ok(!('inputDb' in read) && !('inputAuto' in read))
  assert.ok(!('inputDb' in (chainSettingsOf('opto-smooth', read) ?? {})))
  la2a.resetInputAuto()
})
