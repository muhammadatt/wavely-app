import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ref, watch, nextTick } from 'vue'

import {
  baseId, idForCopy, copyOfId, isChainCopyId, effectForCopy, pluginCopies,
  chainCopy, chainCopyNumber,
} from '../../src/composables/pluginCopies.js'

/**
 * Every chainable plugin exists as a solo copy, opened from the Effects menu
 * with an Apply of its own, and one chain copy per slot. Copies must never
 * share state, a node or a window, and a removed slot's copy must be gone.
 */

test('a chain copy is the solo id with a numbered suffix, and maps back', () => {
  assert.equal(idForCopy('inflator', chainCopy(1)), 'inflator@chain-1')
  assert.equal(idForCopy('inflator', chainCopy(12)), 'inflator@chain-12')
  assert.equal(idForCopy('inflator', 'solo'), 'inflator')
  assert.equal(idForCopy('inflator@chain-2', 'solo'), 'inflator')
  assert.equal(idForCopy('inflator@chain-2', chainCopy(3)), 'inflator@chain-3')
  assert.equal(baseId('inflator@chain-2'), 'inflator')
  assert.equal(baseId('inflator'), 'inflator')
  assert.equal(copyOfId('inflator@chain-2'), 'chain-2')
  assert.equal(copyOfId('plugin-chain'), 'solo')
  assert.equal(chainCopyNumber('chain-7'), 7)
  assert.equal(chainCopyNumber('solo'), 0)
  assert.equal(isChainCopyId('plugin-chain'), false)
  assert.equal(isChainCopyId('inflator@chain'), false, 'an unnumbered suffix is not a copy')
})

test('a chain copy is the same effect under its own EffectChain id', () => {
  const effect = { id: 'inflator', name: 'Inflator', createNodes() {} }
  assert.equal(effectForCopy(effect, 'solo'), effect)
  const chained = effectForCopy(effect, chainCopy(2))
  assert.equal(chained.id, 'inflator@chain-2')
  assert.equal(chained.createNodes, effect.createNodes)
  assert.equal(effect.id, 'inflator', 'the solo definition is untouched')
})

test('each copy is built once, and copies never share state', () => {
  let built = 0
  const copies = pluginCopies((copy) => {
    built++
    const state = { copy, value: 0 }
    return () => state
  })
  const solo = copies('solo')()
  const one = copies(chainCopy(1))()
  const two = copies(chainCopy(2))()
  solo.value = 7
  one.value = 3
  assert.equal(two.value, 0)
  assert.equal(copies('solo')(), solo)
  assert.equal(copies(chainCopy(1))(), one)
  assert.equal(built, 3)
  // Outside a component there is no window to ask: the solo copy.
  assert.equal(copies()(), solo)
})

test('disposing a copy runs its cleanups, stops its watchers, and the next ask starts fresh', async () => {
  const source = ref(0)
  const seen = []
  let cleaned = 0
  const lives = new Map()
  const copies = pluginCopies((copy, life) => {
    lives.set(copy, life)
    const state = { value: 0 }
    life.onDispose(() => { cleaned++ })
    // A watcher that outlives any window — in the copy's scope.
    life.scope.run(() => watch(source, v => seen.push([copy, v])))
    return () => state
  })
  const first = copies(chainCopy(1))()
  copies(chainCopy(2))()
  first.value = 5
  source.value = 1
  await nextTick()
  assert.deepEqual(seen, [['chain-1', 1], ['chain-2', 1]])

  lives.get(chainCopy(1)).dispose()
  assert.equal(cleaned, 1)
  source.value = 2
  await nextTick()
  assert.deepEqual(seen.slice(2), [['chain-2', 2]], 'a disposed copy watches nothing')

  const again = copies(chainCopy(1))()
  assert.notEqual(again, first)
  assert.equal(again.value, 0, 're-adding starts from defaults')
  // Disposing twice, or a stale life, is a no-op.
  lives.get(chainCopy(2)).dispose()
  lives.get(chainCopy(2)).dispose()
  assert.equal(cleaned, 2)
})
