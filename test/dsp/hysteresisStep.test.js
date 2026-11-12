/**
 * Run with:  npm test
 *
 * The Jiles-Atherton loop's speedups (dsp/hysteresis.js): the Langevin table
 * that ships, and the one-evaluation `fast` step PHAT*SS's bench A/Bs.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JilesAtherton } from '../../src/audio/dsp/hysteresis.js'
import { toKernelParams, PHATASS_DEFAULTS, TAPE_STEPS } from '../../src/audio/phatassParams.js'
import { shaperCurve, SHAPER_CURVES } from '../../src/audio/dsp/shaperCurves.js'

/** A drum-ish test field: decaying low tones with a noisy click on each hit. */
function field(n, drive) {
  const h = new Float64Array(n)
  let r = 7
  for (let i = 0; i < n; i++) {
    const t = i % 8000
    r = (r * 16807) % 2147483647
    const env = Math.exp(-t / 1500)
    h[i] = drive * env * (Math.sin(i * 0.01) + (t < 200 ? 0.3 * ((r / 2147483647) * 2 - 1) : 0) + 0.2 * Math.sin(i * 0.13))
  }
  return h
}

/** The closed-form model (no table) — what the loop was before the table shipped. */
class ClosedForm extends JilesAtherton {
  _dmdh(m, h, d) {
    const L = q => (Math.abs(q) < 1e-3 ? q / 3 - (q * q * q) / 45 : 1 / Math.tanh(q) - 1 / q)
    const Ls = q => (Math.abs(q) < 1e-3 ? 1 / 3 - (q * q) / 15 : 1 / (q * q) - 1 / Math.sinh(q) ** 2)
    const q = h + this.A * m
    const man = L(q)
    const dman = Ls(q)
    const dm = man - m
    const irr = dm * d >= 0 ? ((1 - this.c) * dm) / ((1 - this.c) * d * this.K - this.A * dm) : 0
    return (irr + this.c * dman) / (1 - this.c * this.A * dman)
  }
}

const errDb = (y, ref) => {
  let e = 0, er = 0
  for (let i = 0; i < y.length; i++) { e += (y[i] - ref[i]) ** 2; er += ref[i] ** 2 }
  return 10 * Math.log10(e / er)
}
const run = (ja, h) => Float64Array.from(h, v => ja.step(v))

test('the Langevin table reproduces the closed-form loop to under −150 dB, out to deep saturation', () => {
  for (const drive of [0.5, 3, 40]) {
    const h = field(40000, drive)
    const e = errDb(run(new JilesAtherton(), h), run(new ClosedForm(), h))
    assert.ok(e < -150, `drive ${drive}: ${e.toFixed(1)} dB`)
  }
})

test('the FAST step stays within −45 dB of the exact loop, even through un-oversampled noise bursts', () => {
  for (const drive of [1, 3, 10]) {
    const h = field(40000, drive)
    const exact = run(new JilesAtherton(), h)
    const e = errDb(run(new JilesAtherton({ fast: true }), h), exact)
    assert.ok(e < -45, `drive ${drive}: ${e.toFixed(1)} dB`)
    assert.ok(e > -200, 'the fast step is a different integrator, not a copy')
  }
})

test('PHAT*SS: Loop step ships EXACT; FAST picks the hidden fast curve for THICK only', () => {
  assert.deepEqual(TAPE_STEPS, ['exact', 'fast'])
  assert.equal(PHATASS_DEFAULTS.tapeStep, 'exact')
  const base = { tape: 6, voiceLevelDb: -20, warmthCeilingDb: -3 }
  assert.equal(toKernelParams({ ...base, tapeCurve: 'hysteresis' }).tapeLayer.curve, 'hysteresis')
  const fast = toKernelParams({ ...base, tapeCurve: 'hysteresis', tapeStep: 'fast' }).tapeLayer
  assert.equal(fast.curve, 'hysteresis-fast')
  // Same drive: the fast loop is calibrated as the exact one.
  assert.equal(fast.driveDb, toKernelParams({ ...base, tapeCurve: 'hysteresis' }).tapeLayer.driveDb)
  assert.equal(toKernelParams({ ...base, tapeCurve: 'cubic', tapeStep: 'fast' }).tapeLayer.curve, 'cubic')
  assert.equal(shaperCurve('hysteresis-fast').hidden, true)
  assert.ok(SHAPER_CURVES.filter(c => !c.hidden).every(c => c.id !== 'hysteresis-fast'))
})
