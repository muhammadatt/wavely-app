/**
 * Run with:  npm test
 *
 * ⚠ THIS GUARDS AN UNWIRED MODULE, AND THAT IS THE POINT. dsp/tapeCharacter.js
 * has one live caller (Tube Saturation's HF Loss); the rest waits for the Tape
 * Saturation / combined Saturation-Distortion plugin that will use it. Tests
 * are what stop dormant code rotting — the same arrangement bandSplitLimiter.js
 * has.
 *
 * Most of these are recovered from the soft clipper's suite, where they guarded
 * the same components before they were extracted. Each one exists because
 * something went wrong once; the comments say what, because a test whose reason
 * is lost gets deleted the first time it is inconvenient.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SkewTracker, SoftenLimiter, HfLossShelf,
  asymmetryOffset, softenScale, softenRef, makeDcBlocker,
  ASYM_MAX_FRACTION, SKEW_DEADBAND, SKEW_TAU_S,
  HF_LOSS_MAX_DB, HF_LOSS_CORNER_HZ,
} from '../../src/audio/dsp/tapeCharacter.js'

const SR = 44100

function tone(seconds, freqHz, amp, sr = SR) {
  const n = Math.round(seconds * sr)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sr)
  return out
}

/**
 * A deliberately skewed waveform: asymmetric like a glottal pulse.
 *
 * ⚠ THE SECOND HARMONIC HAS TO BE IN QUADRATURE. `sin(p) + a*sin(2p)` measures
 * a third moment of EXACTLY ZERO however large `a` is — the first probe written
 * here did that and the tracker correctly refused to commit on it, which read
 * as the tracker being broken. `cos(2p)` leans the waveform; positive `lean`
 * gives negative skew.
 */
function skewed(seconds, freqHz, amp, lean, sr = SR) {
  const n = Math.round(seconds * sr)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * freqHz * i) / sr
    out[i] = amp * (Math.sin(ph) + lean * Math.cos(2 * ph))
  }
  return out
}

const rms = (b) => {
  let s = 0
  for (const v of b) s += v * v
  return Math.sqrt(s / b.length)
}

// ── Asymmetry ──────────────────────────────────────────────────────────────

test('the offset is absent at zero, so a stage using it stays bit-transparent', () => {
  // ABSENT, not flat. Every colour control in this family follows the rule:
  // the branch is skipped, so the patch that shipped before it existed is
  // bit-identical rather than close.
  assert.equal(asymmetryOffset(0, 1, 0.5), 0)
  assert.equal(asymmetryOffset(0, -1, 0.5), 0)
})

test('the offset cannot exceed the reference, which is what stops a fold', () => {
  // ⚠ THE ONE FAILURE THIS CONTROL EXISTS TO AVOID. The proof: with
  // `off <= reference` and a curve monotone with f(t) = t, any input past the
  // crossing returns at least `t - off`, non-negative exactly when the offset
  // is within the reference. Measured at frac 1.2, real samples change sign.
  //
  // So ASYM_MAX_FRACTION is a ceiling rather than a taste, and this asserts the
  // arithmetic that makes it one.
  for (const ref of [0.05, 0.25, 0.9]) {
    for (const amount of [1, 25, 60, 100]) {
      const off = Math.abs(asymmetryOffset(amount, 1, ref))
      assert.ok(off <= ref + 1e-12,
        `offset ${off} exceeds reference ${ref} at amount ${amount}`)
    }
  }
  assert.equal(ASYM_MAX_FRACTION, 1, 'the provable ceiling moved')
})

test('the offset scales to the reference rather than being absolute', () => {
  // A fixed offset destroys level invariance — the property that once made a
  // stage quietly stop working on quiet files (14.36 dB of reduction at
  // T = -6 dBFS against 0.53 at -30). Halve the reference, halve the offset.
  const a = asymmetryOffset(50, 1, 0.4)
  const b = asymmetryOffset(50, 1, 0.2)
  assert.ok(Math.abs(a - 2 * b) < 1e-12, `${a} is not twice ${b}`)
})

test('wrapped around a curve, the offset is exactly nothing below it', () => {
  // ⚠ THE STRUCTURAL FACT ABOUT ASYMMETRY: `curve(x + off) - off` is the
  // IDENTITY wherever the curve is transparent, because add-then-subtract
  // cancels. The offset has no effect of its own; it only repositions a curve.
  // Anyone reusing this must wrap a real nonlinearity or nothing happens.
  const T = 0.5
  const curve = (x) => (Math.abs(x) <= T ? x : Math.sign(x) * (T + (Math.abs(x) - T) * 0.5))
  const off = asymmetryOffset(100, 1, T)
  for (const x of [0, 0.05, -0.12, 0.2]) {
    // Below the shifted threshold on both sides, the round trip is exact.
    if (Math.abs(x + off) <= T) {
      assert.ok(Math.abs((curve(x + off) - off) - x) < 1e-12,
        `offset changed a transparent sample: ${x}`)
    }
  }
})

