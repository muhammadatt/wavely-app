import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EffectChain } from '../../src/audio/effectChain.js'

/**
 * The chain's slots: membership that outlives a bypass, an order the user
 * controls, and a master bypass — checked on the audio graph the chain
 * actually wires, not on its bookkeeping alone.
 */

// A node that records what it is connected to.
function fakeNode(name) {
  return {
    name,
    out: new Set(),
    connect(n) { this.out.add(n) },
    disconnect() { this.out.clear() },
  }
}

function fakeContext() {
  const destination = fakeNode('destination')
  let n = 0
  return { destination, createGain: () => fakeNode(`gain${n++}`) }
}

function fakeEffect(id) {
  return {
    id,
    name: id,
    createNodes: () => {
      const input = fakeNode(`${id}.in`)
      const output = fakeNode(`${id}.out`)
      return { input, output, setParam() {}, getParam() {} }
    },
  }
}

// Walk the graph from the chain input and name every effect the signal passes.
function signalPath(chain) {
  const path = []
  let node = chain.inputNode
  for (let hops = 0; hops < 20; hops++) {
    const [next] = node.out
    if (!next || next === chain.outputNode) break
    const entry = chain.effects.find(e => e.nodes.input === next)
    path.push(entry.id)
    node = entry.nodes.output
  }
  return path
}

// What the Add list does: turn the plugin on, then give it a slot.
function engage(chain, id) {
  chain.setEnabled(id, true)
  chain.addToChain(id)
}

function chainWith(...ids) {
  const chain = new EffectChain(fakeContext())
  for (const id of ids) chain.addEffect(fakeEffect(id))
  return chain
}

test('adding appends a slot: the default order is the order plugins were added', () => {
  // Built (opened) a, b, c — but added c, then a.
  const chain = chainWith('a', 'b', 'c')
  engage(chain, 'c')
  engage(chain, 'a')
  assert.deepEqual(chain.members().map(e => e.id), ['c', 'a'])
  assert.deepEqual(signalPath(chain), ['c', 'a'])
})

test('turning a plugin on does not add it: it is auditioned after the chain', () => {
  const chain = chainWith('a', 'b', 'x')
  engage(chain, 'a')
  engage(chain, 'b')
  chain.setEnabled('x', true) // a plugin window opened on its own
  assert.deepEqual(chain.members().map(e => e.id), ['a', 'b'])
  assert.deepEqual(signalPath(chain), ['a', 'b', 'x'])
  // Its slot, if it is then added, is the end of the chain proper.
  chain.addToChain('x')
  assert.deepEqual(chain.members().map(e => e.id), ['a', 'b', 'x'])
})

test('the master bypass takes out the slots, not an auditioned plugin', () => {
  const chain = chainWith('a', 'x')
  engage(chain, 'a')
  chain.setEnabled('x', true)
  chain.setBypassed(true)
  assert.deepEqual(signalPath(chain), ['x'])
})

test('a bypassed slot keeps its place and comes back to it', () => {
  const chain = chainWith('a', 'b', 'c')
  for (const id of ['a', 'b', 'c']) engage(chain, id)
  chain.setEnabled('b', false)
  assert.deepEqual(chain.members().map(e => e.id), ['a', 'b', 'c'])
  assert.deepEqual(signalPath(chain), ['a', 'c'])
  chain.setEnabled('b', true)
  assert.deepEqual(signalPath(chain), ['a', 'b', 'c'])
})

test('moveEffect reorders the audio, not just the list', () => {
  const chain = chainWith('a', 'b', 'c')
  for (const id of ['a', 'b', 'c']) engage(chain, id)
  chain.moveEffect('c', 0)
  assert.deepEqual(signalPath(chain), ['c', 'a', 'b'])
  chain.moveEffect('c', 99) // clamped to the end
  assert.deepEqual(signalPath(chain), ['a', 'b', 'c'])
  chain.moveEffect('a', 1)
  assert.deepEqual(signalPath(chain), ['b', 'a', 'c'])
})

test('removing a slot takes it out; re-adding puts it at the end', () => {
  const chain = chainWith('a', 'b', 'c')
  for (const id of ['a', 'b', 'c']) engage(chain, id)
  chain.removeFromChain('a')
  assert.deepEqual(chain.members().map(e => e.id), ['b', 'c'])
  assert.deepEqual(signalPath(chain), ['b', 'c'])
  engage(chain, 'a')
  assert.deepEqual(signalPath(chain), ['b', 'c', 'a'])
})

test('the master bypass empties the path and keeps every slot', () => {
  const chain = chainWith('a', 'b')
  engage(chain, 'a')
  engage(chain, 'b')
  chain.setBypassed(true)
  assert.deepEqual(signalPath(chain), [])
  assert.ok(chain.inputNode.out.has(chain.outputNode))
  assert.deepEqual(chain.members().map(e => [e.id, e.enabled]), [['a', true], ['b', true]])
  chain.setBypassed(false)
  assert.deepEqual(signalPath(chain), ['a', 'b'])
})

test('every change notifies listeners', () => {
  const chain = chainWith('a', 'b')
  let calls = 0
  chain.onChange(() => calls++)
  chain.setEnabled('a', true)
  chain.addToChain('a')
  chain.setEnabled('b', true)
  chain.addToChain('b')
  chain.moveEffect('b', 0)
  chain.setBypassed(true)
  chain.removeFromChain('a')
  assert.equal(calls, 7)
})
