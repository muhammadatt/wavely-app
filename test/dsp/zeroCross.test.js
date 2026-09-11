/**
 * Snapping a marker to the nearest rising zero-crossing.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapToZeroCrossing, SNAP_WINDOW_SEC } from '../../src/audio/zeroCross.js'

const SR = 44100

/** The bare slice of AudioBuffer that the timeline actually reads. */
function fakeBuffer(data, sampleRate = SR) {
  return {
    sampleRate,
    duration: data.length / sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  }
}

/** A sine at `freq` Hz, so its rising crossings sit on exact known times. */
function sine(freq, seconds, sampleRate = SR) {
  const data = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate)
  }
  return data
}

function timelineOf(buffer, { outputStart = 0, sourceStart = 0, sourceEnd = null } = {}) {
  return [{
    id: 'seg',
    sourceBuffer: buffer,
    sourceBufferId: 'buf',
    sourceStart,
    sourceEnd: sourceEnd ?? buffer.duration,
    outputStart,
  }]
}

// A 100 Hz sine crosses zero going up every 10 ms: at 0, 0.01, 0.02, …
const SINE_100 = fakeBuffer(sine(100, 1))

test('a position just past a rising crossing snaps back onto it', () => {
  const segments = timelineOf(SINE_100)
  const snapped = snapToZeroCrossing(segments, 0.0502)
  assert.ok(Math.abs(snapped - 0.05) < 1e-4, `expected ~0.05, got ${snapped}`)
})

test('a position just before a rising crossing snaps forward onto it', () => {
  const snapped = snapToZeroCrossing(timelineOf(SINE_100), 0.0997)
  assert.ok(Math.abs(snapped - 0.1) < 1e-4, `expected ~0.1, got ${snapped}`)
})

test('it takes the nearest crossing, not the next one along', () => {
  // 0.0504 is 0.4 ms past the crossing at 0.05 and 9.6 ms short of 0.06.
  const snapped = snapToZeroCrossing(timelineOf(SINE_100), 0.0504)
  assert.ok(Math.abs(snapped - 0.05) < 1e-4, `expected ~0.05, got ${snapped}`)
})

test('it snaps to rising crossings only, never falling ones', () => {
  // A 100 Hz sine falls through zero at 0.005, 0.015, … Sitting right on the
  // falling crossing at 0.055, the nearest *rising* one is 0.05 or 0.06.
  const snapped = snapToZeroCrossing(timelineOf(SINE_100), 0.055)
  const nearestRising = Math.min(Math.abs(snapped - 0.05), Math.abs(snapped - 0.06))
  assert.ok(nearestRising < 1e-4, `snapped to ${snapped}, which is not a rising crossing`)
})

test('the snap is sub-sample accurate, not quantised to the sample grid', () => {
  // A step from -0.25 to +0.75 between samples 4 and 5 puts the true crossing
  // a quarter of a sample past 4. A snap that rounded to the grid would land
  // on 4 or 5; interpolation lands on 4.25.
  //
  // Built by hand rather than from a sine on purpose: at 44.1 kHz a sine at any
  // round frequency has its crossings *on* sample boundaries, so it cannot tell
  // an interpolating implementation from a rounding one.
  const step = new Float32Array(10).fill(0.75)
  step.fill(-0.25, 0, 5)
  const snapped = snapToZeroCrossing(timelineOf(fakeBuffer(step)), 4.4 / SR)
  assert.ok(Math.abs(snapped * SR - 4.25) < 1e-6, `expected 4.25 samples, got ${snapped * SR}`)
})

test('a silence segment has nothing to snap to, so the time comes back unchanged', () => {
  const segments = [{ id: 's', sourceBuffer: null, duration: 2, outputStart: 0 }]
  assert.equal(snapToZeroCrossing(segments, 1.234), 1.234)
})

test('a time past the end of the timeline comes back unchanged', () => {
  assert.equal(snapToZeroCrossing(timelineOf(SINE_100), 99), 99)
})

test('an empty timeline comes back unchanged', () => {
  assert.equal(snapToZeroCrossing([], 1), 1)
})

test('no rising crossing within the window means no snap', () => {
  // DC at +0.5 never crosses zero at all.
  const dc = new Float32Array(SR).fill(0.5)
  assert.equal(snapToZeroCrossing(timelineOf(fakeBuffer(dc)), 0.5), 0.5)
})

test('the search window bounds how far a marker can be moved', () => {
  // A 1 Hz sine over one second rises through zero only at the very start.
  // From 0.4 s that crossing is 400 ms away — far outside the default window,
  // so the marker stays exactly where it was put.
  const slow = fakeBuffer(sine(1, 1))
  assert.equal(snapToZeroCrossing(timelineOf(slow), 0.4), 0.4)

  // Widen the window past 400 ms and the same call reaches it.
  const widened = snapToZeroCrossing(timelineOf(slow), 0.4, { windowSec: 0.5 })
  assert.ok(Math.abs(widened) < 1e-3, `expected ~0, got ${widened}`)
  assert.ok(SNAP_WINDOW_SEC < 0.5, 'the default window is the narrow one')
})

test('the result is in timeline time, not source time', () => {
  // A segment that starts 5 s into the timeline and 0.2 s into its source.
  const segments = timelineOf(SINE_100, { outputStart: 5, sourceStart: 0.2, sourceEnd: 0.9 })
  // Timeline 5.05 is source 0.25; the nearest rising crossings are 0.24/0.25.
  const snapped = snapToZeroCrossing(segments, 5.0502)
  assert.ok(Math.abs(snapped - 5.05) < 1e-4, `expected ~5.05, got ${snapped}`)
})

test('the snap never leaves the part of the source the segment actually plays', () => {
  // The segment plays only 0.2–0.9 s of its source. Asking near its head must
  // not reach back into source audio before sourceStart.
  const segments = timelineOf(SINE_100, { outputStart: 0, sourceStart: 0.2, sourceEnd: 0.9 })
  const snapped = snapToZeroCrossing(segments, 0.0005)
  assert.ok(snapped >= 0, `snapped to ${snapped}, before the start of the timeline`)
  assert.ok(snapped <= 0.7, `snapped to ${snapped}, past the end of the segment`)
})