test('a DC blocker is available and does not boost', () => {
  // Butterworth, so no passband overshoot — which is what keeps a "never
  // boosts" guarantee intact through the blocker. It exists only because the
  // offset shifts the waveform, and at one operating point it looks
  // unnecessary: at ordinary settings the DC sits 70-90 dB down. Under drive an
  // input that already carries DC came out 5.1 dB below its own peak without it.
  const b = makeDcBlocker(SR)
  b.ensureChannels(1)
  // Long enough for a 2 Hz corner to settle from a step — the corner trades
  // settling against disturbance, and 2 Hz is the settling end of that trade.
  const sig = tone(4, 200, 0.5)
  const withDc = new Float32Array(sig.length)
  for (let i = 0; i < sig.length; i++) withDc[i] = sig[i] + 0.3
  const out = new Float32Array(sig.length)
  b.process(withDc, out, sig.length, 0)
  let mean = 0
  const from = out.length - SR
  for (let i = from; i < out.length; i++) mean += out[i]
  mean /= (out.length - from)
  assert.ok(Math.abs(mean) < 0.01, `DC survived at ${mean}`)
  let peak = 0
  for (let i = from; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
  assert.ok(peak <= 0.5 + 1e-3, `the blocker boosted: ${peak}`)
})

// ── The skew tracker ───────────────────────────────────────────────────────

test('only the SIGN comes from the skew — the magnitude must not', () => {
  // ⚠ THE MUTATION THAT SILENTLY TURNS THE KNOB OFF. `direction = -tanh(skew /
  // scale)` reads as an elegant continuous sign and commits properly on real
  // material — and gives ZERO offset on symmetric material, so the control does
  // nothing at any setting. It was caught only because even-harmonic energy
  // went to exactly zero on synthetic probes, which are sums of sines and
  // symmetric to the last bit.
  //
  // The property: on symmetric material the direction must still have unit
  // magnitude, so the offset is full-sized and the knob works.
  const t = new SkewTracker(SR)
  const sig = tone(6, 220, 0.4) // symmetric to the last bit
  for (const v of sig) t.update(v)
  assert.ok(Math.abs(Math.abs(t.direction) - 1) < 1e-6,
    `symmetric material gave direction ${t.direction} — the knob is off`)
  assert.ok(Math.abs(asymmetryOffset(100, t.direction, 0.5)) > 0.4,
    'the offset collapsed on symmetric material')
})

test('the sign waits for evidence, because the estimate is wrong early', () => {
  // ⚠ NOT MERELY IMPRECISE EARLY ON — LARGE AND WRONG, and the decision is
  // sticky, so one early excursion latches for the whole file. On a probe whose
  // settled skew is ~0, the running estimate reads 1.15 at 0.5 s. A build that
  // decided at a 500 ms warm-up latched the WRONG SIGN on symmetric material.
  //
  // This pins that nothing is decided before a full time constant of evidence.
  const t = new SkewTracker(SR)
  const sig = skewed(10, 150, 0.4, -0.6) // leans one way, unambiguously
  const half = Math.round(SKEW_TAU_S * SR * 0.5)
  for (let i = 0; i < half; i++) t.update(sig[i])
  assert.equal(t.sign, 1, 'the sign moved before its evidence window closed')
  for (let i = half; i < sig.length; i++) t.update(sig[i])
  assert.equal(t.sign, -1, 'the sign never committed on clearly skewed material')
})

test('the offset opposes the lean, whichever way the lean points', () => {
  // The whole purpose: even content is identical either way, but total
  // distortion is not, and the difference tracks the material's own lean —
  // 7.9 dB on a file at |skew| 1.47. A polarity flip must reverse the choice.
  const run = (lean) => {
    const t = new SkewTracker(SR)
    const sig = skewed(12, 150, 0.4, lean)
    for (const v of sig) t.update(v)
    return { sign: t.sign, skew: t.skew }
  }
  const pos = run(0.6)
  const neg = run(-0.6)
  assert.equal(Math.sign(pos.skew), -Math.sign(neg.skew), 'the probe is not actually skewed both ways')
  assert.equal(pos.sign, -neg.sign, 'the sign did not follow the lean')
  // And it opposes rather than follows.
  assert.equal(pos.sign, -Math.sign(pos.skew))
})

test('the direction travels rather than stepping', () => {
  // The offset only touches material already over the threshold, so a
  // discontinuity lands mid-syllable on exactly the loud samples the stage is
  // working on. 200 ms is far below the rate this is judged at and far above
  // anything that could click.
  const t = new SkewTracker(SR)
  const sig = skewed(12, 150, 0.4, -0.6)
  let biggestStep = 0
  let prev = t.direction
  for (const v of sig) {
    t.update(v)
    biggestStep = Math.max(biggestStep, Math.abs(t.direction - prev))
    prev = t.direction
  }
  assert.ok(biggestStep < 1e-3, `the direction stepped by ${biggestStep}`)
  assert.ok(Math.abs(t.direction + 1) < 0.05, `it never arrived: ${t.direction}`)
})

test('the deadband holds the sign on material with no opinion', () => {
  // Below the deadband the penalty the sign exists to avoid has vanished
  // anyway — measured, the two signs differ by 7.9 dB at |skew| 1.47 and 0.6 dB
  // at 0.58 — so dithering there would be motion for nothing.
  const t = new SkewTracker(SR)
  const sig = skewed(12, 150, 0.4, 0.02) // barely leaning
  for (const v of sig) t.update(v)
  assert.ok(Math.abs(t.skew) < SKEW_DEADBAND, `probe is not inside the deadband: ${t.skew}`)
  assert.equal(t.sign, 1, 'the sign moved on material inside the deadband')
})

// ── Soften ─────────────────────────────────────────────────────────────────

test('at scale 1 the limit provably cannot bind — Bernstein', () => {
  // The bound is exact only when the reference IS the amplitude bound the claim
  // is about. A signal bandlimited to the base Nyquist and bounded by A cannot
  // move more than (pi/L)*A per oversampled sample, so at scale 1 nothing legal
  // can trip it — and the round trip has to be exact, not approximate.
  const L = 4
  const lim = new SoftenLimiter(L)
  const ref = 0.5
  // Oversampled by construction: a base-rate-bandlimited tone read at L times
  // the rate.
  const n = 4096
  let worst = 0
  for (let i = 0; i < n; i++) {
    const x = ref * Math.sin((2 * Math.PI * (SR / 2) * i) / (L * SR))
    worst = Math.max(worst, Math.abs(lim.process(x, 1, ref) - x))
  }
  assert.ok(worst < 1e-9, `scale 1 bound a legal signal by ${worst}`)
  assert.ok(Math.abs(softenRef(L) - Math.PI / L) < 1e-12)
})

test('soften never boosts, at any setting', () => {
  // The output only ever moves TOWARD the input, so
  // |y| <= max(|y_prev|, |x|) at every sample. A limiter that could overshoot
  // would be a nonlinearity wearing an envelope's clothing.
  for (const amount of [10, 50, 100]) {
    const lim = new SoftenLimiter(4)
    const scale = softenScale(amount)
    let peakIn = 0, peakOut = 0
    for (let i = 0; i < 8192; i++) {
      const x = 0.6 * Math.sin((2 * Math.PI * 3000 * i) / (4 * SR))
      peakIn = Math.max(peakIn, Math.abs(x))
      peakOut = Math.max(peakOut, Math.abs(lim.process(x, scale, 0.5)))
    }
    assert.ok(peakOut <= peakIn + 1e-9, `amount ${amount} boosted ${peakIn} -> ${peakOut}`)
  }
})

test('the knob is monotonic, which is what catches an inverted mapping', () => {
  // ⚠ A MUTATION THAT SURVIVED FOUR ASSERTIONS: inverting the mapping. Every HF
  // test still passed, because a tone well over the threshold binds even at
  // scale 1 — Bernstein's promise covers material at or below the reference
  // only. Monotonicity across the knob is what catches it.
  const removed = (amount) => {
    const lim = new SoftenLimiter(4)
    const scale = softenScale(amount)
    const out = new Float32Array(8192)
    for (let i = 0; i < out.length; i++) {
      const x = 0.6 * Math.sin((2 * Math.PI * 6000 * i) / (4 * SR))
      out[i] = x - lim.process(x, scale, 0.5)
    }
    return rms(out)
  }
  const sweep = [0, 25, 50, 75, 100].map(removed)
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(sweep[i] >= sweep[i - 1] - 1e-9,
      `not monotonic across the knob: ${sweep.map(v => v.toExponential(2)).join(' ')}`)
  }
  assert.ok(sweep[4] > sweep[0], 'the knob does nothing at all')
})

