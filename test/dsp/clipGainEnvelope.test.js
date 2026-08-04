/**
 * Run with:  npm test
 *
 * These exist because the builder used to drop events silently. Every case
 * below produced an envelope with a hole in it and a count that said otherwise.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildClipGainEnvelope } from '../../src/audio/dsp/clipGainEnvelope.js'

const SR = 44100

function event(startSample, endSample, extra = {}) {
  return { startSample, endSample, gainDb: -6, eventType: 'fricative', ...extra }
}

/** Lowest point of the envelope, i.e. was anything rendered at all. */
function minOf(multiplier) {
  let m = Infinity
  for (let i = 0; i < multiplier.length; i++) m = Math.min(m, multiplier[i])
  return m
}

test('a fractional sample index still renders', () => {
  // THE BUG. 2.2 * 44100 is 97020.00000000001, which failed Number.isInteger,
  // matched neither resolve branch, and vanished on a bare `continue`.
  const r = buildClipGainEnvelope(SR * 4, SR, [event(2.0 * SR, 2.2 * SR)])
  assert.equal(r.eventCount, 1, 'fractional bounds must not disappear')
  assert.equal(r.skipped.length, 0)
  assert.ok(minOf(r.multiplier) < 0.6, 'the cut should actually be in the envelope')
})

test('eventCount is what was rendered, not what was handed in', () => {
  // The count used to be treatedEvents.length regardless, so a dropped event
  // was still reported as treated — in the UI and in the processing report.
  const r = buildClipGainEnvelope(SR, SR, [
    event(1000, 3000),
    event(NaN, NaN),
    event(5000, 7000),
  ])
  assert.equal(r.eventCount, 2)
  assert.equal(r.inputCount, 3)
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].reason, 'unresolved-bounds')
  assert.equal(r.skipped[0].index, 1)
})

test('events outside the buffer are reported, not conflated with bad input', () => {
  // Legitimate: the envelope can span a sub-region. Still worth counting, but
  // it is not a producer bug and must not read as one.
  const r = buildClipGainEnvelope(SR, SR, [event(SR * 2, SR * 3)])
  assert.equal(r.eventCount, 0)
  assert.equal(r.skipped[0].reason, 'outside-buffer')
})

test('degenerate bounds are reported as such', () => {
  const inverted = buildClipGainEnvelope(SR, SR, [event(9000, 3000)])
  assert.equal(inverted.skipped[0].reason, 'degenerate')

  const zeroLength = buildClipGainEnvelope(SR, SR, [event(3000, 3000)])
  assert.equal(zeroLength.skipped[0].reason, 'degenerate')
})

test('seconds-based bounds still work', () => {
  const r = buildClipGainEnvelope(SR * 2, SR, [
    { startSec: 0.5, endSec: 0.7, gainDb: -6, eventType: 'fricative' },
  ])
  assert.equal(r.eventCount, 1)
  assert.ok(minOf(r.multiplier) < 0.6)
})

test('missing bounds do not throw, they report', () => {
  const r = buildClipGainEnvelope(SR, SR, [{ gainDb: -6 }])
  assert.equal(r.eventCount, 0)
  assert.equal(r.skipped[0].reason, 'unresolved-bounds')
})

test('an event clipped by the buffer edge still renders', () => {
  // Partial overlap is not the same as no overlap.
  const r = buildClipGainEnvelope(SR, SR, [event(SR - 2000, SR + 5000)])
  assert.equal(r.eventCount, 1)
  assert.ok(minOf(r.multiplier) < 1)
})

test('no events is not an error', () => {
  const r = buildClipGainEnvelope(1000, SR, [])
  assert.equal(r.eventCount, 0)
  assert.equal(r.inputCount, 0)
  assert.deepEqual(r.skipped, [])
  assert.equal(minOf(r.multiplier), 1)
})
