/**
 * The clip lamp's brightness law.
 *
 * Two things need pinning. The law and its inverse must be exact opposites,
 * because the lamp's brightness and the numeral printed beside it are derived
 * from one held quantity through the two of them, and a pair that drifted
 * apart would put a light and a number on screen disagreeing about the same
 * event. And the law has to stay READABLE at the readings this stage actually
 * produces — it shipped once using the compressors' voltage curve, which put a
 * 0.3 dB event at 3.9% lit, and that was reported as a lamp that barely works.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  lampFraction, lampFractionToDb, grFraction, LAMP_CURVE_K,
} from '../../src/components/meters/ballistics.js'

const FULL = 6 // MAX_REDUCTION_DB, the kernel's own bound

test('the lamp law and its inverse are exact opposites', () => {
  for (let db = 0; db <= FULL; db += 0.01) {
    const back = lampFractionToDb(lampFraction(db, FULL), FULL)
    assert.ok(Math.abs(back - db) < 1e-9, `round trip failed at ${db}: got ${back}`)
  }
  // And the other way, so neither direction can drift alone.
  for (let f = 0; f <= 1; f += 0.001) {
    const back = lampFraction(lampFractionToDb(f, FULL), FULL)
    assert.ok(Math.abs(back - f) < 1e-9, `inverse round trip failed at ${f}: got ${back}`)
  }
})

test('the lamp law spans exactly 0 to 1 and never runs backwards', () => {
  assert.equal(lampFraction(0, FULL), 0)
  assert.equal(lampFraction(FULL, FULL), 1)
  // Past full scale it clamps rather than exceeding — the kernel bounds
  // reduction at 6 dB, so anything above that is a bug elsewhere and the lamp
  // must not amplify it into a nonsense reading.
  assert.equal(lampFraction(FULL * 3, FULL), 1)
  // Sign-blind: the caller passes a magnitude, but a negative must not invert.
  assert.equal(lampFraction(-2, FULL), lampFraction(2, FULL))
  let prev = -1
  for (let db = 0; db <= FULL; db += 0.005) {
    const f = lampFraction(db, FULL)
    assert.ok(f >= prev, `not monotonic at ${db}`)
    prev = f
  }
})

test('the readings this stage actually produces are visibly lit', () => {
  // The regression guard for the reported bug. These are not aesthetic
  // numbers: 0.3-0.4 dB is the measured median of the blocks that clip on real
  // narration, and the whole complaint was that the lamp did not show it.
  assert.ok(lampFraction(0.3, FULL) > 0.20, `0.3 dB only lights ${lampFraction(0.3, FULL)}`)
  assert.ok(lampFraction(1, FULL) > 0.45, `1 dB only lights ${lampFraction(1, FULL)}`)
  // ...without flattening the range the stage is steered over. 1, 3 and 6 dB
  // have to stay tellable apart, or the fix has traded one unreadable lamp for
  // another.
  assert.ok(lampFraction(3, FULL) - lampFraction(1, FULL) > 0.20)
  assert.ok(lampFraction(6, FULL) - lampFraction(3, FULL) > 0.15)
})

test('it is strictly brighter than the voltage law it replaced, everywhere it matters', () => {
  // States the direction of the change rather than just its endpoint values,
  // so a future curve tweak that happens to satisfy the thresholds above while
  // being dimmer than the thing that was already too dim cannot pass.
  for (let db = 0.05; db < FULL; db += 0.05) {
    assert.ok(lampFraction(db, FULL) > grFraction(db, FULL),
      `at ${db} dB the lamp law is no brighter than grFraction`)
  }
  // They must still agree at both ends, or the lamp would be lit at rest.
  assert.equal(lampFraction(0, FULL), grFraction(0, FULL))
  assert.equal(lampFraction(FULL, FULL), grFraction(FULL, FULL))
})

test('the curve constant is in the range that keeps the top half legible', () => {
  // K expands the bottom; too much and 1, 3 and 6 dB converge. Recorded as a
  // bound rather than an equality so the constant can be tuned by eye without
  // a test edit, but not silently taken somewhere it stops working.
  assert.ok(LAMP_CURVE_K >= 2 && LAMP_CURVE_K <= 8, `LAMP_CURVE_K = ${LAMP_CURVE_K}`)
})
