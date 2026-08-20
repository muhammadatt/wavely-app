/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { F0Tracker, F0_MIN_HZ, F0_MAX_HZ, MIN_CORR_RATIO } from '../../src/audio/dsp/f0.js'

const SR = 44100
const FRAME = 2048

/** Sawtooth — rich in harmonics, like a glottal source. */
function sawFrame(freqHz, n = FRAME, sampleRate = SR, phase = 0) {
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = ((freqHz * (i + phase)) / sampleRate) % 1
    out[i] = 2 * t - 1
  }
  return out
}

function makeTracker(opts = {}) {
  return new F0Tracker({ sampleRate: SR, frameSize: FRAME, ...opts })
}

test('estimates the pitch of a sawtooth across the vocal range', () => {
  for (const f of [80, 100, 120, 150, 200, 250, 300, 380]) {
    const t = makeTracker()
    const { f0, pitched } = t.estimate(sawFrame(f))
    assert.ok(pitched, `${f} Hz should read pitched`)
    const errCents = 1200 * Math.log2(f0 / f)
    assert.ok(
      Math.abs(errCents) < 25,
      `${f} Hz estimated ${f0.toFixed(2)} (${errCents.toFixed(1)} cents off)`,
    )
  }
})

test('parabolic interpolation is applied', () => {
  // 137 Hz lands between integer lags at 44.1 kHz (44100/137 = 321.9), so the
  // estimate must not be exactly sr/integerLag.
  const { f0 } = makeTracker().estimate(sawFrame(137))
  let nearestIntegerLagF0 = Infinity
  for (const lag of [321, 322, 323]) {
    if (Math.abs(SR / lag - f0) < Math.abs(nearestIntegerLagF0 - f0)) {
      nearestIntegerLagF0 = SR / lag
    }
  }
  assert.notEqual(f0, nearestIntegerLagF0)
  assert.ok(Math.abs(f0 - nearestIntegerLagF0) > 1e-6, 'interpolation had no effect')
})

test('matches the Python reference implementation', () => {
  // Golden values captured from server/scripts/estimate_f0_contour.py's
  // _autocorr_f0_batch run over identical frames. Cross-checked over 29 cases:
  // worst deviation 1.2e-9 Hz, zero voiced/unvoiced disagreements.
  //
  // Some of these are not "correct" pitches — saw65 and saw440 fall outside
  // [F0_MIN_HZ, F0_MAX_HZ] and land on octave artefacts. They are pinned
  // deliberately: the contract is fidelity to the reference, quirks included,
  // so a future optimisation cannot quietly change behaviour.
  const golden = [
    ['saw65', 65, 113.820707],
    ['saw80', 80, 80.012255],
    ['saw97.3', 97.3, 97.32528],
    ['saw118.7', 118.7, 118.661028],
    ['saw137', 137, 136.947433],
    ['saw173.2', 173.2, 173.164218],
    ['saw250', 250, 250.009401],
    ['saw400', 400, 400.250051],
    ['saw440', 440, 220.01977],
  ]
  for (const [label, inputHz, expected] of golden) {
    const { f0 } = makeTracker().estimate(sawFrame(inputHz))
    assert.ok(
      Math.abs(f0 - expected) < 1e-6,
      `${label}: expected ${expected}, got ${f0}`,
    )
  }
})

test('matches the reference on harmonic stacks and mixtures', () => {
  const harmonicStack = (f0Hz, firstHarmonic) => {
    const out = new Float64Array(FRAME)
    for (let i = 0; i < FRAME; i++) {
      let s = 0
      for (let h = firstHarmonic; h <= 12; h++) {
        s += (1 / h) * Math.sin((2 * Math.PI * f0Hz * h * i) / SR)
      }
      out[i] = s / 3
    }
    return out
  }

  // Full stack, and the missing-fundamental case — both should resolve to 150 Hz.
  assert.ok(Math.abs(makeTracker().estimate(harmonicStack(150, 1)).f0 - 150.167946) < 1e-6)
  assert.ok(Math.abs(makeTracker().estimate(harmonicStack(150, 2)).f0 - 150.138623) < 1e-6)

  // Two simultaneous pitches: the reference locks to the stronger one.
  const mix = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) {
    mix[i] =
      0.6 * (2 * (((120 * i) / SR) % 1) - 1) + 0.4 * (2 * (((190 * i) / SR) % 1) - 1)
  }
  assert.ok(Math.abs(makeTracker().estimate(mix).f0 - 119.863462) < 1e-6)
})

