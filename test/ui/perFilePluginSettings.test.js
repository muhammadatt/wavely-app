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

test('a manual INPUT trim belongs to its file; a new file starts it on AUTO', () => {
  per.resetPerFilePluginSettings()
  const la2a = useLA2A('solo')
  const trim = () => (la2a.la2aInputAuto.value ? 'AUTO' : la2a.la2aInputDb.value)
  la2a.syncPeakReduction(63)
  la2a.syncInput(6)                                    // dialled by hand on A
  per.onActiveDocumentChanged('B', 'A', ['A', 'B'])
  assert.equal(trim(), 'AUTO', 'B has nothing saved: the trim starts on AUTO')
  assert.equal(la2a.la2aPeakReduction.value, 63, '…while the other settings are inherited')
  la2a.syncInput(-4)                                   // dialled on B
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

test('a switch during a chain Apply never saves the Apply\'s rack as another file\'s', () => {
  const live = { bypassed: false, slots: [{ plugin: 'inflator' }] }   // file A's rack, frozen by its Apply
  const previous = { bypassed: false, slots: [{ plugin: 'air-band' }] } // what B had saved
  assert.equal(per.chainToSave({ docId: 'A', owner: 'A', live, previous: null }), live, 'the owner saves the live rack')
  assert.equal(per.chainToSave({ docId: 'B', owner: 'A', live, previous }), previous, 'B keeps its own chain')
  assert.equal(per.chainToSave({ docId: 'C', owner: 'A', live, previous: undefined }), live, 'nothing saved yet: inherited')
  assert.equal(per.chainToSave({ docId: 'B', owner: null, live, previous }), live, 'no owner yet: the live rack')
})

test('a file closed while another is active is forgotten without a tab switch', async () => {
  const { nextTick } = await import('vue')
  per.resetPerFilePluginSettings()
  const { appState } = useEditorState()
  per.installPerFilePluginSettings()
  appState.documents.push({ id: 'keep' }, { id: 'gone' })
  per.savePluginSettingsFor('keep')
  per.savePluginSettingsFor('gone')
  assert.deepEqual(per.savedDocumentIds().sort(), ['gone', 'keep'])
  appState.documents.splice(appState.documents.findIndex(d => d.id === 'gone'), 1)
  await nextTick()
  assert.deepEqual(per.savedDocumentIds(), ['keep'])
  appState.documents.splice(0)
  await nextTick()
})
