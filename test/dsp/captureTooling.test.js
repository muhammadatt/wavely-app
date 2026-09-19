/**
 * Run with:  npm test
 *
 * Guards on the shared capture-tooling library under `scripts/lib/`, which the
 * LA-2A and FET Punch reference-measurement suites both build on.
 *
 * These are not tests that the DSP is "correct" — the scripts' own `--selftest`
 * modes do that against a kernel with known constants. They pin the three
 * behaviours that have bitten, or would bite silently:
 *
 *   1. An infeasible mute-schedule request must THROW, not hang. It hung once.
 *   2. A plan that loses an event to a mute must fail the build, not ship.
 *   3. The gain trace must reconstruct exactly, and must not interpolate
 *      across a dropout it cannot see over.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CLEAN_WINDOW_S, MUTE_PERIOD_S, scheduleClear, assertPlanClear,
} from '../../scripts/lib/demoMute.js'
import { snapToZeroCrossing, buildProbe } from '../../scripts/lib/probeStimulus.js'
import { traceGain, fillShortGaps, blindWindowUs, blockGain } from '../../scripts/lib/gainTrace.js'

test('scheduleClear places a span in a clean window', () => {
  // A span that would straddle the 20 s mute gets pushed past it, not into it.
  const t = scheduleClear(19.0, 3.0, 'probe')
  assert.ok(t >= MUTE_PERIOD_S + 1.0, `pushed to ${t}, still inside the mute`)
})

test('scheduleClear leaves a span that already fits exactly where it is', () => {
  assert.equal(scheduleClear(2.0, 5.0, 'probe'), 2.0)
})

test('an infeasible span throws rather than searching forever', () => {
  // ⚠ THE REGRESSION THIS PINS IS A HANG, NOT A WRONG ANSWER. A span longer
  // than the clean window lands on another mute wherever it is pushed, so the
  // loop chased `t` without terminating — a 12 s burst hung the stimulus build
  // instead of failing it.
  assert.throws(
    () => scheduleClear(1.0, CLEAN_WINDOW_S + 0.5, 'too long'),
    /exceeds the .* clean window/)
})

test('assertPlanClear rejects a plan whose event overlaps a mute', () => {
  assert.throws(
    () => assertPlanClear('bursts', [['burst', 19.5, 21.5]]),
    /hits the demo mute at 20.00s/)
  assert.doesNotThrow(() => assertPlanClear('bursts', [['burst', 21.5, 25.0]]))
})

test('probe steps land on a zero crossing of their own frequency', () => {
  for (const f of [100, 1000, 4000]) {
    const t = snapToZeroCrossing(3.1234, f)
    // Phase at the step is an exact multiple of pi, so sin() is zero there.
    assert.ok(Math.abs(Math.sin(2 * Math.PI * f * t)) < 1e-9, `${f} Hz landed mid-cycle`)
  }
})

test('buildProbe returns the exact envelope that produced the waveform', () => {
  const sr = 48000
  const plan = {
    seconds: 1.0,
    lowDb: -40,
    events: [{ tag: 'step', freqHz: 1000, hiDb: -6, up: 0.25, down: 0.75 }],
  }
  const { x, env } = buildProbe(plan, sr)
  assert.equal(x.length, sr)
  // |x| never exceeds the envelope, and reaches it at the peaks.
  let maxRatio = 0
  for (let i = 0; i < x.length; i++) maxRatio = Math.max(maxRatio, Math.abs(x[i]) / env[i])
  assert.ok(maxRatio <= 1 + 1e-9 && maxRatio > 0.999, `peak/envelope ratio ${maxRatio}`)
  assert.ok(Math.abs(env[sr / 2] - Math.pow(10, -6 / 20)) < 1e-12, 'hold level wrong')
  assert.ok(Math.abs(env[10] - Math.pow(10, -40 / 20)) < 1e-12, 'rest level wrong')
})

test('traceGain recovers an applied gain exactly, away from the crossings', () => {
  const sr = 96000
  const plan = {
    seconds: 0.2,
    lowDb: -40,
    events: [{ tag: 'step', freqHz: 4000, hiDb: -6, up: 0.05, down: 0.15 }],
  }
  const { x, env } = buildProbe(plan, sr)
  // A known, time-varying gain — nothing a smoothed envelope could track.
  const wet = new Float32Array(x.length)
  const truth = i => 0.5 + 0.4 * Math.sin(2 * Math.PI * 37 * i / sr)
  for (let i = 0; i < x.length; i++) wet[i] = x[i] * truth(i)

  const g = traceGain(wet, env, x, { floor: 0.1 })
  let worst = 0, n = 0
  for (let i = 0; i < g.length; i++) {
    if (!Number.isFinite(g[i])) continue
    worst = Math.max(worst, Math.abs(g[i] - truth(i)))
    n++
  }
  assert.ok(n > g.length * 0.85, `only ${n}/${g.length} samples usable`)
  assert.ok(worst < 1e-6, `worst gain error ${worst}`)
})

test('traceGain honours the lag, so a latent capture still reconstructs', () => {
  const sr = 96000
  const plan = { seconds: 0.05, lowDb: -40, events: [{ tag: 's', freqHz: 4000, hiDb: -6, up: 0.01, down: 0.04 }] }
  const { x, env } = buildProbe(plan, sr)
  const lag = 50 // the shipping path's OVERSAMPLE_LATENCY_SAMPLES
  const wet = new Float32Array(x.length + lag)
  for (let i = 0; i < x.length; i++) wet[i + lag] = x[i] * 0.25
  const g = traceGain(wet, env, x, { lag })
  const seen = [...g].filter(Number.isFinite)
  assert.ok(seen.length > 0)
  assert.ok(seen.every(v => Math.abs(v - 0.25) < 1e-6), 'lag not applied')
})

test('fillShortGaps bridges a zero crossing and refuses a dropout', () => {
  const g = new Float64Array([1, 1, NaN, NaN, 1, NaN, NaN, NaN, NaN, NaN, 1])
  const out = fillShortGaps(g, 2)
  assert.ok(Number.isFinite(out[2]) && Number.isFinite(out[3]), 'short gap not bridged')
  // ⚠ A LONG GAP IS A DEMO MUTE, NOT A CROSSING. Interpolating one draws a
  // straight line through a second of silence and calls it a gain.
  for (let i = 5; i <= 9; i++) assert.ok(Number.isNaN(out[i]), `long gap bridged at ${i}`)
})

test('blindWindowUs is why the FET probe is 4 kHz and the LA-2A probe is 1 kHz', () => {
  // 20 us is ATTACK_FASTEST_S. A 1 kHz probe is blind for longer than that and
  // cannot see the fast end of this unit at all; 4 kHz is blind for less.
  assert.ok(blindWindowUs(1000, 0.1) > 20)
  assert.ok(blindWindowUs(4000, 0.1) < 20)
})

test('blockGain recovers a per-block gain and gates silence', () => {
  const n = 4096
  const dry = new Float32Array(n)
  for (let i = 0; i < n; i++) dry[i] = i < n / 2 ? 0.5 * Math.sin(2 * Math.PI * 220 * i / 44100) : 0
  const wet = new Float32Array(n)
  for (let i = 0; i < n; i++) wet[i] = dry[i] * 0.4
  const { g } = blockGain(dry, wet, 64)
  const loud = [...g].slice(0, n / 2 / 64)
  assert.ok(loud.every(v => Math.abs(v - 0.4) < 1e-5), 'gain not recovered')
  assert.ok([...g].slice(n / 2 / 64).every(v => Number.isNaN(v)), 'silence not gated')
})
