/**
 * Run with:  npm test
 *
 * PERCENTILE-REFERENCED MAKEUP, AND THE CEILING THAT MAKES IT LEGAL.
 *
 * ⚠ THE PROMISE UNDER TEST IS ONE THE ARITHMETIC USED TO MAKE FOR FREE. Peak-
 * referenced makeup cannot push the output above the source: it solves for
 * exactly that. A percentile reference gives that up — measured, by nearly
 * 6 dB — and `ceilingDb` puts it back by enforcement. So the guarantee moved
 * from being a property of the solve to being a property of a stage, and a
 * stage can be bypassed, misconfigured or regressed where arithmetic cannot.
 * That is what these tests are for; see the note on `peakOfChannels`.
 *
 * The nulls matter as much as the guarantee: a build that never asks for a
 * percentile must be sample-identical to one from before this existed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  processLA2ABuffer, computeAutoMakeupDb, computeAutoMakeupPlan,
  MAKEUP_PERCENTILE,
} from '../../src/audio/la2aProcessor.js'

const SR = 44100
const db = x => 20 * Math.log10(Math.max(x, 1e-12))
const peak = x => { let p = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a } return p }

/**
 * Narration-shaped: syllables, and one hard onset out of a long silence. The
 * onset is the whole point — it is the shape that binds a peak-referenced
 * solve, so a stimulus without one cannot tell the two references apart.
 */
function stimulus(seconds = 4) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    phase += (2 * Math.PI * 130) / SR
    let s = 0
    for (let h = 1; h <= 10; h++) s += Math.sin(phase * h) / (h * h)
    const gap = t > 1.6 && t < 1.9
    const syl = Math.max(0, Math.sin(2 * Math.PI * 3 * t)) ** 2
    // The onset just after the gap is hot, and nothing else is.
    const hot = t >= 1.9 && t < 1.95 ? 2.2 : 1
    x[i] = gap ? 0.0005 * s : 0.42 * s * syl * hot
  }
  return x
}

const render = (x, params) => processLA2ABuffer([x], SR, {
  lookaheadMs: 0, ...params,
}).channelData[0]

test('the percentile reference asks for more makeup than the peak reference', () => {
  const x = stimulus()
  for (const pr of [50, 60, 70]) {
    const byPeak = computeAutoMakeupPlan([x], SR, { peakReduction: pr })
    const byPct = computeAutoMakeupPlan([x], SR, { peakReduction: pr }, { reference: 'percentile' })
    assert.ok(byPct.makeupDb > byPeak.makeupDb,
      `PR ${pr}: percentile ${byPct.makeupDb.toFixed(2)} should exceed peak ${byPeak.makeupDb.toFixed(2)}`)
  }
})

test('the peak reference returns no ceiling; the percentile reference always does', () => {
  const x = stimulus()
  assert.equal(computeAutoMakeupPlan([x], SR, { peakReduction: 60 }).ceilingDb, null)
  const pct = computeAutoMakeupPlan([x], SR, { peakReduction: 60 }, { reference: 'percentile' })
  assert.ok(Number.isFinite(pct.ceilingDb), 'percentile plan must carry a ceiling')
  assert.ok(Math.abs(pct.ceilingDb - db(peak(x))) < 1e-6,
    `the ceiling is the source peak: ${pct.ceilingDb} vs ${db(peak(x))}`)
})

test('an unknown reference is refused rather than silently treated as peak', () => {
  assert.throws(() => computeAutoMakeupPlan([stimulus(1)], SR, {}, { reference: 'p99' }), /unknown makeup reference/)
})

/**
 * ⚠ THE FAILURE THE CEILING EXISTS FOR, PINNED AS A FAILURE. If this ever stops
 * failing, the percentile has stopped over-compensating and the pairing has
 * become unnecessary — which is a finding, not a passing test.
 */
test('percentile makeup WITHOUT the ceiling does exceed the source peak', () => {
  const x = stimulus()
  const plan = computeAutoMakeupPlan([x], SR, { peakReduction: 70 }, { reference: 'percentile' })
  const unguarded = render(x, { peakReduction: 70, gainDb: plan.makeupDb })
  assert.ok(peak(unguarded) > peak(x),
    `expected overshoot without the ceiling: ${db(peak(unguarded)).toFixed(2)} vs ${db(peak(x)).toFixed(2)}`)
})

test('the ceiling holds the output under the source peak at every setting', () => {
  const x = stimulus()
  const inPeak = peak(x)
  for (const pr of [40, 50, 60, 70, 80, 90]) {
    for (const tube of [false, true]) {
      const params = { peakReduction: pr, tube }
      const plan = computeAutoMakeupPlan([x], SR, params, { reference: 'percentile' })
      const y = render(x, { ...params, gainDb: plan.makeupDb, ceilingDb: plan.ceilingDb })
      assert.ok(peak(y) <= inPeak,
        `PR ${pr} tube=${tube}: output ${db(peak(y)).toFixed(3)} exceeded source ${db(inPeak).toFixed(3)}`)
    }
  }
})

test('the ceiling is strict, not merely met, and holds against absurd gain', () => {
  const x = stimulus(1)
  const ceilingDb = -6
  const y = render(x, { peakReduction: 0, gainDb: 24, ceilingDb })
  assert.ok(peak(y) < Math.exp(ceilingDb * Math.LN10 / 20),
    `asymptotic ceiling must not be reached: ${db(peak(y)).toFixed(4)} vs ${ceilingDb}`)
})

test('no ceiling is sample-identical to not passing one', () => {
  const x = stimulus(2)
  const bare = render(x, { peakReduction: 60, gainDb: 6 })
  const explicit = render(x, { peakReduction: 60, gainDb: 6, ceilingDb: null })
  for (let i = 0; i < bare.length; i++) assert.equal(bare[i], explicit[i], `sample ${i} moved`)
})

test('a ceiling above the signal changes nothing', () => {
  const x = stimulus(2)
  const bare = render(x, { peakReduction: 60, gainDb: 0 })
  const high = render(x, { peakReduction: 60, gainDb: 0, ceilingDb: 12 })
  for (let i = 0; i < bare.length; i++) {
    assert.equal(bare[i], high[i], `sample ${i} moved under a ceiling nothing reaches`)
  }
})

test('computeAutoMakeupDb is unchanged and still peak-referenced', () => {
  const x = stimulus(2)
  assert.equal(computeAutoMakeupDb([x], SR, { peakReduction: 60 }),
    computeAutoMakeupPlan([x], SR, { peakReduction: 60 }).makeupDb)
})

test('MAKEUP_PERCENTILE sits clear of the programme', () => {
  assert.ok(MAKEUP_PERCENTILE > 0 && MAKEUP_PERCENTILE <= 0.01,
    'a reference below the 99th percentile would track the programme, not the outlier')
})
