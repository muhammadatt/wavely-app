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
  MAX_REDUCTION_DB, KNEE_DB, SHAPE_EXPONENT, SHAPE_MIN_KNEE_DB,
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

test('softClip never boosts: |y| <= |x| everywhere', () => {
  // This REPLACES an earlier assertion that the output asymptotes below 1.0.
  // That property belonged to the full-scale-anchored curve and is
  // deliberately gone: bounding REDUCTION at MAX_REDUCTION_DB means an input
  // already above full scale comes back out above full scale, just quieter.
  // Spec §1.1 is explicit that this stage does not guarantee a peak ceiling
  // ("that is a separate brickwall stage, not this one"), so the honest
  // invariant is that it only ever attenuates.
  for (const T of [0.01, 0.126, 0.3, 0.6]) {
    for (const x of [0.5, 1, 2, 5, 10, 100]) {
      assert.ok(Math.abs(softClip(x, T)) <= Math.abs(x) + 1e-12, `T=${T} x=${x}`)
      assert.ok(Math.abs(softClip(-x, T)) <= Math.abs(x) + 1e-12, `T=${T} x=${-x}`)
    }
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
  let prev = -Infinity   // not -1: outputs are no longer bounded by full scale
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
  // The probe is speech-like (pauses, realistic crest) rather than a steady
  // tone, for two reasons that both bite. On steady material the valley
  // follower settles at the signal's own level so the gate never opens; with
  // the fail-safe warm-up (see SPEECH_INIT_HOLD_DB) that now means the tracker
  // never leaves its hold value and the stage does literally nothing at every
  // Headroom setting. And a sine's ~3 dB crest cannot exercise a threshold
  // that is compared against samples at all.
  function reductionFor(headroomDb) {
    const signal = concat(
      speechLike(5, 0.3, 17),
      tone(120, 0.015, 0.9),
      speechLike(1.5, 0.3, 41),
    )
    return processSoftClipperBuffer([signal], SR, { headroomDb, emphasisDb: 0 }).metering.maxReductionDb
  }
  const headrooms = [16, 12, 10, 8, 4]
  const sweep = headrooms.map(reductionFor)
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(
      sweep[i] >= sweep[i - 1] - 1e-6,
      `reduction should not fall as headroom decreases: ${sweep.map(v => v.toFixed(2)).join(' → ')}`,
    )
  }
  assert.ok(
    sweep[sweep.length - 1] > sweep[0] + 1,
    `expected a meaningful spread across the headroom range: ${sweep.map(v => v.toFixed(2)).join(' → ')}`,
  )
})

