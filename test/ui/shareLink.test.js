/**
 * Shared chain / preset links (src/audio/shareLink.js, useSharedLink.js).
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeShare, decodeShare, shareUrl, shareCodeFromHash, hashWithoutShare,
  SHARE_MAX_JSON_BYTES,
} from '../../src/audio/shareLink.js'
import { register } from 'node:module'

// The loader stub pluginSettings.test.js uses: Vite's `?worker&url` imports and
// `import.meta.env` do not exist under Node.
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

const { pluginForPresetCollection, resolveOffer } = await import('../../src/composables/shareOffer.js')
const { PLUGIN_SETTINGS } = await import('../../src/composables/pluginSettings.js')

const chain = {
  v: 1,
  kind: 'chain',
  name: 'Narration polish',
  params: {
    slots: [
      { plugin: 'de-esser', active: true, settings: { duck: 24, eq: 12 } },
      { plugin: 'opto-smooth', active: false, settings: { peakReduction: 55 } },
    ],
  },
}

test('a chain round-trips through a compressed link', async () => {
  const code = await encodeShare(chain)
  assert.equal(code[0], 'z')
  assert.match(code, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(await decodeShare(code), chain)
})

test('a preset round-trips, and the plain-JSON form decodes too', async () => {
  const preset = { v: 1, kind: 'preset', preset: 'opto-smooth', name: 'Gentle', params: { peakReduction: 40 } }
  assert.deepEqual(await decodeShare(await encodeShare(preset)), preset)
  const plain = 'j' + Buffer.from(JSON.stringify(preset)).toString('base64url')
  assert.deepEqual(await decodeShare(plain), preset)
})

test('names are cleaned and defaulted', async () => {
  const out = await decodeShare(await encodeShare({ ...chain, name: `  a\n\n${'x'.repeat(80)}` }))
  assert.equal(out.name.length, 48)
  assert.ok(out.name.startsWith('a x'))
  const unnamed = await decodeShare(await encodeShare({ ...chain, name: undefined }))
  assert.equal(unnamed.name, 'Shared chain')
})

test('junk never throws and never decodes', async () => {
  for (const code of ['', 'z', 'q' + 'abc', 'zzzz!!', 'j' + Buffer.from('not json').toString('base64url'),
    'j' + Buffer.from(JSON.stringify({ v: 2, kind: 'chain', params: { slots: [{}] } })).toString('base64url'),
    'j' + Buffer.from(JSON.stringify({ v: 1, kind: 'chain', params: { slots: [] } })).toString('base64url'),
    'j' + Buffer.from(JSON.stringify({ v: 1, kind: 'preset', params: {} })).toString('base64url'),
    null, 42]) {
    assert.equal(await decodeShare(code), null, String(code))
  }
})

test('a compressed bomb is refused rather than inflated whole', async () => {
  const huge = { ...chain, params: { slots: [{ plugin: 'de-esser', settings: { pad: 'a'.repeat(SHARE_MAX_JSON_BYTES * 4) } }] } }
  const json = new TextEncoder().encode(JSON.stringify(huge))
  const z = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
  const code = 'z' + Buffer.from(z).toString('base64url')
  assert.ok(code.length < 4096, 'the bomb is small on the wire')
  assert.equal(await decodeShare(code), null)
  await assert.rejects(encodeShare(huge))
})

test('the link lives in the fragment and leaves other fragments alone', () => {
  assert.equal(shareUrl('zABC', 'https://example.test/'), 'https://example.test/#share=zABC')
  assert.equal(shareCodeFromHash('#share=zABC'), 'zABC')
  assert.equal(shareCodeFromHash('#/account/billing'), null)
  assert.equal(shareCodeFromHash(''), null)
  assert.equal(hashWithoutShare('#share=zABC'), '')
  assert.equal(hashWithoutShare('#/account/billing'), '#/account/billing')
})

test('every preset collection maps back to the plugin that owns it', () => {
  for (const [opId, entry] of Object.entries(PLUGIN_SETTINGS)) {
    if (entry.presetPlugin) assert.equal(pluginForPresetCollection(entry.presetPlugin), opId)
  }
  assert.equal(pluginForPresetCollection('no-such-collection'), null)
})

test('an offer names the plugins and marks the ones this build lacks', () => {
  const ops = { 'de-esser': { id: 'de-esser', label: 'De-Esser' }, 'opto-smooth': { id: 'opto-smooth', label: 'LA Vintage 2A' } }
  const ctx = { chainIds: ['de-esser'], getOperation: id => ops[id] ?? null }
  const offer = resolveOffer({ ...chain, params: { slots: [{ plugin: 'de-esser', active: false }, { plugin: 'gone-plugin' }, { plugin: 'opto-smooth' }] } }, ctx)
  assert.deepEqual(offer.plugins.map(p => [p.label, p.available, p.active]),
    [['De-Esser', true, false], ['gone-plugin', false, true], ['LA Vintage 2A', false, true]])
  assert.equal(resolveOffer({ ...chain, params: { slots: [{ plugin: 'gone-plugin' }] } }, ctx), null)
  assert.equal(resolveOffer({ v: 1, kind: 'preset', preset: 'nope', name: 'x', params: {} }, ctx), null)
  const preset = resolveOffer({ v: 1, kind: 'preset', preset: PLUGIN_SETTINGS['opto-smooth'].presetPlugin, name: 'x', params: {} }, ctx)
  assert.equal(preset.opId, 'opto-smooth')
  assert.equal(preset.pluginLabel, 'LA Vintage 2A')
})