test('white noise is not reported as pitched', () => {
  const t = makeTracker()
  let s = 12345
  const frame = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    frame[i] = s / 0x3fffffff - 1
  }
  const { pitched } = t.estimate(frame)
  assert.equal(pitched, false, 'noise should fail the correlation-ratio gate')
})

test('silence is not reported as pitched', () => {
  const t = makeTracker()
  const { pitched, f0 } = t.estimate(new Float64Array(FRAME))
  assert.equal(pitched, false)
  assert.equal(f0, null)
})

test('the caller energy gate can veto an otherwise periodic frame', () => {
  const t = makeTracker()
  const { pitched } = t.estimate(sawFrame(150), false)
  assert.equal(pitched, false, 'energy gate should override the correlation gate')
})

test('is insensitive to DC offset', () => {
  const a = makeTracker().estimate(sawFrame(150)).f0
  const withDc = sawFrame(150)
  for (let i = 0; i < withDc.length; i++) withDc[i] += 0.7
  const b = makeTracker().estimate(withDc).f0
  assert.ok(Math.abs(a - b) < 1e-9, `DC changed the estimate: ${a} vs ${b}`)
})

test('rolling median tracks the source and ignores unpitched frames', () => {
  const t = makeTracker({ medianWindow: 5, defaultF0: 60 })
  assert.equal(t.median, 60, 'seeded default before any voiced frame')

  for (const f of [118, 122, 120, 119, 121]) t.estimate(sawFrame(f))
  assert.ok(Math.abs(t.median - 120) < 3, `median ${t.median}`)

  // Unvoiced frames must not enter the history.
  const before = t.median
  t.estimate(new Float64Array(FRAME))
  t.estimate(new Float64Array(FRAME))
  assert.equal(t.median, before, 'silence should not shift the median')
})

test('median window is bounded', () => {
  const t = makeTracker({ medianWindow: 4 })
  for (const f of [100, 100, 100, 100]) t.estimate(sawFrame(f))
  for (const f of [300, 300, 300, 300]) t.estimate(sawFrame(f))
  assert.ok(Math.abs(t.median - 300) < 10, `stale values retained: median ${t.median}`)
})

test('lag range brackets the configured F0 limits', () => {
  const t = makeTracker()
  assert.equal(t.lagMin, Math.floor(SR / F0_MAX_HZ))
  assert.equal(t.lagMax, Math.floor(SR / F0_MIN_HZ))
  // A tone below F0_MIN cannot be reported inside the range.
  const { f0, pitched } = makeTracker().estimate(sawFrame(45))
  if (pitched) {
    assert.ok(f0 >= F0_MIN_HZ - 5, `reported ${f0} below the search floor`)
  }
})

test('reset clears history', () => {
  const t = makeTracker({ defaultF0: 60 })
  t.estimate(sawFrame(200))
  assert.ok(Math.abs(t.median - 200) < 5)
  t.reset()
  assert.equal(t.median, 60)
})

// ── Voicing gate and hold ───────────────────────────────────────────────────

/**
 * Noisy signal with a weak periodic component — the kind of frame the default
 * gate admits and cannot actually measure.
 */
function weaklyPitched(f0, periodicAmp, seconds = 0.5) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  let s = 31337
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = 0.3 * (s / 0x3fffffff - 1) + periodicAmp * Math.sin((2 * Math.PI * f0 * i) / SR)
  }
  return out
}

