import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LookaheadLimiter } from '../../src/audio/dsp/lookaheadLimiter.js'

const SR = 48000

function run(x, threshold, L = 96) {
  const lim = new LookaheadLimiter(L)
  const y = new Float32Array(x.length)
  const t = typeof threshold === 'number' ? () => threshold : threshold
  for (let i = 0; i < x.length; i++) y[i] = lim.processSample(x[i], t(i))
  return { y, lim }
}
function peak(x, from = 0) {
  let p = 0
  for (let i = from; i < x.length; i++) p = Math.max(p, Math.abs(x[i]))
  return p
}

test('the output never exceeds the threshold, on signals built to beat it', () => {
  // THE ONE PROPERTY THAT MATTERS. A limiter you can beat is not a limiter,
  // and the usual failure — smoothing the envelope until it no longer reaches
  // its target at the peak — is silent. These are the shapes that find it:
  // a bare impulse (nothing for the smoother to lean on), a step (asymmetric
  // window), back-to-back transients closer together than the lookahead, and
  // full-scale noise (every window different).
  const L = 96, N = SR
  const cases = {
    impulse: () => { const x = new Float32Array(N); x[N >> 1] = 0.99; return x },
    twoImpulses: () => { const x = new Float32Array(N); x[N >> 1] = 0.99; x[(N >> 1) + 40] = 0.95; return x },
    step: () => { const x = new Float32Array(N); for (let i = N >> 1; i < N; i++) x[i] = 0.9; return x },
    burstTrain: () => {
      const x = new Float32Array(N)
      for (let k = 0; k < 20; k++) {
        const at = 5000 + k * 700
        for (let i = 0; i < 30; i++) x[at + i] = 0.95 * Math.sin((Math.PI * i) / 30)
      }
      return x
    },
    noise: () => { const x = new Float32Array(N); let s = 7
      for (let i = 0; i < N; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = (s / 0x7fffffff) * 2 - 1 }
      return x },
    dc: () => new Float32Array(N).fill(0.8),
  }
  for (const [name, make] of Object.entries(cases)) {
    for (const T of [0.05, 0.2, 0.5]) {
      const { y } = run(make(), T, L)
      assert.ok(peak(y) <= T + 1e-6,
        `${name} at threshold ${T} overshot: ${peak(y).toFixed(6)}`)
    }
  }
})

test('it holds even when the threshold itself is moving', () => {
  // The stage's T is adaptive, so the limiter is asked for a different target
  // on every sample. The required gain is read against the sample arriving
  // now — which is `latencySamples` ahead of the one coming out — so a moving
  // threshold must not open a window where the guarantee lapses.
  const N = SR
  const x = new Float32Array(N)
  let s = 11
  for (let i = 0; i < N; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = ((s / 0x7fffffff) * 2 - 1) * 0.9 }
  const thr = i => 0.1 + 0.35 * (0.5 + 0.5 * Math.sin((2 * Math.PI * 3 * i) / SR))
  const lim = new LookaheadLimiter(96)
  let worst = 0
  const hist = []
  for (let i = 0; i < N; i++) {
    hist.push(thr(i))
    const out = lim.processSample(x[i], thr(i))
    // The output sample was the input from `latency` ago, and it was measured
    // against the threshold in force at THAT time.
    const at = i - lim.latencySamples
    if (at >= 0) worst = Math.max(worst, Math.abs(out) - hist[at])
  }
  assert.ok(worst <= 1e-6, `moving threshold overshot by ${worst.toExponential(2)}`)
})

test('a signal that NEVER reaches the threshold comes back exactly', () => {
  // ⚠ READ THE NAME CAREFULLY — this is much weaker than "unity below T", and
  // an earlier version of this test was called that. It is NOT true that
  // material below the threshold is left alone: the gain envelope is smoothed
  // over +/-L, so anything within L of a crossing is ducked whether or not it
  // is itself over T. Measured on real narration at a -14 dBFS threshold,
  // **24-36% of the sub-threshold samples are gain-reduced, by 2.2-5.4 dB on
  // average and up to 13 dB**. That is not a defect — it is what a smooth gain
  // envelope does, and it is the limiter's central difference from the curve,
  // which is unity below T sample by sample.
  //
  // What this test actually pins is the degenerate case: a signal with no
  // crossings anywhere gets gain 1 throughout, so the limiter is a pure delay.
  // Worth having, because a limiter that coloured even THAT would be broken.
  const N = 4096
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = 0.2 * Math.sin((2 * Math.PI * 700 * i) / SR)
  const { y, lim } = run(x, 0.5)
  const D = lim.latencySamples
  for (let i = 0; i + D < N; i++) {
    assert.equal(y[i + D], x[i], `sample ${i} was altered below the threshold`)
  }
})

