/**
 * Run with:  npm test
 *
 * THE SHARED MAKEUP REFERENCE — the percentile both compressors solve against,
 * and the ceiling that makes it safe to.
 *
 * ⚠ THE PERCENTILE IS A QUICKSELECT, AND THE POINT OF THESE TESTS IS THAT IT IS
 * EXACT. It replaced a full sort because the sort was a real cost — 160.7 ms on
 * the 30 s analysis cap against 230.3 ms for a whole base-rate kernel render, so
 * roughly 40 % of a converged makeup solve, inside the budget that cap exists to
 * protect. A quantised or approximate answer would have been the wrong trade:
 * the makeup is derived from this number, so an approximate quantile is an
 * approximate gain. Every case below is checked against a full sort.
 *
 * The degenerate shapes are the ones that matter. An all-equal array, a
 * two-value array and an already-sorted one are exactly what a careless pivot or
 * an off-by-one partition mishandles — and audio magnitudes are far from random,
 * so "already ordered" is a realistic input here rather than a contrived one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  percentileOfChannels, softCeiling, float32AtOrBelow,
  MAKEUP_PERCENTILE, CEILING_KNEE_DB,
} from '../../src/audio/dsp/makeupReference.js'

/** The definition the quickselect has to match, done the slow obvious way. */
function byFullSort(channels, q, skip = 0) {
  const all = []
  for (const ch of channels) for (let i = skip; i < ch.length; i++) all.push(Math.abs(ch[i]))
  if (!all.length) return 0
  const a = Float32Array.from(all).sort()
  const idx = Math.min(a.length - 1, Math.max(0, Math.round(a.length * (1 - q)) - 1))
  return a[idx]
}

const SHAPES = {
  random: n => Float32Array.from({ length: n }, () => Math.random() * 2 - 1),
  allEqual: n => Float32Array.from({ length: n }, () => 0.5),
  twoValues: n => Float32Array.from({ length: n }, (_, i) => (i % 2 ? 0.2 : 0.8)),
  ascending: n => Float32Array.from({ length: n }, (_, i) => i / n),
  descending: n => Float32Array.from({ length: n }, (_, i) => 1 - i / n),
  oneOutlier: n => Float32Array.from({ length: n }, (_, i) => (i < n - 1 ? 0.1 : 0.9)),
  allZero: n => new Float32Array(n),
}

for (const [name, shape] of Object.entries(SHAPES)) {
  test(`percentileOfChannels matches a full sort — ${name}`, () => {
    for (const n of [1, 2, 3, 5, 17, 1000, 4099]) {
      for (const q of [0.001, 0.01, 0.5, 0.999]) {
        const x = shape(n)
        const got = percentileOfChannels([Float32Array.from(x)], q)
        const want = byFullSort([x], q)
        assert.ok(Object.is(got, want), `${name} n=${n} q=${q}: ${got} vs ${want}`)
      }
    }
  })
}

test('it spans channels rather than reading the first', () => {
  const left = Float32Array.from({ length: 3000 }, () => Math.random())
  const right = Float32Array.from({ length: 3000 }, () => Math.random() * 0.3)
  assert.ok(Object.is(
    percentileOfChannels([Float32Array.from(left), Float32Array.from(right)], MAKEUP_PERCENTILE),
    byFullSort([left, right], MAKEUP_PERCENTILE),
  ))
})

test('it honours skip, which is how a latency-padded render is measured', () => {
  const x = Float32Array.from({ length: 500 }, (_, i) => (i < 50 ? 0.99 : 0.1))
  assert.ok(Object.is(
    percentileOfChannels([Float32Array.from(x)], 0.01, 50),
    byFullSort([x], 0.01, 50),
  ))
})

test('an empty or fully skipped region reports zero rather than throwing', () => {
  assert.equal(percentileOfChannels([], 0.001), 0)
  assert.equal(percentileOfChannels([new Float32Array(0)], 0.001), 0)
  assert.equal(percentileOfChannels([new Float32Array(10)], 0.001, 10), 0)
})

test('it does not modify the caller’s buffers', () => {
  const x = Float32Array.from({ length: 200 }, () => Math.random() * 2 - 1)
  const before = Float32Array.from(x)
  percentileOfChannels([x], 0.001)
  for (let i = 0; i < x.length; i++) assert.equal(x[i], before[i], `sample ${i} was reordered`)
})

// ── the ceiling ─────────────────────────────────────────────────────────────

test('softCeiling is unity below the knee, to the bit', () => {
  const ceiling = 0.5
  const kneeStart = ceiling * Math.exp(-CEILING_KNEE_DB * Math.LN10 / 20)
  for (const v of [0, 1e-9, 0.01, kneeStart * 0.5, kneeStart]) {
    assert.equal(softCeiling(v, ceiling, kneeStart), v, `${v} was touched below the knee`)
    assert.equal(softCeiling(-v, ceiling, kneeStart), -v)
  }
})

test('softCeiling never exceeds the ceiling, at any drive or sign', () => {
  const ceiling = 0.5
  const kneeStart = ceiling * Math.exp(-CEILING_KNEE_DB * Math.LN10 / 20)
  for (const v of [0.4, 0.5, 0.7, 1, 4, 100, 1e6]) {
    assert.ok(softCeiling(v, ceiling, kneeStart) <= ceiling, `+${v} exceeded`)
    assert.ok(softCeiling(-v, ceiling, kneeStart) >= -ceiling, `-${v} exceeded`)
  }
})

test('softCeiling is monotone and odd', () => {
  const ceiling = 0.5
  const kneeStart = ceiling * Math.exp(-CEILING_KNEE_DB * Math.LN10 / 20)
  let previous = -Infinity
  for (let v = 0; v < 2; v += 0.001) {
    const y = softCeiling(v, ceiling, kneeStart)
    assert.ok(y >= previous, `not monotone at ${v}`)
    assert.equal(softCeiling(-v, ceiling, kneeStart), -y, `not odd at ${v}`)
    previous = y
  }
})

/**
 * ⚠ THE STORE IS WHY THIS EXISTS. Output buffers are Float32Array, so a float64
 * ceiling written into one becomes float32's NEAREST neighbour, which rounds up
 * — measured 5e-10 over at a -8 dBFS ceiling, where the same code passed at -6
 * and -12. Rounding down first makes the clamped value exactly representable.
 */
test('float32AtOrBelow never rounds up, and survives the store', () => {
  const probe = new Float32Array(1)
  for (const db of [-1, -2.8, -6, -8, -12, -0.1, -23.7]) {
    const exact = Math.exp(db * Math.LN10 / 20)
    const safe = float32AtOrBelow(exact)
    assert.ok(safe <= exact, `${db} dB: ${safe} > ${exact}`)
    probe[0] = safe
    assert.ok(probe[0] <= exact, `${db} dB: survived rounding but not the store`)
    assert.equal(probe[0], safe, `${db} dB: not exactly representable in float32`)
  }
})

test('MAKEUP_PERCENTILE sits clear of the programme', () => {
  assert.ok(MAKEUP_PERCENTILE > 0 && MAKEUP_PERCENTILE <= 0.01,
    'a reference below the 99th percentile would track the programme, not the outlier')
})