test('adaptive mode is level-invariant; fixed mode is not', () => {
  // THE TEST THAT WAS MISSING, and the earlier version of it was malformed:
  // it built "quiet" and "loud" with DIFFERENT relative dynamics (a 20 dB
  // transient-over-speech against a 9 dB one), so it compared two different
  // signals and could not have detected level sensitivity in either mode.
  //
  // The claim §3.3 makes is specifically that deriving T from the speaker's
  // own level makes the stage level-invariant. Testing that requires ONE
  // signal at two levels, so the only thing that changes is absolute level.
  // The probe needs PAUSES, and that is not incidental. On steady material the
  // noise-floor valley follower settles at the signal's own level, so the gate
  // condition (fastRms > noiseEst + GATE_MARGIN_DB) never fires, the speech
  // tracker never updates, and it sits at its absolute -24 dBFS seed forever —
  // measured: 6 s of continuous tone left speechLevel at exactly -24.0 at both
  // test levels, which is not invariance, it is a detector that never ran. A
  // steady tone is pathological for a gated detector by construction.
  //
  // Invariance is also necessarily a STEADY-STATE property: the seed is an
  // absolute constant because at t=0 there is nothing relative to seed it
  // from, so the convergence PATH differs with level even though the converged
  // value does not. Hence the long run-up before the transient under test.
  const gap = () => noise(0.35, dbToLin(-70))
  const phrase = amp => tone(200, 0.5, amp)
  const speechAmp = dbToLin(-22)
  const base = concat(
    phrase(speechAmp), gap(), phrase(speechAmp), gap(), phrase(speechAmp), gap(),
    phrase(speechAmp), gap(), phrase(speechAmp), gap(), phrase(speechAmp), gap(),
    phrase(speechAmp), gap(), phrase(speechAmp), gap(),
    tone(120, 0.05, dbToLin(-1)),
    phrase(speechAmp),
  )
  const scaled = new Float32Array(base.length)
  const TRIM_DB = -18
  for (let i = 0; i < base.length; i++) scaled[i] = base[i] * dbToLin(TRIM_DB)

  const red = (sig, params) => processSoftClipperBuffer([sig], SR, params).metering.maxReductionDb

  const adaptive = { thresholdMode: 'adaptive', headroomDb: 10, emphasisDb: 0 }
  const aBase = red(base, adaptive)
  const aScaled = red(scaled, adaptive)
  assert.ok(
    Math.abs(aBase - aScaled) < 0.5,
    `adaptive must be level-invariant: ${aBase.toFixed(2)} at 0 dB vs ${aScaled.toFixed(2)} at ${TRIM_DB} dB`,
  )
  assert.ok(aBase > 1, `and must actually be doing something: ${aBase.toFixed(2)} dB`)

  // Fixed mode is absolute by definition, so the SAME trim must move it a lot.
  // This is the control: it proves the trim is large enough to be detectable,
  // so adaptive's flatness above is invariance and not a dead measurement.
  const fixed = { thresholdMode: 'fixed', fixedThresholdDb: -12, emphasisDb: 0 }
  const fBase = red(base, fixed)
  const fScaled = red(scaled, fixed)
  assert.ok(
    fBase - fScaled > 2,
    `fixed mode should track absolute level: ${fBase.toFixed(2)} vs ${fScaled.toFixed(2)}`,
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

test('the spec-as-written curve is bounded at 2.37 dB — do not go back to it', () => {
  // Computed INLINE rather than through softClip(), because the shipped curve
  // no longer has this shape at any parameter setting. Pinning the mechanism
  // so nobody reads §4.4, finds our constants unfamiliar, and "restores" it.
  //
  // §4.4: y = T + (1-T)*tanh((|x|-T)/(1-T)). The tanh argument at |x| = 1.0 is
  // (1-T)/(1-T) = 1 for EVERY threshold, so the output is always
  // T + tanh(1)*(1-T) and reduction is capped at -20*log10(tanh(1)) = 2.37 dB
  // as T approaches zero. Within the [-1, 1] domain digital audio occupies,
  // that curve only ever traverses the first unit of tanh's argument.
  const specCurve = (x, T) => T + (1 - T) * Math.tanh((x - T) / (1 - T))
  const ceilingDb = -20 * Math.log10(Math.tanh(1))
  assert.ok(Math.abs(ceilingDb - 2.37) < 0.01, `ceiling should be 2.37 dB, got ${ceilingDb.toFixed(3)}`)
  for (const T of [0.001, 0.05, 0.126, 0.3, 0.5]) {
    const red = -20 * Math.log10(specCurve(1.0, T))
    assert.ok(red <= ceilingDb + 1e-9, `T=${T} exceeded its own bound: ${red.toFixed(3)}`)
    assert.ok(red < 3, `T=${T} still cannot reach 3 dB: ${red.toFixed(3)}`)
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

test('C1 continuity at the knee holds across the whole constant space', () => {
  // The two shaping constants are only safe to retune because unit slope at
  // the knee is independent of both: d(reduction)/d(excess) is 0 at excess 0
  // because tanh^2 is flat at the origin, whatever it is scaled by.
  const h = 1e-7
  for (const rMax of [1, 3, 6, 12]) {
    for (const knee of [6, 11.4, 20, 40]) {
      for (const T of [0.001, 0.1, 0.3, 0.6]) {
        const hh = T * h
        const dBelow = (softClip(T, T, rMax, knee) - softClip(T - hh, T, rMax, knee)) / hh
        const dAbove = (softClip(T + hh, T, rMax, knee) - softClip(T, T, rMax, knee)) / hh
        assert.ok(Math.abs(dBelow - 1) < 2e-3, `rMax=${rMax} knee=${knee} T=${T}: below ${dBelow}`)
        assert.ok(Math.abs(dAbove - 1) < 2e-3, `rMax=${rMax} knee=${knee} T=${T}: above ${dAbove}`)
      }
    }
  }
})

test('the shipped curve stays monotonic at every threshold', () => {
  // Monotonicity is not free here: it requires KNEE_DB > 0.7698*MAX_REDUCTION_DB,
  // the peak of 2*tanh(u)*sech^2(u). Pinned so a future retune of either
  // constant cannot silently make a louder input produce a quieter output.
  assert.ok(
    KNEE_DB > 0.7698 * MAX_REDUCTION_DB,
    `KNEE_DB ${KNEE_DB} must exceed 0.7698*MAX_REDUCTION_DB = ${(0.7698 * MAX_REDUCTION_DB).toFixed(3)}`,
  )
  for (const T of [0.001, 0.1, 0.3, 0.6]) {
    let prev = -Infinity
    for (let e = 0; e < 80; e += 0.05) {
      const y = softClip(T * dbToLin(e), T)
      assert.ok(y >= prev, `T=${T}: not monotonic at ${e} dB over threshold`)
      prev = y
    }
  }
})

// ── Level invariance and bounded reduction ──────────────────────────────────
//
// The two properties the shipped curve exists to provide, neither of which the
// spec's §4.4 curve has. Both were found on a real file after the whole suite
// above was already green — the level sensitivity because the reporter asked
// whether an input trim would be principled, and the unboundedness because the
// first attempt at fixing the level sensitivity produced 29 dB of reduction on
// a stage whose job is 3-6.

test('the curve is exactly level-invariant: reduction depends only on excess over T', () => {
  // The property §3.3 claims the adaptive threshold buys, and which the
  // full-scale-anchored curve threw away. Swept over four decades of
  // threshold with the overshoot held constant.
  for (const overDb of [3, 6, 12, 17.6, 30]) {
    const reductions = [-6, -18, -30, -42, -60].map((tDb) => {
      const T = dbToLin(tDb)
      const x = T * dbToLin(overDb)
      return 20 * Math.log10(x / softClip(x, T))
    })
    const spread = Math.max(...reductions) - Math.min(...reductions)
    assert.ok(
      spread < 1e-9,
      `at ${overDb} dB over threshold, reduction varied by ${spread.toExponential(2)} dB across 54 dB of threshold`,
    )
  }
})

test('the spec-as-written curve is NOT level-invariant — the bug this replaced', () => {
  // Guard against a well-meaning revert to §4.4's form. Its (1-T) span
  // references digital full scale, so the same overshoot yields wildly
  // different reduction depending only on where the threshold sits.
  const specCurve = (x, T) => T + (1 - T) * Math.tanh((x - T) / (1 - T))
  const red = (tDb) => {
    const T = dbToLin(tDb)
    const x = T * dbToLin(17.6)
    return 20 * Math.log10(x / specCurve(x, T))
  }
  const loud = red(-6)
  const quiet = red(-42)
  assert.ok(loud - quiet > 10, `expected the old curve to collapse; got ${loud.toFixed(2)} vs ${quiet.toFixed(2)}`)
})

test('reduction is bounded by MAX_REDUCTION_DB however wrong the threshold is', () => {
  // Boundedness is a SAFETY property once the curve is level-invariant: with
  // reduction a function of x/T alone, a mis-tracked threshold is punished in
  // proportion. Measured on the reference clip during detector convergence, an
  // unbounded invariant curve produced 29 dB of reduction at t=0.46 s.
  for (const T of [0.001, 0.01, 0.126, 0.6]) {
    for (const overDb of [20, 40, 60, 90]) {
      const x = T * dbToLin(overDb)
      const reductionDb = 20 * Math.log10(x / softClip(x, T))
      assert.ok(
        reductionDb <= MAX_REDUCTION_DB + 1e-9,
        `T=${T}, ${overDb} dB over: ${reductionDb.toFixed(2)} dB exceeds the ${MAX_REDUCTION_DB} dB ceiling`,
      )
    }
  }
})

test('the detector warm-up keeps the threshold sane from the first sample', () => {
  // The valley follower snaps down instantly and fastRms starts at zero, so
  // without a warm-up the floor locks onto the filter's own start-up transient,
  // the gate treats near-silence as speech, and the tracker seeds from it.
  // Measured on the reference clip before the fix: T dived to -52 dBFS and took
  // ~10 s to climb out, which an unbounded curve turned into 29 dB of gain
  // reduction. T must never fall far below the seeded speech level.
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams({ headroomDb: 10, emphasisDb: 0 })
  const quietLeadIn = noise(0.4, dbToLin(-55))
  const speech = tone(200, 1.0, dbToLin(-20))
  const signal = concat(quietLeadIn, speech)
  const out = new Float32Array(signal.length)
  let minT = Infinity
  for (let off = 0; off < signal.length; off += 128) {
    const len = Math.min(128, signal.length - off)
    kernel.process([signal.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    minT = Math.min(minT, kernel.tScratch[len - 1])
  }
  const minTDb = 20 * Math.log10(minT)
  assert.ok(minTDb > -45, `threshold dived to ${minTDb.toFixed(1)} dBFS during start-up`)
})

// ── Selectivity: outliers only, not ordinary speech ─────────────────────────
//
// THE TESTS THAT WERE MISSING AGAIN, and the omission had the same shape as
// last time. The whole suite above passed against a build that shaped 4.4% of
// voiced samples and put residual above -40 dBc on a third of all voiced
// blocks — reported from listening on headphones as subtle distortion across
// the entire file, not on peaks. Nothing here asked "how MUCH of the signal is
// being touched", only "is the curve well-shaped" and "does it reduce peaks".
//
// The cause was that the threshold was RMS-referenced while being compared
// against SAMPLES. Every probe above is a sine (~3 dB crest), so none of them
// could expose it: it takes material with a realistic speech crest factor.
// Spec §8.3 names this failure exactly and prescribes the onset-excess
// histogram for it; that diagnostic was deferred as an offline exercise.

/**
 * A probe with a realistic speech crest factor (~14 dB), which a sine
 * (~3 dB) cannot provide. Syllable-shaped bursts of a few harmonics with
 * inter-syllable dips, amplitudes skewed so a few are much louder.
 */
function speechLike(seconds, peakAmp, seed = 11) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  let i = 0
  while (i < n) {
    const sylN = Math.round((0.08 + rnd() * 0.14) * SR)
    const gapN = Math.round((0.02 + rnd() * 0.06) * SR)
    const amp = peakAmp * (0.25 + 0.75 * rnd() * rnd())
    const f0 = 100 + rnd() * 60
    for (let j = 0; j < sylN && i < n; j++, i++) {
      const env = Math.sin((Math.PI * j) / sylN) ** 1.5
      const t = i / SR
      out[i] = (amp * env * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t)
        + 0.33 * Math.sin(6 * Math.PI * f0 * t) + 0.25 * Math.sin(8 * Math.PI * f0 * t))) / 2.08
    }
    for (let j = 0; j < gapN && i < n; j++, i++) out[i] = peakAmp * 0.002 * (rnd() - 0.5)
  }
  return out
}

/** Fraction of voiced samples the curve actually touches, past settling. */
function fractionTouched(signal, params) {
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams({ emphasisDb: 6, ...params })
  const out = new Float32Array(signal.length)
  let above = 0, voiced = 0
  for (let off = 0; off < signal.length; off += 128) {
    const len = Math.min(128, signal.length - off)
    kernel.process([signal.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    if (off < 2 * SR) continue
    for (let i = 0; i < len; i++) {
      const a = Math.abs(signal[off + i])
      if (a > 0.003) { voiced++; if (a > kernel.tScratch[i]) above++ }
    }
  }
  return above / voiced
}

test('the stage touches only a small fraction of ordinary speech samples', () => {
  // The property the distortion report was about. On material with a real
  // crest factor the default must shape a small minority of samples — if it
  // shapes several percent, that is waveshaping the programme, not taming
  // transients, and it is audible as broadband grit on headphones.
  const signal = speechLike(8, 0.5)
  const touched = fractionTouched(signal, {})
  assert.ok(
    touched < 0.02,
    `default settings touched ${(100 * touched).toFixed(2)}% of voiced samples; the reported build touched 4.4%`,
  )
})

test('an RMS-referenced threshold would fail that — the bug this replaced', () => {
  // Pins the mechanism rather than the symptom. The tracker follows a peak
  // envelope; against a signal with ~14 dB of crest, an RMS reference puts T
  // roughly a crest factor too low and the touched fraction explodes. Emulated
  // by asking for a threshold that much lower, which is what RMS-referencing
  // amounted to.
  const signal = speechLike(8, 0.5)
  const proper = fractionTouched(signal, {})
  const rmsLike = fractionTouched(signal, { headroomDb: 8 - 13 })
  assert.ok(
    rmsLike > 8 * proper,
    `an RMS-referenced threshold should touch far more: ${(100 * rmsLike).toFixed(2)}% vs ${(100 * proper).toFixed(2)}%`,
  )
})

test('but genuine outlier transients still get caught', () => {
  // The other half: selectivity is worthless if the stage now does nothing.
  // A plosive planted well above the surrounding syllables must still be
  // reduced, and by an amount inside the operating range §7.1 states.
  const body = speechLike(6, 0.3)
  const plosive = tone(120, 0.012, 0.95)
  const tail = speechLike(2, 0.3, 29)
  const signal = concat(body, plosive, tail)
  const { metering } = processSoftClipperBuffer([signal], SR, {})
  assert.ok(
    metering.maxReductionDb > 2,
    `a planted outlier should still be caught, got ${metering.maxReductionDb.toFixed(2)} dB`,
  )
  assert.ok(
    metering.maxReductionDb <= MAX_REDUCTION_DB + 1e-9,
    `and must stay under the ceiling, got ${metering.maxReductionDb.toFixed(2)} dB`,
  )
})

test('the tracked level is peak-referenced, not RMS-referenced', () => {
  // Direct check on the reference itself, which is the root cause the other
  // tests here only see the symptom of.
  //
  // An earlier version of this test asserted that a PEAKIER signal at matched
  // RMS raises the tracked level. That premise was wrong and measuring it said
  // so: the tracker follows a mean of the peak ENVELOPE, i.e. the TYPICAL
  // syllable peak, not the maximum. A signal built as a few loud syllables
  // among many quiet ones tracks 12 dB LOWER at the same RMS, and that is the
  // behaviour we want — T should sit above ordinary peaks so the rare loud
  // ones are precisely what becomes an outlier.
  //
  // The property that actually distinguishes the two references is simpler:
  // against material with a real crest factor, a peak-referenced tracker
  // settles well ABOVE the signal's RMS, where an RMS-referenced one settles
  // on it.
  const signal = speechLike(10, 0.45, 3)
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams({ headroomDb: 8, emphasisDb: 0 })
  const out = new Float32Array(signal.length)
  for (let off = 0; off < signal.length; off += 128) {
    const len = Math.min(128, signal.length - off)
    kernel.process([signal.subarray(off, off + len)], [out.subarray(off, off + len)], len)
  }
  let sumSq = 0, n = 0
  for (const x of signal) if (Math.abs(x) > 0.003) { sumSq += x * x; n++ }
  const voicedRmsDb = 20 * Math.log10(Math.sqrt(sumSq / n))
  const above = kernel.speechLevelDb - voicedRmsDb
  assert.ok(
    above > 3,
    `tracked level should sit well above voiced RMS; it is ${above.toFixed(2)} dB above `
    + `(${kernel.speechLevelDb.toFixed(1)} vs ${voicedRmsDb.toFixed(1)} dBFS). `
    + 'Near 0 would mean the tracker is RMS-referenced again.',
  )
})

// ── Cold start: no processing until the detector knows the level ────────────

test('a cold start does not over-process the opening of a file', () => {
  // Reported from listening: a second or so of distortion at the start of the
  // file, absent in fixed-threshold mode. Measured on the reference clip, the
  // opening 3 s saw 5.98 dB of reduction — the ceiling — against 3.17 dB for
  // the rest of the file, because the warm-up averaged a quiet lead-in and the
  // onset ramp of the first phrase and read the speech level 44 dB LOW, which
  // put T under everything.
  //
  // The property asserted is the FRACTION of early samples the curve touches,
  // not the reduction on any one of them. That is what separates the two
  // failures: the old build clipped essentially the whole opening (broadband
  // grit), while the fix processes almost none of it. A max-reduction
  // assertion would not distinguish "one caught transient" from "everything
  // clipped", and it is the second that was audible.
  const signal = concat(
    noise(0.5, dbToLin(-55)),        // room tone before anyone speaks
    speechLike(6, 0.5, 13),
  )
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams({ headroomDb: 8, emphasisDb: 6 })
  const out = new Float32Array(signal.length)
  let earlyAbove = 0, earlyVoiced = 0
  for (let off = 0; off + 128 < signal.length; off += 128) {
    kernel.process([signal.subarray(off, off + 128)], [out.subarray(off, off + 128)], 128)
    if (off / SR >= 2) continue
    for (let i = 0; i < 128; i++) {
      const a = Math.abs(signal[off + i])
      if (a > 0.003) { earlyVoiced++; if (a > kernel.tScratch[i]) earlyAbove++ }
    }
  }
  const touched = earlyVoiced > 0 ? earlyAbove / earlyVoiced : 0
  assert.ok(
    touched < 0.005,
    `the opening 2 s should be near-untouched; ${(100 * touched).toFixed(2)}% of its voiced samples were clipped`,
  )
})

test('the warm-up hold is released, not held forever', () => {
  // The other side of failing safe: a stage that never engages is also broken.
  // Pinned separately from the test above so a warm-up that never completes
  // cannot pass by making both halves quiet.
  const signal = concat(speechLike(6, 0.5, 71), tone(120, 0.015, 0.95), speechLike(1, 0.5, 5))
  const { metering } = processSoftClipperBuffer([signal], SR, { headroomDb: 8, emphasisDb: 0 })
  assert.ok(metering.maxReductionDb > 1, `warm-up never released: ${metering.maxReductionDb.toFixed(2)} dB`)
})

test('the scope pairs each peak with the threshold at that same sample', () => {
  // The scope's one job is to make crossings visible. That only works if the
  // peak it reports and the threshold it reports come from the SAME sample:
  // in adaptive mode T moves within a block, so pairing the block's loudest
  // sample with (say) the block's final T can draw a crossing that did not
  // happen, or hide one that did. Asserted against the kernel's own per-sample
  // threshold scratch rather than against a recomputed estimate.
  const signal = concat(speechLike(4, 0.6, 29), tone(120, 0.02, 0.95), speechLike(1, 0.5, 31))
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams({ headroomDb: 8, emphasisDb: 6 })
  const out = new Float32Array(signal.length)
  let checked = 0
  let crossings = 0
  for (let off = 0; off + 128 <= signal.length; off += 128) {
    kernel.process([signal.subarray(off, off + 128)], [out.subarray(off, off + 128)], 128)

    let want = 0
    let wantIdx = 0
    for (let i = 0; i < 128; i++) {
      const a = Math.abs(signal[off + i])
      if (a > want) { want = a; wantIdx = i }
    }
    assert.ok(
      Math.abs(kernel.scopePeak - want) < 1e-6,
      `scope peak ${kernel.scopePeak} != block peak ${want}`,
    )
    assert.equal(kernel.scopeThreshold, kernel.tScratch[wantIdx])
    if (kernel.scopePeak > kernel.scopeThreshold) crossings++
    checked++
  }
  assert.ok(checked > 100, 'not enough blocks to be a real check')
  // And it must actually report crossings on material the stage works on —
  // a scope that never draws one would pass every pairing assertion above.
  assert.ok(crossings > 0, 'the scope reported no crossing on material that clips')
})

test('the scope threshold starts above full scale, so warm-up draws no crossings', () => {
  // Failing safe has to be visible too: during warm-up the stage deliberately
  // processes nothing, and the display must show that rather than showing an
  // un-initialised threshold sitting at zero with everything above it.
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams({ headroomDb: 8, emphasisDb: 6 })
  const signal = concat(noise(0.3, dbToLin(-55)), speechLike(1, 0.5, 41))
  const out = new Float32Array(signal.length)
  for (let off = 0; off + 128 <= 0.25 * SR; off += 128) {
    kernel.process([signal.subarray(off, off + 128)], [out.subarray(off, off + 128)], 128)
    assert.ok(
      kernel.scopePeak <= kernel.scopeThreshold,
      `warm-up drew a crossing: peak ${kernel.scopePeak} over T ${kernel.scopeThreshold}`,
    )
  }
})

// ── DELTA monitoring and the ENGAGED readout ────────────────────────────────
//
// Both are new instrumentation rather than new processing, and both are the
// kind of thing that ships broken unnoticed: a monitor is only correct if the
// residual it plays is genuinely the difference, and a coverage figure is only
// useful if it moves with the control it sits beside.

/** Render a signal through a kernel, optionally monitoring the residual. */
function renderKernel(signal, params = {}, { monitorDelta = false } = {}) {
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams(params)
  if (monitorDelta) kernel.setMonitor(true)
  const out = new Float32Array(signal.length)
  for (let off = 0; off < signal.length; off += 128) {
    const len = Math.min(128, signal.length - off)
    kernel.process([signal.subarray(off, off + len)], [out.subarray(off, off + len)], len)
  }
  return { out, kernel }
}

test('DELTA plus the processed output reconstructs the input exactly', () => {
  // The guarantee that makes the monitor trustworthy: what you hear on DELTA
  // is precisely what the stage removed, with nothing else in it. The dry copy
  // is delayed by the oversampler's own group delay, so the sum lands on the
  // input shifted by that much rather than on the input itself — comparing
  // against the un-delayed original would fail for a reason that has nothing
  // to do with the residual.
  const signal = speechLike(3, 0.6, 23)
  const params = { headroomDb: 6, emphasisDb: 6 }
  const wet = renderKernel(signal, params).out
  const delta = renderKernel(signal, params, { monitorDelta: true }).out

  const D = SOFT_CLIPPER_LATENCY_SAMPLES
  let worst = 0
  for (let i = D; i < signal.length; i++) {
    const err = Math.abs(wet[i] + delta[i] - signal[i - D])
    if (err > worst) worst = err
  }
  assert.ok(worst < 1e-6, `delta + output did not reconstruct the input: worst error ${worst}`)
})

test("DELTA's floor is the oversampler, and clipping stands far above it", () => {
  // What the monitor plays when the stage does nothing is NOT digital silence,
  // and it is worth knowing why: the clip curve is bit-transparent below the
  // threshold, but the signal still makes a round trip through the 4x halfband
  // pair, whose reconstruction is not exact. Measured on this probe, with zero
  // blocks clipping, the residual sits at -79.9 dBFS peak / -97.0 rms. That is
  // the monitor's noise floor, it is inaudible, and it comes from the
  // oversampler rather than from anything the user set.
  //
  // Both ends are asserted on purpose. A monitor that simply output silence
  // would pass the quiet half on its own, which is exactly the bug this is
  // meant to catch.
  const signal = speechLike(8, 0.5, 11)
  const peakDb = (params) => {
    const delta = renderKernel(signal, params, { monitorDelta: true }).out
    let peak = 0
    for (let i = SOFT_CLIPPER_LATENCY_SAMPLES; i < delta.length; i++) {
      const a = Math.abs(delta[i])
      if (a > peak) peak = a
    }
    return 20 * Math.log10(peak)
  }

  // Headroom at the top of its range is effectively off — nothing crosses.
  const idle = peakDb({ headroomDb: 16, emphasisDb: 6 })
  // Headroom at the bottom is the aggressive end.
  const working = peakDb({ headroomDb: 4, emphasisDb: 6 })

  assert.ok(idle < -60, `residual on an untouched signal peaked at ${idle.toFixed(1)} dBFS`)
  assert.ok(working > -35, `residual on heavily clipped material only reached ${working.toFixed(1)} dBFS`)
  assert.ok(
    working - idle > 30,
    `residual barely moved between idle and working: ${idle.toFixed(1)} -> ${working.toFixed(1)} dBFS`,
  )
})

test('Output Trim scales the residual rather than leaking dry signal into it', () => {
  // The residual is taken before the trim and trimmed with everything else. If
  // it were taken after, a trim of -6 dB would add 6 dB of broadband DRY
  // signal to the difference and the monitor would stop being a monitor.
  const signal = speechLike(3, 0.6, 31)
  const base = renderKernel(signal, { headroomDb: 6, emphasisDb: 6, outputTrimDb: 0 }, { monitorDelta: true }).out
  const trimmed = renderKernel(signal, { headroomDb: 6, emphasisDb: 6, outputTrimDb: -6 }, { monitorDelta: true }).out

  let sumBase = 0, sumTrim = 0
  for (let i = SR; i < signal.length; i++) { sumBase += base[i] * base[i]; sumTrim += trimmed[i] * trimmed[i] }
  const ratioDb = 10 * Math.log10(sumTrim / sumBase)
  assert.ok(
    Math.abs(ratioDb + 6) < 0.2,
    `-6 dB of trim moved the residual by ${ratioDb.toFixed(2)} dB; a post-trim difference would read far higher`,
  )
})

test('monitoring is off by default and unreachable through the parameters', () => {
  // The structural guarantee behind setMonitor: applySoftClipperRegion spreads
  // a param object straight into the kernel, so a monitoring mode that could be
  // set from `params` would be one careless key away from rendering a
  // difference signal into someone's timeline.
  const kernel = new SoftClipperKernel(SR)
  assert.equal(kernel.monitorDelta, false)
  kernel.setParams({ monitorDelta: true, delta: true, monitor: 'delta' })
  assert.equal(kernel.monitorDelta, false, 'a monitoring mode was reachable through setParams')
})

test('the offline buffer path never monitors', () => {
  // processSoftClipperBuffer is what verification scripts render through, and
  // the app's apply path is its worklet equivalent. Neither may ever emit a
  // residual, whatever it is handed.
  const signal = speechLike(2, 0.6, 37)
  const viaBuffer = processSoftClipperBuffer([signal], SR, { headroomDb: 6, emphasisDb: 6, monitorDelta: true })
  const expected = renderKernel(signal, { headroomDb: 6, emphasisDb: 6 }).out
  let worst = 0
  for (let i = 0; i < signal.length; i++) {
    const err = Math.abs(viaBuffer.channelData[0][i] - expected[i])
    if (err > worst) worst = err
  }
  assert.equal(worst, 0, 'the offline path diverged from an unmonitored render')
})

/**
 * Highest ENGAGED reading over a render, past the detector's settling.
 *
 * The kernel's own field is a 2 s exponential average — correct for a live
 * readout, and a poor thing to assert on at the end of a file, where it
 * reports only the last couple of seconds and swings with whatever the passage
 * happened to be doing there. The peak over the render is the same quantity
 * measured stably.
 */
function peakEngaged(signal, params) {
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams({ emphasisDb: 6, ...params })
  const out = new Float32Array(signal.length)
  let peak = 0
  for (let off = 0; off < signal.length; off += 128) {
    const len = Math.min(128, signal.length - off)
    kernel.process([signal.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    if (off >= 2 * SR && kernel.engagedFraction > peak) peak = kernel.engagedFraction
  }
  return peak
}

test('ENGAGED rises as Headroom falls, and reads zero when the stage is off', () => {
  // The readout exists because peak reduction cannot distinguish "idle" from
  // "working quietly" — the blocks that clip take a median of 0.3-0.4 dB. So
  // the property that matters is that this number MOVES with the control the
  // dB meter barely responds to. Measured on this probe: 0% / 0.6% / 2.6% /
  // 4.7% across Headroom 16 / 8 / 6 / 4.
  const signal = speechLike(8, 0.5, 11)

  const off = peakEngaged(signal, { headroomDb: 16 })
  const gentle = peakEngaged(signal, { headroomDb: 8 })
  const hard = peakEngaged(signal, { headroomDb: 4 })

  assert.equal(off, 0, `Headroom 16 should be effectively off; engaged read ${(100 * off).toFixed(2)}%`)
  assert.ok(gentle > 0, `engaged stayed at zero at Headroom 8, where the curve does engage`)
  assert.ok(
    hard > gentle,
    `engaged did not rise from Headroom 8 (${(100 * gentle).toFixed(2)}%) to 4 (${(100 * hard).toFixed(2)}%)`,
  )
  assert.ok(hard <= 1, `engaged is a fraction and read ${hard}`)
})

test('ENGAGED ignores silence, so it measures the setting and not the pauses', () => {
  // Averaged over voiced blocks only. Padding a passage with silence must not
  // change the reading — otherwise the number tracks how slowly someone reads.
  const voiced = speechLike(6, 0.5, 47)
  const padded = concat(noise(3, dbToLin(-70), SR, 5), voiced, noise(3, dbToLin(-70), SR, 6))
  const a = renderKernel(voiced, { headroomDb: 6, emphasisDb: 6 }).kernel.engagedFraction
  const b = renderKernel(padded, { headroomDb: 6, emphasisDb: 6 }).kernel.engagedFraction
  assert.ok(
    Math.abs(a - b) < 0.15,
    `silence padding moved engaged from ${(100 * a).toFixed(1)}% to ${(100 * b).toFixed(1)}%`,
  )
})

// ── Knee shapes (SELECTIVITY: tanh^2 / tanh^3 / tanh^4) ─────────────────────

const SHAPES = Object.keys(SHAPE_EXPONENT)

test('every shape is still exactly bit-transparent below the threshold', () => {
  // The one guarantee that must survive any curve change: material that never
  // reaches T is untouched, sample for sample. This is what separates the
  // architecture from a plain tanh waveshaper, and adding shapes must not
  // quietly cost it on one of them.
  const T = 0.25
  for (const shape of SHAPES) {
    const n = SHAPE_EXPONENT[shape]
    for (let i = 0; i <= 2000; i++) {
      const x = -T + (2 * T * i) / 2000
      assert.equal(softClip(x, T, MAX_REDUCTION_DB, KNEE_DB, n), x,
        `${shape} altered a below-threshold sample at x=${x}`)
    }
  }
})

test('every shape is monotonic at the shipped KNEE_DB', () => {
  // Non-monotonic means the transfer curve folds: a louder input producing a
  // quieter output, which is the one failure mode here that sounds like
  // destruction rather than colour. Swept across four decades of threshold
  // because the curve is level-invariant and a bug could hide at one scale.
  for (const shape of SHAPES) {
    const n = SHAPE_EXPONENT[shape]
    for (const T of [0.002, 0.02, 0.2, 0.9]) {
      let prev = -Infinity
      for (let i = 0; i <= 20000; i++) {
        const x = (i / 20000) * 1.5
        const y = softClip(x, T, MAX_REDUCTION_DB, KNEE_DB, n)
        assert.ok(y >= prev, `${shape} folded at T=${T}, x=${x}: ${y} < ${prev}`)
        prev = y
      }
    }
  }
})

test('the recorded monotonicity bounds are the real ones, per shape', () => {
  // SHAPE_MIN_KNEE_DB is quoted in the kernel's shape table as the reason the
  // smoothstep family was rejected and the tanh family accepted. If those
  // numbers are wrong the rejection was wrong, so they are checked from both
  // sides rather than taken on trust: a hair above each bound must be
  // monotonic and a hair below must not.
  const foldsAt = (n, kneeDb) => {
    const T = 0.1
    let prev = -Infinity
    for (let i = 0; i <= 40000; i++) {
      const y = softClip((i / 40000) * 1.2, T, MAX_REDUCTION_DB, kneeDb, n)
      if (y < prev - 1e-12) return true
      prev = y
    }
    return false
  }
  for (const shape of SHAPES) {
    const n = SHAPE_EXPONENT[shape]
    const bound = SHAPE_MIN_KNEE_DB[shape]
    assert.ok(!foldsAt(n, bound * 1.01), `${shape} folds above its stated bound ${bound}`)
    assert.ok(foldsAt(n, bound * 0.97), `${shape} does not fold below its stated bound ${bound}`)
    assert.ok(bound < KNEE_DB, `${shape} is not usable at the shipped KNEE_DB ${KNEE_DB}`)
  }
})

test('higher shapes spend proportionally more of the budget on the big peaks', () => {
  // This is the whole point of the control, and it is a RATIO so it holds at
  // any knee: what fraction of the reduction a deep transient gets is also
  // applied to something only just over the line. Falling means the stage is
  // getting more selective, which is what "transparency" means here — the
  // near-threshold material is ordinary speech.
  const T = 0.25
  const at = (n, excessDb) => {
    const x = T * dbToLin(excessDb)
    return -20 * Math.log10(softClip(x, T, MAX_REDUCTION_DB, KNEE_DB, n) / x)
  }
  const ratios = SHAPES.map(shape => {
    const n = SHAPE_EXPONENT[shape]
    return at(n, 3) / at(n, 12)
  })
  for (let i = 1; i < ratios.length; i++) {
    assert.ok(ratios[i] < ratios[i - 1] * 0.75,
      `${SHAPES[i]} is not meaningfully more selective than ${SHAPES[i - 1]}: ` +
      `${ratios.map(r => r.toFixed(4)).join(' -> ')}`)
  }
  // And the ordering must not come from simply doing less overall — every
  // shape still reaches real depth on a genuine outlier.
  for (const shape of SHAPES) {
    assert.ok(at(SHAPE_EXPONENT[shape], 12) > 4,
      `${shape} barely works on a +12 dB peak: ${at(SHAPE_EXPONENT[shape], 12).toFixed(2)} dB`)
  }
})

test('every shape keeps level invariance and the reduction bound', () => {
  // Both properties are structural rather than calibrated, so a new exponent
  // cannot break them by arithmetic — but the exponent is applied by hand-
  // unrolled multiplies, and a misplaced one would show up here.
  for (const shape of SHAPES) {
    const n = SHAPE_EXPONENT[shape]
    const excessDb = 9
    let first = null
    for (const T of [0.001, 0.01, 0.1, 0.5]) {
      const x = T * dbToLin(excessDb)
      const red = -20 * Math.log10(softClip(x, T, MAX_REDUCTION_DB, KNEE_DB, n) / x)
      if (first === null) first = red
      assert.ok(Math.abs(red - first) < 1e-9, `${shape} is not level-invariant at T=${T}`)
    }
    // Bound: even a threshold 60 dB too low cannot cost more than the cap.
    const worst = -20 * Math.log10(softClip(0.9, 0.0009, MAX_REDUCTION_DB, KNEE_DB, n) / 0.9)
    assert.ok(worst <= MAX_REDUCTION_DB + 1e-9,
      `${shape} exceeded the reduction bound: ${worst.toFixed(3)} dB`)
  }
})

test('the shape reaches the kernel, and an unknown value fails safe', () => {
  // End-to-end rather than through softClip alone: the exponent is resolved
  // from a string once per process() call, and a lookup that silently missed
  // would leave the panel switch doing nothing at all.
  const signal = concat(speechLike(4, 0.6, 53), tone(120, 0.02, 0.95), speechLike(1, 0.5, 59))
  const run = (shape) => processSoftClipperBuffer([signal], SR, { headroomDb: 8, emphasisDb: 6, shape })
  const base = run('tanh2').channelData[0]
  const tight = run('tanh4').channelData[0]
  let diff = 0
  for (let i = 0; i < base.length; i++) diff = Math.max(diff, Math.abs(base[i] - tight[i]))
  assert.ok(diff > 1e-5, `tanh4 produced the same audio as tanh2 (max diff ${diff})`)

  // A bad param must not throw on the audio thread, and must not process with
  // some accidental exponent — it falls back to the shipped shape exactly.
  const bogus = run('not-a-shape').channelData[0]
  for (let i = 0; i < base.length; i++) {
    assert.equal(bogus[i], base[i], `unknown shape did not fall back to tanh2 at sample ${i}`)
  }
})

test('the default shape is bit-identical to the curve before shapes existed', () => {
  // The regression guard for the whole change: adding a switch must not move
  // anyone who never touches it. tanh^2 with the exponent path in place has
  // to equal the two-multiply form it replaced, exactly.
  const T = 0.2
  for (let i = 0; i <= 5000; i++) {
    const x = -1.2 + (2.4 * i) / 5000
    const ax = Math.abs(x)
    let want = x
    if (ax > T) {
      const t = Math.tanh((20 * Math.log10(ax / T)) / KNEE_DB)
      const y = ax * Math.exp(-MAX_REDUCTION_DB * t * t * (Math.LN10 / 20))
      want = x < 0 ? -y : y
    }
    assert.equal(softClip(x, T, MAX_REDUCTION_DB, KNEE_DB, 2), want)
  }
})

test('at a fixed Headroom, higher shapes do strictly less on both axes', () => {
  // The claim the panel actually makes, pinned end-to-end rather than on the
  // curve alone: at the SAME setting, raising the shape touches fewer samples
  // AND takes less off each one. Measured this way round because the reverse
  // reading -- matching the depth by winding Headroom down -- reverses the
  // sample-count ordering on real audio, and a test asserting the wrong one of
  // those two would enshrine the framing that measurement overturned. See the
  // shape table in the kernel for both.
  const signal = concat(
    speechLike(5, 0.5, 97),
    tone(120, 0.02, 0.95),
    speechLike(2, 0.5, 101),
  )
  const stats = SHAPES.map(shape => {
    const out = processSoftClipperBuffer([signal], SR, { headroomDb: 6, emphasisDb: 0, shape }).channelData[0]
    const ref = processSoftClipperBuffer([signal], SR, { headroomDb: 60, emphasisDb: 0, shape }).channelData[0]
    let touched = 0, voiced = 0, sum = 0
    for (let i = 0; i < signal.length; i++) {
      const a = Math.abs(ref[i])
      if (a < 0.005) continue
      voiced++
      const d = 20 * Math.log10(a / Math.max(Math.abs(out[i]), 1e-12))
      if (d > 0.02) { touched++; sum += d }
    }
    return { shape, frac: touched / voiced, mean: touched ? sum / touched : 0 }
  })
  assert.ok(stats[0].frac > 0, 'the probe never engaged the stage at all')
  for (let i = 1; i < stats.length; i++) {
    assert.ok(stats[i].frac < stats[i - 1].frac,
      `${stats[i].shape} touched more samples than ${stats[i - 1].shape}: ` +
      stats.map(s => `${s.shape} ${(100 * s.frac).toFixed(3)}%`).join(', '))
    assert.ok(stats[i].mean < stats[i - 1].mean,
      `${stats[i].shape} took more off each sample than ${stats[i - 1].shape}: ` +
      stats.map(s => `${s.shape} ${s.mean.toFixed(3)} dB`).join(', '))
  }
})
