/**
 * Run with:  npm test
 *
 * The Adaptive Soft Clipper: the clip curve's own shape guarantees (unity
 * below threshold, C¹-continuous knee, bounded asymptote, odd symmetry), the
 * de-emphasis stage's exactness as an algebraic inverse of pre-emphasis, the
 * detector's noise-gate hold behaviour, and the kernel's block-size
 * independence (spec §6.3) and constant latency (spec §6.4).
 *
 * What this file does NOT cover: the harmonic-distribution and aliasing
 * sweeps of spec §8.2, and the onset-excess histogram of §8.3. Those are
 * explicitly an offline-prototype exercise (spec §8.1, "implement in Python
 * ... before writing any real-time code") over a real narrator corpus, not
 * something a synthetic unit test can stand in for — see CLAUDE.md's running
 * account of how often synthetic material has been too clean to answer a
 * question like that.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SoftClipperKernel, processSoftClipperBuffer, softClip, SOFT_CLIPPER_LATENCY_SAMPLES,
} from '../../src/audio/softClipperProcessor.js'
import {
  highShelf, invertBiquad, biquadZerosInsideUnitCircle, BiquadCascade,
} from '../../src/audio/dsp/biquad.js'

const SR = 44100

const dbToLin = db => Math.pow(10, db / 20)

/** A steady tone at a given peak amplitude. */
function tone(freqHz, seconds, amp, sr = SR) {
  const n = Math.round(seconds * sr)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sr)
  return out
}

/** Deterministic broadband noise, amplitude-bounded. */
function noise(seconds, amp, sr = SR, seed = 7) {
  const n = Math.round(seconds * sr)
  const out = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = ((s / 0x7fffffff) - 0.5) * 2 * amp
  }
  return out
}

function concat(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0)
  const out = new Float32Array(total)
  let off = 0
  for (const a of arrays) { out.set(a, off); off += a.length }
  return out
}

// ── Clip curve shape (spec §4.4) ────────────────────────────────────────────

test('softClip is exactly unity below threshold', () => {
  const T = 0.5
  for (const x of [0, 0.1, 0.3, 0.4999, -0.2, -0.4999]) {
    assert.equal(softClip(x, T), x)
  }
})

test('softClip is C1-continuous at the knee: slope is 1 on both sides at |x| = T', () => {
  const T = 0.4
  const h = 1e-6
  // One-sided numerical derivatives either side of the knee.
  const dBelow = (softClip(T, T) - softClip(T - h, T)) / h
  const dAbove = (softClip(T + h, T) - softClip(T, T)) / h
  assert.ok(Math.abs(dBelow - 1) < 1e-3, `slope below knee: ${dBelow}`)
  assert.ok(Math.abs(dAbove - 1) < 1e-3, `slope above knee: ${dAbove}`)
})

test('softClip never reaches or exceeds 1.0 for any input a real signal could present', () => {
  // Bounded well under the point where tanh(x) itself rounds to exactly 1.0
  // in float64 (~x > 19 here) — beyond that the curve's OWN math still
  // asymptotes correctly, but the floating-point representation of tanh's
  // output no longer distinguishes it from 1.0, which is a precision limit
  // of IEEE754, not a defect in the curve. 10x full scale already covers any
  // overshoot a real upstream gain stage could hand this plugin.
  const T = 0.3
  for (const x of [1, 2, 5, 10]) {
    assert.ok(softClip(x, T) < 1, `softClip(${x}) = ${softClip(x, T)}`)
    assert.ok(softClip(-x, T) > -1, `softClip(${-x}) = ${softClip(-x, T)}`)
  }
})

test('softClip has exact odd symmetry', () => {
  const T = 0.35
  for (const x of [0.1, 0.5, 0.9, 3, 50]) {
    assert.equal(softClip(-x, T), -softClip(x, T))
  }
})

test('softClip is monotonically increasing (no folding at extreme drive)', () => {
  const T = 0.2
  let prev = -1
  for (let x = -3; x <= 3; x += 0.01) {
    const y = softClip(x, T)
    assert.ok(y >= prev, `not monotonic at x=${x}`)
    prev = y
  }
})

// ── De-emphasis as the exact algebraic inverse of pre-emphasis (spec §4.2) ──

