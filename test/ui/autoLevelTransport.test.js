/**
 * Auto Leveler — transport scheduling against the loop lookahead.
 *
 * ⚠ THE BUG THIS EXISTS FOR IS INAUDIBLE IN A UNIT TEST OF THE DSP AND OBVIOUS
 * IN THE ROOM. Playback books the next loop pass BEFORE the current one ends:
 * `scheduleTransport(passEndsAt, loopFrom)` fires TRANSPORT_LOOKAHEAD_SEC (60 ms)
 * ahead of the seam, with `when` in the future. The first version of this effect
 * began `startTransport` with an unconditional `cancelScheduledValues(now)` and
 * a write of `gain.value = 1`, which does not tidy up the outgoing pass — it
 * kills automation that is still sounding. Every repeat lost the leveler for its
 * final 60 ms, and on a boosted quiet phrase that is a 10 dB drop at the seam.
 *
 * The gain curve itself is right either way, which is why the parity and segment
 * suites cannot see this. What is wrong is WHEN the curve is taken away, so the
 * test records the context times of every automation call rather than any audio.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createAutoLeveler } from '../../src/audio/effects/autoLevel.js'

/**
 * An AudioContext whose clock only moves when the test moves it, recording
 * every AudioParam call with the time it was made at and the time it targets.
 *
 * Same shape as playbackLoop.test.js's fake, extended with the param surface —
 * that test needed source-node start/stop times, this one needs automation.
 */
function makeFakeContext() {
  const calls = []
  const ctx = {
    currentTime: 0,
    sampleRate: 44100,
    baseLatency: 0,
    outputLatency: 0,
    destination: { name: 'destination' },
    createGain() {
      const param = {
        value: 1,
        setValueAtTime(v, at) { calls.push({ op: 'setValueAtTime', v, at, now: ctx.currentTime }) },
        setValueCurveAtTime(curve, at, dur) {
          calls.push({ op: 'setValueCurveAtTime', at, dur, now: ctx.currentTime, points: curve.length })
        },
        cancelScheduledValues(at) { calls.push({ op: 'cancel', at, now: ctx.currentTime }) },
      }
      return {
        gain: param,
        connect() {}, disconnect() {},
      }
    },
    // levelTap's dependencies — the meters are not under test here.
    createAnalyser() {
      return {
        fftSize: 2048, smoothingTimeConstant: 0, frequencyBinCount: 1024,
        connect() {}, disconnect() {},
        getFloatTimeDomainData() {}, getByteFrequencyData() {},
      }
    },
    createChannelSplitter() { return { connect() {}, disconnect() {} } },
  }
  return { ctx, calls }
}

const SR = 44100

/** Two clips a second apart, so the curve has holds and one fade. */
function fixtureCurve() {
  return {
    segments: [
      { startSample: 0, endSample: SR, fromDb: 4, toDb: 4 },
      { startSample: SR, endSample: SR + 1323, fromDb: 4, toDb: -3 },
      { startSample: SR + 1323, endSample: 4 * SR, fromDb: -3, toDb: -3 },
    ],
    startSec: 0,
    sampleRate: SR,
  }
}

test('a pass booked into the lookahead window does not cancel the sounding one', () => {
  const { ctx, calls } = makeFakeContext()
  const node = createAutoLeveler(ctx)
  node.setParam('curve', fixtureCurve())

  // Pass 1 starts now and runs to 4 s.
  node.startTransport(0, 0)
  calls.length = 0

  // 60 ms before the seam, playback books pass 2 at a FUTURE context time.
  ctx.currentTime = 3.94
  node.startTransport(4.0, 0)

  const cancels = calls.filter(c => c.op === 'cancel')
  assert.equal(cancels.length, 1, 'expected exactly one cancel for the new pass')
  assert.equal(
    cancels[0].at, 4.0,
    'cancel must target the seam, not the moment the next pass was booked — ' +
    `cancelled at ${cancels[0].at} while the clock read ${cancels[0].now}`,
  )
})

test('the sounding pass is never forced back to unity by a lookahead booking', () => {
  const { ctx } = makeFakeContext()
  const node = createAutoLeveler(ctx)
  node.setParam('curve', fixtureCurve())

  node.startTransport(0, 0)
  ctx.currentTime = 3.94
  node.startTransport(4.0, 0)

  // The intrinsic value is what the param falls back to with nothing scheduled.
  // Writing 1 here would step a boosted phrase to unity mid-flight.
  assert.equal(
    node.getParam('curve').length > 0, true, 'curve should still be loaded',
  )
  assert.notEqual(
    node.getGainDb(), 0,
    'the meter should still read the sounding pass, not drop to unity',
  )
})

test('an immediate stop does cancel now and return to unity', () => {
  const { ctx, calls } = makeFakeContext()
  const node = createAutoLeveler(ctx)
  node.setParam('curve', fixtureCurve())

  node.startTransport(0, 0)
  ctx.currentTime = 1.5
  calls.length = 0
  node.stopTransport()

  const cancels = calls.filter(c => c.op === 'cancel')
  assert.equal(cancels.length, 1)
  assert.equal(cancels[0].at, 1.5, 'a real stop cancels at the current time')
  assert.equal(node.getGainDb(), 0, 'a stopped transport reports no gain')
})

test('the meter keeps reading the outgoing pass until the seam arrives', () => {
  const { ctx } = makeFakeContext()
  const node = createAutoLeveler(ctx)
  node.setParam('curve', fixtureCurve())

  node.startTransport(0, 0)

  // Mid-way through the second clip, which sits at -3 dB.
  ctx.currentTime = 2.0
  const before = node.getGainDb()
  assert.ok(Math.abs(before - (-3)) < 1e-6, `expected -3 dB, read ${before}`)

  // Book the next pass ahead of the seam. The meter must not jump.
  ctx.currentTime = 3.94
  node.startTransport(4.0, 0)
  const during = node.getGainDb()
  assert.ok(
    Math.abs(during - (-3)) < 1e-6,
    `meter jumped to ${during} dB while the outgoing pass was still sounding`,
  )

  // Once the seam passes, the new pass's anchor takes over and the meter reads
  // the head of the curve again.
  ctx.currentTime = 4.0
  const after = node.getGainDb()
  assert.ok(Math.abs(after - 4) < 1e-6, `expected +4 dB after the seam, read ${after}`)
})

test('scheduling skips what is already behind the playhead', () => {
  const { ctx, calls } = makeFakeContext()
  const node = createAutoLeveler(ctx)
  node.setParam('curve', fixtureCurve())

  // Seek straight into the third segment.
  node.startTransport(0, 2.0)

  const sets = calls.filter(c => c.op === 'setValueAtTime')
  const curves = calls.filter(c => c.op === 'setValueCurveAtTime')

  // The entry value is set at `when`, and nothing is scheduled before it.
  assert.ok(sets.length >= 1)
  for (const c of [...sets, ...curves]) {
    assert.ok(c.at >= 0, `scheduled ${c.op} in the past at ${c.at}`)
  }
  // The fade at 1.0 s is behind the 2.0 s entry point, so it is not scheduled.
  assert.equal(curves.length, 0, 'a fade behind the playhead should not be scheduled')
})