test('the gain envelope moves smoothly enough not to be a distortion of its own', () => {
  // A gain that jumps per sample is a waveshaper wearing an envelope's
  // clothing — the exact thing this stage exists to avoid. The triangular
  // smoother bounds how fast it can move.
  const N = SR
  const x = new Float32Array(N)
  x[N >> 1] = 0.99
  const lim = new LookaheadLimiter(96)
  let worst = 0, prev = 1
  for (let i = 0; i < N; i++) {
    lim.processSample(x[i], 0.1)
    worst = Math.max(worst, Math.abs(lim.gain - prev))
    prev = lim.gain
  }
  // One boxcar of length L+1 can move by at most (max-min)/(L+1) per sample,
  // and there are two in cascade, so a full 1 -> 0.1 swing is spread out.
  assert.ok(worst < 0.02, `the gain jumped ${worst.toFixed(4)} in one sample`)
})

test('reset returns it to a clean state', () => {
  const N = 2048
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = 0.9 * Math.sin((2 * Math.PI * 300 * i) / SR)
  const lim = new LookaheadLimiter(64)
  // ⚠ Float64Array, not Float32Array. processSample returns a float64, so
  // storing it in a Float32Array truncates it and the comparison then fails on
  // the last bits — a test failure that looks exactly like a state leak.
  const first = new Float64Array(N)
  for (let i = 0; i < N; i++) first[i] = lim.processSample(x[i], 0.3)
  lim.reset()
  for (let i = 0; i < N; i++) {
    assert.equal(lim.processSample(x[i], 0.3), first[i], `sample ${i} differs after reset`)
  }
})

test('the envelope ducks sub-threshold material near a peak — the cost, pinned', () => {
  // THE PROPERTY THE PREVIOUS TEST DOES NOT COVER, asserted directly so the
  // limiter's central trade-off is written down rather than discovered by ear.
  // One isolated peak in otherwise quiet material: everything within the
  // smoothing window is pulled down with it.
  const SR = 48000, N = SR
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = 0.05 * Math.sin((2 * Math.PI * 150 * i) / SR)
  const at = N >> 1
  for (let i = 0; i < 40; i++) x[at + i] += 0.9 * Math.sin((Math.PI * i) / 40)
  const L = 96
  const lim = new LookaheadLimiter(L)
  const g = new Float32Array(N)
  for (let i = 0; i < N; i++) { lim.processSample(x[i], 0.2); g[i] = lim.gain }
  const D = lim.latencySamples
  // Well before the peak and outside the window: untouched.
  assert.ok(g[at - 4 * L + D] > 0.999, 'the envelope reached material far from the peak')
  // Just before the peak, and below the threshold: ducked anyway.
  assert.ok(g[at - Math.round(L / 2) + D] < 0.9,
    `the envelope did not duck ahead of the peak: ${g[at - Math.round(L / 2) + D].toFixed(3)}`)
  assert.ok(Math.abs(x[at - Math.round(L / 2)]) < 0.2,
    'the probe is wrong — that sample was over the threshold')
})

test('the smoothing window has to be long relative to the period, or it distorts', () => {
  // ⚠ A SECOND, SEPARABLE PROBLEM. If the window is shorter than a cycle the
  // gain follows the waveform rather than its envelope, which is harmonic
  // distortion of the bass rather than gain riding. Measured on a tone 3 dB
  // over the threshold: at L = 2 ms an 80 Hz tone comes out at -39 dBc, and at
  // L = 5 ms it is numerically clean. Above 200 Hz even 2 ms is clean.
  const SR = 48000, N = SR * 2
  const f0 = 80
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f0 * i) / SR)
  const T = 0.5 * Math.pow(10, -3 / 20)
  const distortion = (ms) => {
    const lim = new LookaheadLimiter(Math.round((ms / 1000) * SR))
    const y = new Float32Array(N)
    for (let i = 0; i < N; i++) y[i] = lim.processSample(x[i], T)
    const D = lim.latencySamples
    let num = 0, den = 0
    for (let i = SR; i + D < N; i++) { num += y[i + D] * x[i]; den += x[i] * x[i] }
    const gain = num / den
    let e = 0, sig = 0, c = 0
    for (let i = SR; i + D < N; i++) { const d = y[i + D] - gain * x[i]; e += d * d; sig += (gain * x[i]) ** 2; c++ }
    return 20 * Math.log10(Math.sqrt(e / c) / Math.sqrt(sig / c))
  }
  assert.ok(distortion(2) > -60, `the short window did not distort 80 Hz: ${distortion(2).toFixed(1)} dBc`)
  assert.ok(distortion(5) < -100, `the long window still distorts 80 Hz: ${distortion(5).toFixed(1)} dBc`)
})
