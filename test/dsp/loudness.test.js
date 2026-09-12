/**
 * Run with:  npm test
 *
 * BS.1770 LOUDNESS MEASUREMENT.
 *
 * ⚠ THE WHOLE VALUE OF THIS MODULE IS THAT ITS NUMBER MATCHES SOMEBODY ELSE'S
 * METER. A normalizer built on a measurement that is 1 LU out still produces a
 * confident, consistent, wrong file — and the user finds out when a platform
 * rejects it, not when they listen. So the calibration is pinned against the
 * specification's own reference case rather than against this implementation's
 * previous output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  measureIntegratedLufs, measureRmsDb, measureSamplePeakDb, measureTruePeakDb,
  measureLoudness, kWeightingSections, TRUE_PEAK_PHASES, ABSOLUTE_GATE_LUFS,
} from '../../src/audio/dsp/loudness.js'

const SR = 48000

/** A sine, faded at both ends so the region has no edge discontinuity. */
function sine(freq, amp, seconds = 3, sampleRate = SR, phase = 0) {
  const n = Math.round(seconds * sampleRate)
  const x = new Float32Array(n)
  const fade = Math.min(2000, n >> 2)
  for (let i = 0; i < n; i++) {
    const r = Math.min(i, n - 1 - i) / fade
    const w = r < 1 ? 0.5 - 0.5 * Math.cos(Math.PI * r) : 1
    x[i] = w * amp * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase)
  }
  return x
}

/**
 * BS.1770-4's own calibration: a 997 Hz sine at -X dBFS in one channel reads
 * (X + 3.01) LKFS, because K-weighting is flat there and a sine's mean square
 * is 3.01 dB below its peak.
 */
test('a 997 Hz sine reads the loudness the specification says it does', () => {
  for (const peakDb of [-6, -12, -20, -30]) {
    const amp = Math.pow(10, peakDb / 20)
    const lufs = measureIntegratedLufs([sine(997, amp)], SR)
    assert.ok(
      Math.abs(lufs - (peakDb - 3.01)) < 0.05,
      `${peakDb} dBFS sine read ${lufs.toFixed(3)} LUFS, expected ${(peakDb - 3.01).toFixed(2)}`,
    )
  }
})

test('the same signal reads the same at 44.1 kHz — the coefficients follow the rate', () => {
  // ⚠ 48 kHz COEFFICIENTS AT 44.1 kHz ARE 0.2 LU OUT, and this app's internal
  // rate is 44.1. Re-deriving through the bilinear transform is what makes the
  // two agree; a transcribed 48 kHz table would fail here.
  const at48 = measureIntegratedLufs([sine(997, 0.25, 3, 48000)], 48000)
  const at441 = measureIntegratedLufs([sine(997, 0.25, 3, 44100)], 44100)
  assert.ok(Math.abs(at48 - at441) < 0.05, `${at48} vs ${at441}`)
})

test('K-weighting lifts the presence band and cuts rumble', () => {
  const flat = measureRmsDb([sine(997, 0.25)])
  const high = measureIntegratedLufs([sine(6000, 0.25)], SR) - measureIntegratedLufs([sine(997, 0.25)], SR)
  const low = measureIntegratedLufs([sine(30, 0.25)], SR) - measureIntegratedLufs([sine(997, 0.25)], SR)
  // ~3.3 rather than the shelf's full 4 dB: 997 Hz already sits partway up it,
  // since the shelf corner is at 1682 Hz. The figure that matters is that the
  // presence band is lifted and the bottom is not.
  assert.ok(high > 3 && high < 4, `6 kHz should sit ~3.3 dB up, got ${high.toFixed(2)}`)
  assert.ok(low < -8, `30 Hz should be well down, got ${low.toFixed(2)}`)
  assert.ok(Number.isFinite(flat))
})

test('mono is measured as one channel, so dual mono reads 3 LU louder', () => {
  const x = sine(997, 0.25)
  const mono = measureIntegratedLufs([x], SR)
  const dual = measureIntegratedLufs([x, x], SR)
  // Not a quirk to be fixed: BS.1770 sums channel powers, and every compliant
  // meter reports the same 3.01 LU. Narration is delivered mono, so this is
  // the common path.
  assert.ok(Math.abs(dual - mono - 3.01) < 0.02, `${mono} vs ${dual}`)
})

test('the gate throws away silence that ungated RMS counts', () => {
  // Half speech, half digital silence. LUFS gates the silence out and reads the
  // speech; RMS averages it in and reads 3 dB quieter. Two different questions,
  // which is exactly why both measurements exist here.
  const speech = sine(997, 0.25, 3)
  const n = speech.length
  const padded = new Float32Array(n * 2)
  padded.set(speech, 0)

  const lufsSpeech = measureIntegratedLufs([speech], SR)
  const lufsPadded = measureIntegratedLufs([padded], SR)
  // Not exactly equal: the blocks straddling the boundary are part speech and
  // part silence, so they measure quieter and still pass the gate. A quarter of
  // a LU, against the 3 dB the ungated measurement moves by.
  assert.ok(Math.abs(lufsPadded - lufsSpeech) < 0.4,
    `gating should ignore the silence: ${lufsSpeech} vs ${lufsPadded}`)

  const rmsSpeech = measureRmsDb([speech])
  const rmsPadded = measureRmsDb([padded])
  assert.ok(Math.abs(rmsPadded - rmsSpeech - -3.01) < 0.1,
    `ungated RMS must count the silence: ${rmsSpeech} vs ${rmsPadded}`)
})

