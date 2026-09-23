/**
 * The hardware faceplate's dial and VU geometry: the numbers that decide what
 * the Classic 76 face SAYS, pinned without a DOM.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DIAL_MIN_DEG, DIAL_MAX_DEG, valueToDeg, evenAngles, engraving, formatSignedDb,
  vuFraction, grToVuFraction, vuFractionToDeg, VU_SWEEP_DEG,
} from '../../src/components/hardware/hardwareDial.js'
import {
  FET1176_OUTPUT_MIN_DB, FET1176_OUTPUT_MAX_DB,
} from '../../src/audio/fet1176Processor.js'

test('a knob points at the stops and straight up at mid-travel', () => {
  assert.equal(valueToDeg(0, 0, 100), DIAL_MIN_DEG)
  assert.equal(valueToDeg(100, 0, 100), DIAL_MAX_DEG)
  assert.equal(valueToDeg(50, 0, 100), 0)
  // Clamped: an out-of-range value cannot wind the pointer past a stop.
  assert.equal(valueToDeg(140, 0, 100), DIAL_MAX_DEG)
})

test('the engraving puts a bare dot between every pair of numerals', () => {
  const { dots, labels } = engraving(['a', '', 'b'])
  assert.deepEqual(labels.map(l => l.angle), evenAngles(3))
  assert.equal(dots.length, 5)
  assert.deepEqual(dots, [-140, -70, 0, 70, 140])
})

test("Output's printed numbers sit where the knob actually points", () => {
  // The face prints -24..+24 in 6 dB steps at even angles. That is only true
  // if the knob's travel is exactly that range and linear, so check each
  // numeral against the pointer angle for its own value.
  const printed = [-24, -18, -12, -6, 0, 6, 12, 18, 24]
  const { labels } = engraving(printed.map(String))
  printed.forEach((db, i) => {
    const deg = valueToDeg(db, FET1176_OUTPUT_MIN_DB, FET1176_OUTPUT_MAX_DB)
    assert.ok(Math.abs(deg - labels[i].angle) < 1e-9, `${db} dB printed at ${labels[i].angle}°, knob points at ${deg}°`)
  })
})

test('the Output readout prints a real minus and never a signed zero', () => {
  assert.equal(formatSignedDb(4.84), '+4.8 dB')
  assert.equal(formatSignedDb(-12), '−12.0 dB')
  assert.equal(formatSignedDb(-0.04), '0.0 dB')
  assert.equal(formatSignedDb(0), '0.0 dB')
})

test('the VU needle rests on 0 with no reduction and falls left one division per dB', () => {
  assert.equal(grToVuFraction(0), vuFraction(0))
  assert.equal(grToVuFraction(0), 0.70)
  assert.equal(grToVuFraction(10), vuFraction(-10))
  assert.equal(grToVuFraction(20), 0)
  assert.equal(grToVuFraction(40), 0, 'pinned at the left stop past full scale')
  // Negative reduction is not a thing the needle should show as gain.
  assert.equal(grToVuFraction(-3), vuFraction(0))
})

test('the VU scale is monotonic and spans the full sweep', () => {
  let prev = -Infinity
  for (let vu = -25; vu <= 5; vu += 0.25) {
    const f = vuFraction(vu)
    assert.ok(f >= prev, `scale ran backwards at ${vu} VU`)
    prev = f
  }
  assert.equal(vuFractionToDeg(0), -VU_SWEEP_DEG)
  assert.equal(vuFractionToDeg(1), VU_SWEEP_DEG)
})
