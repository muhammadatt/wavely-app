/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decayCoeff,
  riseCoeff,
  RmsFollower,
  AttackReleaseFollower,
  linToDb,
  dbToLin,
} from '../../src/audio/dsp/envelope.js'

const SR = 44100

test('decayCoeff matches the Python _time_to_coeff', () => {
  // resonance_suppressor.py: np.exp(-frame_period_ms / time_ms)
  const framePeriodMs = (512 / 44100) * 1000
  for (const tau of [15, 80, 250]) {
    const expected = Math.exp(-framePeriodMs / tau)
    assert.ok(Math.abs(decayCoeff(tau, framePeriodMs) - expected) < 1e-15)
  }
  assert.equal(decayCoeff(0, 10), 0)
  assert.equal(decayCoeff(10, 0), 0)
})

test('riseCoeff matches the compressor kernels', () => {
  // la2aProcessor.js: 1 - Math.exp(-1 / (sr * seconds))
  for (const tauMs of [10, 35, 150]) {
    const expected = 1 - Math.exp(-1 / (SR * (tauMs / 1000)))
    assert.ok(Math.abs(riseCoeff(tauMs, SR) - expected) < 1e-15)
  }
})

test('the two conventions are complements at the same period', () => {
  const periodMs = 1000 / SR
  const tau = 50
  assert.ok(Math.abs(riseCoeff(tau, SR) - (1 - decayCoeff(tau, periodMs))) < 1e-12)
})

test('RmsFollower converges to the true RMS of a sine', () => {
  const f = new RmsFollower(SR, 50)
  const amp = 0.5
  const n = SR // one second, far beyond a 50 ms time constant
  for (let i = 0; i < n; i++) f.process(amp * Math.sin((2 * Math.PI * 440 * i) / SR))
  const expected = amp / Math.SQRT2
  assert.ok(
    Math.abs(f.value - expected) < 0.01,
    `expected ~${expected.toFixed(4)}, got ${f.value.toFixed(4)}`,
  )
})

test('RmsFollower never returns zero, so it is safe as a divisor', () => {
  // This is the whole reason the floor exists: vocal_saturation.py divides by
  // wet_rms and out_rms, and a streaming follower will see true silence.
  const f = new RmsFollower(SR, 50, 1e-6)
  for (let i = 0; i < SR; i++) f.process(0)
  assert.ok(f.value >= 1e-6, `floor breached: ${f.value}`)
  assert.ok(Number.isFinite(1 / f.value))
  assert.ok(Number.isFinite(f.db))
})

test('processBlock matches per-sample processing', () => {
  const n = 1024
  const sig = new Float64Array(n)
  for (let i = 0; i < n; i++) sig[i] = Math.sin(i / 10) * 0.4

  const a = new RmsFollower(SR, 100)
  for (let i = 0; i < n; i++) a.process(sig[i])

  const b = new RmsFollower(SR, 100)
  b.processBlock(sig, n)

  assert.ok(Math.abs(a.value - b.value) < 1e-15)
})

test('RmsFollower reset returns it to the initial state', () => {
  const f = new RmsFollower(SR, 100)
  for (let i = 0; i < 1000; i++) f.process(0.5)
  f.reset()
  assert.equal(f.meanSq, 0)
  assert.equal(f.warmupCount, 0)
})

test('RmsFollower reaches a usable estimate within a few cycles', () => {
  // Matters at region boundaries: a gain derived from a follower ramping up
  // from zero would swing over the opening ~tau and leave an audible step.
  // The warmup uses a cumulative mean, so accuracy arrives after roughly one
  // cycle of the signal rather than after one time constant.
  const f = new RmsFollower(SR, 300)
  const amp = 0.5
  const freq = 200
  const expected = amp / Math.SQRT2
  const cycleSamples = SR / freq

  // After three cycles (~15 ms) the estimate should already be close, versus
  // the 300 ms an unwarmed exponential average would need.
  for (let i = 0; i < cycleSamples * 3; i++) {
    f.process(amp * Math.sin((2 * Math.PI * freq * i) / SR))
  }
  assert.ok(
    Math.abs(f.value - expected) < 0.05,
    `after 3 cycles: expected ~${expected.toFixed(3)}, got ${f.value.toFixed(3)}`,
  )
})

test('RmsFollower warmup hands over to the exponential average', () => {
  const f = new RmsFollower(SR, 10) // short tau so warmup ends quickly
  for (let i = 0; i < f.warmupTarget; i++) f.process(0.5)
  assert.equal(f.warmupCount, f.warmupTarget)
  assert.ok(Math.abs(f.value - 0.5) < 1e-9)

  // Now a level change should track at the IIR rate, not the cumulative one.
  for (let i = 0; i < SR * 0.2; i++) f.process(0.1)
  assert.ok(Math.abs(f.value - 0.1) < 1e-3, `did not track after warmup: ${f.value}`)
})

test('explicit prime skips the warmup entirely', () => {
  const f = new RmsFollower(SR, 300)
  f.prime(0.25) // meanSq
  assert.ok(Math.abs(f.value - 0.5) < 1e-12)
  assert.equal(f.warmupCount, f.warmupTarget)
})

test('AttackReleaseFollower rises fast and falls slow', () => {
  const f = new AttackReleaseFollower(SR, 1, 200)
  // Step up: with a 1 ms attack, 10 ms should be essentially settled.
  for (let i = 0; i < SR * 0.01; i++) f.process(1)
  assert.ok(f.value > 0.99, `attack too slow: ${f.value}`)
  // Step down: with a 200 ms release, 10 ms should barely move.
  for (let i = 0; i < SR * 0.01; i++) f.process(0)
  assert.ok(f.value > 0.9, `release too fast: ${f.value}`)
  // ...but a full second gets there.
  for (let i = 0; i < SR; i++) f.process(0)
  assert.ok(f.value < 0.01, `release never completed: ${f.value}`)
})

test('linToDb and dbToLin round-trip', () => {
  for (const db of [-60, -20, -6, 0, 6]) {
    assert.ok(Math.abs(linToDb(dbToLin(db)) - db) < 1e-12)
  }
  assert.ok(linToDb(0) <= -240, 'zero must clamp, not return -Infinity')
})
