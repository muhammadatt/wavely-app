import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  baseId, idForCopy, copyOfId, isChainCopyId, effectForCopy, pluginCopies,
} from '../../src/composables/pluginCopies.js'

/**
 * Every chainable plugin exists twice: the solo copy, opened from the Effects
 * menu with an Apply of its own, and the chain's copy, which holds its slot.
 * The two must never share state, a node or a window.
 */

test('a chain copy is the solo id with a suffix, and maps back', () => {
  assert.equal(idForCopy('inflator', 'chain'), 'inflator@chain')
  assert.equal(idForCopy('inflator', 'solo'), 'inflator')
  assert.equal(idForCopy('inflator@chain', 'solo'), 'inflator')
  assert.equal(idForCopy('inflator@chain', 'chain'), 'inflator@chain')
  assert.equal(baseId('inflator@chain'), 'inflator')
  assert.equal(baseId('inflator'), 'inflator')
  assert.equal(copyOfId('inflator@chain'), 'chain')
  assert.equal(copyOfId('plugin-chain'), 'solo')
  assert.equal(isChainCopyId('plugin-chain'), false)
})

test('the chain copy is the same effect under its own EffectChain id', () => {
  const effect = { id: 'inflator', name: 'Inflator', createNodes() {} }
  assert.equal(effectForCopy(effect, 'solo'), effect)
  const chained = effectForCopy(effect, 'chain')
  assert.equal(chained.id, 'inflator@chain')
  assert.equal(chained.createNodes, effect.createNodes)
  assert.equal(effect.id, 'inflator', 'the solo definition is untouched')
})

test('each copy is built once, and the two never share state', () => {
  let built = 0
  const copies = pluginCopies((copy) => {
    built++
    const state = { copy, value: 0 }
    return () => state
  })
  const solo = copies('solo')()
  const chain = copies('chain')()
  solo.value = 7
  assert.equal(chain.value, 0)
  assert.equal(copies('solo')(), solo)
  assert.equal(copies('chain')(), chain)
  assert.equal(built, 2)
  // Outside a component there is no window to ask: the solo copy.
  assert.equal(copies()(), solo)
})
