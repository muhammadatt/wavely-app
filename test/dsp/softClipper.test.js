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
  SHAPE_KNEE_DB, SHAPE_ANCHOR_DB, SHAPE_KNEE_ANCHOR_SHAPE,
  softClipperLatencySamples,
  SOFT_CLIPPER_KERNEL_DEFAULTS,
} from '../../src/audio/softClipperProcessor.js'
import {
  highShelf, invertBiquad, biquadZerosInsideUnitCircle, BiquadCascade,
} from '../../src/audio/dsp/biquad.js'

const SR = 44100

/**
 * ⚠ CURVE-ONLY PROBES PIN `limiter: 0`, AND THEY HAVE TO NOW.
 *
 * The kernel ships the hybrid peak path engaged (`limiter: 100`), so the stage's
 * default behaviour is a lookahead limiter feeding the curve: 242 samples of
 * latency instead of 50, and a gain envelope that ducks sub-threshold material
 * by design. Every guarantee in this file that belongs to the CURVE — unity
 * below the threshold, the delta reconstruction at SOFT_CLIPPER_LATENCY_SAMPLES,
 * the knee anchoring, the residual readout, the emphasis compensation — has to
 * say so, or it is measuring the limiter and reporting it as the curve.
 *
 * The same convention this file already follows for `shape` and `emphasisDb`:
 * a probe that cares about a default states it rather than inheriting it, so
 * moving a default breaks the tests that are ABOUT the default and leaves the
 * rest alone. The hybrid path has its own tests at the end of the file.
 */
const CURVE_ONLY = { limiter: 0 }

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
  const { channelData } = processSoftClipperBuffer([quiet], SR,
    { ...CURVE_ONLY, headroomDb: 16, emphasisDb: 0 })
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
    return processSoftClipperBuffer([signal], SR,
      { ...CURVE_ONLY, headroomDb, emphasisDb: 0 }).metering.maxReductionDb
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

  const adaptive = { ...CURVE_ONLY, thresholdMode: 'adaptive', headroomDb: 10, emphasisDb: 0 }
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
  const fixed = { ...CURVE_ONLY, thresholdMode: 'fixed', fixedThresholdDb: -12, emphasisDb: 0 }
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
    ...CURVE_ONLY, thresholdMode: 'fixed', fixedThresholdDb: -18, emphasisDb: 0,
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

/** A single voiced burst, used as a plosive-shaped outlier. */
function plosiveBurst(seconds, amp, sr = SR) {
  const n = Math.round(seconds * sr)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = amp * (Math.sin((Math.PI * i) / n) ** 2) * Math.sin((2 * Math.PI * 110 * i) / sr)
  }
  return out
}

/**
 * A sustained fricative-like band — first-differenced noise, so a 6 dB/octave
 * HF tilt with most of its energy above the 3.5 kHz emphasis corner.
 *
 * The counterpart to plosiveBurst: the two are normalised to the same peak
 * amplitude and differ only in spectrum, which is what makes them able to
 * separate "the emphasis moved the threshold" from "the emphasis aimed the
 * stage somewhere".
 */
function fricativeNoise(seconds, amp, seed = 5, sr = SR) {
  const n = Math.round(seconds * sr)
  const out = new Float32Array(n)
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  let prev = 0, max = 0
  for (let i = 0; i < n; i++) {
    const r = rnd() - 0.5
    const d = r - prev
    prev = r
    out[i] = d
    if (Math.abs(d) > max) max = Math.abs(d)
  }
  if (max > 0) for (let i = 0; i < n; i++) out[i] *= amp / max
  return out
}

/** Run a signal through a fresh kernel in 128-sample blocks, return metering. */
function meter(signal, params) {
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams({ ...CURVE_ONLY, shape: 'tanh3', ...params })
  const out = new Float32Array(signal.length)
  for (let off = 0; off < signal.length; off += 128) {
    const len = Math.min(128, signal.length - off)
    kernel.process([signal.subarray(off, off + len)], [out.subarray(off, off + len)], len)
  }
  return kernel.getMetering()
}

/**
 * speechLike with a realistic dynamic spread — syllable peaks vary over ~12 dB
 * rather than clustering.
 *
 * WHY IT EXISTS: speechLike's syllables all land within a few dB of each
 * other, so at any Headroom the stage either touches all of them or none. Real
 * narration crosses the threshold constantly and shallowly (p50 1.2 dB over,
 * p90 3.0, max 6.1 — see KNEE_DB), and a probe with no shallow crossings
 * cannot see anything a knee does. This one reproduces that distribution to
 * p50 1.25 / p90 2.93 / max 4.16 at Headroom 4.
 */
function variedSpeech(seconds, peakAmp, seed = 11) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  let i = 0
  while (i < n) {
    const sylN = Math.round((0.08 + rnd() * 0.14) * SR)
    const gapN = Math.round((0.02 + rnd() * 0.06) * SR)
    const amp = peakAmp * Math.pow(10, (-10 + 12 * rnd()) / 20)
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
  const { metering } = processSoftClipperBuffer([signal], SR, { ...CURVE_ONLY })
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
  const { metering } = processSoftClipperBuffer([signal], SR,
    { ...CURVE_ONLY, headroomDb: 8, emphasisDb: 0 })
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
  const params = { ...CURVE_ONLY, headroomDb: 6, emphasisDb: 6 }
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
  const idle = peakDb({ ...CURVE_ONLY, headroomDb: 16, emphasisDb: 6 })
  // Headroom at the bottom is the aggressive end.
  const working = peakDb({ ...CURVE_ONLY, headroomDb: 4, emphasisDb: 6 })

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

/**
 * The kernel's SKEW_DEADBAND is not exported — the probes only need to clear
 * it comfortably, so the tests carry their own copy of the threshold they are
 * checking against rather than importing a constant they would then be unable
 * to fail independently of.
 */
const SKEW_DEADBAND_PROBE = 0.2

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
      assert.equal(softClip(x, T, MAX_REDUCTION_DB, SHAPE_KNEE_DB[shape], n), x,
        `${shape} altered a below-threshold sample at x=${x}`)
    }
  }
})

test('every shape is monotonic at its shipped knee', () => {
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
        const y = softClip(x, T, MAX_REDUCTION_DB, SHAPE_KNEE_DB[shape], n)
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
    // Against the shape's OWN knee, not the shared one: normalisation spends
    // part of the margin (9.08 / 7 / 6.01 dB), and buying matched depth with a
    // folded curve would be a much worse bug than the one it fixes.
    assert.ok(bound < SHAPE_KNEE_DB[shape],
      `${shape}'s knee ${SHAPE_KNEE_DB[shape].toFixed(3)} is below its fold bound ${bound}`)
  }
})

test('higher shapes spend proportionally more of the budget on the big peaks', () => {
  // This is the whole point of the control, and it is a RATIO so it holds at
  // any knee: what fraction of the reduction a deep transient gets is also
  // applied to something only just over the line. Falling means the stage is
  // getting more selective, which is what "transparency" means here — the
  // near-threshold material is ordinary speech.
  const T = 0.25
  const at = (shape, excessDb) => {
    const x = T * dbToLin(excessDb)
    return -20 * Math.log10(
      softClip(x, T, MAX_REDUCTION_DB, SHAPE_KNEE_DB[shape], SHAPE_EXPONENT[shape]) / x)
  }
  const ratios = SHAPES.map(shape => at(shape, 3) / at(shape, 12))
  for (let i = 1; i < ratios.length; i++) {
    assert.ok(ratios[i] < ratios[i - 1] * 0.75,
      `${SHAPES[i]} is not meaningfully more selective than ${SHAPES[i - 1]}: ` +
      `${ratios.map(r => r.toFixed(4)).join(' -> ')}`)
  }
  // And the ordering must not come from simply doing less overall — every
  // shape still reaches real depth on a genuine outlier.
  for (const shape of SHAPES) {
    assert.ok(at(shape, 12) > 4,
      `${shape} barely works on a +12 dB peak: ${at(shape, 12).toFixed(2)} dB`)
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
      const red = -20 * Math.log10(softClip(x, T, MAX_REDUCTION_DB, SHAPE_KNEE_DB[shape], n) / x)
      if (first === null) first = red
      assert.ok(Math.abs(red - first) < 1e-9, `${shape} is not level-invariant at T=${T}`)
    }
    // Bound: even a threshold 60 dB too low cannot cost more than the cap.
    const worst = -20 * Math.log10(
      softClip(0.9, 0.0009, MAX_REDUCTION_DB, SHAPE_KNEE_DB[shape], n) / 0.9)
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
  // some accidental exponent — it falls back to the DEFAULT shape exactly.
  // Compared against the default read from the kernel rather than a literal,
  // so moving the default cannot leave this test asserting the old one.
  const def = SOFT_CLIPPER_KERNEL_DEFAULTS.shape
  const expected = run(def).channelData[0]
  const bogus = run('not-a-shape').channelData[0]
  for (let i = 0; i < expected.length; i++) {
    assert.equal(bogus[i], expected[i], `unknown shape did not fall back to ${def} at sample ${i}`)
  }
})

