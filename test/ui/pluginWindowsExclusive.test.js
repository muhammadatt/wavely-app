import { test } from 'node:test'
import assert from 'node:assert/strict'

import { useWindows, setChainSlotPredicate } from '../../src/composables/useWindows.js'

/**
 * Plugin windows open in two groups that never share the screen: the Plugin
 * Chain with the windows of its own plugins, or one plugin on its own. The
 * analyzer stays open beside either.
 */

// Stand in for the chain: these window ids have a slot.
function withSlots(...ids) {
  const slots = new Set(ids)
  setChainSlotPredicate(id => slots.has(id))
  const w = useWindows()
  w.closeAllWindows()
  return w
}

test('a plugin outside the chain replaces the plugin window already open', () => {
  const w = withSlots()
  w.openWindow('inflator')
  w.openWindow('opto-smooth')
  assert.deepEqual([...w.windows], ['opto-smooth'])
  // Peak Normalize is a plugin window for this rule too.
  w.openWindow('normalize')
  assert.deepEqual([...w.windows], ['normalize'])
})

test('the chain is a plugin window: it closes a plugin outside it, and is closed by one', () => {
  const w = withSlots()
  w.openWindow('inflator')
  w.openWindow('plugin-chain')
  assert.deepEqual([...w.windows], ['plugin-chain'])
  w.openWindow('air-band')
  assert.deepEqual([...w.windows], ['air-band'])
})

test('the chain and the plugins in it open together', () => {
  const w = withSlots('inflator', 'air-band')
  w.openWindow('plugin-chain')
  w.openWindow('inflator')
  w.openWindow('air-band')
  assert.deepEqual([...w.windows], ['plugin-chain', 'inflator', 'air-band'])
  // A plugin outside the chain takes the whole group off the screen.
  w.openWindow('opto-smooth')
  assert.deepEqual([...w.windows], ['opto-smooth'])
  // And a chain plugin takes the solo plugin off it.
  w.openWindow('inflator')
  assert.deepEqual([...w.windows], ['inflator'])
})

test('the analyzer stays open beside either group', () => {
  const w = withSlots('inflator')
  w.openWindow('spectrum-analyzer')
  w.openWindow('plugin-chain')
  w.openWindow('inflator')
  w.openWindow('opto-smooth')
  assert.deepEqual([...w.windows], ['spectrum-analyzer', 'opto-smooth'])
  // Reopening an open window only raises it.
  w.openWindow('spectrum-analyzer')
  assert.deepEqual([...w.windows], ['opto-smooth', 'spectrum-analyzer'])
  w.closeAllWindows()
  setChainSlotPredicate(() => false)
})
