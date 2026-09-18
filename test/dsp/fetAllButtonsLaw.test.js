/**
 * Run with:  npm test
 *
 * THE ALL-BUTTONS SLOPE LAW RUNS DOWNHILL.
 *
 * ⚠⚠ IT USED TO RUN UPHILL, AND NOTHING NOTICED FOR THE WHOLE RE-TUNE. The law
 * was `ratio = MIN + SPAN*over/(over+HALF)` with MIN 6 and SPAN 14, so the ratio
 * CLIMBED 6 -> 20 with overshoot. Measured on CLA-76's four all-buttons captures
 * it FALLS, from ~19.7 just clear of the knee to ~6.3 some 19 dB above it.
 * Corroborated by Shanks's "plateau" description (via Moore, JARP 2012) and by
 * the UA manual's "between 12:1 and 20:1", which the measurement matches near
 * the knee and drops below at the top.
 *
 * This pins the direction and the span, because a sign is the kind of thing that
 * survives a refactor unnoticed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FET1176Kernel, allButtonsIncrSlope, allButtonsGr,
  ALL_INCR_AT_KNEE, ALL_INCR_FALL_PER_DB, ALL_INCR_FLOOR, ALL_KNEE_DB,
} from '../../src/audio/fet1176Processor.js'

const HALF_KNEE = ALL_KNEE_DB / 2

test('the incremental slope falls with overshoot, and does not climb', () => {
  const at = (over) => allButtonsIncrSlope(over, HALF_KNEE)
  const sweep = [HALF_KNEE, HALF_KNEE + 5, HALF_KNEE + 10, HALF_KNEE + 15, HALF_KNEE + 19]
  const vals = sweep.map(at)
  for (let i = 1; i < vals.length; i++) {
    assert.ok(vals[i] < vals[i - 1],
      `slope must fall with overshoot; got ${vals.map(v => v.toFixed(4)).join(' / ')}`)
  }
  // The measured endpoints, which are what the law was fitted to.
  assert.ok(Math.abs(vals[0] - 0.949) < 0.01, `at the knee exit: ${vals[0].toFixed(4)}`)
  assert.ok(Math.abs(vals[4] - 0.8418) < 0.02, `19 dB above it: ${vals[4].toFixed(4)}`)
})

/**
 * ⚠ THE FLOOR IS AN EXTRAPOLATION AND MUST STILL BE A LEGAL RATIO. A falling
 * slope with no floor keeps falling until it passes 0 — which is expansion, not
 * compression, and would make the plugin get LOUDER the harder it is driven.
 */
test('the floor holds, so the law can never expand', () => {
  for (const over of [40, 80, 200, 1000]) {
    const s = allButtonsIncrSlope(over, HALF_KNEE)
    assert.ok(s >= ALL_INCR_FLOOR - 1e-12, `slope fell through the floor at ${over} dB: ${s}`)
    assert.ok(s > 0, 'and must never reach expansion')
  }
  assert.ok(ALL_INCR_FLOOR > 0 && ALL_INCR_FLOOR < 1, 'the floor itself must be a legal slope')
})

/**
 * ⚠⚠ REDUCTION IS THE INTEGRAL OF THE SLOPE, NOT `slope * over`. Everywhere else
 * in the kernel reduction is a SECANT multiply, which is right for a fixed
 * ratio and wrong for a law whose slope moves: with `gr = s(over)*over` the
 * incremental slope is `s + over*s'`, so a secant falling at k reads as an
 * incremental falling at 2k. A first cut installed the measured rate as a
 * secant and the shape extractor caught our kernel falling twice as fast as the
 * reference. This is the property that keeps the two in step.
 */
test('reduction is the integral of the slope, to the factor of two that cost', () => {
  const h = 1e-4
  for (const over of [HALF_KNEE + 1, HALF_KNEE + 8, HALF_KNEE + 16]) {
    const numeric = (allButtonsGr(over + h, HALF_KNEE) - allButtonsGr(over - h, HALF_KNEE)) / (2 * h)
    const stated = allButtonsIncrSlope(over, HALF_KNEE)
    assert.ok(Math.abs(numeric - stated) < 1e-4,
      `at ${over} dB the curve's own derivative is ${numeric.toFixed(5)} against a ` +
      `stated ${stated.toFixed(5)} — the integral and the law have come apart`)
  }
})

test('the gain computer is continuous where the knee meets the law', () => {
  const k = new FET1176Kernel(44100)
  k.setParams({ ratio: 'all', inputDrive: 50 })
  const eps = 1e-6
  const below = k._grForOvershoot(k.halfKnee - eps)
  const above = k._grForOvershoot(k.halfKnee + eps)
  assert.ok(Math.abs(above - below) < 1e-4,
    `a step of ${(above - below).toFixed(6)} dB at the knee exit would be audible as a click`)
})

/**
 * The kernel must actually USE the law — an override that changes nothing is
 * the failure mode a fit cannot see, because it fits whatever it is given.
 */
test('the law reaches the rendered curve, and the overrides reach the law', () => {
  const grAt = (levelDb, extra) => {
    const k = new FET1176Kernel(44100)
    k.setParams({ inputDrive: 70, ratio: 'all', attack: 1, release: 7, fetDrive: 0,
      oversample: false, outputGainDb: 0, mix: 1, ...extra })
    const n = 44100
    const x = new Float32Array(n)
    const amp = Math.pow(10, levelDb / 20)
    for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * 1000 * i / 44100)
    k.process([x], [new Float32Array(n)], n)
    return k.getMetering().maxGainReductionDb
  }
  // A steeper fall must reduce LESS at high overshoot — that is what falling means.
  const shipping = grAt(-3, {})
  const steeper = grAt(-3, { allIncrFallPerDb: ALL_INCR_FALL_PER_DB * 3 })
  assert.ok(steeper < shipping,
    `a steeper fall must compress less up here: ${steeper.toFixed(2)} vs ${shipping.toFixed(2)} dB`)
  const flat = grAt(-3, { allIncrFallPerDb: 0 })
  assert.ok(flat > shipping, 'and a flat law must compress more')
  assert.ok(Math.abs(ALL_INCR_AT_KNEE - 0.949) < 1e-9, 'the fitted anchor is what ships')
})