test('soften scales with the reference, so it is level-relative', () => {
  // ⚠ AND THE REFERENCE HAS TO BE MOTIONLESS. While it was a speech-level
  // tracker, a live preview and an offline region render disagreed by
  // 1.5-2.3 dB, because the tracker starts cold offline. Anything reusing this
  // must reference it to a value that is the same at sample 0 as in steady
  // state.
  const removed = (ref) => {
    const lim = new SoftenLimiter(4)
    let acc = 0
    for (let i = 0; i < 8192; i++) {
      const x = 0.6 * Math.sin((2 * Math.PI * 6000 * i) / (4 * SR))
      const d = x - lim.process(x, softenScale(80), ref)
      acc += d * d
    }
    return Math.sqrt(acc / 8192)
  }
  assert.ok(removed(0.25) > removed(0.5), 'a smaller reference did not bite harder')
})

// ── HF Loss ────────────────────────────────────────────────────────────────

test('the shelf is exactly transparent at zero depth', () => {
  // EXACTLY, not approximately — that is the property the blend structure has
  // and a recomputed biquad would not.
  const shelf = new HfLossShelf(SR)
  const sig = tone(0.2, 1000, 0.5)
  const buf = Float32Array.from(sig)
  shelf.process(buf, buf.length, 0, 1)
  for (let i = 0; i < buf.length; i++) assert.equal(buf[i], sig[i], `sample ${i} moved`)
})

