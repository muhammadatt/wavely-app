/**
 * Auto Leveler — the segment list's contract with its two consumers.
 *
 * The gain curve exists in two forms: scheduled onto an AudioParam for preview,
 * expanded per sample for apply. Both derive from one segment list, and these
 * tests pin the properties each consumer silently assumes — the ones whose
 * violation produces a wrong sound rather than an exception.
 *
 * The parity suite already proves the segments reproduce the server's curve on
 * real audio. What it cannot reach is the pathological layout: crossfades
 * running off the end of the region, clips that abut with no gap, a single
 * clip, a region shorter than one fade. Those are built directly here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGainSegments, expandGainSegments, gainDbAtSample, crossfadeWeight,
  buildCrossfadePlans, buildPowerSum, CROSSFADE_MS,
} from '../../src/audio/dsp/autoLevel.js'
import { renderRampCurve } from '../../src/audio/effects/autoLevel.js'

const SR = 44100

function clip(startSample, endSample) {
  return { hopStart: 0, hopEnd: 0, sampleStart: startSample, sampleEnd: endSample }
}

/** Crossfade plans placed as the solver would, over flat (silent) audio. */
function plansFor(clips, gains, totalSamples) {
  const ps = buildPowerSum(new Float32Array(totalSamples))
  const xf = Math.max(1, Math.round(CROSSFADE_MS * 0.001 * SR))
  return buildCrossfadePlans(clips, gains, ps, xf, totalSamples)
}

// ── Tiling: the property both consumers depend on ────────────────────────────

/**
 * `expandGainSegments` writes into a Float32Array it does not pre-fill, and the
 * scheduler emits one automation event per segment. Both are only correct if
 * the segments cover the region exactly once, in order: a hole leaves expand
 * writing a silent 0 dB it never meant and leaves the scheduler holding a stale
 * value, and an overlap makes `setValueCurveAtTime` throw outright.
 */
function assertTiles(segments, totalSamples, label) {
  assert.ok(segments.length > 0, `${label}: no segments`)
  assert.equal(segments[0].startSample, 0, `${label}: does not start at 0`)
  assert.equal(
    segments[segments.length - 1].endSample, totalSamples,
    `${label}: does not reach the end`,
  )
  for (let i = 0; i < segments.length; i++) {
    assert.ok(
      segments[i].endSample > segments[i].startSample,
      `${label}: segment ${i} is empty`,
    )
    if (i > 0) {
      assert.equal(
        segments[i].startSample, segments[i - 1].endSample,
        `${label}: gap or overlap before segment ${i}`,
      )
    }
  }
}

const LAYOUTS = [
  {
    name: 'clips separated by long gaps',
    clips: [clip(0, 44100), clip(88200, 132300), clip(176400, 220500)],
    gains: [3, -2, 1],
    total: 264600,
  },
  {
    name: 'abutting clips (sub-phrase splits, no gap at all)',
    clips: [clip(0, 44100), clip(44100, 88200), clip(88200, 132300)],
    gains: [4, 0, -3],
    total: 132300,
  },
  {
    name: 'mixed abutting and gapped',
    clips: [clip(4410, 44100), clip(44100, 88200), clip(100000, 132300)],
    gains: [-5, 2, 2],
    total: 140000,
  },
  {
    name: 'final clip ends at the region edge, fade would run past it',
    clips: [clip(0, 44100), clip(44100, 60000)],
    gains: [0, 5],
    total: 60000,
  },
  {
    name: 'single clip — no boundaries to fade',
    clips: [clip(10000, 50000)],
    gains: [2.5],
    total: 60000,
  },
  {
    name: 'region shorter than one crossfade',
    clips: [clip(0, 400), clip(400, 800)],
    gains: [1, -1],
    total: 800,
  },
]

for (const layout of LAYOUTS) {
  test(`segments tile the region: ${layout.name}`, () => {
    const plans = plansFor(layout.clips, layout.gains, layout.total)
    const segments = buildGainSegments(layout.clips, layout.gains, plans, layout.total)
    assertTiles(segments, layout.total, layout.name)
  })

  test(`gainDbAtSample agrees with the expansion: ${layout.name}`, () => {
    const plans = plansFor(layout.clips, layout.gains, layout.total)
    const segments = buildGainSegments(layout.clips, layout.gains, plans, layout.total)
    const expanded = expandGainSegments(segments, layout.total)

    // The meter reads single positions out of the same curve the apply path
    // writes; if the two disagree the bar shows a gain nobody hears.
    for (let i = 0; i < layout.total; i += 97) {
      assert.ok(
        Math.abs(gainDbAtSample(segments, i) - expanded[i]) < 1e-5,
        `${layout.name}: sample ${i} reads ${gainDbAtSample(segments, i)} ` +
        `but expands to ${expanded[i]}`,
      )
    }
  })
}

