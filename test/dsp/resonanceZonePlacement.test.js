/**
 * Zone placement from a measured voice.
 *
 * The property that matters most here is the NEGATIVE one: a male narrator must
 * reproduce the shipped boundaries exactly. Everything this panel has been
 * listened to on is male or near it, so a placement that moved those numbers
 * would silently re-tune every calibration on record while looking like a
 * feature. Several of these tests exist to fail if that happens.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PLACED_ZONE_COUNT,
  PLACEMENT_CEIL_HZ,
  PLACEMENT_FLOOR_HZ,
  placeResonanceZones,
  voiceZoneBoundaries,
} from '../../src/audio/resonanceZonePlacement.js'
import {
  DEFAULT_RESONANCE_ZONES,
  RESONANCE_ZONE_MAX,
  RESONANCE_ZONE_MIN_OCTAVES,
  RESONANCE_ZONE_STOCK,
  buildResonanceZoneCurves,
} from '../../src/audio/resonanceParams.js'

/** A male narrator near the voice the stock numbers were calibrated on. */
const MALE = { medianF0Hz: 110, cornerHz: 60 }
/** A female narrator, where the region tables sit 0.26-0.47 octaves higher. */
const FEMALE = { medianF0Hz: 210, cornerHz: 100 }

const STOCK_BOUNDARIES = DEFAULT_RESONANCE_ZONES.slice(0, -1).map(z => z.hiHz)

test('placement never exceeds the zone editor cap', () => {
  assert.ok(PLACED_ZONE_COUNT <= RESONANCE_ZONE_MAX)
})

test('a male voice reproduces the shipped boundaries exactly', () => {
  // THE WHOLE POINT. The stock set is the male region table; scaling it by its
  // own anchors' ratios against a male reference must be the identity. If this
  // fails, every listening result recorded against the stock zones is void.
  const { boundaries } = placeResonanceZones(null, MALE)
  assert.deepEqual(boundaries.slice(1), STOCK_BOUNDARIES)
})

test('a female voice moves every boundary up, and by the table\'s own ratios', () => {
  const { boundaries, voiceType } = placeResonanceZones(null, FEMALE)
  assert.equal(voiceType, 'female')
  // upper_presence's top edge is 5000 male / 6000 female, and the stock 5000 IS
  // that edge, so this one lands on the table value with no rounding to hide in.
  assert.equal(boundaries[3], 6000)
  // lower_presence's bottom is 1200 / 1500, a ratio of exactly 1.25.
  assert.equal(boundaries[2], Math.round(1100 * 1.25))
  // body_warmth's geometric centre, sqrt(120*280) -> sqrt(180*350).
  const ratio = Math.sqrt(180 * 350) / Math.sqrt(120 * 280)
  assert.equal(boundaries[1], Math.round(180 * ratio))

  for (let i = 1; i < boundaries.length; i++) {
    assert.ok(boundaries[i] > STOCK_BOUNDARIES[i - 1], `boundary ${i} moved up`)
  }
})

test('an ambiguous voice interpolates between the two, monotonically', () => {
  const low = placeResonanceZones(null, { medianF0Hz: 150, cornerHz: 80 }).boundaries
  const mid = placeResonanceZones(null, { medianF0Hz: 170, cornerHz: 85 }).boundaries
  const high = placeResonanceZones(null, { medianF0Hz: 190, cornerHz: 90 }).boundaries
  for (let i = 1; i < 4; i++) {
    assert.ok(low[i] <= mid[i] && mid[i] <= high[i], `boundary ${i} rises with F0`)
    assert.ok(mid[i] >= STOCK_BOUNDARIES[i - 1])
  }
})

test('the sub-fundamental boundary is the measured corner, not a scaled one', () => {
  // It is a statement about this speaker rather than about a region table, so
  // it must pass through untouched. A mutation that scaled it alongside the
  // others would still produce a plausible-looking ladder.
  // Both voices, because on a male one every anchor ratio is 1 and a mutation
  // that scaled the corner alongside the rest would be invisible.
  for (const medianF0Hz of [130, 210]) {
    for (const corner of [40, 55, 72, 100]) {
      const { boundaries } = placeResonanceZones(null, { medianF0Hz, cornerHz: corner })
      assert.equal(boundaries[0], corner, `F0 ${medianF0Hz}, corner ${corner}`)
    }
  }
})

test('boundaries stay ordered and inside the band on a hostile measurement', () => {
  // The corner cannot normally reach a fundamental boundary — it clamps at
  // 100 Hz and the lowest fundamental boundary is 180 — but nothing structural
  // says so, and a zone of negative width is a state the strip draws and the
  // user cannot undo by dragging.
  const { boundaries } = voiceZoneBoundaries(400, 100000, STOCK_BOUNDARIES)
  const gap = Math.pow(2, RESONANCE_ZONE_MIN_OCTAVES)
  assert.ok(boundaries[0] >= PLACEMENT_FLOOR_HZ)
  for (let i = 1; i < boundaries.length; i++) {
    assert.ok(boundaries[i] >= boundaries[i - 1] * gap * 0.999,
      `boundary ${i} holds the minimum spacing`)
  }
  assert.ok(boundaries[boundaries.length - 1] < PLACEMENT_CEIL_HZ)
})

