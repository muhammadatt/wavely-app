/**
 * The decisions behind every plugin window's open / close / apply
 * (src/composables/usePluginWindow.js), without a component.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { shouldEngageOnOpen, pluginWindowActions } = await import('../../src/composables/usePluginWindow.js')

test('opening a window switches on the solo copy only, and only when it is off', () => {
  assert.equal(shouldEngageOnOpen(false, 'solo'), true)
  assert.equal(shouldEngageOnOpen(true, 'solo'), false, 'already on: opening must not toggle it off')
  assert.equal(shouldEngageOnOpen(false, 'chain-1'), false, 'a chain slot keeps its ON/BYPASS')
  assert.equal(shouldEngageOnOpen(false, 'chain-3'), false)
})

function recorder(applyResult) {
  const calls = []
  return {
    calls,
    apply: async () => { calls.push('apply'); return applyResult },
    teardown: () => calls.push('teardown'),
    closeModal: () => calls.push('close'),
  }
}

test('a live plugin applies, stops its preview and meters, then closes', async () => {
  const r = recorder(undefined)
  await pluginWindowActions(r).applyAndClose()
  assert.deepEqual(r.calls, ['apply', 'teardown', 'close'])
})

test('closing a live plugin window stops its preview and meters', () => {
  const r = recorder()
  pluginWindowActions(r).close()
  assert.deepEqual(r.calls, ['teardown'])
})

test('an offline plugin closes only when its run committed', async () => {
  const ok = recorder(true)
  await pluginWindowActions({ ...ok, teardown: undefined, closeOnlyOnSuccess: true }).applyAndClose()
  assert.deepEqual(ok.calls, ['apply', 'close'])

  const refused = recorder(false)
  await pluginWindowActions({ ...refused, teardown: undefined, closeOnlyOnSuccess: true }).applyAndClose()
  assert.deepEqual(refused.calls, ['apply'], 'a refused or cancelled run leaves the window open')
})

test('Preview asks the transport to play or stop', () => {
  const seen = []
  globalThis.window = {
    dispatchEvent: e => seen.push(e.type),
  }
  globalThis.CustomEvent ??= class { constructor(type) { this.type = type } }
  try {
    pluginWindowActions(recorder()).togglePlayback()
    assert.deepEqual(seen, ['wavely:toggle-play'])
  } finally {
    delete globalThis.window
  }
})
