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
import { startPlayback, stopPlayback, setPlaybackLoop, setPlaybackRegion } from '../../src/audio/playback.js'

// ── Fakes ───────────────────────────────────────────────────────────────────

/**
 * An AudioContext whose clock only moves when the test moves it, plus a frame
 * pump standing in for requestAnimationFrame. Together they let a test say
 * "advance 20 ms and deliver a frame" and get deterministic scheduling out.
 */
function makeFakeContext() {
  const started = []      // { at, offset, duration }
  const stopped = []      // { at }
  const disconnected = [] // nodes freed from the graph
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    destination: { name: 'destination' },
    createBufferSource() {
      const node = {
        buffer: null,
        onended: null,
        connect() {},
        disconnect() { disconnected.push(node) },
        start(at, offset, duration) { started.push({ at, offset, duration, node }) },
        stop(at) { stopped.push({ at: at ?? ctx.currentTime, node }) },
      }
      return node
    },
  }
  return { ctx, started, stopped, disconnected }
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
  const { ctx, started, stopped, disconnected } = makeFakeContext()
  play(ctx, { start: 0, end: 1, loop: true, loopStart: 0 })

  for (let i = 0; i < 120 && started.length < 2; i++) advance(ctx, 1 / 60)
  assert.equal(started.length, 2, 'the next pass is sitting in the lookahead window')

  setPlaybackLoop(false)
  assert.ok(
    stopped.some(s => s.node === started[1].node && s.at === started[1].at),
    'the pre-scheduled pass is stopped at its own start time, so it never sounds',
  )

  // It is stopped in the future, so nothing can disconnect it at cancel time —
  // its own `onended` has to, or the graph keeps a node nothing references.
  const cancelled = started[1].node
  assert.ok(!disconnected.includes(cancelled), 'not disconnected while still scheduled')
  assert.equal(typeof cancelled.onended, 'function', 'the node frees itself when it ends')
  cancelled.onended()
  assert.ok(disconnected.includes(cancelled), 'ending disconnects it from the graph')

  stopPlayback()
})

test('without loop, playback still ends once at the end', () => {
  const { ctx } = makeFakeContext()
  const times = play(ctx, { start: 0, end: 1, loop: false })

  for (let i = 0; i < 90; i++) advance(ctx, 1 / 60)
  assert.equal(times.filter(t => t === 'END').length, 1, 'onEnd fired exactly once')
  assert.equal(times[times.length - 2], 1, 'the last position reported is the end')
})

// ── Moving the region while it loops ────────────────────────────────────────
//
// Dragging the edge of a looping selection has to change what the loop plays
// now. These measure the same way the seam tests do — from the context times
// the nodes are told to start and stop at — because "did the loop update" and
// "did it update without a gap" are different questions and only one of them is
// answerable by ear.

test('moving the end later extends the pass that is already sounding', () => {
  const { ctx, started } = makeFakeContext()
  play(ctx, { start: 4, end: 6, loop: true, loopStart: 4 })
  const first = started[0]
  assert.equal(first.duration, 2, 'the first pass covers 4 s → 6 s')

  advance(ctx, 0.5)
  setPlaybackRegion(4, 8)

  assert.equal(started.length, 2, 'the tail past the old end is scheduled')
  const tail = started[1]
  // It joins at the old end's context time, reading into the buffer there, so
  // the extension is as seamless as the loop seam itself.
  assert.equal(tail.at, first.at + first.duration, 'the tail joins with no gap')
  assert.equal(tail.offset, 6, 'the tail reads into the buffer at the old end')
  assert.equal(tail.duration, 2, 'the tail runs to the new end')
  stopPlayback()
})

test('moving the end earlier stops the pass at the new end', () => {
  const { ctx, started, stopped } = makeFakeContext()
  play(ctx, { start: 4, end: 8, loop: true, loopStart: 4 })
  const first = started[0]

  advance(ctx, 0.5)
  setPlaybackRegion(4, 6)

  const cut = stopped.find(s => s.node === first.node)
  assert.ok(cut, 'the sounding pass is stopped early')
  assert.equal(cut.at, first.at + 2, 'stopped at the new end, not the old one')
  stopPlayback()
})

