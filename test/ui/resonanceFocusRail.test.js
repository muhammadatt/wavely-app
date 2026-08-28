import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NODE_HIT_PX,
  SPAN_WHEEL_RATIO,
  addNode,
  biasCurvePoints,
  biasFromY,
  canAddFocusNode,
  hzFromX,
  makeFocusNode,
  moveNode,
  nodeAt,
  nodeNearHz,
  nodePoint,
  removeNode,
  scaleNodeSpan,
  setNodeParam,
  toggleNode,
  xFromHz,
  yFromBias,
} from '../../src/components/meters/resonanceFocusRail.js'
import {
  RESONANCE_FOCUS_MAX_NODES,
  RESONANCE_FOCUS_RANGES,
  focusBiasAt,
} from '../../src/audio/resonanceFocus.js'

const axis = { w: 600, minHz: 20, maxHz: 20000 }
const rail = { h: 58, maxDb: RESONANCE_FOCUS_RANGES.biasDb.max }

// ── The axis. ───────────────────────────────────────────────────────────────

/**
 * ⚠ THE FAILURE THIS FILE EXISTS FOR: a node editor whose frequency mapping is
 * off by an octave still looks like a working node editor. The same reason
 * resonanceZoneEdit.js is a separate module from the plot that draws it.
 */
test('the frequency mapping round-trips and matches the plot"s axis', () => {
  for (const hz of [20, 60, 250, 1000, 4400, 20000]) {
    assert.ok(Math.abs(hzFromX(xFromHz(hz, axis), axis) - hz) < 1e-6, `${hz} Hz`)
  }
  // Logarithmic, so equal octaves are equal widths — the property that makes a
  // node's span mean the same thing everywhere on the strip.
  const oct = xFromHz(200, axis) - xFromHz(100, axis)
  assert.ok(Math.abs((xFromHz(8000, axis) - xFromHz(4000, axis)) - oct) < 1e-9)
  assert.equal(Math.round(xFromHz(20, axis)), 0)
  assert.equal(Math.round(xFromHz(20000, axis)), 600)
})

/**
 * The rail is SYMMETRIC AROUND A CENTRE LINE because the quantity is signed and
 * its zero is the whole point of the model. A scale whose zero sat at the
 * bottom would draw "leave this alone" and "work a little harder" as
 * neighbouring positions near one end, when they are opposite statements.
 */
test('zero bias is the centre line, and the scale is symmetric', () => {
  assert.equal(yFromBias(0, rail), rail.h / 2)
  assert.equal(yFromBias(rail.maxDb, rail), 0)
  assert.equal(yFromBias(-rail.maxDb, rail), rail.h)
  assert.ok(Math.abs(biasFromY(rail.h / 2, rail)) < 1e-12)
  for (const db of [-12, -3, 0, 5, 17]) {
    assert.ok(Math.abs(biasFromY(yFromBias(db, rail), rail) - db) < 1e-9, `${db} dB`)
  }
})

/**
 * The rail's full travel IS the parameter's full range, so there is no position
 * on the strip that means "past the end" and no travel that does nothing.
 */
test('the rail cannot express a value the parameter cannot hold', () => {
  assert.equal(rail.maxDb, RESONANCE_FOCUS_RANGES.biasDb.max)
  assert.equal(biasFromY(-50, rail), RESONANCE_FOCUS_RANGES.biasDb.max)
  assert.equal(biasFromY(500, rail), RESONANCE_FOCUS_RANGES.biasDb.min)
})

// ── Hit testing. ────────────────────────────────────────────────────────────

test('a node is grabbed at its own frequency and its own amount', () => {
  const nodes = [makeFocusNode(1000, 'a')]
  const p = nodePoint(nodes[0], axis, rail)
  assert.equal(nodeAt(nodes, p.x, p.y, axis, rail), 0)
  // Not at the centre line under it — the handle is at its VALUE, which is what
  // makes the amount draggable at all.
  assert.equal(nodeAt(nodes, p.x, rail.h / 2 + NODE_HIT_PX * 2, axis, rail), -1)
  assert.equal(nodeAt(nodes, p.x + NODE_HIT_PX * 3, p.y, axis, rail), -1)
})

/**
 * Two nodes stacked at one frequency are distinguished only by their amounts,
 * so nearest-wins has to consider both axes or one of them is unreachable.
 */
