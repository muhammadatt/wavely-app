import { test } from 'node:test'
import assert from 'node:assert/strict'

import { useWindows, isSoloPluginWindow } from '../../src/composables/useWindows.js'

/**
 * Plugin windows open in two groups that never share the screen: the Plugin
 * Chain with the windows of its plugins' chain copies (`<id>@chain-<n>`), or one
 * plugin's solo copy on its own. The analyzer stays open beside either.
 */

function fresh() {
  const w = useWindows()
  w.closeAllWindows()
  return w
}

test('a plugin outside the chain replaces the plugin window already open', () => {
  const w = fresh()
  w.openWindow('inflator')
  w.openWindow('opto-smooth')
  assert.deepEqual([...w.windows], ['opto-smooth'])
  // Peak Normalize is a plugin window for this rule too.
  w.openWindow('normalize')
  assert.deepEqual([...w.windows], ['normalize'])
})

test('the chain is a plugin window: it closes a plugin outside it, and is closed by one', () => {
  const w = fresh()
  w.openWindow('inflator')
  w.openWindow('plugin-chain')
  assert.deepEqual([...w.windows], ['plugin-chain'])
  w.openWindow('air-band')
  assert.deepEqual([...w.windows], ['air-band'])
})

test('the chain and the plugins in it open together', () => {
  const w = fresh()
  w.openWindow('plugin-chain')
  w.openWindow('inflator@chain-1')
  w.openWindow('air-band@chain-1')
  assert.deepEqual([...w.windows], ['plugin-chain', 'inflator@chain-1', 'air-band@chain-1'])
  // A plugin outside the chain takes the whole group off the screen.
  w.openWindow('opto-smooth')
  assert.deepEqual([...w.windows], ['opto-smooth'])
  // And a chain copy takes the solo plugin off it — and brings the chain
  // with it, since that is where its Apply lives.
  w.openWindow('inflator@chain-1')
  assert.deepEqual([...w.windows], ['plugin-chain', 'inflator@chain-1'])
})

test('a plugin that is also in the chain still opens on its own, as its solo copy', () => {
  const w = fresh()
  w.openWindow('plugin-chain')
  w.openWindow('inflator@chain-1')
  // From the Effects menu: the solo Cambridge Inflator, with an Apply of its own. Its
  // chain copy keeps its slot; only the chain group's windows close.
  w.openWindow('inflator')
  assert.deepEqual([...w.windows], ['inflator'])
  w.closeAllWindows()
})

test('a solo plugin window is what suspends the chain, whatever its ON says', () => {
  assert.equal(isSoloPluginWindow('opto-smooth'), true)
  assert.equal(isSoloPluginWindow('normalize'), true, 'no live preview, still a solo window')
  assert.equal(isSoloPluginWindow('inflator'), true, 'the solo copy, even with a chain copy in the chain')
  assert.equal(isSoloPluginWindow('inflator@chain-1'), false)
  assert.equal(isSoloPluginWindow('plugin-chain'), false)
  assert.equal(isSoloPluginWindow('spectrum-analyzer'), false)
})

test('the analyzer stays open beside either group', () => {
  const w = fresh()
  w.openWindow('spectrum-analyzer')
  w.openWindow('plugin-chain')
  w.openWindow('inflator@chain-1')
  w.openWindow('opto-smooth')
  assert.deepEqual([...w.windows], ['spectrum-analyzer', 'opto-smooth'])
  // Reopening an open window only raises it.
  w.openWindow('spectrum-analyzer')
  assert.deepEqual([...w.windows], ['opto-smooth', 'spectrum-analyzer'])
  w.closeAllWindows()
})
