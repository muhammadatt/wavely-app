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

test('THE INTERPOLATED PITCH STAYS INSIDE THE RANGE IT SEARCHED', () => {
  // Parabolic interpolation locates a peak lying BETWEEN three samples, so an
  // offset beyond half a sample is not an interpolation, it is a runaway. The
  // reference implementation leaves it unbounded, and measured on 46 s of real
  // narration inside a 70-400 Hz search that produced estimates up to 5664 Hz
  // and two negative ones — values that feed the harmonic mask's comb spacing
  // and the cepstral lifter's ceiling directly.
  //
  // Half a sample at the edge of the lag window can still round a hair outside
  // the range, so the bound here is the range plus one lag step rather than the
  // range exactly.
  const SR = 44100
  const N = 2048
  for (const [lo, hi] of [[70, 400], [40, 1200]]) {
    const tracker = new F0Tracker({ sampleRate: SR, frameSize: N, defaultF0: null })
    tracker.setRange(lo, hi)
    // The exact reachable extremes: the lag window's ends, each moved by the
    // half-sample the interpolation is now allowed. Quantising a frequency
    // range to integer lags is what makes these wider than [lo, hi].
    const hiBound = SR / (Math.floor(SR / hi) - 0.5)
    const loBound = SR / (Math.floor(SR / lo) + 0.5)
    for (let seed = 0; seed < 40; seed++) {
      // Deterministic noise and near-periodic junk: the shapes that make the
      // correlation flat, which is where the denominator goes to zero.
      const frame = new Float32Array(N)
      for (let i = 0; i < N; i++) {
        frame[i] = Math.sin(i * (0.31 + seed * 0.017)) * 0.4
          + Math.sin(i * 0.0007 * (seed + 1)) * 0.3
          + (((i * (seed + 7)) % 97) / 97 - 0.5) * 0.2
      }
      const { f0, pitched } = tracker.estimate(frame)
      if (!pitched) continue
      assert.ok(f0 > 0, `seed ${seed}: reported a non-positive pitch ${f0}`)
      assert.ok(f0 >= loBound - 1e-6 && f0 <= hiBound + 1e-6,
        `seed ${seed}: ${f0.toFixed(1)} Hz is outside the ${lo}-${hi} search `
        + `(reachable ${loBound.toFixed(1)}-${hiBound.toFixed(1)})`)
    }
  }
})

test('a peak pinned to the edge of the window is trusted only if it is a real peak', () => {
  // A source outside the search range leaves its correlation peak outside it
  // too, so the largest value INSIDE the window sits on the boundary and is not
  // a maximum of anything. Reporting it is how mains hum gets a confident,
  // rock-steady, wrong pitch — which is exactly what defeated humDetect's
  // concentration veto once the interpolation above stopped scattering it.
  //
  // But a source sitting legitimately AT the limit also pins to the edge, and a
  // tracker that cannot report its own maximum is broken. The discriminator is
  // whether the neighbours either side are lower: the correlation is computed
  // at every lag and only the search is bounded, so they are available.
  const SR = 44100
  const N = 2048
  const harmonic = (f0) => {
    const x = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      let v = 0
      for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * f0 * h * i) / SR) / h
      x[i] = 0.2 * v
    }
    return x
  }
  const at = (f0, lo, hi) => {
    const t = new F0Tracker({ sampleRate: SR, frameSize: N, defaultF0: null })
    t.setRange(lo, hi)
    return t.estimate(harmonic(f0))
  }
  // 60 Hz hum, searched for a voice: its period is outside the window entirely.
  assert.equal(at(60, 70, 400).pitched, false, '60 Hz hum should not read as a voice')
  // A source at the top of the range is a real peak and must still be found.
  const top = at(400, 70, 400)
  assert.equal(top.pitched, true, 'a source at the range limit must still be found')
  assert.ok(Math.abs(top.f0 - 400) < 5, `expected ~400 Hz, got ${top.f0}`)
  // And ordinary in-range material is untouched by either guard.
  const mid = at(150, 70, 400)
  assert.equal(mid.pitched, true)
  assert.ok(Math.abs(mid.f0 - 150) < 2, `expected ~150 Hz, got ${mid.f0}`)
})

test('matches the Python reference implementation', () => {
  // Golden values captured from server/scripts/estimate_f0_contour.py's
  // _autocorr_f0_batch run over identical frames. Cross-checked over 29 cases:
  // worst deviation 1.2e-9 Hz, zero voiced/unvoiced disagreements.
  //
  // Some of these are not "correct" pitches — saw440 falls above F0_MAX_HZ and
  // lands on an octave artefact. That one is pinned deliberately: it is a real
  // property of autocorrelation pitch tracking, and the contract is fidelity to
  // the reference so a future optimisation cannot quietly change behaviour.
  //
  // SAW65 IS THE ONE PLACE THIS DELIBERATELY DIVERGES FROM THE PYTHON, and it
  // is a defect there rather than a quirk worth keeping. 65 Hz is below the
  // 70 Hz search floor, so its correlation peak pins to the longest lag in the
  // window; the reference then runs an unbounded parabolic interpolation off
  // that pinned peak and reports 113.82 Hz with confidence. Measured on 46 s of
  // real narration the same runaway produced estimates up to 5664 Hz and two
  // NEGATIVE ones inside a 70–400 Hz search — values that go straight into the
  // harmonic mask's comb spacing. Bounding the offset to half a sample and
  // rejecting peaks pinned to the window edge makes this case report what is
  // true: no pitch in the range asked for.
  //
  // `server/scripts/estimate_f0_contour.py` still has the original and needs
  // this ported.
  const golden = [
    ['saw65', 65, null],
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
    if (expected === null) {
      assert.equal(f0, null, `${label}: expected no pitch, got ${f0}`)
      continue
    }
    assert.ok(
      f0 !== null && Math.abs(f0 - expected) < 1e-6,
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
