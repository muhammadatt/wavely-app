import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readTimelineEnvelope } from '../../src/audio/timelineEnvelope.js'

const SR = 1000

/** Minimal stand-in for the parts of an AudioBuffer this reader touches. */
function buffer(samples, channels = 1) {
  const data = channels === 1
    ? [Float32Array.from(samples)]
    : samples.map((ch) => Float32Array.from(ch))
  return {
    sampleRate: SR,
    length: data[0].length,
    numberOfChannels: data.length,
    getChannelData: (ch) => data[ch],
  }
}

/** A segment playing all of `buf`, laid down at `outputStart`. */
function seg(buf, outputStart, sourceStart = 0, sourceEnd = buf.length / SR) {
  return { sourceBuffer: buf, sourceStart, sourceEnd, outputStart }
}

const ramp = (n, f) => Array.from({ length: n }, (_, i) => f(i))

test('one column per slice, holding the peak of that slice', () => {
  // 1 s of audio, 0.5 in the first half-second and 0.9 in the second.
  const buf = buffer(ramp(SR, (i) => (i < SR / 2 ? 0.5 : 0.9)))
  const out = readTimelineEnvelope([seg(buf, 0)], 0, 1, 2)
  assert.equal(out.length, 2)
  assert.ok(Math.abs(out[0] - 0.5) < 1e-6)
  assert.ok(Math.abs(out[1] - 0.9) < 1e-6)
})

test('reads absolute value, so a negative peak counts', () => {
  const buf = buffer(ramp(SR, (i) => (i === 10 ? -0.8 : 0)))
  const out = readTimelineEnvelope([seg(buf, 0)], 0, 1, 1)
  assert.ok(Math.abs(out[0] - 0.8) < 1e-6)
})

test('takes the loudest channel', () => {
  const buf = buffer([ramp(100, () => 0.2), ramp(100, () => 0.7)], 2)
  const out = readTimelineEnvelope([seg(buf, 0)], 0, 0.1, 1)
  assert.ok(Math.abs(out[0] - 0.7) < 1e-6)
})

test('starts at the requested position, not at the timeline origin', () => {
  const buf = buffer(ramp(SR, (i) => (i < SR / 2 ? 0.1 : 0.6)))
  const out = readTimelineEnvelope([seg(buf, 0)], 0.5, 0.5, 1)
  assert.ok(Math.abs(out[0] - 0.6) < 1e-6)
})

test('honours sourceStart — the segment is a window onto its buffer', () => {
  // Only the second half of the buffer is in the timeline, so reading the
  // timeline from 0 must land on the buffer's own 0.5 s mark.
  const buf = buffer(ramp(SR, (i) => (i < SR / 2 ? 0.1 : 0.6)))
  const out = readTimelineEnvelope([seg(buf, 0, 0.5, 1)], 0, 0.5, 1)
  assert.ok(Math.abs(out[0] - 0.6) < 1e-6)
})

test('a silence segment reads as zero rather than as the next segment', () => {
  const buf = buffer(ramp(SR, () => 0.9))
  const segments = [
    { sourceBuffer: null, duration: 1, outputStart: 0 },
    seg(buf, 1),
  ]
  const out = readTimelineEnvelope(segments, 0, 2, 2)
  assert.equal(out[0], 0)
  assert.ok(Math.abs(out[1] - 0.9) < 1e-6)
})

test('crosses a segment boundary inside one column', () => {
  const quiet = buffer(ramp(SR, () => 0.1))
  const loud = buffer(ramp(SR, () => 0.8))
  // One column spanning 0.5-1.5 s straddles the join at 1 s.
  const out = readTimelineEnvelope([seg(quiet, 0), seg(loud, 1)], 0.5, 1, 1)
  assert.ok(Math.abs(out[0] - 0.8) < 1e-6)
})

test('past the end of the timeline is zero, not the last sample held', () => {
  const buf = buffer(ramp(SR, () => 0.9))
  const out = readTimelineEnvelope([seg(buf, 0)], 0.5, 1, 2)
  assert.ok(Math.abs(out[0] - 0.9) < 1e-6)
  assert.equal(out[1], 0)
})

test('before the timeline origin is silence, not the first sample', () => {
  // The scope reads a window BEHIND the playhead, so within half a window of
  // the start of the file it asks for negative time.
  const buf = buffer(ramp(SR, () => 0.9))
  const out = readTimelineEnvelope([seg(buf, 0)], -0.5, 1, 2)
  assert.equal(out[0], 0)
  assert.ok(Math.abs(out[1] - 0.9) < 1e-6)
})

test('an empty timeline yields silence, not a throw', () => {
  assert.deepEqual([...readTimelineEnvelope([], 0, 1, 3)], [0, 0, 0])
  assert.deepEqual([...readTimelineEnvelope(null, 0, 1, 2)], [0, 0])
})

test('reuses the destination array and clears what was there', () => {
  const buf = buffer(ramp(SR, () => 0.4))
  const out = new Float32Array(2).fill(0.99)
  const got = readTimelineEnvelope([seg(buf, 0)], 5, 1, 2, out)
  assert.equal(got, out)
  assert.deepEqual([...out], [0, 0])
})
