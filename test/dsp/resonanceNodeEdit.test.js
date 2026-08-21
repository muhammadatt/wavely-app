import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NODE_DRAG_DB_PER_PX,
  NODE_HIT_PX,
  NODE_NEW_GAIN_DB,
  addNode,
  dragNode,
  hzFromX,
  nodeAt,
  nodeOctaves,
  nudgeNode,
  removeNode,
  xFromHz,
} from '../../src/components/meters/resonanceNodes.js'
import {
  RESONANCE_WEIGHT_DEFAULT_OCTAVES,
  RESONANCE_WEIGHT_MAX_DB,
  RESONANCE_WEIGHT_MAX_NODES,
  RESONANCE_WEIGHT_MAX_OCTAVES,
  RESONANCE_WEIGHT_MIN_OCTAVES,
  resonanceWeightDbAt,
} from '../../src/audio/resonanceParams.js'

/**
 * The sensitivity node editor's arithmetic.
 *
 * These are the parts of an on-plot editor that can be wrong without looking
 * wrong: a frequency mapping off by an octave, a drag that loses its excursion
 * against a clamp, a hit test that cannot reach the node it is drawn under.
 * The drawing is not tested here — a canvas needs eyes — but everything that
 * decides WHAT a gesture meant is.
 */

const axis = { w: 600, minHz: 20, maxHz: 20000 }

function node(over = {}) {
  return {
    id: 'a', freqHz: 400, gainDb: 6,
    octaves: RESONANCE_WEIGHT_DEFAULT_OCTAVES, enabled: true, ...over,
  }
}

test('the axis is logarithmic and round-trips', () => {
  for (const hz of [20, 100, 440, 3000, 20000]) {
    assert.ok(Math.abs(hzFromX(xFromHz(hz, axis), axis) - hz) < hz * 1e-9)
  }
  // Equal octaves take equal width: 20->200 and 200->2000 are both a decade.
  const a = xFromHz(200, axis) - xFromHz(20, axis)
  const b = xFromHz(2000, axis) - xFromHz(200, axis)
  assert.ok(Math.abs(a - b) < 0.01, `${a} vs ${b}`)
})

test('the hit test reaches a node and stops at the radius', () => {
  const nodes = [node()]
  const x = xFromHz(400, axis)
  assert.equal(nodeAt(nodes, x, axis)?.id, 'a')
  assert.equal(nodeAt(nodes, x + NODE_HIT_PX - 0.5, axis)?.id, 'a')
  assert.equal(nodeAt(nodes, x + NODE_HIT_PX + 2, axis), null)
})

test('the hit test picks the nearer of two crowded nodes', () => {
  const nodes = [node({ id: 'a', freqHz: 400 }), node({ id: 'b', freqHz: 430 })]
  assert.equal(nodeAt(nodes, xFromHz(402, axis), axis).id, 'a')
  assert.equal(nodeAt(nodes, xFromHz(428, axis), axis).id, 'b')
})

test('a placed node lands on the frequency that was clicked', () => {
  const next = addNode([], xFromHz(1000, axis), axis, 'w1')
  // addNode takes a frequency, not a pixel — the caller converts. Passing the
  // pixel would place it at 20-odd Hz, which is exactly the off-by-an-axis
  // mistake this asserts against.
  assert.notEqual(next[0].freqHz, 1000)
  const placed = addNode([], hzFromX(xFromHz(1000, axis), axis), axis, 'w1')
  assert.equal(placed[0].freqHz, 1000)
  assert.equal(placed[0].gainDb, NODE_NEW_GAIN_DB)
  assert.equal(placed[0].octaves, RESONANCE_WEIGHT_DEFAULT_OCTAVES)
})

test('the node ceiling returns the list unchanged, by identity', () => {
  let nodes = []
  for (let i = 0; i < RESONANCE_WEIGHT_MAX_NODES; i++) {
    nodes = addNode(nodes, 100 * (i + 1), axis, `w${i}`)
  }
  assert.equal(nodes.length, RESONANCE_WEIGHT_MAX_NODES)
  assert.equal(addNode(nodes, 5000, axis, 'x'), nodes)
})

test('edits never mutate the array or the nodes in it', () => {
  const before = [node()]
  const snapshot = JSON.parse(JSON.stringify(before))
  nudgeNode(before, 'a', { db: 3 }, axis)
  dragNode(before, { id: 'a', freqHz: 400, gainDb: 6, octaves: 0.3 }, 40, -20, axis)
  removeNode(before, 'a')
  assert.deepEqual(before, snapshot)
})

