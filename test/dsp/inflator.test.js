/**
 * Run with:  npm test
 *
 * Each test carries the mistake it exists for. The curve's four properties are
 * algebraic rather than fitted, so they are pinned exactly rather than to a
 * tolerance — a port that is subtly wrong looks exactly like one that is right,
 * and these are the assertions that can tell them apart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inflatorCoefficients,
  inflatorCurve,
  InflatorBandSplit,
  CURVE_MIN_PCT,
  CURVE_MAX_PCT,
  SPLIT_LOW_HZ,
  SPLIT_HIGH_HZ,
} from '../../src/audio/dsp/inflator.js'
import {
  InflatorKernel,
  INFLATOR_LATENCY_SAMPLES,
  INFLATOR_KERNEL_DEFAULTS,
  processInflatorBuffer,
} from '../../src/audio/inflatorProcessor.js'

const SR = 44100
const CURVES = [-50, -25, -10, 0, 10, 25, 50]

function tone(n, freqHz, amp = 0.4, sr = SR) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sr)
  return out
}

function rms(buf, from = 0) {
  let s = 0
  for (let i = from; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / (buf.length - from))
}

function peak(buf, from = 0) {
  let m = 0
  for (let i = from; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]))
  return m
}

// ── The curve's four properties ─────────────────────────────────────────────

test('the ceiling does not move with Curve: f(1) = 1 exactly, at every setting', () => {
  // THE PROPERTY THAT MAKES CURVE A CHARACTER CONTROL RATHER THAN A SECOND
  // DEPTH CONTROL. The D term carries a factor of s^2*(1-s)^2, zero at s = 1,
  // so f(1) = A + B + C = 1 identically. This codebase has shipped a hidden
  // depth control twice (the soft clipper's KNEE switch and its HF Emphasis
  // knob); this asserts that this knob is not a third.
  //
  // ⚠ PINNED TO A FEW ULP RATHER THAN TO EXACT EQUALITY, and the reason is
  // arithmetic rather than slack: A + B + C is exactly 1 in real arithmetic but
  // not in binary floating point for every p. At Curve -10 the sum
  // 1.4 + 0.2 - 0.6 evaluates to 0.9999999999999999 — one ULP low. Four ULP is
  // still tight enough that any real error in the coefficient law fails it; the
  // D term alone is 0.0625 at Curve 0, twelve orders of magnitude larger.
  for (const curve of CURVES) {
    const co = inflatorCoefficients(curve)
    const err = Math.abs(inflatorCurve(1, co) - 1)
    assert.ok(err <= 4 * Number.EPSILON, `f(1) moved at Curve ${curve} by ${err}`)
    assert.ok(Math.abs(inflatorCurve(-1, co) + 1) <= 4 * Number.EPSILON,
      `f(-1) moved at Curve ${curve}`)
  }
})

test('the small-signal gain is 1.5 + Curve/100, and that is the whole effect', () => {
  // Quiet material comes up while the ceiling stays put — the difference is the
  // density. Measured as a limit rather than asserted from the coefficient, so
  // an error in the polynomial's assembly is caught and not just one in A.
  for (const curve of CURVES) {
    const co = inflatorCoefficients(curve)
    const expected = 1.5 + curve / 100
    const measured = inflatorCurve(1e-7, co) / 1e-7
    assert.ok(
      Math.abs(measured - expected) < 1e-5,
      `Curve ${curve}: small-signal gain ${measured}, expected ${expected}`,
    )
  }
  // The ends are worth stating outright: Curve -50 has NO lift at all, and
  // Curve +50 has exactly +6 dB of it.
  assert.ok(Math.abs(inflatorCurve(1e-7, inflatorCoefficients(-50)) / 1e-7 - 1) < 1e-5)
  assert.ok(Math.abs(inflatorCurve(1e-7, inflatorCoefficients(50)) / 1e-7 - 2) < 1e-5)
})

test('the curve arrives at full scale flat — f\'(1) = 0 at every setting', () => {
  // A + 2B + 3C = 0 identically, so there is no corner at 0 dBFS to generate a
  // burst of high-order content. This is the structural reason the stage reads
  // as density rather than as clipping, and it is what lets the fold-back
  // region join on without a discontinuity in slope.
  const h = 1e-6
  for (const curve of CURVES) {
    const co = inflatorCoefficients(curve)
    const slopeBelow = (inflatorCurve(1, co) - inflatorCurve(1 - h, co)) / h
    assert.ok(Math.abs(slopeBelow) < 1e-4, `Curve ${curve}: slope at 1 is ${slopeBelow}`)
    // ...and the fold-back leaves at the same value with the same slope.
    const slopeAbove = (inflatorCurve(1 + h, co) - inflatorCurve(1, co)) / h
    assert.ok(Math.abs(slopeAbove) < 1e-4, `Curve ${curve}: fold-back slope ${slopeAbove}`)
  }
})

test('the curve is monotonic and bounded by 1 on [0, 1], at every setting', () => {
  // No instantaneous fold in the region the signal normally occupies, and
  // nothing that can exceed full scale. Swept rather than argued: the quartic
  // has enough freedom to bulge past 1 for the wrong D, which is exactly the
  // failure a plugin promising a fixed ceiling must not have.
  for (const curve of CURVES) {
    const co = inflatorCoefficients(curve)
    let prev = 0
    for (let i = 0; i <= 4000; i++) {
      const y = inflatorCurve(i / 4000, co)
      assert.ok(y >= prev - 1e-12, `Curve ${curve}: not monotonic at s=${i / 4000}`)
      assert.ok(y <= 1 + 1e-12, `Curve ${curve}: exceeded 1 at s=${i / 4000} (${y})`)
      prev = y
    }
  }
})

test('above full scale the curve folds back and is Curve-independent', () => {
  // 2s - s^2, falling from 1 at s=1 to 0 at s=2, the same at every Curve. This
  // is the behaviour the Clip switch exists to prevent, so it has to be real
  // rather than a clip in disguise — a sample 6 dB over comes out at ZERO.
  for (const curve of CURVES) {
    const co = inflatorCoefficients(curve)
    assert.ok(Math.abs(inflatorCurve(1.5, co) - 0.75) < 1e-12)
    assert.equal(inflatorCurve(2, co), 0)
    // Continuous into the guard branch rather than stepping to it.
    assert.ok(Math.abs(inflatorCurve(2.0001, co)) < 1e-3)
  }
})

test('the curve is odd, so it generates odd harmonics only', () => {
  // f(-x) = -f(x) exactly. The soft clipper records the same property and what
  // it costs: no setting of this stage can reach second-order warmth. Worth
  // pinning so nobody looks for an even-harmonic control that cannot exist.
  const co = inflatorCoefficients(30)
  for (let i = 1; i <= 200; i++) {
    const x = i / 100
    assert.equal(inflatorCurve(-x, co), -inflatorCurve(x, co), `not odd at ${x}`)
  }
})

test('Curve is clamped to its stated range rather than extrapolating', () => {
  const beyond = inflatorCoefficients(CURVE_MAX_PCT + 40)
  const atMax = inflatorCoefficients(CURVE_MAX_PCT)
  assert.deepEqual(beyond, atMax)
  const below = inflatorCoefficients(CURVE_MIN_PCT - 40)
  assert.deepEqual(below, inflatorCoefficients(CURVE_MIN_PCT))
})

// ── The band split ──────────────────────────────────────────────────────────

test('the three bands sum to the input exactly, sample for sample', () => {
  // The bands are DIFFERENCES of two lowpasses, so reconstruction is exact by
  // construction rather than flat to a tolerance — bandSplitLimiter's LR4
  // split manages 0.06 dB, this one manages zero. That is what makes
  // "Effect 0 is the dry signal" true at the sample level with Split on.
  const split = new InflatorBandSplit(SR * 4)
  const sig = tone(4096, 700, 0.8)
  let worst = 0
  for (let i = 0; i < sig.length; i++) {
    const b = split.process(sig[i])
    worst = Math.max(worst, Math.abs(b.low + b.mid + b.high - sig[i]))
  }
  assert.ok(worst < 1e-15, `split does not reconstruct: worst ${worst}`)
})

test('the split actually splits — each band takes its own part of the spectrum', () => {
  // A reconstruction test passes for a split that puts everything in one band,
  // so the sum test above cannot stand alone. 60 Hz should land in low, 700 Hz
  // in mid, 9 kHz in high.
  const probe = (freq) => {
    const split = new InflatorBandSplit(SR)
    const sig = tone(SR, freq, 0.5)
    const lo = new Float64Array(sig.length)
    const mi = new Float64Array(sig.length)
    const hi = new Float64Array(sig.length)
    for (let i = 0; i < sig.length; i++) {
      const b = split.process(sig[i])
      lo[i] = b.low; mi[i] = b.mid; hi[i] = b.high
    }
    const skip = SR / 2
    return { low: rms(lo, skip), mid: rms(mi, skip), high: rms(hi, skip) }
  }
  const low = probe(60)
  assert.ok(low.low > low.mid && low.low > low.high, '60 Hz did not land in the low band')
  const mid = probe(700)
  assert.ok(mid.mid > mid.low && mid.mid > mid.high, '700 Hz did not land in the mid band')
  const high = probe(9000)
  assert.ok(high.high > high.mid && high.high > high.low, '9 kHz did not land in the high band')
})

test('the mid band drive G is derived from the coefficients, and moves with rate', () => {
  // G is not a taste constant: it falls out of the two filter coefficients, so
  // it has to be COMPUTED at whatever rate the split runs at. Building the
  // split at the base rate and running it oversampled would drive the mid band
  // by the wrong amount — small, and wrong for no reason.
  const base = new InflatorBandSplit(SR)
  const over = new InflatorBandSplit(SR * 4)
  assert.ok(Math.abs(base.g - 1.1099) < 1e-3, `base-rate G ${base.g}`)
  assert.ok(Math.abs(over.g - 1.1110) < 1e-3, `4x G ${over.g}`)
  assert.notEqual(base.g, over.g)
  // GR undoes G exactly, so the band comes back at unity and what survives is
  // only the extra curvature it saw.
  for (const s of [base, over]) assert.ok(Math.abs(s.g * s.gInv - 1) < 1e-15)
})

test('the crossovers are the reference values and are not parameters', () => {
  assert.equal(SPLIT_LOW_HZ, 240)
  assert.equal(SPLIT_HIGH_HZ, 2400)
})

// ── The kernel ──────────────────────────────────────────────────────────────

test('Effect 0 is the dry signal exactly, delayed by the reported latency', () => {
  // ABSENT AT ZERO, NOT RUN-AND-DISCARDED. The oversampler's own reconstruction
  // error is about -70 dBc even with the curve idle, so a version that ran the
  // wet path and multiplied it by zero would be inaudibly but measurably wrong.
  // Asserted at ZERO error, which is what catches that.
  const n = 8192
  const sig = tone(n, 220, 0.5)
  const { channelData, latencySamples } = processInflatorBuffer([sig], SR, { effect: 0 })
  assert.equal(latencySamples, INFLATOR_LATENCY_SAMPLES)
  let worst = 0
  for (let i = 1000; i < n; i++) {
    worst = Math.max(worst, Math.abs(channelData[0][i] - sig[i - INFLATOR_LATENCY_SAMPLES]))
  }
  assert.equal(worst, 0, `Effect 0 is not bit-exact dry: worst ${worst}`)
})

test('latency is constant across every setting, Effect 0 included', () => {
  // The apply path trims a fixed count. A stage whose delay moved with a knob
  // would shift the region on the timeline mid-drag — the bug the soft
  // clipper's apply path actually shipped, trimming 50 samples off a
  // 226-sample render.
  const patches = [
    {}, { effect: 0 }, { effect: 1 }, { curve: 50 }, { curve: -50 },
    { clip: true }, { bandSplit: true }, { bandSplit: true, clip: true, effect: 1 },
    { inputDb: 12, outputDb: -12 },
  ]
  for (const p of patches) {
    const k = new InflatorKernel(SR)
    k.setParams(p)
    assert.equal(k.latencySamples, INFLATOR_LATENCY_SAMPLES, `latency moved for ${JSON.stringify(p)}`)
  }
})

test('an impulse comes out where the reported latency says it does', () => {
  // Finds where the impulse ACTUALLY lands rather than trusting the getter —
  // the check that catches a delay line sized 2L+1 instead of 2L, which is a
  // read-before-write error this codebase has hit before.
  const n = 2048
  const imp = new Float32Array(n)
  imp[200] = 0.5
  const { channelData } = processInflatorBuffer([imp], SR, { effect: 0 })
  let argmax = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(channelData[0][i]) > Math.abs(channelData[0][argmax])) argmax = i
  }
  assert.equal(argmax, 200 + INFLATOR_LATENCY_SAMPLES)
})

test('it raises quiet material without moving the peak', () => {
  // The claim the plugin is FOR, end to end through the kernel rather than
  // through the bare curve. A full-scale tone comes back at full scale; a quiet
  // one comes back louder.
  const n = 16384
  const loud = tone(n, 300, 1.0)
  const quiet = tone(n, 300, 0.1)
  const wetLoud = processInflatorBuffer([loud], SR, { effect: 1 }).channelData[0]
  const wetQuiet = processInflatorBuffer([quiet], SR, { effect: 1 }).channelData[0]

  // The peak of a full-scale input is held at full scale — within the
  // resampler's ripple, which is what the tolerance is for.
  assert.ok(Math.abs(peak(wetLoud, 2000) - 1) < 0.02, `peak moved: ${peak(wetLoud, 2000)}`)
  // The quiet one is lifted by close to the small-signal figure.
  const liftDb = 20 * Math.log10(rms(wetQuiet, 2000) / rms(quiet, 2000))
  assert.ok(liftDb > 3.0 && liftDb < 3.6, `quiet lift ${liftDb.toFixed(2)} dB`)
  // And the loud one is lifted much less — that gap IS the density.
  const loudLiftDb = 20 * Math.log10(rms(wetLoud, 2000) / rms(loud, 2000))
  assert.ok(loudLiftDb < liftDb - 1.5, `no density: quiet ${liftDb}, loud ${loudLiftDb}`)
})

test('Clip prevents the fold-back, which is what it is for', () => {
  // With Clip off, material over full scale folds toward zero and the output
  // gets QUIETER as the input gets louder. With Clip on it cannot happen.
  const n = 8192
  const over = tone(n, 300, 1.8)
  const folded = processInflatorBuffer([over], SR, { effect: 1, clip: false }).channelData[0]
  const clipped = processInflatorBuffer([over], SR, { effect: 1, clip: true }).channelData[0]
  // The folded version dips through zero at the waveform's crest; the clipped
  // one is flat-topped near full scale there.
  assert.ok(rms(clipped, 2000) > rms(folded, 2000) * 1.2,
    `clip did not prevent the fold: folded ${rms(folded, 2000)}, clipped ${rms(clipped, 2000)}`)

  // ⚠ CLIP IS NOT A BRICKWALL ON THE OUTPUT, AND MUST NOT BE SOLD AS ONE.
  // It clips at the OVERSAMPLED rate, and the downsampler then band-limits a
  // signal with flat tops in it — which overshoots. Measured here at 1.0002,
  // about +0.002 dB. That is inherent to clipping inside an oversampled path
  // and is true of the reference too; the alternative, clipping after the
  // downsampler, would put an unfiltered corner straight into the output and
  // alias. Anything that actually needs a guaranteed ceiling wants the soft
  // clipper's lookahead limiter, whose no-overshoot guarantee is structural.
  const overshoot = peak(clipped, 2000)
  assert.ok(overshoot > 1, 'the oversampled clip somehow did not overshoot — check the test')
  assert.ok(overshoot < 1.01, `clip overshoot is larger than expected: ${overshoot}`)
})

test('Input drives the curve and Output only ever cuts', () => {
  const n = 8192
  const sig = tone(n, 300, 0.2)
  const flat = processInflatorBuffer([sig], SR, { effect: 1 }).channelData[0]
  const driven = processInflatorBuffer([sig], SR, { effect: 1, inputDb: 12 }).channelData[0]
  assert.ok(rms(driven, 2000) > rms(flat, 2000), 'Input gain did not drive the curve')

  // Output is clamped to -12..0: a positive request cannot make it louder.
  const asked = processInflatorBuffer([sig], SR, { effect: 1, outputDb: 6 }).channelData[0]
  let worst = 0
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(asked[i] - flat[i]))
  assert.equal(worst, 0, 'Output accepted a boost')
})

test('band split changes the sound but not the level much, and reconstructs when idle', () => {
  const n = 16384
  const sig = tone(n, 700, 0.4)
  // With the curve idle (Effect 0) the split is not even reached, so this is
  // really a statement about the wet path being the only place it acts.
  const broad = processInflatorBuffer([sig], SR, { effect: 1, bandSplit: false }).channelData[0]
  const split = processInflatorBuffer([sig], SR, { effect: 1, bandSplit: true }).channelData[0]
  let diff = 0
  for (let i = 2000; i < n; i++) diff = Math.max(diff, Math.abs(broad[i] - split[i]))
  assert.ok(diff > 1e-4, 'band split is not wired — it changed nothing')
  // It is a character control, not a level control.
  const db = 20 * Math.log10(rms(split, 2000) / rms(broad, 2000))
  assert.ok(Math.abs(db) < 1.5, `band split moved the level by ${db.toFixed(2)} dB`)
})

test('stereo channels are independent and identical on identical input', () => {
  const n = 4096
  const a = tone(n, 300, 0.5)
  const b = tone(n, 300, 0.5)
  const { channelData } = processInflatorBuffer([a, b], SR, { effect: 1, bandSplit: true })
  for (let i = 0; i < n; i++) {
    assert.equal(channelData[0][i], channelData[1][i], `channels diverged at ${i}`)
  }
})

test('the shipped defaults are the reference\'s, except Effect', () => {
  // Recorded so a change to any of them is deliberate. Effect is ours: the
  // reference ships 0% because a VST must be silent until asked, and this app
  // opens plugins engaged.
  assert.equal(INFLATOR_KERNEL_DEFAULTS.curve, 0)
  assert.equal(INFLATOR_KERNEL_DEFAULTS.inputDb, 0)
  assert.equal(INFLATOR_KERNEL_DEFAULTS.outputDb, 0)
  assert.equal(INFLATOR_KERNEL_DEFAULTS.clip, false)
  assert.equal(INFLATOR_KERNEL_DEFAULTS.bandSplit, false)
  assert.equal(INFLATOR_KERNEL_DEFAULTS.effect, 0.5)
})

test('silence in, silence out', () => {
  const n = 2048
  const { channelData } = processInflatorBuffer([new Float32Array(n)], SR, {
    effect: 1, curve: 50, clip: true, bandSplit: true,
  })
  assert.equal(peak(channelData[0]), 0)
})

// ── Guards added after mutation testing ─────────────────────────────────────
// Six of the first seven mutations tried survived the suite above. These are
// the assertions that kill them; each names its mutation.

test('the curve matches a golden table — the D term is load-bearing', () => {
  // MUTATION: deleting the `- D*(s² - 2s³ + s⁴)` term entirely passed every
  // behavioural test above, because D affects neither f(0), f(1) nor f'(1) —
  // it is a bulge that vanishes at both ends. It is exactly what shapes the
  // middle of the curve, which is where the audio is, so it needs a golden
  // table rather than an endpoint check. Values computed from the verbatim
  // reference formula; at Curve 0 dropping D moves f(0.5) by 0.0039.
  const GOLDEN = [
    // Curve, f at s = 0.1, 0.25, 0.5, 0.75, 0.9, 1.0, 1.5
    [-50, [0.106975, 0.288085937500, 0.609375, 0.881835937500, 0.978975, 1, 0.75]],
    [0, [0.14899375, 0.364990234375, 0.68359375, 0.911865234375, 0.98499375, 1, 0.75]],
    [50, [0.19, 0.4375, 0.75, 0.9375, 0.99, 1, 0.75]],
  ]
  const points = [0.1, 0.25, 0.5, 0.75, 0.9, 1.0, 1.5]
  for (const [curve, expected] of GOLDEN) {
    const co = inflatorCoefficients(curve)
    points.forEach((s, i) => {
      const got = inflatorCurve(s, co)
      assert.ok(
        Math.abs(got - expected[i]) < 1e-9,
        `Curve ${curve} at s=${s}: got ${got}, expected ${expected[i]}`,
      )
    })
  }
})

test('the band-split path matches a golden vector', () => {
  // MUTATIONS THIS KILLS, none of which any behavioural test caught:
  //   - dropping the mid band's G drive (`curve(mid*G)*GR` -> `curve(mid)`)
  //   - building the split at the base rate instead of the oversampled one,
  //     which changes G from 1.1110 to 1.1099
  // Both are sub-dB effects on one band, invisible to a level or spectrum
  // assertion and perfectly visible to a sample comparison. Recorded from the
  // implementation verified against the reference above.
  const SRATE = 44100
  const n = 1024
  const sig = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    sig[i] = 0.6 * Math.sin((2 * Math.PI * 180 * i) / SRATE)
      + 0.3 * Math.sin((2 * Math.PI * 3000 * i) / SRATE)
  }
  const out = processInflatorBuffer([sig], SRATE, {
    effect: 1, bandSplit: true, curve: 25, inputDb: 3,
  }).channelData[0]

  const INDICES = [300, 400, 500, 600, 700, 800, 900, 1000]
  const GOLDEN = [
    0.227600038, -0.137323454, -1.41471577, 1.44612205,
    -0.434046298, 0.572175384, -0.325970680, -1.23388445,
  ]
  INDICES.forEach((idx, k) => {
    assert.ok(
      Math.abs(out[idx] - GOLDEN[k]) < 1e-6,
      `sample ${idx}: got ${out[idx]}, expected ${GOLDEN[k]}`,
    )
  })
})

test('the dry path carries Input Gain and Clip, because the dry is captured after them', () => {
  // MUTATION: capturing the dry from the raw input instead of the post-gain
  // signal. That would make Effect a blend between two signals at DIFFERENT
  // levels, i.e. a second input gain wearing a mix knob's label — which is
  // precisely the amount/character tangle this codebase keeps shipping.
  const n = 4096
  const sig = tone(n, 300, 0.2)
  const { channelData } = processInflatorBuffer([sig], SR, { effect: 0, inputDb: 6 })
  const g = Math.pow(10, 6 / 20)
  let worst = 0
  for (let i = 1000; i < n; i++) {
    worst = Math.max(worst, Math.abs(channelData[0][i] - sig[i - INFLATOR_LATENCY_SAMPLES] * g))
  }
  assert.ok(worst < 1e-6, `dry path did not carry input gain: worst ${worst}`)
})

test('the ±2 guard bounds the DRY path, which is the only thing it bounds', () => {
  // MUTATION: removing the clamp. It survived every test, and working out why
  // corrected my own understanding of it: the curve ALREADY returns 0 for
  // s >= 2, so the guard is redundant on the wet path. What it actually bounds
  // is the dry signal, which is captured from it — without it a +12 dB input
  // gain on hot material puts an unbounded dry signal into the blend.
  const n = 2048
  const hot = tone(n, 300, 1.0)
  const { channelData } = processInflatorBuffer([hot], SR, { effect: 0, inputDb: 12 })
  // 1.0 x +12 dB = 3.98, clamped to 2.
  assert.ok(peak(channelData[0], 500) <= 2 + 1e-6,
    `dry path exceeded the guard: ${peak(channelData[0], 500)}`)
  assert.ok(peak(channelData[0], 500) > 1.9, 'guard clamped harder than ±2')
})

test('BROADBAND the output never exceeds full scale — and BAND SPLIT does', () => {
  // ⚠ THE HEADLINE GUARANTEE IS BROADBAND-ONLY, and this is the test that says
  // so. f(s) <= 1 bounds the curve, so one curve on one signal cannot exceed
  // full scale. Band Split sums THREE curve outputs, each individually bounded
  // by 1, so their sum is not — measured at 1.38 (+2.8 dB over) on hot
  // material. That is the reference's behaviour, not a porting error, and it
  // is what the Clip switch is for in Split mode.
  const n = 16384
  const hot = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    hot[i] = 0.55 * Math.sin((2 * Math.PI * 150 * i) / SR)
      + 0.28 * Math.sin((2 * Math.PI * 900 * i) / SR)
      + 0.17 * Math.sin((2 * Math.PI * 5000 * i) / SR)
  }

  const broad = processInflatorBuffer([hot], SR, { effect: 1 }).channelData[0]
  assert.ok(peak(broad, 2000) <= 1.001, `broadband exceeded full scale: ${peak(broad, 2000)}`)

  const split = processInflatorBuffer([hot], SR, { effect: 1, bandSplit: true }).channelData[0]
  assert.ok(peak(split, 2000) > 1.2, `band split did not overshoot: ${peak(split, 2000)}`)

  // ...and Clip is the remedy, back to full scale plus the oversampled clip's
  // own small overshoot.
  const clipped = processInflatorBuffer([hot], SR, {
    effect: 1, bandSplit: true, clip: true,
  }).channelData[0]
  assert.ok(peak(clipped, 2000) < 1.02, `clip did not contain the split: ${peak(clipped, 2000)}`)
})

test('Effect blends linearly, and both code paths use the same dry signal', () => {
  // TWO MUTATIONS SURVIVED UNTIL THIS EXISTED, and they shared a cause:
  // nothing tested an INTERMEDIATE Effect. Every other test sits at 0 or 1,
  // where `wet * effect` is either skipped or a multiply by one — so dropping
  // the `* effect` on the wet side passed, and so did taking the dry from the
  // raw input, because the Effect-0 fast path is a different line of code from
  // the one the blend uses.
  //
  // Asserting the blend law directly covers both: out(e) must be exactly
  // dry*(1-e) + wet(1)*e, which can only hold if the wet side is scaled AND
  // the dry side is the same signal the fast path uses.
  const n = 8192
  const sig = tone(n, 300, 0.35)
  const opts = { inputDb: 4, curve: 20 }
  const dry = processInflatorBuffer([sig], SR, { ...opts, effect: 0 }).channelData[0]
  const wet = processInflatorBuffer([sig], SR, { ...opts, effect: 1 }).channelData[0]

  for (const e of [0.25, 0.5, 0.75]) {
    const mixed = processInflatorBuffer([sig], SR, { ...opts, effect: e }).channelData[0]
    let worst = 0
    for (let i = 1000; i < n; i++) {
      worst = Math.max(worst, Math.abs(mixed[i] - (dry[i] * (1 - e) + wet[i] * e)))
    }
    assert.ok(worst < 1e-6, `Effect ${e} is not a linear blend: worst ${worst}`)
  }
})