test('no clips at all is unity across the whole region', () => {
  const segments = buildGainSegments([], [], [], 1000)
  assertTiles(segments, 1000, 'empty')
  const expanded = expandGainSegments(segments, 1000)
  for (let i = 0; i < 1000; i++) assert.equal(expanded[i], 0)
})

// ── Ramp integrity ───────────────────────────────────────────────────────────

test('ramps are never split across segments', () => {
  // A voiced-adjacent boundary puts a clip edge in the middle of its own fade,
  // which is the case that tempted an earlier version to emit two half-fades.
  // Two linear halves of a cosine are not the cosine, and the seam sits exactly
  // where the fade was supposed to be smoothest.
  const clips = [clip(0, 44100), clip(44100, 88200)]
  const gains = [6, -6]
  const plans = plansFor(clips, gains, 88200)
  const segments = buildGainSegments(clips, gains, plans, 88200)

  const ramps = segments.filter(s => s.fromDb !== s.toDb)
  assert.equal(ramps.length, 1, 'expected exactly one fade')

  const xf = Math.round(CROSSFADE_MS * 0.001 * SR)
  assert.equal(ramps[0].endSample - ramps[0].startSample, xf,
    'the fade is not its full length')
  assert.equal(ramps[0].fromDb, 6)
  assert.equal(ramps[0].toDb, -6)

  // And it really is a cosine end to end, not two straight lines.
  const expanded = expandGainSegments(segments, 88200)
  const mid = ramps[0].startSample + Math.floor(xf / 2)
  const quarter = ramps[0].startSample + Math.floor(xf / 4)
  assert.ok(Math.abs(expanded[mid] - 0) < 0.05, 'fade midpoint should be ~0 dB')
  // A straight line would read 3 dB at the quarter point; the cosine reads
  // shallower because it leaves its endpoint slowly.
  assert.ok(expanded[quarter] > 3.2,
    `quarter point ${expanded[quarter].toFixed(2)} dB looks linear, not cosine`)
})

// ── Preview/apply equivalence ────────────────────────────────────────────────

test('the scheduled fade curve matches the rendered one sample for sample', () => {
  // The whole preview/apply equivalence claim reduces to this: the Float32Array
  // handed to setValueCurveAtTime has to hold the same values, in the same
  // order, that expandGainSegments writes over the same span. Web Audio
  // interpolates linearly between curve points, and there is one point per
  // sample, so equality at the points is equality everywhere.
  const segment = { startSample: 1000, endSample: 1000 + 1323, fromDb: -4, toDb: 7 }
  const curve = renderRampCurve(segment, SR)

  // length + 1: the points are the sample boundaries, so the last one lands on
  // the fade's end rather than one sample short of it.
  assert.equal(curve.length, 1324)

  const total = 3000
  const expanded = expandGainSegments(
    [
      { startSample: 0, endSample: 1000, fromDb: -4, toDb: -4 },
      segment,
      { startSample: segment.endSample, endSample: total, fromDb: 7, toDb: 7 },
    ],
    total,
  )

  // Every point but the last has a sample under it; the last is the fade's
  // endpoint, checked separately below.
  for (let i = 0; i < curve.length - 1; i++) {
    // The curve is linear gain; the expansion is dB.
    const expectedLin = Math.pow(10, expanded[segment.startSample + i] / 20)
    assert.ok(
      Math.abs(curve[i] - expectedLin) < 1e-5,
      `curve point ${i}: scheduled ${curve[i]} vs rendered ${expectedLin}`,
    )
  }

  // Endpoints exactly, since those are what the neighbouring holds must meet.
  assert.ok(Math.abs(curve[0] - Math.pow(10, -4 / 20)) < 1e-6)
  assert.ok(Math.abs(curve[curve.length - 1] - Math.pow(10, 7 / 20)) < 1e-6)
})

test('crossfadeWeight is a raised cosine from 0 to 1', () => {
  assert.equal(crossfadeWeight(0), 0)
  assert.ok(Math.abs(crossfadeWeight(0.5) - 0.5) < 1e-12)
  assert.ok(Math.abs(crossfadeWeight(1) - 1) < 1e-12)
  // Monotone, so a fade never doubles back.
  let prev = -1
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const w = crossfadeWeight(t)
    assert.ok(w >= prev, `not monotone at t=${t}`)
    prev = w
  }
})