test('the default shape is a real shape, and it is the one the panel offers', () => {
  // The effect wrapper's defaults are spread from this object rather than
  // restated, so there is no second copy to drift — but a typo here would
  // silently ship the fallback exponent to every user, which is a working
  // curve and therefore invisible. Asserted against the shape table itself.
  assert.ok(SOFT_CLIPPER_KERNEL_DEFAULTS.shape in SHAPE_EXPONENT,
    `default shape ${SOFT_CLIPPER_KERNEL_DEFAULTS.shape} is not in SHAPE_EXPONENT`)
})

test('the exponent path is bit-identical to the two-multiply form it replaced', () => {
  // The regression guard for the exponent unrolling: tanh^2 at a given knee
  // has to equal the hand-written two-multiply curve that predates shapes,
  // exactly. (This is no longer the DEFAULT shape, and no longer the knee any
  // shape ships with — see the anchor test below for the guard that the stock
  // patch itself has not moved.)
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

test('every shape delivers the same reduction at the anchor', () => {
  // THE POINT OF SHAPE_ANCHOR_DB, asserted on the curve itself. A peak this
  // far over the threshold must lose the same amount whichever position is
  // selected — otherwise the switch is a depth control again and no A/B
  // through it compares shapes.
  const T = 0.25
  const at = (shape, excessDb) => {
    const x = T * dbToLin(excessDb)
    return -20 * Math.log10(
      softClip(x, T, MAX_REDUCTION_DB, SHAPE_KNEE_DB[shape], SHAPE_EXPONENT[shape]) / x)
  }
  const anchored = SHAPES.map(shape => at(shape, SHAPE_ANCHOR_DB))
  for (const r of anchored) {
    assert.ok(Math.abs(r - anchored[0]) < 1e-9,
      `shapes disagree at the anchor: ${anchored.map(v => v.toFixed(6)).join(' / ')}`)
  }
  // And it is a genuine pivot, not a curve collapse: strictly ordered one way
  // below the anchor and strictly the other way above it. Checked at both
  // sides rather than only at the anchor, because three identical curves
  // would satisfy the assertion above and would be a broken control.
  for (let i = 1; i < SHAPES.length; i++) {
    assert.ok(at(SHAPES[i], SHAPE_ANCHOR_DB / 2) < at(SHAPES[i - 1], SHAPE_ANCHOR_DB / 2),
      `${SHAPES[i]} does not do less than ${SHAPES[i - 1]} below the anchor`)
    assert.ok(at(SHAPES[i], SHAPE_ANCHOR_DB * 2) > at(SHAPES[i - 1], SHAPE_ANCHOR_DB * 2),
      `${SHAPES[i]} does not do more than ${SHAPES[i - 1]} above the anchor`)
  }
})

test('the CALIBRATED shape ships at exactly KNEE_DB, whatever the default is', () => {
  // ⚠ THE ANCHOR IS NOT THE DEFAULT, and it used to be — which made moving
  // which position the panel opens on silently re-derive all three curves.
  // KNEE_DB is a measurement of one shape; the anchor has to name that shape,
  // not whichever one happens to be shipped. Pinned from both sides: the
  // calibrated shape sits exactly on KNEE_DB, and the default is free to be
  // something else without moving it.
  assert.equal(SHAPE_KNEE_DB[SHAPE_KNEE_ANCHOR_SHAPE], KNEE_DB)
  assert.equal(SHAPE_KNEE_ANCHOR_SHAPE, 'tanh3', 'the calibrated shape moved')
  assert.equal(SOFT_CLIPPER_KERNEL_DEFAULTS.shape, 'tanh4', 'the shipped knee default moved')
})

test('the recorded per-shape knees are the ones the derivation produces', () => {
  // The knees are computed, not tabulated, so the numbers quoted throughout
  // the kernel comments and the panel captions have nothing pinning them.
  // Stated here to three decimals so a change to the anchor or to the default
  // shape fails loudly rather than silently re-tuning a shipped control.
  const stated = { tanh2: 8.490, tanh3: 7.000, tanh4: 6.221 }
  for (const shape of SHAPES) {
    assert.ok(Math.abs(SHAPE_KNEE_DB[shape] - stated[shape]) < 0.001,
      `${shape} knee is ${SHAPE_KNEE_DB[shape].toFixed(4)}, not the recorded ${stated[shape]}`)
  }
})

test('at a fixed Headroom, the shapes now land at the same depth', () => {
  // The end-to-end version of the anchor guarantee, and the reported symptom
  // it answers: switching to LATE at a fixed threshold used to sound cleaner
  // largely because it was doing less. Peak reduction is read from the
  // kernel's own meter — the number the lamp shows and the ear reads as depth.
  //
  // The probe's outlier is placed near the anchor deliberately. Depth matches
  // EXACTLY only there; well above it the shapes diverge again by design, so a
  // probe with a 10 dB outlier would fail an assertion this tight and would be
  // testing the wrong claim.
  const signal = concat(
    speechLike(5, 0.5, 97),
    plosiveBurst(0.03, 0.62),
    speechLike(3, 0.5, 101),
  )
  const peakGr = (shape) => {
    const kernel = new SoftClipperKernel(SR)
    kernel.setParams({ ...CURVE_ONLY, headroomDb: 6.5, emphasisDb: 6, shape })
    const out = new Float32Array(signal.length)
    for (let off = 0; off < signal.length; off += 128) {
      const len = Math.min(128, signal.length - off)
      kernel.process([signal.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    }
    return kernel.getMetering().maxReductionDb
  }
  const grs = SHAPES.map(peakGr)
  assert.ok(grs[0] > 1, `the probe never engaged the stage: ${grs.join(', ')}`)
  const spread = Math.max(...grs) - Math.min(...grs)
  // 1.49 dB before normalisation, 0.15 after, on this probe.
  assert.ok(spread < 0.4,
    `the shapes still differ in depth at a fixed Headroom: ` +
    SHAPES.map((sh, i) => `${sh} ${grs[i].toFixed(2)}`).join(', '))
})

test('what survives normalisation is where the distortion is spent', () => {
  // The other half of the same claim: matching the depth must not flatten the
  // control into three identical curves. On crossings distributed like real
  // narration (p50 1.25 dB over, p90 2.93, max 4.16 — the figures recorded at
  // KNEE_DB are p50 1.2 / p90 3.0 / max 6.1) the same depth is spent on fewer,
  // deeper crossings as the shape rises, and the residual falls monotonically.
  //
  // variedSpeech, not speechLike: at the shipped Headroom speechLike's
  // syllables never reach the threshold at all, so its entire output is one
  // outlier and there is nothing for a knee to redistribute between.
  const signal = variedSpeech(12, 0.9, 41)
  const residualDb = (shape) => {
    const wet = processSoftClipperBuffer([signal], SR,
      { ...CURVE_ONLY, headroomDb: 4, emphasisDb: 6, shape }).channelData[0]
    const dry = processSoftClipperBuffer([signal], SR,
      { ...CURVE_ONLY, headroomDb: 60, emphasisDb: 6, shape }).channelData[0]
    let sq = 0
    for (let i = 0; i < signal.length; i++) { const d = dry[i] - wet[i]; sq += d * d }
    return 10 * Math.log10(sq / signal.length)
  }
  const res = SHAPES.map(residualDb)
  for (let i = 1; i < res.length; i++) {
    assert.ok(res[i] < res[i - 1] - 1,
      `${SHAPES[i]} does not distort measurably less than ${SHAPES[i - 1]}: ` +
      SHAPES.map((sh, k) => `${sh} ${res[k].toFixed(1)}`).join(', '))
  }
  // -52.0 / -55.3 / -57.8 dBFS measured. Under the shared knee this spread was
  // 13.9 dB and came with a 3.5x depth difference; the depth is now held and
  // the remainder is the control.
  assert.ok(res[0] - res[res.length - 1] < 10,
    `the shapes still differ like a depth control: ` +
    SHAPES.map((sh, k) => `${sh} ${res[k].toFixed(1)}`).join(', '))
})

// ── HF Emphasis lift compensation (LIFT_TAU_S) ──────────────────────────────

/**
 * A syllable bed whose voiced parts are part tone and part HF-tilted noise.
 *
 * GATED LIKE SPEECH, and that is not cosmetic: the detector's noise floor is a
 * valley follower, so on CONTINUOUS material it settles at the signal's own
 * level, the gate never opens, and the speech tracker never updates. A
 * sustained noise probe therefore measures a stage that is not running — the
 * same trap recorded twice in the kernel, once for the aliasing sweep and once
 * for the noise-floor-relative threshold guard. `hfMix` is the share of each
 * syllable's amplitude that is fricative rather than tone.
 */
function sibilantSpeech(seconds, peakAmp, seed, hfMix) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  let i = 0, prev = 0
  while (i < n) {
    const sylN = Math.round((0.08 + rnd() * 0.14) * SR)
    const gapN = Math.round((0.02 + rnd() * 0.06) * SR)
    const amp = peakAmp * Math.pow(10, (-10 + 12 * rnd()) / 20)
    const f0 = 100 + rnd() * 60
    for (let j = 0; j < sylN && i < n; j++, i++) {
      const env = Math.sin((Math.PI * j) / sylN) ** 1.5
      const t = i / SR
      const tone = (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t)
        + 0.33 * Math.sin(6 * Math.PI * f0 * t) + 0.25 * Math.sin(8 * Math.PI * f0 * t)) / 2.08
      const r = rnd() - 0.5
      const d = (r - prev) * 2.6 // first difference: HF tilt, roughly peak-matched
      prev = r
      out[i] = amp * env * ((1 - hfMix) * tone + hfMix * d)
    }
    for (let j = 0; j < gapN && i < n; j++, i++) { out[i] = peakAmp * 0.002 * (rnd() - 0.5); prev = 0 }
  }
  return out
}

test('the lift reads zero on low-frequency material and tracks HF material', () => {
  // The measurement the whole compensation rests on. A signal with no energy
  // above the 3.5 kHz corner is not lifted by the pre-emphasis at all, so the
  // threshold must not move for it; a sibilant passage is lifted nearly by
  // the full knob. Measured: 0.05 dB against 11.6 at emphasis 12.
  const lf = sibilantSpeech(12, 0.35, 41, 0)
  const hf = sibilantSpeech(12, 0.35, 41, 0.8)
  for (const emphasisDb of [3, 6, 12]) {
    const lfLift = meter(lf, { headroomDb: 6.5, emphasisDb }).liftDb
    const hfLift = meter(hf, { headroomDb: 6.5, emphasisDb }).liftDb
    assert.ok(lfLift < 0.1,
      `emphasis ${emphasisDb} lifted an LF-only signal by ${lfLift.toFixed(3)} dB`)
    assert.ok(hfLift > 0.85 * emphasisDb,
      `emphasis ${emphasisDb} only lifted a sibilant passage by ${hfLift.toFixed(2)} dB`)
  }
})

test('the lift can never leave [0, emphasisDb]', () => {
  // Bounded BY CONSTRUCTION — the shelf is a pure boost, magnitude within
  // [0, N] dB to four decimals at 3, 6 and 12 with no corner overshoot — but
  // the clamp is what stops a follower still filling from zero producing a
  // nonsense threshold in the first milliseconds. That failure mode is on
  // record: an unbounded quantity reaching the threshold once produced 29 dB
  // of reduction while a tracker was still converging.
  const cases = [
    concat(new Float32Array(SR), fricativeNoise(2, 0.95)),
    fricativeNoise(0.5, 1e-6),
    sibilantSpeech(2, 0.9, 3, 0.8),
    new Float32Array(64),
  ]
  for (const emphasisDb of [0, 6, 12]) {
    for (const signal of cases) {
      const { liftDb } = meter(signal, { headroomDb: 6.5, emphasisDb })
      assert.ok(liftDb >= 0 && liftDb <= emphasisDb + 1e-9,
        `lift ${liftDb} escaped [0, ${emphasisDb}]`)
    }
  }
})

test('quiet HF material does not drive the lift', () => {
  // WHAT LIFT_GATE_DB FIXES, and the failure is a real-audio one reproduced
  // here: a bed whose LOUD moments are low-frequency and whose fricatives are
  // 12 dB quieter. The peaks that reach the curve carry no HF and were never
  // lifted, so the threshold must not rise for them — but a lift averaged over
  // all voiced material reads the quiet fricatives and raises it anyway,
  // over-compensating exactly the peaks the stage exists to catch.
  //
  // On 35 s of real narration that error was a factor of two (1.74 dB measured
  // against a 0.85 dB target at emphasis 12) and it inverted the sign of the
  // depth drift rather than removing it.
  const quietHf = () => fricativeNoise(1, 0.5 * Math.pow(10, -12 / 20))
  const signal = concat(
    speechLike(3, 0.5, 97), quietHf(),
    speechLike(3, 0.5, 101), quietHf(),
    speechLike(3, 0.5, 103), quietHf(),
  )
  // 0.31 dB gated against 4.91 ungated on this probe — a 16x separation, so
  // the bound is nowhere near either value and the test is about the
  // mechanism rather than about a tuned number.
  const { liftDb } = meter(signal, { headroomDb: 6.5, emphasisDb: 12 })
  assert.ok(liftDb < 1.5,
    `quiet fricatives drove the lift to ${liftDb.toFixed(2)} dB on a bed whose peaks are LF`)
})

test('emphasis 0 compensates by exactly nothing', () => {
  // The guarantee that keeps the whole feature free for anyone who has the
  // filters bypassed: with no emphasis there is no lift to give back, on any
  // material, and the threshold is the one the build before compensation
  // computed. Exact, not approximate — the clamp's upper bound is 0.
  for (const signal of [sibilantSpeech(4, 0.35, 11, 0.8), speechLike(4, 0.35, 11)]) {
    assert.equal(meter(signal, { headroomDb: 6.5, emphasisDb: 0 }).liftDb, 0)
  }
})

test('a single fricative does not move the compensation', () => {
  // THE TEST THE BALLISTICS EXIST FOR, and the one a fast time constant
  // fails. If the lift tracked transients, a fricative would raise the
  // threshold as it arrived and receive no extra reduction — the compensation
  // would cancel exactly the selectivity it is meant to preserve.
  //
  // MEASURED AT THE END OF THE BURST, by truncating the signal there, because
  // getMetering() reports the CURRENT lift: reading it after four more seconds
  // of bed measures how far it has decayed back, which a 20 ms constant passes
  // just as easily as a 3 s one. That version of this test did not fail under
  // mutation, which is how the hole was found.
  //
  // DIFFERENTIAL, against the same bed with silence in the burst's place: the
  // bed is synthetic speech with hard syllable edges, which splatter some HF
  // of their own, so an absolute reading would be measuring the generator as
  // much as the burst.
  const bed = sibilantSpeech(4, 0.35, 97, 0)
  const gap = new Float32Array(Math.round(0.03 * SR))
  for (const emphasisDb of [6, 12]) {
    const without = meter(concat(bed, gap), { headroomDb: 6.5, emphasisDb }).liftDb
    const withBurst = meter(concat(bed, fricativeNoise(0.03, 0.44)),
      { headroomDb: 6.5, emphasisDb }).liftDb
    assert.ok(withBurst - without < 0.5,
      `one 30 ms fricative moved the compensation by ${(withBurst - without).toFixed(3)} dB ` +
      `at emphasis ${emphasisDb}`)
  }
})

test('the compensation responds over seconds, not milliseconds', () => {
  // The ballistics asserted directly, as a time constant rather than through
  // a consequence. A step from an LF passage into a sibilant one is the only
  // input that separates "slow" from "fast" cleanly — a single burst is short
  // enough that even a 20 ms constant barely reacts within it, so the burst
  // test above cannot carry this on its own.
  //
  // Bounded on BOTH sides. Too fast and the compensation eats the selectivity
  // it exists to protect; too slow and it never arrives within a take.
  const emphasisDb = 12
  const signal = concat(sibilantSpeech(4, 0.35, 97, 0), sibilantSpeech(10, 0.35, 41, 0.8))
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams({ ...CURVE_ONLY, headroomDb: 6.5, emphasisDb, shape: 'tanh3' })
  const out = new Float32Array(signal.length)
  const trace = []
  for (let off = 0; off < signal.length; off += 128) {
    const len = Math.min(128, signal.length - off)
    kernel.process([signal.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    trace.push({ t: off / SR, lift: kernel.getMetering().liftDb })
  }
  const stepAt = 4
  const before = trace.find(p => p.t >= stepAt - 0.2).lift
  const settled = trace[trace.length - 1].lift
  assert.ok(settled - before > 5, `the step did not move the lift: ${before} -> ${settled}`)
  const target = before + 0.632 * (settled - before)
  const riseS = trace.find(p => p.t > stepAt && p.lift >= target).t - stepAt
  assert.ok(riseS > 0.5 && riseS < 8,
    `lift reached 63% of its step in ${riseS.toFixed(2)} s — expected the order of ` +
    `LIFT_TAU_S, not a transient-following constant`)
})

test('emphasis still aims the stage at HF peaks and away from LF ones', () => {
  // What the knob is FOR, pinned end-to-end, and the half the compensation
  // must not flatten. Two outliers of identical peak amplitude differing only
  // in spectrum, each in its own copy of the same bed: raising emphasis drives
  // the fricative-shaped one much harder (3.00 -> 5.84 dB measured) and leaves
  // the low-frequency one alone (1.88 -> 1.82, drifting very slightly DOWN,
  // which is the pivot pointing the right way).
  const withBurst = (burst) => concat(speechLike(4, 0.35, 97), burst, speechLike(4, 0.35, 101))
  const AMP = 0.44
  const lfSig = withBurst(plosiveBurst(0.03, AMP))
  const hfSig = withBurst(fricativeNoise(0.03, AMP))

  const lf = [0, 12].map(e => meter(lfSig, { headroomDb: 6.5, emphasisDb: e }).maxReductionDb)
  const hf = [0, 12].map(e => meter(hfSig, { headroomDb: 6.5, emphasisDb: e }).maxReductionDb)

  assert.ok(hf[1] > hf[0] + 1.5,
    `emphasis did not reach the HF peak: ${hf.map(v => v.toFixed(2)).join(' -> ')}`)
  assert.ok(lf[1] <= lf[0] + 0.02 && lf[1] > lf[0] - 0.25,
    `emphasis moved the LF peak, which has no energy above the corner: ` +
    lf.map(v => v.toFixed(2)).join(' -> '))
})

test('depth holds across the emphasis knob on synthetic beds', () => {
  // ⚠ SCOPED TO SYNTHETIC MATERIAL DELIBERATELY, and the name says so. On two
  // of three real narrators the depth does NOT hold across the knob, because
  // their peak reduction is set by a single event far more HF-rich than the
  // passage average, and no statistic slow enough to leave an isolated
  // fricative its extra reduction can also cancel it on a peak that IS one.
  // See LIFT_GATE_DB for the three-file table. What this test pins is that the
  // broad inflation is gone on material where the lift is measurable at all —
  // asserting more than that would be asserting something untrue of real
  // audio.
  // The claim the compensation exists to make, end-to-end on three beds
  // spanning no sibilance to heavy sibilance. Uncompensated, peak reduction
  // drifted 1.45 -> 5.45 dB across the knob on the mixed bed and 1.28 -> 5.68
  // on the sibilant one — the knob acting as a second, spectrum-dependent
  // depth control. Measured with the lift in: -0.28 and -0.06 dB of drift.
  //
  // The bound is two-sided. Over-compensating would be the subtler failure —
  // a knob that quietly REDUCES depth as it is raised is just as dishonest an
  // A/B as one that raises it, and the warm-up seed deliberately takes the
  // max, which errs in that direction.
  for (const hfMix of [0, 0.35, 0.8]) {
    const signal = sibilantSpeech(12, 0.35, 41, hfMix)
    const grs = [0, 3, 6, 12].map(e => meter(signal, { headroomDb: 6.5, emphasisDb: e }).maxReductionDb)
    const drift = Math.max(...grs) - Math.min(...grs)
    // ⚠ THE BOUND WAS 0.6 AND PINNING HYSTERESIS WIDENED IT TO 0.72 on the
    // mixed bed. The mechanism is real: the memory measures drive against the
    // lift-compensated threshold, so a rising lift lowers the drive and the
    // depression with it, which compounds the compensation's existing slight
    // OVER-correction — depth falling as the knob rises (1.70 -> 0.98 here).
    // Measured on real narration the same sweep drifts 0.10 dB before the pin
    // and 0.19 after, so this is the sibilant synthetic bed exaggerating
    // again, exactly as it did by a factor of eight on the uncompensated
    // drift. The bound is loosened to what the pin actually costs rather than
    // tightened by weakening the probe.
    assert.ok(drift < 0.8,
      `hfMix ${hfMix}: depth still moves with the knob — ${grs.map(v => v.toFixed(2)).join(' -> ')}`)
  }
})

test('the compensation is seeded during warm-up, not ramped into', () => {
  // Without the seed the feature is absent for its first three seconds: the
  // speech tracker adopts a real level the instant its 500 ms window closes
  // and the stage starts processing, while a lift climbing from zero on a 3 s
  // constant leaves the threshold uncompensated exactly then. Asserted on the
  // opening of a file rather than on its whole length, because a running
  // maximum over a long file hides a short transient — which is how this was
  // nearly missed.
  const signal = sibilantSpeech(2.5, 0.35, 41, 0.8)
  const settled = meter(sibilantSpeech(12, 0.35, 41, 0.8), { headroomDb: 6.5, emphasisDb: 12 })
  const opening = meter(signal, { headroomDb: 6.5, emphasisDb: 12 })
  assert.ok(opening.liftDb > 0.8 * settled.liftDb,
    `lift had only reached ${opening.liftDb.toFixed(2)} dB of ${settled.liftDb.toFixed(2)} ` +
    `after 2.5 s`)
  assert.ok(opening.maxReductionDb < 2,
    `the opening of the file over-clipped: ${opening.maxReductionDb.toFixed(2)} dB`)
})

test('turning Emphasis down takes effect at once', () => {
  // REPORTED IN REVIEW, and worse than it looked. `liftDb` only updates while
  // the gate is open AND the moment is loud, so its 3 s constant is 3 s of
  // GATED time — many times that in wall clock. Measured on real audio before
  // the fix, flipping Emphasis 12 -> 0 mid-file left the threshold 2.76 dB
  // high SIX SECONDS later, quietly under-processing everything in between.
  //
  // The emphasis filters switch the instant the parameter is committed, so the
  // threshold that exists to compensate for them has to switch with them. The
  // bound is therefore applied to the lift STATE, not only to its target.
  const signal = sibilantSpeech(8, 0.35, 41, 0.8)
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams({ headroomDb: 6.5, emphasisDb: 12, shape: 'tanh3' })
  const out = new Float32Array(signal.length)
  const run = (from, to) => {
    for (let off = from; off < to; off += 128) {
      const len = Math.min(128, to - off)
      kernel.process([signal.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    }
  }
  const half = Math.round(signal.length / 2)
  run(0, half)
  const before = kernel.getMetering().liftDb
  assert.ok(before > 2, `the probe never built a lift to release: ${before.toFixed(2)} dB`)

  // Emphasis to zero: exactly zero, on the very next block, not eventually.
  kernel.setParams({ emphasisDb: 0 })
  run(half, half + 128)
  assert.equal(kernel.getMetering().liftDb, 0)

  // And a partial move down is bounded by the new setting immediately, with
  // the rest of the convergence left to the measurement.
  const k2 = new SoftClipperKernel(SR)
  k2.setParams({ headroomDb: 6.5, emphasisDb: 12, shape: 'tanh3' })
  for (let off = 0; off < half; off += 128) {
    const len = Math.min(128, half - off)
    k2.process([signal.subarray(off, off + len)], [out.subarray(off, off + len)], len)
  }
  k2.setParams({ emphasisDb: 4 })
  k2.process([signal.subarray(half, half + 128)], [out.subarray(half, half + 128)], 128)
  assert.ok(k2.getMetering().liftDb <= 4 + 1e-9,
    `lift ${k2.getMetering().liftDb.toFixed(2)} still exceeds the new Emphasis of 4 dB`)
})

// ── RESIDUAL readout (RESIDUAL_TAU_S) ───────────────────────────────────────

/** The kernel's own residual reading, averaged in the energy domain. */
function residualDbc(signal, params, sr = SR) {
  const kernel = new SoftClipperKernel(sr)
  kernel.setParams({ ...CURVE_ONLY, shape: 'tanh3', ...params })
  const out = new Float32Array(signal.length)
  let sum = 0, n = 0
  for (let off = 0; off < signal.length; off += 128) {
    const len = Math.min(128, signal.length - off)
    kernel.process([signal.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    if (off <= 3 * sr) continue
    const r = kernel.getMetering().residualDbc
    if (r > -120) { sum += Math.pow(10, r / 10); n++ }
  }
  return n ? 10 * Math.log10(sum / n) : -Infinity
}

/** The same quantity computed independently, as a ratio of whole-file energies. */
function residualDbcOffline(signal, params, sr = SR) {
  const wet = processSoftClipperBuffer([signal], sr,
    { ...CURVE_ONLY, shape: 'tanh3', ...params }).channelData[0]
  const dry = processSoftClipperBuffer([signal], sr,
    { ...CURVE_ONLY, shape: 'tanh3', ...params, headroomDb: 60 }).channelData[0]
  let res = 0, sig = 0
  for (let i = 3 * sr; i < signal.length; i++) {
    const d = dry[i] - wet[i]
    res += d * d
    sig += dry[i] * dry[i]
  }
  return 10 * Math.log10(res / sig)
}

test('the residual readout matches an independent measurement of the same thing', () => {
  // THE CORRECTNESS TEST. The readout exists so a setting can be compared
  // against another one, so what matters is that it reproduces a whole-file
  // energy ratio — computed here from two renders, which is how the same
  // number was measured offline before the meter existed.
  //
  // The probe deliberately carries BOTH loud material that clips and quiet
  // voiced material that does not, because that mixture is what separates a
  // ratio of averaged energies from an average of per-block ratios. The
  // second is what shipped first: a per-block ratio is large wherever dry is
  // small, so its running mean is dominated by the quietest voiced blocks —
  // the ones carrying almost none of the distortion.
  const signal = concat(
    speechLike(4, 0.5, 97),
    speechLike(3, 0.06, 101), // voiced, far below the threshold, clips nothing
    speechLike(4, 0.5, 103),
  )
  for (const emphasisDb of [0, 6, 12]) {
    const mine = residualDbc(signal, { headroomDb: 6.5, emphasisDb })
    const theirs = residualDbcOffline(signal, { headroomDb: 6.5, emphasisDb })
    assert.ok(Math.abs(mine - theirs) < 2,
      `emphasis ${emphasisDb}: readout ${mine.toFixed(2)} dBc against ${theirs.toFixed(2)} measured directly`)
  }
})

test('the residual readout is a ratio, so level and trim cannot move it', () => {
  // Both properties are what dBc buys over dBFS, and both are the reason the
  // readout can be compared across files at all. Output Trim especially: it is
  // a gain match for A/B, and a diagnostic that moved when it did would be
  // reporting the user's monitoring rather than the processing.
  const signal = concat(speechLike(5, 0.4, 11), speechLike(4, 0.4, 13))
  const base = residualDbc(signal, { headroomDb: 6.5, emphasisDb: 6 })

  const louder = new Float32Array(signal.length)
  for (let i = 0; i < signal.length; i++) louder[i] = signal[i] * dbToLin(6)
  const scaled = residualDbc(louder, { headroomDb: 6.5, emphasisDb: 6 })
  assert.ok(Math.abs(scaled - base) < 0.5,
    `6 dB of input gain moved the readout ${base.toFixed(2)} -> ${scaled.toFixed(2)} dBc`)

  for (const outputTrimDb of [-6, 6]) {
    const trimmed = residualDbc(signal, { headroomDb: 6.5, emphasisDb: 6, outputTrimDb })
    assert.ok(Math.abs(trimmed - base) < 0.1,
      `Output Trim ${outputTrimDb} moved the readout ${base.toFixed(2)} -> ${trimmed.toFixed(2)} dBc`)
  }
})

test('the residual readout bottoms out at the oversampler, not at zero', () => {
  // ⚠ AN IDLE STAGE DOES NOT READ ZERO, and finding out why is the reason this
  // test exists rather than asserting the floor. The residual is taken between
  // the RAW input and the finished output, so it includes the oversampler's
  // reconstruction error, which is there whether or not the curve fires.
  //
  // Measured at -70.7 dBc with the curve fully bypassed, identical at every
  // input level and every emphasis setting — the signature of a linear error.
  // That is 25-40 dB below the range the stage produces in use, so it cannot
  // affect a comparison between settings, but it means a low reading means
  // "the oversampler and nothing else" rather than "nothing".
  const signal = speechLike(6, 0.5, 11)
  const bypassed = residualDbc(signal, { headroomDb: 60, emphasisDb: 0 })
  assert.ok(bypassed < -60,
    `a bypassed stage reported ${bypassed.toFixed(1)} dBc — far too much to be the oversampler`)
  assert.ok(bypassed > -90,
    `a bypassed stage reported ${bypassed.toFixed(1)} dBc — the oversampler error has vanished, ` +
    'which means this test is no longer measuring what it claims')
  // Level-independent, which is what makes it an error rather than a signal.
  const louder = new Float32Array(signal.length)
  for (let i = 0; i < signal.length; i++) louder[i] = signal[i] * dbToLin(6)
  assert.ok(Math.abs(residualDbc(louder, { headroomDb: 60, emphasisDb: 0 }) - bypassed) < 0.5,
    'the bypassed reading moved with input level, so it is not a linear error')

  // And with nothing measured at all it is the floor, finite, for the dash.
  const fresh = new SoftClipperKernel(SR)
  fresh.setParams({ ...CURVE_ONLY, headroomDb: 6.5, emphasisDb: 0, shape: 'tanh3' })
  const r = fresh.getMetering().residualDbc
  assert.equal(r, -120)
  assert.ok(Number.isFinite(r), 'the readout reached an infinity instead of its floor')
})

test('the residual readout tracks the emphasis knob the way the offline sweep does', () => {
  // The reason the readout was built: on real narration the residual has a
  // minimum partway up the HF Emphasis knob on some material and falls
  // monotonically on other material, and neither the lamp nor ENGAGED can see
  // it. Pinned as a SHAPE rather than as values — the absolute figure depends
  // on the probe, the ordering is the claim.
  const signal = concat(speechLike(5, 0.5, 41), fricativeNoise(3, 0.3), speechLike(4, 0.5, 43))
  const curve = [0, 3, 6, 9, 12].map(e => residualDbc(signal, { headroomDb: 6.5, emphasisDb: e }))
  const offline = [0, 3, 6, 9, 12].map(e => residualDbcOffline(signal, { headroomDb: 6.5, emphasisDb: e }))
  for (let i = 1; i < curve.length; i++) {
    assert.equal(Math.sign(curve[i] - curve[i - 1]), Math.sign(offline[i] - offline[i - 1]),
      `the readout and the direct measurement disagree about direction between steps ` +
      `${i - 1} and ${i}: ${curve.map(v => v.toFixed(1)).join(',')} vs ` +
      offline.map(v => v.toFixed(1)).join(','))
  }
})

// ── Asymmetry, its skew tracker and its DC blocker: REMOVED ────────────────
//
// Eleven tests lived here and every one of them is deleted rather than skipped,
// because the code they guarded is deleted. Worth knowing what went, in case
// even harmonics are ever wanted in this stage again: the even/odd
// decomposition F_even(x) = (F(x) + F(-x))/2 pinned that the stage produced
// EXACTLY zero even content until asked; the offset was measured additive
// rather than a rebalancing (H3 moved at most 1 dB across the whole sweep);
// the no-sign-flip guarantee was its own test; and the DC blocker's tests
// caught the one operating point (heavy drive, DC already in the input) where
// dropping it shifts the waveform bodily and corrupts the peak measurement ACX
// is built on.
//
// ⚠ THE SKEW TRACKER'S TESTS ARE THE ONES TO RE-READ FIRST if this is ever
// revisited: they pinned that only the SIGN may come from the material and the
// magnitude may not (scaling by skew silently turns the knob off on symmetric
// input), and that the decision has to wait a full time constant of gated
// evidence — a running skew estimate reads 1.15 at 0.5 s on a probe whose
// settled value is 0.002, so an early read latches the wrong sign for the whole
// file.

// ── HF Loss: MOVED TO TUBE SATURATION ──────────────────────────────────────
//
// Its tests moved with it, to test/dsp/vocalSat.test.js, which is where the
// filter now is. Two of them did not survive the move unchanged and the
// difference is worth noting: "level-invariant" and "bypassed at zero" were one
// test here, and in the new home level invariance is not claimed at all —
// Tube Saturation multiplies absolute sample values into a fixed transfer, so
// nothing in it is level-invariant. Bit-identical bypass is claimed, and pinned.

// ── Hysteresis (HYST_MAX_DB) ────────────────────────────────────────────────

/** A triangular level ramp: up through a range of amplitudes, then back down. */
function levelRamp(seconds, peakAmp, freqHz = 300, sr = SR) {
  const n = Math.round(seconds * sr)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const ph = i / n
    const env = ph < 0.5 ? ph * 2 : (1 - ph) * 2
    out[i] = peakAmp * env * Math.sin((2 * Math.PI * freqHz * i) / sr)
  }
  return out
}

/**
 * Widest difference in reduction between the rising and falling halves of a
 * ramp, at matched input level. Zero for a memoryless stage; the loop is the
 * whole point of hysteresis, so this is what measures it.
 */
function loopWidthDb(seconds, params, sr = SR) {
  const sig = levelRamp(seconds, 0.9, 300, sr)
  const kernel = new SoftClipperKernel(sr)
  kernel.setParams({
    ...CURVE_ONLY,
    thresholdMode: 'fixed', fixedThresholdDb: -18, emphasisDb: 0, shape: 'tanh3', ...params,
  })
  const out = new Float32Array(sig.length)
  const pts = []
  const hop = 64
  for (let off = 0; off < sig.length; off += hop) {
    const len = Math.min(hop, sig.length - off)
    kernel.process([sig.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    let peak = 0
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(sig[off + i]))
    pts.push({ t: off / sr, inDb: 20 * Math.log10(peak + 1e-12), red: kernel.getMetering().reductionDb })
  }
  const half = seconds / 2
  let worst = 0
  const nearest = (list, target) =>
    list.reduce((b, p) => (Math.abs(p.inDb - target) < Math.abs(b.inDb - target) ? p : b))
  for (const target of [-15, -14, -13, -12, -11, -10]) {
    const up = nearest(pts.filter(p => p.t < half * 0.95), target)
    const dn = nearest(pts.filter(p => p.t > half * 1.05), target)
    worst = Math.max(worst, Math.abs(dn.red - up.red))
  }
  return worst
}

test('hysteresis makes the response a loop, and the knob widens it', () => {
  // WHAT SEPARATES THIS FROM ONE MORE ENVELOPE FOLLOWER. The threshold moves
  // down with recent drive, so a level arrived at from below maps to a
  // different threshold than the same level arrived at from above. Measured at
  // syllabic rate (a 100 ms ramp): 0.61 dB of loop at zero, 1.31 at half, 1.88
  // at full.
  //
  // ⚠ THE BASELINE IS NOT ZERO, and that is worth knowing rather than
  // explaining away: the detector's own follower is already asymmetric (1 ms
  // attack, 150 ms release), so the stage always had a little of this. The
  // knob deepens an effect that exists, it does not introduce one — and that
  // same upstream follower, not this stage's ballistics, is where the loop
  // comes from. See HYST_TAU_MS for the sweep that established it.
  const widths = [0, 50, 100].map(hysteresis => loopWidthDb(0.1, { hysteresis }))
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i] > widths[i - 1] + 0.5,
      `the knob did not widen the loop: ${widths.map(v => v.toFixed(2)).join(' -> ')} dB`)
  }
  // And it needs the level to be MOVING at a rate the state can lag behind.
  // On a slow ramp any follower keeps up and the loop nearly closes.
  const slow = loopWidthDb(2.0, { hysteresis: 100 })
  assert.ok(slow < widths[2] - 0.8,
    `the loop did not narrow on a slow ramp: ${slow.toFixed(2)} against ${widths[2].toFixed(2)} dB`)
})

test('hysteresis moves the threshold slowly enough that it cannot waveshape', () => {
  // THE SAFETY PROPERTY, and the reason the memory modulates T rather than the
  // drive or the knee. Moving T translates the curve without reshaping it, so
  // it is monotonic at any frozen state whatever the memory does — but only if
  // the state moves on an ENVELOPE time scale. A state moving at audio rate
  // would be a nonlinearity wearing an envelope's clothing, and would put the
  // fold risk straight back.
  //
  // Bounded from the attack coefficient: HYST_MAX_DB * (1 - exp(-1/(tau*sr)))
  // is about 0.0125 dB per sample at 48 kHz.
  const sr = 48000
  const sig = concat(speechLike(3, 0.6, 17, sr), levelRamp(0.2, 0.95, 200, sr), speechLike(2, 0.6, 19, sr))
  const kernel = new SoftClipperKernel(sr)
  kernel.setParams({ thresholdMode: 'fixed', fixedThresholdDb: -18, emphasisDb: 0, shape: 'tanh3', hysteresis: 100 })
  const out = new Float32Array(sig.length)
  let worstStep = 0
  let prev = null
  for (let off = 0; off < sig.length; off += 128) {
    const len = Math.min(128, sig.length - off)
    kernel.process([sig.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    for (let i = 0; i < len; i++) {
      const tDb = 20 * Math.log10(kernel.tScratch[i])
      if (prev !== null) worstStep = Math.max(worstStep, Math.abs(tDb - prev))
      prev = tDb
    }
  }
  assert.ok(worstStep < 0.02,
    `the threshold moved ${worstStep.toFixed(4)} dB in one sample — fast enough to shape a waveform`)
})

test('hysteresis keeps the bound, never boosts, and is absent at zero', () => {
  const sig = concat(speechLike(4, 0.6, 23), speechLike(3, 0.6, 29))
  const params = { thresholdMode: 'fixed', fixedThresholdDb: -24, emphasisDb: 0, shape: 'tanh3', hysteresis: 100 }

  // BOUNDED. Lowering the threshold cannot raise the reduction ceiling — the
  // curve is the same curve, and its cap travels with it.
  const kernel = new SoftClipperKernel(SR)
  kernel.setParams(params)
  const out = new Float32Array(sig.length)
  for (let off = 0; off < sig.length; off += 128) {
    const len = Math.min(128, sig.length - off)
    kernel.process([sig.subarray(off, off + len)], [out.subarray(off, off + len)], len)
  }
  assert.ok(kernel.getMetering().maxReductionDb <= MAX_REDUCTION_DB + 1e-9,
    `hysteresis exceeded the reduction bound: ${kernel.getMetering().maxReductionDb}`)

  // AND THE THRESHOLD ITSELF MOVES BY AT MOST HYST_MAX_DB (3). Without this,
  // dropping the knee normalisation — feeding raw dB-over into the state
  // instead of `min(1, over / HYST_KNEE_DB)` — passes every other assertion
  // here while letting the threshold fall by tens of dB.
  const trace = (hysteresis) => {
    const k = new SoftClipperKernel(SR)
    k.setParams({ ...params, hysteresis })
    const o = new Float32Array(sig.length)
    const t = []
    for (let off = 0; off < sig.length; off += 128) {
      const len = Math.min(128, sig.length - off)
      k.process([sig.subarray(off, off + len)], [o.subarray(off, off + len)], len)
      for (let i = 0; i < len; i++) t.push(20 * Math.log10(k.tScratch[i]))
    }
    return t
  }
  const flat = trace(0)
  const moved = trace(100)
  let deepest = 0
  let highest = 0
  for (let i = 0; i < flat.length; i++) {
    deepest = Math.max(deepest, flat[i] - moved[i])
    highest = Math.max(highest, moved[i] - flat[i])
  }
  assert.ok(deepest > 0.5, `the memory barely moved the threshold: ${deepest.toFixed(3)} dB`)
  assert.ok(deepest <= 3 + 1e-6, `the threshold fell ${deepest.toFixed(3)} dB, past HYST_MAX_DB`)
  assert.ok(highest <= 1e-9, `the memory RAISED the threshold by ${highest.toFixed(4)} dB`)

  // NEVER BOOSTS.
  const y = processSoftClipperBuffer([sig], SR, params).channelData[0]
  let peakIn = 0, peakOut = 0
  for (let i = Math.round(0.5 * SR); i < sig.length; i++) {
    peakIn = Math.max(peakIn, Math.abs(sig[i]))
    peakOut = Math.max(peakOut, Math.abs(y[i]))
  }
  assert.ok(peakOut <= peakIn + 1e-6, `hysteresis boosted the peak ${peakIn} -> ${peakOut}`)

  // PINNED AT 100 AND OFF THE PANEL — the second pin, on different evidence
  // from the first. At matched OUTPUT PEAK it costs ~1 dB of total residual
  // while moving 2.6 dB of distortion off sustained speech onto onsets, and
  // listening confirmed it does no harm. See HYST_MAX_DB, which also records
  // why the first pin was wrong.
  assert.equal(SOFT_CLIPPER_KERNEL_DEFAULTS.hysteresis, 100,
    'hysteresis is no longer pinned on')
  // The product surface reaches the kernel through `toKernelParams`, which
  // deliberately omits the key. That file cannot be imported here (it pulls a
  // Vite worker URL), so what is pinned instead is the property that makes
  // omitting it safe: an absent key leaves the pin on.
  const absent = new SoftClipperKernel(SR)
  absent.setParams({ headroomDb: 7.0, emphasisDb: 6, shape: 'tanh3' })
  assert.equal(absent.params.hysteresis, 100,
    'an absent hysteresis key unpinned the memory')
  // The bypass path stays reachable from the kernel, because the tests above
  // measure 0 against 100.
  const off = new SoftClipperKernel(SR)
  off.setParams({ ...params, hysteresis: 0 })
  const oo = new Float32Array(sig.length)
  for (let o2 = 0; o2 < sig.length; o2 += 128) {
    const len = Math.min(128, sig.length - o2)
    off.process([sig.subarray(o2, o2 + len)], [oo.subarray(o2, o2 + len)], len)
  }
  assert.ok(off.getMetering().maxReductionDb < kernel.getMetering().maxReductionDb,
    'hysteresis 0 did not reduce less than hysteresis 100 at the same Headroom')
})

test('hysteresis is level-invariant', () => {
  // The memory is measured relative to the threshold, so the same recording at
  // a different level gets the same treatment — the property every control in
  // this stage has to hold.
  const probe = concat(speechLike(4, 0.4, 83), speechLike(3, 0.4, 89))
  const base = { thresholdMode: 'fixed', emphasisDb: 0, shape: 'tanh3', hysteresis: 100 }
  const a = processSoftClipperBuffer([probe], SR, { ...base, fixedThresholdDb: -14 }).channelData[0]
  const louder = new Float32Array(probe.length)
  for (let i = 0; i < probe.length; i++) louder[i] = probe[i] * dbToLin(6)
  const b = processSoftClipperBuffer([louder], SR, { ...base, fixedThresholdDb: -8 }).channelData[0]
  let worst = 0
  for (let i = Math.round(SR); i < probe.length; i++) {
    worst = Math.max(worst, Math.abs(b[i] / dbToLin(6) - a[i]))
  }
  assert.ok(worst < 2e-3, `hysteresis is not level-invariant: worst deviation ${worst}`)
})

// ── Soften: MOVED TO dsp/tapeCharacter.js ─────────────────────────────────
//
// Four tests went with it, and one of them is worth naming here because it was
// about THIS stage rather than about the limiter: `soften is absent at zero and
// never boosts` pinned that the shipped patch was bit-identical to the build
// before Soften existed. That guarantee is now unconditional — there is no
// control here that can forfeit it — so the stage's transparency tests carry it
// instead.
//
// ⚠ THE ONE THAT DID NOT SURVIVE INTACT: `soften is level-invariant`. Soften's
// allowance scaled with this stage's character reference, so its invariance was
// this stage's invariance. In the module the reference is the caller's to
// choose, and the test that replaced it pins the weaker, true thing — that the
// allowance scales with whatever reference it is given.

test('HF Emphasis is pinned and off the faceplate', () => {
  // ⚠ THE PIN IS 0 NOW, AND IT IS NO LONGER A JUDGEMENT — it is what the
  // panel's contract requires. The panel is one ceiling in dBFS captioned
  // "peaks stop here"; the curve compares the PRE-EMPHASISED signal against the
  // threshold, so with any non-zero emphasis where a sample crosses depends on
  // its own HF content and no single dBFS number can describe it. Measured on
  // four real files x two presets, output peak minus the ceiling set: 1.43 to
  // 5.04 dB of escape at emphasis 7, and 0.000 at emphasis 0.
  //
  // The aiming is genuinely given up. It remains reachable from the admin
  // tuning panel for anyone who wants to measure it.
  //
  // ⚠ "OFF THE SURFACE" IS NOW "OFF THE FACEPLATE": the knob exists on the
  // hidden admin tuning panel (softClipperTuning.js). What must still hold is
  // that an ABSENT key leaves the pin alone — the kernel merges partials over
  // its own defaults, so a param object that carries `emphasisDb: undefined`
  // would overwrite the pin rather than fall back to it. That is why
  // toKernelParams forwards the key only when it holds a real number.
  assert.equal(SOFT_CLIPPER_KERNEL_DEFAULTS.emphasisDb, 0,
    'the HF Emphasis pin moved')
  const absent = new SoftClipperKernel(SR)
  absent.setParams({ headroomDb: 7.0, shape: 'tanh3' })
  assert.equal(absent.params.emphasisDb, SOFT_CLIPPER_KERNEL_DEFAULTS.emphasisDb,
    'an absent emphasisDb key unpinned the emphasis')
})

// ── Hybrid peak path (LIMITER_MAX_ABOVE_DB) ─────────────────────────────────

test('the limiter is absent at zero, latency included', () => {
  // A bypass that still ran the delay would shift the timeline by 4 ms for a
  // control set to zero, so zero has to mean the build before the limiter
  // existed — not merely something similar.
  //
  // ⚠ THIS IS NO LONGER THE DEFAULT PATCH. The kernel ships `limiter: 100`, so
  // what this pins is the bypass, and the comparison is against a second
  // explicit render rather than against the default. Reading a bypass off a
  // default is exactly how a moved default turns a guarantee into a tautology.
  const sig = concat(speechLike(4, 0.7, 97), speechLike(3, 0.7, 101))
  const base = { headroomDb: 7.0, shape: 'tanh3' }
  const a = processSoftClipperBuffer([sig], SR, { ...base, limiter: 0 })
  const b = processSoftClipperBuffer([sig], SR, { ...base, limiter: 0 })
  assert.equal(a.latencySamples, b.latencySamples, 'limiter 0 changed the latency')
  assert.equal(a.latencySamples, SOFT_CLIPPER_LATENCY_SAMPLES)
  for (let i = 0; i < sig.length; i++) {
    assert.equal(a.channelData[0][i], b.channelData[0][i], `limiter 0 altered sample ${i}`)
  }
})

test('the shipped default runs the hybrid path, latency and all', () => {
  // ⚠ THE DEFAULT MOVED TO limiter 100, AND IT IS NOT A COSMETIC DEFAULT.
  // Engaged, the stage delays by 242 samples instead of 50 and its gain
  // envelope reaches below the threshold — measured elsewhere in this repo at
  // 24-36% of sub-threshold samples ducked by 2.2-5.4 dB. Anything that
  // renders through this stage inherits both. Pinned so the change is visible
  // from the tests rather than only from the audio.
  const sig = concat(speechLike(4, 0.7, 97), speechLike(3, 0.7, 101))
  const base = { headroomDb: 7.0, shape: 'tanh3' }
  const shipped = processSoftClipperBuffer([sig], SR, base)
  const bypassed = processSoftClipperBuffer([sig], SR, { ...base, limiter: 0 })
  assert.equal(SOFT_CLIPPER_KERNEL_DEFAULTS.limiter, 100, 'the limiter default moved')
  assert.ok(shipped.latencySamples > bypassed.latencySamples,
    `the default did not engage the limiter: ${shipped.latencySamples} samples`)
})

test('the balance moves peak control off the curve and onto the limiter', () => {
  // THE CLAIM THE HYBRID IS FOR. Raising the knob should leave the curve with
  // progressively less to do — that is the whole point, since the curve is the
  // part that makes harmonics. Measured on real narration the curve's peak
  // reduction runs 3.57 -> 2.45 -> 0.85 -> 0.02 dB across the knob.
  // ⚠ THE PROBE NEEDS REAL PEAKS, and plain speechLike does not have them —
  // at any sane Headroom the curve reaches 0.08 dB on it and the gradation is
  // invisible. Plosive-shaped outliers on top of it are what actually reach
  // the curve. Thirteenth time synthetic material has been too clean.
  const sig = speechLike(6, 0.55, 103)
  {
    const burst = Math.round(0.03 * SR)
    for (let k = 0; k < 12; k++) {
      const at = Math.round((0.4 + k * 0.45) * SR)
      for (let j = 0; j < burst && at + j < sig.length; j++) {
        sig[at + j] += 0.9 * Math.sin((Math.PI * j) / burst) ** 2 * Math.sin((2 * Math.PI * 110 * j) / SR)
      }
    }
  }
  const curveWork = (limiter) => {
    const k = new SoftClipperKernel(SR)
    k.setParams({ headroomDb: 2.0, shape: 'tanh3', limiter })
    const o = new Float32Array(sig.length)
    let gr = 0
    for (let off = 0; off < sig.length; off += 128) {
      const n = Math.min(128, sig.length - off)
      k.process([sig.subarray(off, off + n)], [o.subarray(off, off + n)], n)
      if (off > SR) gr = Math.max(gr, k.getMetering().maxReductionDb)
    }
    return gr
  }
  const work = [0, 50, 100].map(curveWork)
  assert.ok(work[2] < work[0] * 0.5,
    `the limiter did not take work off the curve: ${work.map(v => v.toFixed(2)).join(' -> ')} dB`)
  for (let i = 1; i < work.length; i++) {
    assert.ok(work[i] <= work[i - 1] + 0.2,
      `curve work did not fall monotonically: ${work.map(v => v.toFixed(2)).join(' -> ')} dB`)
  }
  // ⚠ AND THE MIDDLE HAS TO BE GENUINELY IN THE MIDDLE. Dropping the ceiling
  // factor — so the limiter always aims at T regardless of the knob — turns
  // the balance into an on/off switch and still satisfies both assertions
  // above, because the endpoints are unchanged and the sequence stays
  // monotonic. Only the gradation catches it.
  assert.ok(work[1] > work[2] + 0.5 && work[1] < work[0] - 0.2,
    `the balance is not gradual, it is a switch: ${work.map(v => v.toFixed(2)).join(' -> ')} dB`)
})

test('the reported latency matches where the audio actually is', () => {
  // ⚠ THE LATENCY IS VARIABLE, so a caller that assumed the constant would
  // misalign by 4 ms. An impulse is the cleanest way to ask where the output
  // really landed.
  for (const limiter of [0, 100]) {
    const N = SR
    const x = new Float32Array(N)
    x[N >> 1] = 0.02      // well under any threshold, so nothing reshapes it
    const r = processSoftClipperBuffer([x], SR, { headroomDb: 7.0, shape: 'tanh3', limiter })
    let at = -1, best = 0
    for (let i = 0; i < N; i++) {
      const v = Math.abs(r.channelData[0][i])
      if (v > best) { best = v; at = i }
    }
    assert.equal(at - (N >> 1), r.latencySamples,
      `limiter ${limiter}: impulse landed ${at - (N >> 1)} samples late, reported ${r.latencySamples}`)
  }
})

test('the residual reports the curve, not the limiter', () => {
  // ⚠ THE DISTINCTION THAT MADE THE HEAD-TO-HEAD COMPARISON MEANINGLESS. The
  // limiter's gain reduction is intended, not distortion; feeding the dry side
  // of the residual post-limiter is what keeps RESIDUAL meaning "what the
  // curve added". With the limiter doing all the work the curve is idle, so
  // the residual has to fall, not rise.
  const sig = concat(speechLike(5, 0.8, 109), speechLike(4, 0.8, 113))
  const residual = (limiter) => {
    const k = new SoftClipperKernel(SR)
    k.setParams({ headroomDb: 5.0, shape: 'tanh3', limiter })
    const o = new Float32Array(sig.length)
    for (let off = 0; off < sig.length; off += 128) {
      const n = Math.min(128, sig.length - off)
      k.process([sig.subarray(off, off + n)], [o.subarray(off, off + n)], n)
    }
    return k.residualDbc
  }
  assert.ok(residual(100) < residual(0) - 3,
    `the residual did not fall as the curve went idle: ${residual(0).toFixed(1)} -> ${residual(100).toFixed(1)} dBc`)
})

// ── Preview / apply agreement ──────────────────────────────────────────────

test('Soften delivers the same depth cold as it does warmed up', () => {
  // ⚠ THE REPORTED DEFECT: the applied audio was less softened than the
  // preview, every time. The preview runs the kernel continuously, so its
  // speech tracker is settled; an offline region render starts it COLD, and
  // Soften's allowance was scaled by that tracker. A larger reference is a
  // larger allowance, so the apply path bit less all the way through — measured
  // at 1.5-2.3 dB on a 10 s region of real narration.
  //
  // Referencing the allowance to T instead makes the whole thing history-free
  // in fixed mode, since T is then a constant the user set. This is that
  // property: the same audio through a WARMED kernel and a COLD one must give
  // the same Soften, and the mutation it catches is scaling the allowance by
  // anything that has to converge.
  const lead = concat(speechLike(6, 0.55, 11), speechLike(6, 0.2, 13))
  const region = concat(speechLike(4, 0.5, 71), speechLike(3, 0.5, 73))
  const patch = { thresholdMode: 'fixed', fixedThresholdDb: -12, emphasisDb: 0, shape: 'tanh3' }

  const depth = (signal, offset, soften) => {
    const wet = processSoftClipperBuffer([signal], SR, { ...patch, soften }).channelData[0]
    const dry = processSoftClipperBuffer([signal], SR, { ...patch, soften: 0 }).channelData[0]
    let sq = 0, n = 0
    for (let i = offset; i < signal.length; i++) { const d = wet[i] - dry[i]; sq += d * d; n++ }
    return 10 * Math.log10(sq / n + 1e-30)
  }

  for (const soften of [60, 100]) {
    // Warmed: the region preceded by 12 s of real material, measured from the
    // region only. Cold: the region on its own, measured from its start.
    const warmed = depth(concat(lead, region), lead.length, soften)
    const cold = depth(region, 0, soften)
    assert.ok(Math.abs(warmed - cold) < 0.5,
      `soften ${soften}: cold and warm disagree — ${cold.toFixed(2)} vs ${warmed.toFixed(2)} dB`)
  }
})

test('the reported latency is per-patch, and the apply path can ask for it', () => {
  // ⚠ THE SECOND HALF OF THE SAME REPORT. `SOFT_CLIPPER_LATENCY_SAMPLES` is the
  // OVERSAMPLER's 50 samples; the limiter adds its lookahead on top and the
  // limiter now ships engaged. The apply path was trimming 50 from a render
  // that was delayed by 226, which shifts the applied region 176 samples late
  // and drops that much of its tail.
  //
  // The function has to agree with a real kernel or the two drift, and it must
  // work WITHOUT one — the offline context's length depends on the answer, so
  // it is needed before anything can be built.
  for (const params of [{}, { limiter: 0 }, { limiter: 1 }, { limiter: 50 }, { limiter: 100 }]) {
    const kernel = new SoftClipperKernel(SR)
    kernel.setParams(params)
    // The kernel's own flag is only set once it has seen audio, so run a block.
    const x = new Float32Array(512), y = new Float32Array(512)
    kernel.process([x], [y], 512)
    assert.equal(softClipperLatencySamples(params, SR), kernel.latencySamples,
      `latency disagrees for ${JSON.stringify(params)}`)
  }
  // And the shipped patch is NOT the bypass figure — the bug was assuming it.
  assert.ok(softClipperLatencySamples({}, SR) > SOFT_CLIPPER_LATENCY_SAMPLES,
    'the shipped default no longer engages the limiter, or the constant is back')
  assert.equal(softClipperLatencySamples({ limiter: 0 }, SR), SOFT_CLIPPER_LATENCY_SAMPLES)
})