test('no measurement means no placement, not a fallback set', () => {
  assert.equal(placeResonanceZones(null, null), null)
  assert.equal(placeResonanceZones(null, { medianF0Hz: 0, cornerHz: 60 }), null)
  assert.equal(placeResonanceZones(null, { medianF0Hz: 110, cornerHz: 0 }), null)
  assert.equal(voiceZoneBoundaries(110, 60, [180, 1100]), null)
})

test('placement produces five zones spanning the band with no gaps', () => {
  const { zones } = placeResonanceZones(DEFAULT_RESONANCE_ZONES, FEMALE)
  assert.equal(zones.length, PLACED_ZONE_COUNT)
  assert.equal(zones[zones.length - 1].hiHz, PLACEMENT_CEIL_HZ)
  for (let i = 1; i < zones.length; i++) {
    assert.ok(zones[i].hiHz > zones[i - 1].hiHz)
  }
  assert.deepEqual(zones.map(z => z.id), ['z1', 'z2', 'z3', 'z4', 'z5'])
})

test('settings are carried over from whatever zone used to cover the span', () => {
  // splitZone's rule, generalised to a whole re-partition: "this span needs to
  // be two spans", not "throw away what I set here". The mutation this catches
  // is resetting to stock, which on an untouched panel is invisible.
  const edited = DEFAULT_RESONANCE_ZONES.map((z, i) => ({
    ...z, selectivity: 10 + i, maxCut: 20 + i, enabled: i !== 2,
  }))
  const { zones } = placeResonanceZones(edited, MALE)

  // z1 (20-60) and z2 (60-180) both come out of the old z1 (20-180).
  assert.equal(zones[0].selectivity, 10)
  assert.equal(zones[1].selectivity, 10)
  // The upper three track the old z2/z3/z4 they were cut from.
  assert.equal(zones[2].selectivity, 11)
  assert.equal(zones[3].selectivity, 12)
  assert.equal(zones[4].selectivity, 13)
  // A switched-off zone stays switched off — `enabled` is a setting, not
  // geometry, and dropping it would silently re-enable a band the user muted.
  assert.equal(zones[3].enabled, false)
})

test('placing from no zones at all falls back to the stock settings', () => {
  const { zones } = placeResonanceZones(null, MALE)
  for (const z of zones) {
    assert.equal(z.selectivity, RESONANCE_ZONE_STOCK.selectivity)
    assert.equal(z.depth, RESONANCE_ZONE_STOCK.depth)
    assert.equal(z.protect, RESONANCE_ZONE_STOCK.protect)
  }
})

test('on an untouched panel the placement is GEOMETRY-ONLY — same curves', () => {
  // The honest claim for the sub-fundamental split: with identical settings
  // everywhere it changes no sound at all. What it buys is the ABILITY to make
  // it change sound, by giving the rumble its own depth, ceiling and on/off —
  // and by confining the spread kernel, which reaches +/-96 bins and is applied
  // before per-zone depth, so a cut taken on a 45 Hz rumble otherwise smears up
  // into the fundamental.
  const binCount = 1025
  const binWidth = 44100 / 2048
  const before = buildResonanceZoneCurves(DEFAULT_RESONANCE_ZONES, binCount, binWidth)
  const after = buildResonanceZoneCurves(
    placeResonanceZones(DEFAULT_RESONANCE_ZONES, MALE).zones, binCount, binWidth,
  )

  assert.equal(after.groups.length, before.groups.length)
  assert.equal(after.uniform, true)
  assert.equal(after.anyProtect, before.anyProtect)
  for (const key of ['depth', 'sharpness', 'selectivity', 'maxCut', 'protect']) {
    let worst = 0
    for (let k = 0; k < binCount; k++) {
      worst = Math.max(worst, Math.abs(after[key][k] - before[key][k]))
    }
    // The extra boundary adds one more crossfade, where identical values are
    // blended by weights summing to 1 rather than assigned — so equality is to
    // float rounding, not bit-for-bit. Tight enough that a real settings
    // difference cannot hide under it.
    assert.ok(worst < 1e-9, `${key} unchanged (worst ${worst})`)
  }
})

test('the sub-fundamental zone is separately controllable once placed', () => {
  // The mutation this catches is placing the boundaries without the sub-F0
  // split — four zones instead of five, which looks correct on every boundary
  // assertion above and silently drops the feature this was built for.
  const { zones } = placeResonanceZones(DEFAULT_RESONANCE_ZONES, MALE)
  assert.equal(zones[0].hiHz, MALE.cornerHz)

  const muted = zones.map((z, i) => (i === 0 ? { ...z, enabled: false } : z))
  const binCount = 1025
  const binWidth = 44100 / 2048
  const curves = buildResonanceZoneCurves(muted, binCount, binWidth)

  // Well under the corner the depth is off; well above it, untouched.
  const at = hz => curves.depth[Math.round(hz / binWidth)]
  assert.equal(at(30), 0)
  assert.equal(at(200), RESONANCE_ZONE_STOCK.depth)
})