test('pre/de-emphasis cascade nulls to near float precision', () => {
  // This is the isolated math, independent of the oversampled clip stage —
  // the kernel-level idle-transparency test below is bounded by the
  // oversampler's own round-trip instead (see that test's comment).
  const pre = highShelf(SR, 3500, 0.7, 6, 'slope')
  assert.ok(biquadZerosInsideUnitCircle(pre), 'pre-emphasis boost must be minimum-phase')
  const de = invertBiquad(pre)

  const cascade = new BiquadCascade(2, 1)
  cascade.setSections([pre, de])

  const input = noise(1, 0.6)
  const output = new Float32Array(input.length)
  cascade.process(input, output, input.length, 0)

  let maxAbsErr = 0
  let refPeak = 0
  for (let i = 0; i < input.length; i++) {
    maxAbsErr = Math.max(maxAbsErr, Math.abs(output[i] - input[i]))
    refPeak = Math.max(refPeak, Math.abs(input[i]))
  }
  const nullDb = 20 * Math.log10(maxAbsErr / refPeak)
  assert.ok(nullDb < -100, `emphasis pair null: ${nullDb.toFixed(1)} dB, expected < -100 dB`)
})

test('the emphasis shelf at its actual operating point reads as minimum-phase', () => {
  const shelf = highShelf(SR, 3500, 0.7, 6, 'slope')
  assert.ok(biquadZerosInsideUnitCircle(shelf))
})

test('the zero check actually rejects a non-minimum-phase numerator', () => {
  // The positive check above only proves the guard doesn't false-positive on
  // the one shelf this kernel actually runs — it says nothing about whether
  // the guard can catch a bad one. This constructs a numerator by hand with a
  // known zero outside the unit circle: b0*z^2 + b1*z + b2 = (z-2)(z-0.5) =
  // z^2 - 2.5z + 1, i.e. a root at z=2. invertBiquad of this would produce an
  // unstable filter, and the check must say so.
  const nonMinimumPhase = { b0: 1, b1: -2.5, b2: 1, a1: 0, a2: 0 }
  assert.equal(biquadZerosInsideUnitCircle(nonMinimumPhase), false)
})

// ── Kernel: idle transparency (spec §8.2) ───────────────────────────────────

test('material well below threshold passes through nearly unchanged', () => {
  // Not "float epsilon" as the spec's offline-prototype target states — this
  // signal crosses the oversampler's halfband filters and the emphasis pair,
  // both round trips, each with a small but nonzero passband ripple
  // (oversample.js: flat to 0.01 dB through 19 kHz). The bound here is set
  // from that, not copied from the spec unchanged.
  const quiet = tone(400, 0.5, 0.05) // well under the 0.10 clamp floor on T
  const { channelData } = processSoftClipperBuffer([quiet], SR, { headroomDb: 16, emphasisDb: 0 })
  const out = channelData[0]

  const latency = SOFT_CLIPPER_LATENCY_SAMPLES
  let maxAbsErr = 0
  for (let i = 0; i + latency < quiet.length; i++) {
    maxAbsErr = Math.max(maxAbsErr, Math.abs(out[i + latency] - quiet[i]))
  }
  const errDb = 20 * Math.log10(maxAbsErr / 0.05)
  assert.ok(errDb < -40, `idle-path error: ${errDb.toFixed(1)} dB`)
})

// ── Detector: noise gate + hold (spec §3.1-3.2) ─────────────────────────────

test('the speech level tracker holds through a pause instead of sagging', () => {
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams({ headroomDb: 10 })

  const speech = tone(200, 1.5, 0.3)
  const pauseHalf = new Float32Array(Math.round(1.0 * SR)) // digital silence
  const scratch = new Float32Array(256)

  function run(signal) {
    for (let off = 0; off < signal.length; off += 256) {
      const len = Math.min(256, signal.length - off)
      kernel.process([signal.subarray(off, off + len)], [scratch.subarray(0, len)], len)
    }
  }

  run(speech)
  const levelAfterSpeech = kernel.speechLevelDb
  run(pauseHalf)
  const levelAfterFirstSecond = kernel.speechLevelDb
  run(pauseHalf)
  const levelAfterSecondSecond = kernel.speechLevelDb

  // Some movement during the first ~10-40 ms of a pause is real and expected:
  // fast_rms hasn't finished collapsing yet, so the tracker is still briefly
  // reacting to the genuine tail of the loudness dropping — not a bug, see
  // deviation note 5a. What the hold is actually there to prevent is
  // CONTINUED sagging deeper into the pause, once the gate has closed for
  // real; that should be exactly zero regardless of how long the pause runs.
  assert.ok(
    Math.abs(levelAfterSpeech - levelAfterFirstSecond) < 3,
    `movement during the pause's onset should be modest: ${levelAfterSpeech.toFixed(2)} -> ${levelAfterFirstSecond.toFixed(2)}`,
  )
  assert.equal(
    levelAfterSecondSecond, levelAfterFirstSecond,
    'once fully gated closed, a longer pause must not sag the tracker any further',
  )
})