test('stacked nodes are told apart by amount', () => {
  const nodes = [
    { ...makeFocusNode(1000, 'a'), biasDb: 12 },
    { ...makeFocusNode(1000, 'b'), biasDb: -12 },
  ]
  const x = xFromHz(1000, axis)
  assert.equal(nodeAt(nodes, x, yFromBias(12, rail), axis, rail), 0)
  assert.equal(nodeAt(nodes, x, yFromBias(-12, rail), axis, rail), 1)
})

// ── Edits. ──────────────────────────────────────────────────────────────────

/**
 * A drag sets frequency AND amount — two of the three numbers on one gesture,
 * with width on the wheel. That split is not arbitrary: where and how much are
 * what you sweep by ear against the audio; how wide is what you set and read.
 */
test('a drag moves frequency and amount together and leaves width alone', () => {
  const nodes = [makeFocusNode(1000, 'a')]
  const next = moveNode(nodes, 0, xFromHz(4000, axis), yFromBias(-9, rail), axis, rail)
  assert.ok(Math.abs(next[0].hz - 4000) < 1)
  assert.ok(Math.abs(next[0].biasDb + 9) < 1e-9)
  assert.equal(next[0].spanOct, nodes[0].spanOct)
  // A new array, so Vue sees the change. Mutating in place is what lets a
  // panel's copy and the worklet's copy diverge.
  assert.notEqual(next, nodes)
  assert.equal(nodes[0].hz, 1000)
})

test('a drag past either end of the strip clamps rather than wrapping', () => {
  const nodes = [makeFocusNode(1000, 'a')]
  const lo = moveNode(nodes, 0, -400, -400, axis, rail)
  assert.equal(lo[0].hz, RESONANCE_FOCUS_RANGES.hz.min)
  assert.equal(lo[0].biasDb, RESONANCE_FOCUS_RANGES.biasDb.max)
  const hi = moveNode(nodes, 0, 9999, 9999, axis, rail)
  assert.equal(hi[0].hz, RESONANCE_FOCUS_RANGES.hz.max)
  assert.equal(hi[0].biasDb, RESONANCE_FOCUS_RANGES.biasDb.min)
})

/**
 * Width scales GEOMETRICALLY. A fixed step would take forever at the wide end
 * and jump at the narrow one, because span is read on a log axis for the same
 * reason frequency is.
 */
test('the width wheel is a ratio, and is bounded', () => {
  // ⚠ CHECKED AT TWO DIFFERENT WIDTHS, and one is not enough: at the stock span
  // of 1 octave a geometric step of x1.12 and an additive step of +0.12 land on
  // exactly the same number, so a single-width assertion passes under the
  // mutation it exists to catch. The property is EQUAL RATIO AT EVERY SIZE.
  for (const start of [0.25, 1, 3]) {
    const n0 = [{ ...makeFocusNode(1000, 'a'), spanOct: start }]
    const up = scaleNodeSpan(n0, 0, 1)[0].spanOct
    assert.ok(Math.abs(up / start - SPAN_WHEEL_RATIO) < 1e-9,
      `expected a constant ratio at every width; at ${start} oct it stepped to ${up}`)
    // And it comes back: a wheel that cannot undo itself is a trap on a
    // control with no other editor than the number beside it.
    assert.ok(Math.abs(scaleNodeSpan(up === start ? n0 : [{ ...n0[0], spanOct: up }], 0, -1)[0].spanOct - start) < 1e-9)
  }
  let n = [makeFocusNode(1000, 'a')]
  for (let i = 0; i < 100; i++) n = scaleNodeSpan(n, 0, 1)
  assert.equal(n[0].spanOct, RESONANCE_FOCUS_RANGES.spanOct.max)
  for (let i = 0; i < 200; i++) n = scaleNodeSpan(n, 0, -1)
  assert.equal(n[0].spanOct, RESONANCE_FOCUS_RANGES.spanOct.min)
})

/**
 * ⚠ A NEW NODE IS CREATED DOING SOMETHING. One created at zero amount would be
 * invisible on the rail and inaudible in the file, so the gesture that makes it
 * looks broken — the same failure the ceiling presets shipped, where a click
 * was accepted and silently discarded.
 */
