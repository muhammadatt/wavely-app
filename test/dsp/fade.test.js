/**
 * Fades (dsp/fade.js) and the timeline edit behind a crossfade.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FADE_CURVES, fadeGain, crossfadeGains, effectiveFadeSeconds, applyFade, crossfadeChannels,
} from '../../src/audio/dsp/fade.js'
import { replaceRegionWithBuffer, getTimelineDuration } from '../../src/audio/operations.js'

const ones = (n) => new Float32Array(n).fill(1)

test('every curve runs 0 → 1, monotonically', () => {
  for (const curve of FADE_CURVES) {
    assert.equal(fadeGain(curve, 0), 0, curve)
    assert.ok(Math.abs(fadeGain(curve, 1) - 1) < 1e-12, curve)
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const g = fadeGain(curve, i / 100)
      assert.ok(g >= prev, `${curve} not monotone at ${i}`)
      prev = g
    }
  }
})

test('the curves have their shapes: expo is linear in dB, s-curve is symmetric', () => {
  assert.equal(fadeGain('linear', 0.5), 0.5)
  assert.ok(Math.abs(fadeGain('s-curve', 0.5) - 0.5) < 1e-12)
  // 60 dB over the travel: each 0.1 of x is ~6 dB once clear of the floor.
  const db = (x) => 20 * Math.log10(fadeGain('expo', x))
  assert.ok(Math.abs(db(0.9) - db(0.8) - 6) < 0.05)
  assert.ok(fadeGain('expo', 0.5) < 0.04)
  assert.throws(() => fadeGain('nope', 0.5))
})

test('crossfade pairs: linear and s-curve hold constant gain, expo constant power', () => {
  for (let i = 0; i <= 20; i++) {
    const x = i / 20
    const [la, lb] = crossfadeGains('linear', x)
    assert.ok(Math.abs(la + lb - 1) < 1e-12)
    const [sa, sb] = crossfadeGains('s-curve', x)
    assert.ok(Math.abs(sa + sb - 1) < 1e-12)
    const [ea, eb] = crossfadeGains('expo', x)
    assert.ok(Math.abs(ea * ea + eb * eb - 1) < 1e-12)
  }
})

test('the fade length is capped by the selection, a crossfade at half of it', () => {
  assert.equal(effectiveFadeSeconds('in', 1, 3), 1)
  assert.equal(effectiveFadeSeconds('out', 5, 3), 3)
  assert.equal(effectiveFadeSeconds('cross', 1, 3), 1)
  assert.equal(effectiveFadeSeconds('cross', 5, 3), 1.5)
})

test('fade in starts silent and meets the untouched audio; fade out ends silent', () => {
  for (const curve of FADE_CURVES) {
    const n = 1000
    const [up] = applyFade([ones(n)], 'in', curve)
    assert.equal(up[0], 0)
    assert.ok(up[n - 1] > 0.99 && up[n - 1] < 1, `${curve} in: ${up[n - 1]}`)
    const [down] = applyFade([ones(n)], 'out', curve)
    assert.equal(down[n - 1], 0)
    assert.ok(down[0] > 0.99 && down[0] < 1, `${curve} out: ${down[0]}`)
    // Out is in, reversed.
    for (let i = 0; i < n; i++) assert.equal(down[i], up[n - 1 - i])
  }
})

test('fades apply the same gain to every channel', () => {
  const l = new Float32Array(64).fill(0.5)
  const r = new Float32Array(64).fill(-0.25)
  applyFade([l, r], 'in', 's-curve')
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(l[i] / 0.5 + r[i] / 0.25) < 1e-6 || l[i] === 0)
})

test('a crossfade is continuous with the outgoing side at its start and the incoming at its end', () => {
  const n = 4410
  const a = new Float32Array(n)
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    a[i] = Math.sin(i * 0.05)
    b[i] = Math.cos(i * 0.031)
  }
  for (const curve of FADE_CURVES) {
    const [out] = crossfadeChannels([a], [b], curve)
    assert.equal(out.length, n)
    // Within one sample's step of the curve of each side at the seams.
    assert.ok(Math.abs(out[0] - a[0]) < 0.01, `${curve} start`)
    assert.ok(Math.abs(out[n - 1] - b[n - 1]) < 0.01, `${curve} end`)
  }
  // Identical sides through a constant-gain pair come out unchanged.
  const [same] = crossfadeChannels([a], [a], 'linear')
  for (let i = 0; i < n; i++) assert.ok(Math.abs(same[i] - a[i]) < 1e-6)
  // Inputs are not modified.
  assert.equal(a[10], Math.fround(Math.sin(10 * 0.05)))
})

test('replacing a region with a shorter buffer shortens the timeline and moves what follows', () => {
  const src = { duration: 10 }
  const segments = [{ id: 's', sourceBuffer: src, sourceBufferId: 'src', sourceStart: 0, sourceEnd: 10, outputStart: 0 }]
  const joined = { duration: 0.5 }
  const out = replaceRegionWithBuffer(segments, 2, 5, joined, 'j', 0.5)
  assert.ok(Math.abs(getTimelineDuration(out) - 7.5) < 1e-9)
  const j = out.find((s) => s.sourceBufferId === 'j')
  assert.equal(j.outputStart, 2)
  assert.equal(j.sourceEnd, 0.5)
  const tail = out[out.length - 1]
  assert.ok(Math.abs(tail.outputStart - 2.5) < 1e-9)
  assert.ok(Math.abs(tail.sourceStart - 5) < 1e-9)
  // Without a duration it still replaces like for like.
  const same = replaceRegionWithBuffer(segments, 2, 5, { duration: 3 }, 'k')
  assert.ok(Math.abs(getTimelineDuration(same) - 10) < 1e-9)
})
