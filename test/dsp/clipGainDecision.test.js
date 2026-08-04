/**
 * Run with:  npm test
 *
 * These pin the property the realtime de-esser depends on: every attenuation
 * knob is a pure function of two frozen per-event measurements, so it can move
 * without re-running detection.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideClipGains, maxReductionOf, CLIP_GAIN_DEFAULTS } from '../../src/audio/dsp/clipGainDecision.js'
import { buildClipGainEnvelope } from '../../src/audio/dsp/clipGainEnvelope.js'

const SR = 44100

/** One strident event peaking `overDb` above its context. */
function event(overDb, opts = {}) {
  const contextRmsDb = opts.contextRmsDb ?? -20
  return {
    startSample: opts.startSample ?? 1000,
    endSample: opts.endSample ?? 3000,
    eventType: opts.eventType ?? 'fricative',
    sibilantClass: opts.sibilantClass ?? 'strident',
    contextRmsDb,
    eventPeakDb: contextRmsDb + overDb,
  }
}

test('matches the Python decision formula', () => {
  // gain_db = -min(excess * ratio, cap), excess = peak - (ctxRms + ceiling)
  const [t] = decideClipGains([event(14)], { stridentCeilingDb: 6, reductionRatio: 0.5, maxReductionDb: 8 })
  assert.equal(t.excessDb, 8) // 14 - 6
  assert.equal(t.gainDb, -4) // -min(8 * 0.5, 8)
})

test('the cap binds before the ratio runs away', () => {
  const [t] = decideClipGains([event(40)], { stridentCeilingDb: 6, reductionRatio: 0.5, maxReductionDb: 8 })
  assert.equal(t.gainDb, -8, 'excess 34 * 0.5 = 17 dB, capped at 8')
})

test('events at or under the ceiling are not treated', () => {
  assert.equal(decideClipGains([event(6)], { stridentCeilingDb: 6 }).length, 0, 'exactly at the ceiling')
  assert.equal(decideClipGains([event(2)], { stridentCeilingDb: 6 }).length, 0, 'under it')
  assert.equal(decideClipGains([event(7)], { stridentCeilingDb: 6 }).length, 1)
})

test('lowering the ceiling brings back an event the server declined', () => {
  // THE REASON the server had to start emitting untreated events. At the
  // preset's 6 dB ceiling this event is in range and gets dropped; at 2 dB it
  // is treatable. If the client only had treatedEvents it could never find it.
  const events = [event(4)]
  assert.equal(decideClipGains(events, { stridentCeilingDb: 6 }).length, 0)
  const treated = decideClipGains(events, { stridentCeilingDb: 2 })
  assert.equal(treated.length, 1)
  assert.equal(treated[0].excessDb, 2)
})

test('the two sibilant classes take their own ceilings', () => {
  // /f/ and /θ/ sit BELOW surrounding voiced RMS, so their ceiling is negative
  // — a shared ceiling would never treat them.
  const events = [
    event(4, { sibilantClass: 'strident' }),
    event(-2, { sibilantClass: 'non_strident' }),
  ]
  const treated = decideClipGains(events, { stridentCeilingDb: 6, nonStridentCeilingDb: -4 })
  assert.equal(treated.length, 1)
  assert.equal(treated[0].sibilantClass, 'non_strident', 'the quiet /f/ is the one over its ceiling')
})

test('an unknown class falls back to the strident ceiling', () => {
  const treated = decideClipGains(
    [event(10, { sibilantClass: undefined })],
    { stridentCeilingDb: 6, nonStridentCeilingDb: -4 },
  )
  assert.equal(treated[0].ceilingDb, 6)
})

test('the input is never mutated, so knobs can be swept freely', () => {
  const events = [event(14)]
  const snapshot = JSON.stringify(events)
  decideClipGains(events, { reductionRatio: 1.0 })
  decideClipGains(events, { reductionRatio: 0.1 })
  assert.equal(JSON.stringify(events), snapshot)
})

test('ratio and cap move reduction monotonically', () => {
  const events = [event(20)]
  const light = maxReductionOf(decideClipGains(events, { reductionRatio: 0.2, maxReductionDb: 24 }))
  const heavy = maxReductionOf(decideClipGains(events, { reductionRatio: 0.9, maxReductionDb: 24 }))
  assert.ok(heavy > light, `ratio did nothing: ${light} vs ${heavy}`)

  const capped = maxReductionOf(decideClipGains(events, { reductionRatio: 0.9, maxReductionDb: 3 }))
  assert.equal(capped, 3)
})

test('feeds buildClipGainEnvelope directly', () => {
  // The decision output is the envelope builder's input shape — that hand-off
  // is the whole client-side apply path.
  const treated = decideClipGains([event(14, { startSample: 1000, endSample: 3000 })], CLIP_GAIN_DEFAULTS)
  const { multiplier, eventCount, maxReductionDb } = buildClipGainEnvelope(SR, SR, treated)

  assert.equal(eventCount, 1)
  assert.equal(multiplier.length, SR)
  assert.equal(multiplier[0], 1, 'untouched outside the event')
  assert.equal(multiplier[SR - 1], 1)

  const expected = Math.pow(10, treated[0].gainDb / 20)
  const mid = multiplier[2000]
  assert.ok(Math.abs(mid - expected) < 1e-6, `body should sit at ${expected}, got ${mid}`)

  // The builder's own reduction figure should agree with the decision's.
  assert.ok(
    Math.abs(maxReductionDb - maxReductionOf(treated)) < 1e-9,
    `builder says ${maxReductionDb}, decision says ${maxReductionOf(treated)}`,
  )

  // Fades mean the edges are between the floor and unity, never outside it.
  for (let i = 0; i < SR; i++) {
    assert.ok(
      multiplier[i] <= 1 + 1e-9 && multiplier[i] >= expected - 1e-9,
      `sample ${i} out of range: ${multiplier[i]}`,
    )
  }
})

test('no events means a flat envelope, not a broken one', () => {
  const { multiplier, eventCount } = buildClipGainEnvelope(1000, SR, decideClipGains([], CLIP_GAIN_DEFAULTS))
  assert.equal(eventCount, 0)
  for (let i = 0; i < 1000; i++) assert.equal(multiplier[i], 1)
})
