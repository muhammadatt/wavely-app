/**
 * OptoSmooth's auto makeup at partial Mix.
 *
 * ⚠ THE PLAIN LOOP STALLED HERE, AND ITS OUTPUT LEVEL HID IT. It adds the whole
 * dB error to the makeup each pass, which assumes a dB of makeup moves the
 * output a dB; summed with a dry path it moves it by the wet share only. At
 * Peak Reduction 70 the makeup landed 1.4 / 4.6 / 9.8 dB short at mix
 * 0.5 / 0.3 / 0.1 while the output level was only 0.7 / 1.2 / 0.6 dB short —
 * the dry path dominates it. So these tests check the level against the REAL
 * mixed render and, separately, the makeup against a fully converged solve.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  processLA2ABuffer, computeAutoMakeupPlan, la2aLatencySamples,
} from '../../src/audio/la2aProcessor.js'
import {
  MAKEUP_PERCENTILE, percentileOfChannels, peakOfChannels,
  blendInto, peakBlendGain, percentileBlendGain,
} from '../../src/audio/dsp/makeupReference.js'
import { LA2A_DEFAULTS, toKernelParams } from '../../src/audio/effects/la2aParams.js'

const SR = 44100
const db = x => 20 * Math.log10(Math.max(x, 1e-12))

/** Narration-shaped: syllables, and one hot onset out of a pause. */
function stimulus(seconds = 2) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    phase += (2 * Math.PI * 130) / SR
    let s = 0
    for (let h = 1; h <= 10; h++) s += Math.sin(phase * h) / (h * h)
    const gap = t > 0.8 && t < 1.0
    const syl = Math.max(0, Math.sin(2 * Math.PI * 3 * t)) ** 2
    const hot = t >= 1.0 && t < 1.05 ? 2.2 : 1
    x[i] = gap ? 0.0005 * s : 0.42 * s * syl * hot
  }
  return x
}

/** The kernel's real mixed output at a makeup, latency trimmed. */
function renderAt(x, params) {
  const p = { oversample: false, ceilingDb: null, ...params }
  const lat = la2aLatencySamples(p, SR)
  const padded = new Float32Array(x.length + lat)
  padded.set(x)
  return processLA2ABuffer([padded], SR, p).channelData[0].subarray(lat, lat + x.length)
}

const pct = x => percentileOfChannels([x], MAKEUP_PERCENTILE)

test('at partial mix the solved makeup puts the real mixed output on target', () => {
  const x = stimulus()
  for (const peakReduction of [50, 70]) {
    for (const mix of [0.5, 0.3, 0.1]) {
      const params = { peakReduction, mix, lookaheadMs: 0 }
      const plan = computeAutoMakeupPlan([x], SR, params, { reference: 'percentile' })
      const errDb = db(pct(renderAt(x, { ...params, gainDb: plan.makeupDb }))) - db(pct(x))
      assert.ok(Math.abs(errDb) < 0.05,
        `PR ${peakReduction} mix ${mix}: output ${errDb.toFixed(3)} dB off target`)
    }
  }
})

test('at partial mix the makeup matches a fully converged solve, not just the level', () => {
  const x = stimulus()
  for (const mix of [0.3, 0.1]) {
    const params = { peakReduction: 70, mix, lookaheadMs: 0 }
    const shipped = computeAutoMakeupPlan([x], SR, params, { reference: 'percentile' })
    const converged = computeAutoMakeupPlan([x], SR, params,
      { reference: 'percentile', maxIterations: 50, toleranceDb: 0.0005 })
    assert.ok(Math.abs(shipped.makeupDb - converged.makeupDb) < 0.05,
      `mix ${mix}: ${shipped.makeupDb.toFixed(2)} dB against converged ${converged.makeupDb.toFixed(2)}`)
  }
})

test('the peak reference is honoured at partial mix too', () => {
  const x = stimulus()
  const params = { peakReduction: 60, mix: 0.4, lookaheadMs: 0 }
  const plan = computeAutoMakeupPlan([x], SR, params, { reference: 'peak' })
  const out = renderAt(x, { ...params, gainDb: plan.makeupDb })
  const errDb = db(peakOfChannels([out])) - db(peakOfChannels([x]))
  assert.ok(Math.abs(errDb) < 0.05, `peak ${errDb.toFixed(3)} dB off the source peak`)
})

test('mix 1 is the shipping solve, unchanged, whether the key is sent or not', () => {
  const x = stimulus()
  for (const reference of ['peak', 'percentile']) {
    const absent = computeAutoMakeupPlan([x], SR, { peakReduction: 60 }, { reference })
    const one = computeAutoMakeupPlan([x], SR, { peakReduction: 60, mix: 1 }, { reference })
    assert.deepEqual(one, absent)
  }
})

test('the ceiling still keeps a partial-mix render at or under the source peak', () => {
  const x = stimulus()
  const params = { peakReduction: 70, mix: 0.3, lookaheadMs: 0 }
  const plan = computeAutoMakeupPlan([x], SR, params, { reference: 'percentile' })
  assert.ok(Number.isFinite(plan.ceilingDb) && Number.isFinite(plan.ceilingKneeDb))
  const out = renderAt(x, {
    ...params, gainDb: plan.makeupDb, ceilingDb: plan.ceilingDb, ceilingKneeDb: plan.ceilingKneeDb,
  })
  assert.ok(db(peakOfChannels([out])) <= plan.ceilingDb + 1e-4,
    `peak ${db(peakOfChannels([out])).toFixed(3)} over ceiling ${plan.ceilingDb.toFixed(3)}`)
})

test('mix 0 has nothing to make up', () => {
  const plan = computeAutoMakeupPlan([stimulus()], SR, { peakReduction: 70, mix: 0 }, { reference: 'percentile' })
  assert.equal(plan.makeupDb, 0)
})

test('the panel always sends mix, so a return to 1 reaches the live worklet', () => {
  assert.equal(LA2A_DEFAULTS.mix, 1)
  assert.equal(toKernelParams(LA2A_DEFAULTS).mix, 1)
  assert.equal(toKernelParams({ ...LA2A_DEFAULTS, mix: 0.35 }).mix, 0.35)
  // A patch saved before the control existed has no key, and was heard fully wet.
  const { mix: _omit, ...legacy } = LA2A_DEFAULTS
  assert.equal(toKernelParams(legacy).mix, 1)
})

test('the shared blend solve: closed form at mix 1, bisection below it', () => {
  const dry = [Float32Array.from([0.5, -0.25, 0.1, 0.8])]
  const wet = [Float32Array.from([0.2, -0.1, 0.05, 0.3])]
  // Peak: the tightest sample bound on |a + b·g| <= limit.
  const g = peakBlendGain(dry, wet, 0.5, 0.8)
  const out = blendInto([new Float32Array(4)], dry, wet, 0.5, g)
  assert.ok(Math.abs(peakOfChannels(out) - 0.8) < 1e-6)
  // Percentile at mix 1 scales exactly.
  const target = 2 * percentileOfChannels(wet, MAKEUP_PERCENTILE)
  assert.ok(Math.abs(percentileBlendGain(dry, wet, 1, target, -24, 24, null) - 2) < 1e-9)
  // Below mix 1 the bisection lands the blend on its target.
  const scratch = [new Float32Array(4)]
  const gp = percentileBlendGain(dry, wet, 0.5, 0.6, -24, 24, scratch)
  const ref = percentileOfChannels(blendInto(scratch, dry, wet, 0.5, gp), MAKEUP_PERCENTILE)
  assert.ok(Math.abs(db(ref) - db(0.6)) < 0.01)
})