test('the shelf cuts highs, leaves lows, and cannot boost anywhere', () => {
  // ⚠ MUTATION CAUGHT: blending the wrong way round, which turns the cut into
  // the complementary boost. The never-boosts property is provable —
  // |g + (1-g)*LP| <= 1 for any 0 <= g <= 1 — and asserted so the proof cannot
  // quietly stop describing the code.
  const at = (freq, depthDb) => {
    const shelf = new HfLossShelf(SR)
    const sig = tone(0.5, freq, 0.5)
    const buf = Float32Array.from(sig)
    const gain = shelf.advance(depthDb, buf.length)
    shelf.process(buf, buf.length, 0, gain)
    const from = Math.round(0.2 * SR)
    return 20 * Math.log10(rms(buf.subarray(from)) / rms(sig.subarray(from)))
  }
  const full = [1000, 2000, 4000, 8000, 16000].map(f => at(f, HF_LOSS_MAX_DB))
  for (const v of full) assert.ok(v <= 0.01, `boosted: ${full.map(x => x.toFixed(2))}`)
  for (let i = 1; i < full.length; i++) {
    assert.ok(full[i] < full[i - 1], `not monotonic: ${full.map(x => x.toFixed(2))}`)
  }
  assert.ok(Math.abs(full[0]) < 0.5, `too much at 1 kHz: ${full[0].toFixed(2)}`)
  // Deeper at a deeper setting, at the frequency the control is about.
  assert.ok(at(8000, HF_LOSS_MAX_DB) < at(8000, HF_LOSS_MAX_DB / 2) - 1)
  assert.equal(HF_LOSS_CORNER_HZ, 4000, 'the corner moved — every figure above is against 4 kHz')
})

test('the depth ramp is shared and advances once per block, not per channel', () => {
  // ⚠ THE BUG IN THE INLINE VERSION THIS REPLACED. It advanced the ramp inside
  // the per-channel loop, so a 30 ms ramp converged in 15 on stereo — the rate
  // depended on the channel count. Inaudible on a parameter ramp, wrong, and
  // the kind of thing that becomes audible the moment someone lengthens the
  // constant.
  const a = new HfLossShelf(SR)
  const g1 = a.advance(HF_LOSS_MAX_DB, 128)
  const g2 = a.advance(HF_LOSS_MAX_DB, 128)
  assert.ok(g2 < g1, 'the ramp did not advance')

  // Two channels through one block must see ONE advance and the same gain.
  const b = new HfLossShelf(SR)
  const gain = b.advance(HF_LOSS_MAX_DB, 128)
  const left = new Float32Array(128).fill(0.4)
  const right = new Float32Array(128).fill(0.4)
  b.process(left, 128, 0, gain)
  b.process(right, 128, 1, gain)
  for (let i = 0; i < 128; i++) {
    assert.equal(left[i], right[i], `channels diverged at ${i}`)
  }
})

test('the shelf is static, not envelope-following', () => {
  // ⚠ MUTATION CAUGHT: making it follow the envelope — i.e. modelling gap loss
  // faithfully. Full depth on a loud syllable and none through the pause after
  // it is a room that BREATHES, which a listener hears as pumping long before
  // they hear the colour. At a settled depth the gain must not depend on what
  // the signal is doing.
  const shelf = new HfLossShelf(SR)
  const settle = shelf.advance(HF_LOSS_MAX_DB, SR) // one second: fully settled
  const quiet = new Float32Array(512).fill(0.001)
  const loud = new Float32Array(512).fill(0.9)
  const g1 = shelf.advance(HF_LOSS_MAX_DB, 512)
  shelf.process(quiet, 512, 0, g1)
  const g2 = shelf.advance(HF_LOSS_MAX_DB, 512)
  shelf.process(loud, 512, 1, g2)
  assert.ok(Math.abs(g1 - g2) < 1e-9, `the depth moved with the signal: ${g1} vs ${g2}`)
  assert.ok(Math.abs(g1 - settle) < 1e-6)
})
