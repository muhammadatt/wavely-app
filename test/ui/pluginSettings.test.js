import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'

/**
 * Saved plugin chains: every chainable plugin's settings round-trip through
 * src/composables/pluginSettings.js on the REAL composables, and the saved
 * chain's own shape is checked by its preset definition.
 *
 * Same loader stub as pluginSettingsExtra.test.js: Vite's `?worker&url`
 * imports and `import.meta.env` do not exist under Node.
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

const { PLUGIN_SETTINGS, pluginSettingsIO, writePluginSettings } =
  await import('../../src/composables/pluginSettings.js')
const { listPresets, presetParams, PLUGIN_CHAIN_PRESET_PLUGIN, PLUGIN_CHAIN_MAX_SLOTS, pickParams } =
  await import('../../src/audio/pluginPresets/index.js')

const roundTrip = v => JSON.parse(JSON.stringify(v))

test('every chainable registry entry has settings, and nothing else does', () => {
  // The registry imports .vue components, so it is read as source.
  const registry = readFileSync(new URL('../../src/ui/registry.js', import.meta.url), 'utf8')
  const chainable = []
  for (const m of registry.matchAll(/\n {4}id: '([^']+)',[\s\S]*?\n {2}\},/g)) {
    if (/\bchain: true\b/.test(m[0])) chainable.push(m[1])
  }
  assert.ok(chainable.length >= 15)
  assert.deepEqual(Object.keys(PLUGIN_SETTINGS).sort(), chainable.sort())
})

/**
 * For each plugin with a preset collection: every preset it ships, written
 * into one chain copy, reads back as that preset; and the read, through JSON,
 * written into a second copy, reads back identically.
 */
for (const [id, entry] of Object.entries(PLUGIN_SETTINGS)) {
  if (!entry.presetPlugin) continue
  test(`${id}: factory presets survive a save and load`, () => {
    const presets = listPresets(entry.presetPlugin).filter(p => p.source === 'factory')
    assert.ok(presets.length, 'has a factory preset to try')
    for (const p of presets) {
      const params = presetParams(entry.presetPlugin, p.id)
      assert.ok(writePluginSettings(id, 'chain-1', params))
      const saved = pickParams(entry.presetPlugin, roundTrip(pluginSettingsIO(id, 'chain-1').read()))
      assert.deepEqual(saved, params, `${p.name} reads back as itself`)
      assert.ok(writePluginSettings(id, 'chain-2', saved))
      assert.deepEqual(
        pickParams(entry.presetPlugin, roundTrip(pluginSettingsIO(id, 'chain-2').read())), saved,
        `${p.name} reproduces on another copy`,
      )
    }
  })
}

test('nothing to write is a no-op, not an error', () => {
  assert.equal(writePluginSettings('air-band', 'chain-3', null), false)
  assert.equal(writePluginSettings('no-such-plugin', 'chain-1', {}), false)
})

test('a saved chain keeps its slots and drops what is not one', () => {
  const pick = p => pickParams(PLUGIN_CHAIN_PRESET_PLUGIN, p)
  assert.deepEqual(pick({ slots: 'x' }), { slots: [] })
  assert.deepEqual(pick({
    slots: [
      { plugin: 'air-band', active: true, settings: { air: 3, output: 0 } },
      { plugin: 'inflator', active: false, settings: [1, 2] },
      { plugin: '', active: true },
      null,
      { plugin: 'some-future-plugin', settings: { x: 1 } },
    ],
  }), {
    slots: [
      { plugin: 'air-band', active: true, settings: { air: 3, output: 0 } },
      { plugin: 'inflator', active: false, settings: null },
      // Kept: an unknown plugin is skipped with a note at load, not lost here.
      { plugin: 'some-future-plugin', active: true, settings: { x: 1 } },
    ],
  })
  const many = { slots: Array.from({ length: 50 }, () => ({ plugin: 'air-band' })) }
  assert.equal(pick(many).slots.length, PLUGIN_CHAIN_MAX_SLOTS)
})