test('a drag maps pixels to frequency and to dB', () => {
  const nodes = [node()]
  const grab = { id: 'a', freqHz: 400, gainDb: 6, octaves: 0.3 }
  // Up is MORE sensitive, so a negative dy raises the offset.
  const up = dragNode(nodes, grab, 0, -20, axis)[0]
  assert.ok(Math.abs(up.gainDb - (6 + 20 * NODE_DRAG_DB_PER_PX)) < 1e-9)
  assert.equal(up.freqHz, 400)
  // One decade of the axis is w/log2(1000) * ... — just assert the direction
  // and that the same pixel count moves by the same RATIO wherever it starts.
  const from400 = dragNode(nodes, grab, 50, 0, axis)[0].freqHz / 400
  const g2 = { ...grab, freqHz: 4000 }
  const from4000 = dragNode([node({ freqHz: 4000 })], g2, 50, 0, axis)[0].freqHz / 4000
  assert.ok(from400 > 1)
  assert.ok(Math.abs(from400 - from4000) < 0.01, `${from400} vs ${from4000}`)
})

test('a drag is measured from the grab, so a clamped excursion returns', () => {
  const nodes = [node({ gainDb: RESONANCE_WEIGHT_MAX_DB - 1 })]
  const grab = { id: 'a', freqHz: 400, gainDb: RESONANCE_WEIGHT_MAX_DB - 1, octaves: 0.3 }
  const pinned = dragNode(nodes, grab, 0, -400, axis)
  assert.equal(pinned[0].gainDb, RESONANCE_WEIGHT_MAX_DB)
  // Back to where the pointer started: an incremental drag would have lost the
  // 400 px it spent against the ceiling and come back several dB low.
  const back = dragNode(pinned, grab, 0, 0, axis)
  assert.equal(back[0].gainDb, RESONANCE_WEIGHT_MAX_DB - 1)
})

test('shift-drag changes width and nothing else', () => {
  const nodes = [node()]
  const grab = { id: 'a', width: true, freqHz: 400, gainDb: 6, octaves: 0.3 }
  const wider = dragNode(nodes, grab, 100, -50, axis)[0]
  assert.ok(wider.octaves > 0.3)
  assert.equal(wider.freqHz, 400)
  assert.equal(wider.gainDb, 6)
})

test('every edit stays inside the parameter limits', () => {
  let nodes = [node()]
  for (let i = 0; i < 200; i++) nodes = nudgeNode(nodes, 'a', { db: 1, octaves: 0.2, widthFactor: 1.2 }, axis)
  assert.equal(nodes[0].gainDb, RESONANCE_WEIGHT_MAX_DB)
  assert.equal(nodes[0].octaves, RESONANCE_WEIGHT_MAX_OCTAVES)
  assert.ok(nodes[0].freqHz <= axis.maxHz)
  for (let i = 0; i < 400; i++) nodes = nudgeNode(nodes, 'a', { db: -1, octaves: -0.2, widthFactor: 1 / 1.2 }, axis)
  assert.equal(nodes[0].gainDb, -RESONANCE_WEIGHT_MAX_DB)
  assert.equal(nodes[0].octaves, RESONANCE_WEIGHT_MIN_OCTAVES)
  assert.ok(nodes[0].freqHz >= axis.minHz)
})

test('nodeOctaves clamps a node that never carried a width', () => {
  assert.equal(nodeOctaves({}), RESONANCE_WEIGHT_DEFAULT_OCTAVES)
  assert.equal(nodeOctaves({ octaves: 99 }), RESONANCE_WEIGHT_MAX_OCTAVES)
})

test('what the editor produces is what the detector reads', () => {
  // The panel draws its threshold from resonanceWeightDbAt and the kernel
  // builds its curve from the same function, so an edited node has to be a
  // shape that function accepts. This is the seam between the two halves.
  const nodes = addNode([], 356, axis, 'w1')
  const peak = resonanceWeightDbAt(nodes, 356)
  assert.ok(Math.abs(peak - NODE_NEW_GAIN_DB) < 1e-9)
  // One sigma out is down by exp(-1/2).
  const sigma = 356 * Math.pow(2, RESONANCE_WEIGHT_DEFAULT_OCTAVES)
  assert.ok(Math.abs(resonanceWeightDbAt(nodes, sigma) - NODE_NEW_GAIN_DB * Math.exp(-0.5)) < 1e-9)
  // A disabled node is inert without being removed.
  const off = nodes.map(n => ({ ...n, enabled: false }))
  assert.equal(resonanceWeightDbAt(off, 356), 0)
})