test('the repeat after a region change plays the new region', () => {
  const { ctx, started } = makeFakeContext()
  play(ctx, { start: 4, end: 6, loop: true, loopStart: 4 })

  advance(ctx, 0.5)
  setPlaybackRegion(5, 6)   // start dragged in by a second

  for (let i = 0; i < 200 && started.length < 2; i++) advance(ctx, 1 / 60)
  const repeat = started[started.length - 1]
  assert.equal(repeat.offset, 5, 'the repeat starts at the new region start')
  assert.equal(repeat.duration, 1, 'and runs to the new region end')
  stopPlayback()
})

test('a repeat already booked is rebooked against the new region', () => {
  const { ctx, started, stopped } = makeFakeContext()
  play(ctx, { start: 0, end: 1, loop: true, loopStart: 0 })

  // Walk into the lookahead window, so the next pass is sitting there.
  for (let i = 0; i < 120 && started.length < 2; i++) advance(ctx, 1 / 60)
  assert.equal(started.length, 2, 'the next pass is booked')
  const stale = started[1]

  setPlaybackRegion(0, 2)

  // The booked pass covered the old region; it must not sound.
  assert.ok(
    stopped.some(s => s.node === stale.node),
    'the pass booked against the old region is cancelled',
  )
  stopPlayback()
})

test('dragging the end behind the play position wraps immediately', () => {
  const { ctx, started, stopped } = makeFakeContext()
  play(ctx, { start: 0, end: 8, loop: true, loopStart: 0 })
  const first = started[0]

  advance(ctx, 4)             // 4 s into the region
  setPlaybackRegion(0, 2)     // new end is two seconds behind the playhead

  assert.ok(
    stopped.some(s => s.node === first.node && s.at === ctx.currentTime),
    'what is sounding is cut off now — it is audio the user just excluded',
  )
  const wrapped = started[started.length - 1]
  assert.equal(wrapped.at, ctx.currentTime, 'the new pass starts now')
  assert.equal(wrapped.offset, 0, 'from the region start')
  assert.equal(wrapped.duration, 2, 'over the new region')
  stopPlayback()
})

test('without loop, dragging the end behind the play position ends playback', () => {
  const { ctx } = makeFakeContext()
  const times = play(ctx, { start: 0, end: 8, loop: false })

  for (let i = 0; i < 240; i++) advance(ctx, 1 / 60)   // ~4 s in
  setPlaybackRegion(0, 2)
  advance(ctx, 1 / 60)

  assert.equal(times.filter(t => t === 'END').length, 1, 'playback ended once')
})

test('a zero-length or inverted region is ignored', () => {
  const { ctx, started } = makeFakeContext()
  play(ctx, { start: 4, end: 6, loop: true, loopStart: 4 })
  const before = started.length

  // Mid-drag an edge routinely passes through and over its opposite number.
  setPlaybackRegion(5, 5)
  setPlaybackRegion(6, 4)

  assert.equal(started.length, before, 'nothing was rescheduled')
  for (let i = 0; i < 200 && started.length < before + 1; i++) advance(ctx, 1 / 60)
  const repeat = started[started.length - 1]
  assert.equal(repeat.offset, 4, 'the region is unchanged')
  assert.equal(repeat.duration, 2)
  stopPlayback()
})

test('an edge dragged in and back out again plays the region continuously', () => {
  // A drag is a stream of these calls, not one, and each shrink stops the
  // sounding node early. Extending afterwards has to pick up exactly where the
  // last stop left off, or the drag leaves a hole in the middle of the region.
  const { ctx, started, stopped } = makeFakeContext()
  play(ctx, { start: 4, end: 8, loop: true, loopStart: 4 })
  const first = started[0]

  setPlaybackRegion(4, 6)
  setPlaybackRegion(4, 8)

  const cut = stopped.filter(s => s.node === first.node).pop()
  const tail = started[started.length - 1]
  assert.equal(cut.at, first.at + 2, 'the sounding node was cut at the shrunk end')
  assert.equal(tail.at, cut.at, 'the tail picks up at exactly that instant')
  assert.equal(tail.offset, 6, 'reading into the buffer where the cut landed')
  assert.equal(tail.duration, 2, 'and running to the restored end')
  stopPlayback()
})