test('a new node is audible and points the way the gesture implies', () => {
  const n = makeFocusNode(2500, 'x')
  assert.ok(n.biasDb > 0, 'you point at a resonance because you want more done about it')
  assert.ok(n.spanOct >= RESONANCE_FOCUS_RANGES.spanOct.min)
  assert.equal(n.enabled, true)
  assert.ok(Math.abs(n.hz - 2500) < 1e-9)
  assert.ok(Math.abs(focusBiasAt([n], 2500) - n.biasDb) < 1e-9)
})

/**
 * ⚠ AT THE CAP, `addNode` RETURNS THE ARRAY UNCHANGED rather than dropping the
 * oldest or the newest — and the caller checks `canAddFocusNode` and disables
 * the gesture. A silently discarded edit is the worst of the three available
 * failures, and this panel has already shipped one.
 */
test('the node cap refuses rather than discarding', () => {
  let nodes = []
  for (let i = 0; i < RESONANCE_FOCUS_MAX_NODES; i++) {
    assert.equal(canAddFocusNode(nodes), true)
    nodes = addNode(nodes, makeFocusNode(100 * (i + 1), `n${i}`))
  }
  assert.equal(nodes.length, RESONANCE_FOCUS_MAX_NODES)
  assert.equal(canAddFocusNode(nodes), false)
  const after = addNode(nodes, makeFocusNode(999, 'over'))
  assert.equal(after, nodes, 'the same array, so nothing was silently dropped')
})

test('removing and bypassing', () => {
  const nodes = [makeFocusNode(100, 'a'), makeFocusNode(1000, 'b'), makeFocusNode(9000, 'c')]
  assert.deepEqual(removeNode(nodes, 1).map(n => n.id), ['a', 'c'])
  assert.equal(removeNode(nodes, 7), nodes)
  // Bypass keeps the node's position and settings — it is still where you put
  // it, and still the thing the controls are editing.
  const off = toggleNode(nodes, 1)
  assert.equal(off[1].enabled, false)
  assert.equal(off[1].hz, 1000)
  assert.equal(off[1].biasDb, nodes[1].biasDb)
  assert.equal(toggleNode(off, 1)[1].enabled, true)
})

test('setNodeParam clamps, and rejects a name that is not a parameter', () => {
  const nodes = [makeFocusNode(1000, 'a')]
  assert.equal(setNodeParam(nodes, 0, 'biasDb', 999)[0].biasDb, RESONANCE_FOCUS_RANGES.biasDb.max)
  assert.equal(setNodeParam(nodes, 0, 'hz', 1)[0].hz, RESONANCE_FOCUS_RANGES.hz.min)
  assert.equal(setNodeParam(nodes, 0, 'enabled', 0), nodes)
})

// ── Drawing. ────────────────────────────────────────────────────────────────

/**
 * The curve is sampled in PIXELS, not in frequency. Sampling evenly in Hz puts
 * nine tenths of the points in the top two octaves and draws the bottom of the
 * rail as straight segments between three samples — the same argument the
 * spectrum display's log resample makes.
 */
test('the curve is sampled per pixel column and agrees with the model', () => {
  const nodes = [{ ...makeFocusNode(500, 'a'), biasDb: 10, spanOct: 1 }]
  const pts = biasCurvePoints(nodes, axis, rail, 1)
  assert.equal(pts.length, axis.w + 1)
  for (const p of pts) {
    assert.ok(Math.abs(p.db - focusBiasAt(nodes, hzFromX(p.x, axis))) < 1e-12)
    assert.ok(Math.abs(p.y - yFromBias(p.db, rail)) < 1e-12)
  }
  // The peak of the drawn curve lands on the node, within a pixel.
  const peak = pts.reduce((a, b) => (b.db > a.db ? b : a))
  assert.ok(Math.abs(peak.x - xFromHz(500, axis)) <= 1)
})

test('an empty rail draws a flat zero line and nothing else', () => {
  const pts = biasCurvePoints([], axis, rail, 10)
  assert.ok(pts.every(p => p.db === 0 && p.y === rail.h / 2))
})

/**
 * How a click on a named resonance in the plot above finds the node it already
 * made, instead of stacking a second one on top of the first.
 */
test('nodeNearHz finds an existing node within a musical tolerance', () => {
  const nodes = [makeFocusNode(300, 'a'), makeFocusNode(3000, 'b')]
  assert.equal(nodeNearHz(nodes, 3040), 1)
  assert.equal(nodeNearHz(nodes, 3600), -1, 'a third of an octave away is a different resonance')
  assert.equal(nodeNearHz(nodes, 305), 0)
})
