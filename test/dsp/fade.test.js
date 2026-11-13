/**
 * Fades (dsp/fade.js).
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FADE_CURVES, fadeGain, applyFade, fadeCurvePath } from '../../src/audio/dsp/fade.js'

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
  assert.throws(() => applyFade([ones(4)], 'cross', 'linear'))
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

test('the panel icons draw the real curve, mirrored for a fade out', () => {
  const pts = (d) => d.split(/[ML]/).filter(Boolean).map((p) => p.trim().split(' ').map(Number))
  for (const curve of FADE_CURVES) {
    const up = pts(fadeCurvePath(curve, 'in'))
    const down = pts(fadeCurvePath(curve, 'out'))
    // In starts at the bottom (silence, y 22) and ends at the top (y 2); out the reverse.
    assert.deepEqual(up[0], [2, 22]); assert.deepEqual(up[up.length - 1], [46, 2])
    assert.deepEqual(down[0], [2, 2]); assert.deepEqual(down[down.length - 1], [46, 22])
    // Out is in mirrored left to right.
    for (let i = 0; i < up.length; i++) assert.equal(down[i][1], up[up.length - 1 - i][1])
  }
  // Expo rises late: at the midpoint it is still near silence.
  const mid = pts(fadeCurvePath('expo', 'in'))[16]
  assert.ok(mid[1] > 21, `expo midpoint y ${mid[1]}`)
})