test('the relative gate drops a quiet passage out of the average', () => {
  // A loud paragraph followed by one 25 LU below it. The quiet half is more
  // than 10 LU under the mean, so it is gated out and the answer is the loud
  // half — the behaviour that stops a whispered aside pulling a whole chapter
  // up when it is normalized.
  const loud = sine(997, 0.25, 4)
  const quiet = sine(997, 0.25 * Math.pow(10, -25 / 20), 4)
  const both = new Float32Array(loud.length + quiet.length)
  both.set(loud, 0)
  both.set(quiet, loud.length)

  const only = measureIntegratedLufs([loud], SR)
  const mixed = measureIntegratedLufs([both], SR)
  assert.ok(Math.abs(mixed - only) < 0.3, `${only} vs ${mixed}`)
})

test('silence has no loudness, and says so rather than returning a number', () => {
  const quiet = new Float32Array(SR)
  assert.equal(measureIntegratedLufs([quiet], SR), -Infinity)
  assert.equal(measureRmsDb([quiet]), -Infinity)
  assert.equal(measureSamplePeakDb([quiet]), -Infinity)
  assert.equal(measureTruePeakDb([quiet]), -Infinity)
  assert.equal(measureIntegratedLufs([], SR), -Infinity)
})

test('a signal under the absolute gate reads as nothing', () => {
  const belowGate = sine(997, Math.pow(10, (ABSOLUTE_GATE_LUFS - 20) / 20))
  assert.equal(measureIntegratedLufs([belowGate], SR), -Infinity)
})

test('a region shorter than one block still gets an answer, flagged as short', () => {
  const brief = sine(997, 0.25, 0.2)
  const m = measureLoudness([brief], SR)
  assert.equal(m.short, true, 'a 200 ms region must be flagged')
  assert.ok(Number.isFinite(m.lufs), 'and must still measure, rather than refusing')
  assert.equal(measureLoudness([sine(997, 0.25, 3)], SR).short, false)
})

// ── True peak ───────────────────────────────────────────────────────────────

test('every interpolation branch passes a constant through unchanged', () => {
  // Without unity DC gain each branch carries its own small level error
  // straight into the reading, and the error would depend on where in the
  // waveform the peak happened to fall.
  for (const [i, taps] of TRUE_PEAK_PHASES.entries()) {
    const sum = taps.reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-9, `branch ${i} sums to ${sum}`)
  }
})

test('true peak finds the peak between the samples', () => {
  // A sine sampled either side of its crest: the samples never reach the
  // amplitude, and this is exactly the case a dBTP ceiling exists for.
  for (const freq of [1000, 5000, 10000]) {
    for (const phase of [0, 0.3, 0.7, 1.1]) {
      const want = 20 * Math.log10(0.8)
      const got = measureTruePeakDb([sine(freq, 0.8, 2, SR, phase)])
      assert.ok(Math.abs(got - want) < 0.05,
        `${freq} Hz phase ${phase}: read ${got.toFixed(3)} dBTP, want ${want.toFixed(3)}`)
    }
  }
})

test('true peak is never below sample peak', () => {
  // The sample values are one of the four phases, so the reading can only go
  // up from them. A construction that could read lower would let a file past a
  // ceiling its own samples already break.
  for (const freq of [200, 3000, 9000, 16000]) {
    const x = sine(freq, 0.7, 1, SR, 0.4)
    assert.ok(measureTruePeakDb([x]) >= measureSamplePeakDb([x]) - 1e-9, `${freq} Hz`)
  }
})

test('the screen does not hide a peak that only one channel carries', () => {
  // Screening skips samples more than 6 dB below the loudest — a band-limited
  // inter-sample peak cannot climb that far — but it is applied per sample and
  // not per channel, so a quiet channel's own peak is still not the answer.
  const loud = sine(1000, 0.8, 1)
  const soft = sine(1000, 0.1, 1)
  const tp = measureTruePeakDb([loud, soft])
  assert.ok(Math.abs(tp - 20 * Math.log10(0.8)) < 0.05, `${tp}`)
})

test('K-weighting is two sections, whatever the rate', () => {
  for (const rate of [44100, 48000, 96000]) {
    const sections = kWeightingSections(rate)
    assert.equal(sections.length, 2)
    for (const c of sections) {
      for (const k of ['b0', 'b1', 'b2', 'a1', 'a2']) {
        assert.ok(Number.isFinite(c[k]), `${rate}: ${k} is not finite`)
      }
    }
  }
})
