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
  lampFraction, grFraction, LAMP_CURVE_K,
} from '../../src/components/meters/ballistics.js'

// The lamp's own full scale, which is deliberately NOT the kernel's 6 dB
// bound — the stage lives between 0 and 3, so anchoring full brightness at the
// bound gave half the range to readings it almost never produces. Anything
// past 3 pins the light; the numeral beside it keeps counting, which is why
// the numeral is no longer derived through this scale.
const FULL = 3

test('the law is strictly increasing below full scale, so no two readings collide', () => {
  // What the round-trip test against lampFractionToDb used to establish. The
  // inverse is gone deliberately — it clamped at full scale, and full scale is
  // now BELOW the kernel's bound, so deriving the numeral through it would
  // have printed 3.0 for every reduction from 3 to 6 dB. Strict monotonicity
  // is the property that actually mattered and it needs no inverse to state.
  let prev = -1
  for (let db = 0; db < FULL; db += 0.005) {
    const f = lampFraction(db, FULL)
    assert.ok(f > prev, `two distinct reductions share a brightness at ${db}`)
    prev = f
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
  assert.ok(lampFraction(0.3, FULL) > 0.25, `0.3 dB only lights ${lampFraction(0.3, FULL)}`)
  assert.ok(lampFraction(1, FULL) > 0.55, `1 dB only lights ${lampFraction(1, FULL)}`)
  // ...without flattening the range the stage is steered over. The readings
  // below full scale have to stay tellable apart, or the fix has traded one
  // unreadable lamp for another.
  assert.ok(lampFraction(1, FULL) - lampFraction(0.3, FULL) > 0.20)
  assert.ok(lampFraction(2, FULL) - lampFraction(1, FULL) > 0.15)
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
  // And past full scale the lamp pins rather than running on — the numeral is
  // what carries a deeper reading now.
  assert.equal(lampFraction(FULL * 2, FULL), 1)
})

test('the curve constant is in the range that keeps the top half legible', () => {
  // K expands the bottom; too much and 1, 3 and 6 dB converge. Recorded as a
  // bound rather than an equality so the constant can be tuned by eye without
  // a test edit, but not silently taken somewhere it stops working.
  assert.ok(LAMP_CURVE_K >= 2 && LAMP_CURVE_K <= 8, `LAMP_CURVE_K = ${LAMP_CURVE_K}`)
})
