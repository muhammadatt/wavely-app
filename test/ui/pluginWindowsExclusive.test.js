import { test } from 'node:test'
import assert from 'node:assert/strict'

import { useWindows } from '../../src/composables/useWindows.js'

/**
 * Plugins open one at a time: multi-plugin work belongs to the Plugin Chain.
 * The chain and the analyzer are the windows allowed beside a plugin.
 */

test('opening a plugin replaces the plugin window already open', () => {
  const w = useWindows()
  w.closeAllWindows()
  w.openWindow('inflator')
  w.openWindow('opto-smooth')
  assert.deepEqual([...w.windows], ['opto-smooth'])
  // Peak Normalize is a plugin window for this rule too.
  w.openWindow('normalize')
  assert.deepEqual([...w.windows], ['normalize'])
})

test('the chain and the analyzer stay open beside a plugin', () => {
  const w = useWindows()
  w.closeAllWindows()
  w.openWindow('plugin-chain')
  w.openWindow('spectrum-analyzer')
  w.openWindow('inflator')
  w.openWindow('air-band')
  assert.deepEqual([...w.windows], ['plugin-chain', 'spectrum-analyzer', 'air-band'])
  // Reopening an open window only raises it.
  w.openWindow('plugin-chain')
  assert.deepEqual([...w.windows], ['spectrum-analyzer', 'air-band', 'plugin-chain'])
  w.closeAllWindows()
})