test('the noise floor estimate does not chase a single loud transient upward', () => {
  const kernel = new SoftClipperKernel(SR)
  const quietFloor = noise(1.5, 0.01) // settle a low noise estimate first
  const spike = tone(400, 0.02, 0.8) // one brief loud burst
  const scratch = new Float32Array(256)

  function run(signal) {
    for (let off = 0; off < signal.length; off += 256) {
      const len = Math.min(256, signal.length - off)
      kernel.process([signal.subarray(off, off + len)], [scratch.subarray(0, len)], len)
    }
  }

  run(quietFloor)
  const floorBefore = kernel.noiseEstDb
  run(spike)
  const floorAfter = kernel.noiseEstDb

  // A 2 s creep-up time constant means a 20 ms burst moves it by only a
  // fraction of a dB, nowhere near tracking the spike's own level.
  assert.ok(floorAfter - floorBefore < 3, `noise floor jumped ${(floorAfter - floorBefore).toFixed(2)} dB on one spike`)
})

// ── Threshold behaviour (spec §3.3, §5.2) ───────────────────────────────────

test('lower headroom produces more peak reduction (monotonic)', () => {
  function reductionFor(headroomDb) {
    const burst = concat(tone(200, 1.0, 0.25), tone(120, 0.05, 0.9), tone(200, 0.5, 0.25))
    const { metering } = processSoftClipperBuffer([burst], SR, { headroomDb, emphasisDb: 0 })
    return metering.maxReductionDb
  }
  const sweep = [16, 12, 10, 8, 4].map(reductionFor)
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(
      sweep[i] >= sweep[i - 1] - 1e-6,
      `reduction should not fall as headroom decreases: ${sweep.map(v => v.toFixed(2)).join(' → ')}`,
    )
  }
  assert.ok(sweep[sweep.length - 1] > sweep[0] + 1, 'expected a meaningful spread across the headroom range')
})

test('fixed mode ignores programme level; adaptive mode tracks it', () => {
  const quiet = concat(tone(200, 1.0, 0.08), tone(120, 0.05, 0.2), tone(200, 0.5, 0.08))
  const loud = concat(tone(200, 1.0, 0.4), tone(120, 0.05, 0.98), tone(200, 0.5, 0.4))

  function reduction(signal, params) {
    return processSoftClipperBuffer([signal], SR, params).metering.maxReductionDb
  }

  const fixedParams = { thresholdMode: 'fixed', fixedThresholdDb: -12 }
  const adaptiveParams = { thresholdMode: 'adaptive', headroomDb: 10 }

  const fixedQuiet = reduction(quiet, fixedParams)
  const fixedLoud = reduction(loud, fixedParams)
  const adaptiveQuiet = reduction(quiet, adaptiveParams)
  const adaptiveLoud = reduction(loud, adaptiveParams)

  // Fixed mode: the quiet take's transient sits under -12 dBFS and should
  // barely cross T at all; the loud take's sits close to 0 dBFS and should
  // show a clearly larger reduction. The curve's own bounded reduction range
  // (spec §7.1: 3-6 dB is the USABLE range even at aggressive settings) means
  // this is a small-numbers comparison, not a dramatic one.
  assert.ok(fixedLoud - fixedQuiet > 1, `fixed mode should react to absolute level: ${fixedQuiet.toFixed(3)} vs ${fixedLoud.toFixed(3)}`)

  // Adaptive mode: both takes' transients sit the same number of dB above
  // their own speech level, so reduction should land much closer together —
  // a materially smaller gap than fixed mode's, not just a numerically
  // smaller one.
  assert.ok(
    Math.abs(adaptiveLoud - adaptiveQuiet) < 0.5 * Math.abs(fixedLoud - fixedQuiet),
    'adaptive mode should be far less sensitive to absolute level than fixed mode',
  )
})

