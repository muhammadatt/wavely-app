/**
 * Loop seam timing.
 *
 * The question this answers is "is there latency when a loop restarts?", and it
 * is not one the ear can settle — a 15 ms gap at a seam sounds like a stumble
 * but reads on a stopwatch as nothing. So the engine is run against a fake
 * AudioContext that records the exact context time every source node is told to
 * start and stop at, and the seam is measured from those numbers.
 *
 * The old arrangement — TransportBar noticing the end in an animation frame and
 * calling startPlayback again from `audioContext.currentTime` — cannot pass the
 * first test in this file: the frame that notices fires after the end has
 * already gone by, so the next pass starts late by however long that took.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startPlayback, stopPlayback, setPlaybackLoop } from '../../src/audio/playback.js'

// ── Fakes ───────────────────────────────────────────────────────────────────

/**
 * An AudioContext whose clock only moves when the test moves it, plus a frame
 * pump standing in for requestAnimationFrame. Together they let a test say
 * "advance 20 ms and deliver a frame" and get deterministic scheduling out.
 */
function makeFakeContext() {
  const started = []   // { at, offset, duration }
  const stopped = []   // { at }
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    destination: { name: 'destination' },
    createBufferSource() {
      const node = {
        buffer: null,
        connect() {},
        disconnect() {},
        start(at, offset, duration) { started.push({ at, offset, duration, node }) },
        stop(at) { stopped.push({ at: at ?? ctx.currentTime, node }) },
      }
      return node
    },
  }
  return { ctx, started, stopped }
}

let frameCallbacks = []
globalThis.requestAnimationFrame = (cb) => {
  frameCallbacks.push(cb)
  return frameCallbacks.length
}
globalThis.cancelAnimationFrame = () => {}

/** Advance the fake clock by `dt` seconds and deliver one animation frame. */
function advance(ctx, dt) {
  ctx.currentTime += dt
  const due = frameCallbacks
  frameCallbacks = []
  for (const cb of due) cb()
}

/** One 10-second buffer covering the whole timeline. */
function makeSegments(duration = 10) {
  return [{
    id: 'seg-1',
    outputStart: 0,
    sourceStart: 0,
    sourceEnd: duration,
    sourceBuffer: { duration, numberOfChannels: 1, sampleRate: 48000 },
    sourceBufferId: 'buf-1',
  }]
}

function play(ctx, { start = 0, end = null, loop = false, loopStart = null } = {}) {
  frameCallbacks = []
  const times = []
  startPlayback(
    makeSegments(),
    start,
    ctx,
    (t) => times.push(t),
    () => times.push('END'),
    end,
    { loop, loopStart },
  )
  return times
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('a loop pass starts at the exact context time the previous one ended', () => {
  const { ctx, started } = makeFakeContext()
  // Loop a 2-second selection, 4 s → 6 s.
  play(ctx, { start: 4, end: 6, loop: true, loopStart: 4 })

  assert.equal(started.length, 1, 'first pass scheduled one node')
  const firstStart = started[0].at
  const firstEnd = firstStart + started[0].duration

  // Walk the clock to the seam in 16.7 ms frames, the way a 60 Hz display would.
  for (let i = 0; i < 130; i++) advance(ctx, 1 / 60)
  assert.ok(started.length >= 2, 'second pass was scheduled')

  const gap = started[1].at - firstEnd
  assert.equal(
    gap, 0,
    `loop seam has a ${(gap * 1000).toFixed(2)} ms gap — the next pass must start ` +
    'at exactly the context time the previous one ends',
  )
  stopPlayback()
})

test('the next pass is booked before the seam, not after it', () => {
  const { ctx, started } = makeFakeContext()
  play(ctx, { start: 0, end: 1, loop: true, loopStart: 0 })

  // One frame at a time until the second pass appears. It has to be scheduled
  // while the clock is still short of the seam — anything scheduled after the
  // seam has already passed is late by definition.
  let scheduledAt = null
  for (let i = 0; i < 120 && scheduledAt === null; i++) {
    advance(ctx, 1 / 60)
    if (started.length >= 2) scheduledAt = ctx.currentTime
  }

  assert.ok(scheduledAt !== null, 'second pass was scheduled')
  assert.ok(
    scheduledAt < started[1].at,
    `booked at ${scheduledAt.toFixed(3)}s for a seam at ${started[1].at.toFixed(3)}s — ` +
    'scheduling at or after the seam is the latency this is meant to prevent',
  )
  stopPlayback()
})

test('a repeat plays the loop region, not the region the first pass started in', () => {
  const { ctx, started } = makeFakeContext()
  // Whole-file playback from 7 s, looping back to the top.
  play(ctx, { start: 7, end: null, loop: true, loopStart: 0 })

  assert.equal(started[0].offset, 7, 'first pass reads into the buffer at 7 s')
  assert.equal(started[0].duration, 3, 'first pass runs to the end of the file')

  for (let i = 0; i < 300 && started.length < 2; i++) advance(ctx, 1 / 60)
  assert.equal(started[1].offset, 0, 'the repeat starts at the top of the file')
  assert.equal(started[1].duration, 10, 'the repeat plays the whole file')
  stopPlayback()
})

test('the playhead reported across the seam wraps to the loop start', () => {
  const { ctx } = makeFakeContext()
  const times = play(ctx, { start: 2, end: 3, loop: true, loopStart: 2 })

  for (let i = 0; i < 90; i++) advance(ctx, 1 / 60)

  const numeric = times.filter(t => typeof t === 'number')
  assert.ok(!numeric.includes('END'), 'a looping transport never reports the end')
  assert.ok(Math.max(...numeric) <= 3.001, 'playhead never runs past the loop end')
  assert.ok(Math.min(...numeric) >= 2, 'playhead never runs before the loop start')
  // It must have wrapped at least once — a monotonically rising playhead would
  // mean the seam was never crossed.
  const wrapped = numeric.some((t, i) => i > 0 && t < numeric[i - 1])
  assert.ok(wrapped, 'playhead wrapped back to the loop start')
  stopPlayback()
})

test('turning loop off mid-pass cancels the pass already scheduled ahead', () => {
  const { ctx, started, stopped } = makeFakeContext()
  play(ctx, { start: 0, end: 1, loop: true, loopStart: 0 })

  for (let i = 0; i < 120 && started.length < 2; i++) advance(ctx, 1 / 60)
  assert.equal(started.length, 2, 'the next pass is sitting in the lookahead window')

  setPlaybackLoop(false)
  assert.ok(
    stopped.some(s => s.node === started[1].node && s.at === started[1].at),
    'the pre-scheduled pass is stopped at its own start time, so it never sounds',
  )
  stopPlayback()
})

test('without loop, playback still ends once at the end', () => {
  const { ctx } = makeFakeContext()
  const times = play(ctx, { start: 0, end: 1, loop: false })

  for (let i = 0; i < 90; i++) advance(ctx, 1 / 60)
  assert.equal(times.filter(t => t === 'END').length, 1, 'onEnd fired exactly once')
  assert.equal(times[times.length - 2], 1, 'the last position reported is the end')
})