test('the default gate is unchanged, so other consumers are untouched', () => {
  assert.equal(MIN_CORR_RATIO, 0.1)
  const t = makeTracker()
  assert.equal(t.minRatio, MIN_CORR_RATIO)
  assert.equal(t.holdFrames, 0)
})

test('a stricter gate rejects frames the default one admits', () => {
  // Measured on narration: of the frames scraping in just above the default
  // gate, 2% had a harmonic comb clear enough to verify independently, against
  // 71% of frames above 0.7. The gate is what separates them.
  const sig = weaklyPitched(150, 0.15)
  const frame = new Float32Array(FRAME)
  frame.set(sig.subarray(0, FRAME))

  const lenient = makeTracker().estimate(frame)
  const strict = makeTracker({ minRatio: 0.7 }).estimate(frame)
  assert.ok(lenient.ratio < 0.7, `probe is not weak enough: ratio ${lenient.ratio}`)
  assert.equal(lenient.pitched, true, 'the default gate should admit this frame')
  assert.equal(strict.pitched, false, 'a 0.7 gate should reject it')
})

test('the hold carries the last confident pitch, and only so far', () => {
  // THE HOLD IS THE HALF THAT MATTERS. A higher gate on its own converts a bad
  // pitch into NO pitch, and for the resonance suppressor no pitch means no
  // harmonic protection — switching the mask off mid-word is a worse failure
  // than a slightly stale mask.
  const t = makeTracker({ minRatio: 0.7, holdFrames: 3 })
  const strong = new Float32Array(FRAME)
  strong.set(sawFrame(200))
  const first = t.estimate(strong)
  assert.equal(first.pitched, true)
  assert.equal(first.held, false)
  assert.ok(Math.abs(first.f0 - 200) < 5)

  const weak = new Float32Array(FRAME)
  weak.set(weaklyPitched(150, 0.15).subarray(0, FRAME))
  for (let i = 1; i <= 3; i++) {
    const r = t.estimate(weak)
    assert.equal(r.pitched, true, `frame ${i} should still be held`)
    assert.equal(r.held, true)
    assert.ok(Math.abs(r.f0 - first.f0) < 1e-9, 'the held value should be the last confident one')
  }
  const past = t.estimate(weak)
  assert.equal(past.pitched, false, 'the hold must expire')
  assert.equal(past.f0, null)
})

test('the hold does not survive silence', () => {
  // It is gated on the caller's activity flag, so a pause ends it however many
  // frames are left. A mask held across a pause would land on the next word's
  // harmonics, which are not the ones it was built from.
  const t = makeTracker({ minRatio: 0.7, holdFrames: 100 })
  const strong = new Float32Array(FRAME)
  strong.set(sawFrame(200))
  t.estimate(strong)
  const silence = new Float32Array(FRAME)
  assert.equal(t.estimate(silence, false).pitched, false)
})

test('a held frame is not a measurement and stays out of the median', () => {
  const t = makeTracker({ minRatio: 0.7, holdFrames: 5 })
  const strong = new Float32Array(FRAME)
  strong.set(sawFrame(200))
  t.estimate(strong)
  const before = t.median
  const weak = new Float32Array(FRAME)
  weak.set(weaklyPitched(150, 0.15).subarray(0, FRAME))
  t.estimate(weak)
  t.estimate(weak)
  assert.equal(t.median, before, 'held frames must not enter the rolling median')
})

test('reset clears the hold', () => {
  const t = makeTracker({ minRatio: 0.7, holdFrames: 5 })
  const strong = new Float32Array(FRAME)
  strong.set(sawFrame(200))
  t.estimate(strong)
  t.reset()
  const weak = new Float32Array(FRAME)
  weak.set(weaklyPitched(150, 0.15).subarray(0, FRAME))
  assert.equal(t.estimate(weak).pitched, false, 'nothing should be left to hold')
})