// ── Latency (spec §6.4) ──────────────────────────────────────────────────────

test('latency is constant regardless of emphasis or headroom setting', () => {
  for (const params of [{ emphasisDb: 0 }, { emphasisDb: 12 }, { headroomDb: 4 }, { headroomDb: 16 }]) {
    const kernel = new SoftClipperKernel(SR)
    kernel.setParams(params)
    assert.equal(kernel.latencySamples, SOFT_CLIPPER_LATENCY_SAMPLES)
  }
})

// ── Block-size independence (spec §6.3) ─────────────────────────────────────

test('output is identical regardless of host buffer size', () => {
  const signal = concat(tone(180, 0.4, 0.3), tone(140, 0.05, 0.85), noise(0.3, 0.1))

  function renderAt(blockSize) {
    const kernel = new SoftClipperKernel(SR)
    kernel.setParams({ headroomDb: 8, emphasisDb: 6 })
    const out = new Float32Array(signal.length)
    for (let off = 0; off < signal.length; off += blockSize) {
      const len = Math.min(blockSize, signal.length - off)
      kernel.process(
        [signal.subarray(off, off + len)],
        [out.subarray(off, off + len)],
        len,
      )
    }
    return out
  }

  const ref = renderAt(1024)
  for (const blockSize of [64, 256]) {
    const other = renderAt(blockSize)
    let maxDiff = 0
    for (let i = 0; i < signal.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(other[i] - ref[i]))
    }
    assert.ok(maxDiff < 1e-6, `block size ${blockSize} diverged from 1024 by ${maxDiff}`)
  }
})

// ── Emphasis at 0 dB (Open Question #5) ─────────────────────────────────────

test('emphasisDb = 0 matches the emphasis pair being skipped entirely', () => {
  const signal = concat(tone(180, 0.3, 0.3), tone(140, 0.05, 0.85))
  const withZero = processSoftClipperBuffer([signal], SR, { emphasisDb: 0, headroomDb: 8 }).channelData[0]
  const withEpsilon = processSoftClipperBuffer([signal], SR, { emphasisDb: 0.0001, headroomDb: 8 }).channelData[0]
  let maxDiff = 0
  for (let i = 0; i < signal.length; i++) maxDiff = Math.max(maxDiff, Math.abs(withZero[i] - withEpsilon[i]))
  assert.ok(maxDiff < 1e-6, `no audible discontinuity expected crossing the bypass boundary, got ${maxDiff}`)
})

// ── Absolute capability (spec §7.1) ─────────────────────────────────────────
//
// THE TESTS THAT WERE MISSING. Everything above this point passed against a
// curve that could not reduce a peak by even 2.4 dB at any setting — because
// every one of those assertions is about RELATIVE behaviour (is it monotonic,
// is it symmetric, is the knee continuous) or about transparency (does it
// leave quiet material alone). A stage that does nothing at all satisfies most
// of them. Not one asked the only question a user asks: does it work.
//
// Reported from real use, not caught here: on a 35 s narration clip normalised
// to -1 dBFS the meter never passed 1 dB even at minimum Headroom.

test('the curve can reach the peak reduction the spec calls its usable range', () => {
  // The headline claim, and the one the spec's own curve failed. §7.1 states
  // 3-6 dB is usable on speech and calls 6 dB a hard ceiling; a curve that
  // cannot reach the bottom of that range has no usable range at all.
  //
  // -18 dBFS is where the detector actually placed the threshold on the
  // reported clip at minimum Headroom, so this is the real operating point,
  // not a favourable one.
  const T = dbToLin(-18)
  const reductionDb = -20 * Math.log10(softClip(1.0, T))
  assert.ok(
    reductionDb >= 3,
    `a full-scale sample at T = -18 dBFS should reduce by at least 3 dB, got ${reductionDb.toFixed(2)}`,
  )
  assert.ok(
    reductionDb <= 8,
    `...and should not blow past §7.1's ceiling into grit, got ${reductionDb.toFixed(2)}`,
  )
})

test('the spec-as-written curve (k = 1) is bounded at 2.37 dB — do not go back to it', () => {
  // Pins the mechanism so the knee-sharpness term cannot be "simplified" out
  // by someone reading §4.4 and finding an unexplained constant.
  //
  // With k = 1 the tanh argument at |x| = 1.0 is (1-T)/(1-T) = 1 for EVERY
  // threshold, so the output is always T + tanh(1)·(1-T) and the reduction is
  // capped at -20·log10(tanh(1)) = 2.37 dB as T approaches zero. Within the
  // [-1, 1] domain digital audio lives in, that curve only ever traverses the
  // first unit of tanh's argument.
  const ceilingDb = -20 * Math.log10(Math.tanh(1))
  assert.ok(Math.abs(ceilingDb - 2.37) < 0.01, `k=1 ceiling should be 2.37 dB, got ${ceilingDb.toFixed(3)}`)
  for (const T of [0.001, 0.05, 0.126, 0.3, 0.5]) {
    const k1 = -20 * Math.log10(softClip(1.0, T, 1))
    assert.ok(k1 <= ceilingDb + 1e-9, `k=1 at T=${T} exceeded its own bound: ${k1.toFixed(3)}`)
    assert.ok(k1 < 3, `k=1 at T=${T} still cannot reach 3 dB: ${k1.toFixed(3)}`)
  }
})

test('a real narration peak 17 dB over threshold gets meaningfully reduced', () => {
  // End-to-end through the kernel rather than the bare curve, in fixed mode so
  // the assertion is about the audio path and not about detector convergence.
  // Mirrors the reported file: speech around -22 dBFS, threshold -18, peaks
  // at -1 — a peak 17 dB above the threshold, which previously came back
  // 1.82 dB quieter and read to the user as a broken control.
  const body = tone(200, 1.0, dbToLin(-22))
  const transient = tone(120, 0.02, dbToLin(-1))
  const signal = concat(body, transient, tone(200, 0.4, dbToLin(-22)))
  const { metering } = processSoftClipperBuffer([signal], SR, {
    thresholdMode: 'fixed', fixedThresholdDb: -18, emphasisDb: 0,
  })
  assert.ok(
    metering.maxReductionDb >= 3,
    `expected at least 3 dB on a peak 17 dB over threshold, got ${metering.maxReductionDb.toFixed(2)}`,
  )
})

test('C1 continuity at the knee holds for every knee sharpness, not just the shipped one', () => {
  // The knee-sharpness term is only safe to tune because the unit-slope
  // property is independent of k — d/dx above the knee is sech²(0) = 1 at
  // |x| = T whatever k is. Pinned across the range so a future recalibration
  // cannot quietly introduce a slope discontinuity.
  const h = 1e-6
  for (const k of [1, 1.5, 2.2, 3, 6]) {
    for (const T of [0.1, 0.3, 0.6]) {
      const dBelow = (softClip(T, T, k) - softClip(T - h, T, k)) / h
      const dAbove = (softClip(T + h, T, k) - softClip(T, T, k)) / h
      assert.ok(Math.abs(dBelow - 1) < 1e-3, `k=${k} T=${T}: slope below knee ${dBelow}`)
      assert.ok(Math.abs(dAbove - 1) < 1e-3, `k=${k} T=${T}: slope above knee ${dAbove}`)
    }
  }
})

test('the shipped curve still never reaches full scale, and stays monotonic', () => {
  // The bounded-asymptote and monotonicity guarantees are what stop a sharper
  // knee from becoming a hard clipper. Re-checked at the shipped k rather than
  // assuming the k=1 proofs above carry over.
  //
  // This one fails at k=1 for a DIFFERENT reason than the two capability tests
  // above, and the distinction is worth keeping straight: k=1's asymptote is
  // T + (1-T)/1 = exactly 1.0, so once tanh's argument saturates in float64 the
  // output rounds to full scale. A sharper knee pulls the asymptote down to
  // T + (1-T)/k — 0.78 at k=2.2, T=0.6 — which float saturation cannot reach.
  // So the fix incidentally makes the never-hard-clips guarantee hold in
  // arithmetic and not merely in the limit.
  for (const T of [0.1, 0.3, 0.6]) {
    for (const x of [1, 2, 5, 10]) {
      assert.ok(softClip(x, T) < 1, `T=${T}: softClip(${x}) = ${softClip(x, T)}`)
      assert.ok(softClip(-x, T) > -1, `T=${T}: softClip(${-x}) reached full scale`)
    }
    let prev = -1
    for (let x = -3; x <= 3; x += 0.01) {
      const y = softClip(x, T)
      assert.ok(y >= prev, `T=${T}: not monotonic at x=${x}`)
      prev = y
    }
  }
})
