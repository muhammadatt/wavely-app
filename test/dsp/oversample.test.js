/**
 * Run with:  npm test
 *
 * The point of these is not that the filters are "correct" in the abstract, but
 * that the three properties the compressor kernels depend on actually hold:
 * the round trip is transparent in the band that matters, its latency is
 * exactly the advertised whole number of samples (the apply path trims by that
 * number, so an error here silently shifts audio on the timeline), and putting
 * a nonlinearity in the middle no longer folds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  halfbandTaps,
  Oversampler,
  DelayLine,
  OVERSAMPLE_FACTOR,
  OVERSAMPLE_LATENCY_SAMPLES,
  UPSAMPLE_DELAY_SAMPLES,
} from '../../src/audio/dsp/oversample.js'
import { getFFT } from '../../src/audio/dsp/fft.js'

const SR = 44100
const BLOCK = 128

/** Push a signal through up→(optional shaping)→down in 128-sample blocks. */
function roundTrip(input, shape = null) {
  const n = input.length
  const os = new Oversampler()
  const out = new Float64Array(n)
  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    const hi = os.up(input.subarray(off, off + len), len)
    if (shape) {
      for (let j = 0; j < len * OVERSAMPLE_FACTOR; j++) hi[j] = shape(hi[j])
    }
    os.down(out.subarray(off, off + len), len)
  }
  return out
}

function sine(freqHz, n, amp = 0.5) {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / SR)
  return x
}

test('halfband taps have the structural zeros the polyphase form assumes', () => {
  for (const length of [17, 21, 93]) {
    const h = halfbandTaps(length, 8)
    const M = (length - 1) / 2
    assert.equal(h[M], 0.5, `centre tap of ${length}-tap halfband`)
    for (let i = 0; i < length; i++) {
      if (i !== M && (i - M) % 2 === 0) {
        assert.equal(h[i], 0, `tap ${i} of ${length}-tap halfband must be exactly zero`)
      }
    }
  }
})

test('halfband taps sum to unity so the round trip is level-neutral', () => {
  for (const length of [17, 93]) {
    const h = halfbandTaps(length, 8)
    let sum = 0
    for (const t of h) sum += t
    assert.ok(Math.abs(sum - 1) < 1e-12, `sum ${sum}`)
  }
})

test('halfband length must be ≡ 1 (mod 4)', () => {
  assert.throws(() => halfbandTaps(31, 8), /mod 4/)
  assert.throws(() => halfbandTaps(64, 8), /mod 4/)
})

test('advertised delays are whole samples', () => {
  assert.ok(Number.isInteger(OVERSAMPLE_LATENCY_SAMPLES))
  assert.ok(Number.isInteger(UPSAMPLE_DELAY_SAMPLES))
  assert.equal(OVERSAMPLE_LATENCY_SAMPLES, 2 * UPSAMPLE_DELAY_SAMPLES)
})

test('round-trip latency is exactly OVERSAMPLE_LATENCY_SAMPLES', () => {
  const n = 1024
  const x = new Float32Array(n)
  x[0] = 1
  const y = roundTrip(x)

  let peak = 0
  let peakIndex = -1
  for (let i = 0; i < n; i++) {
    if (Math.abs(y[i]) > peak) {
      peak = Math.abs(y[i])
      peakIndex = i
    }
  }
  assert.equal(peakIndex, OVERSAMPLE_LATENCY_SAMPLES)
})

test('round trip is transparent through the voice band', () => {
  const n = 32768
  for (const freqHz of [100, 400, 1000, 3000, 8000, 12000, 16000, 19000]) {
    const x = sine(freqHz, n)
    const y = roundTrip(x)
    let err = 0
    let ref = 0
    for (let i = 4096; i < n - 1024; i++) {
      const d = y[i] - x[i - OVERSAMPLE_LATENCY_SAMPLES]
      err += d * d
      ref += x[i - OVERSAMPLE_LATENCY_SAMPLES] ** 2
    }
    const errDb = 10 * Math.log10(err / ref)
    assert.ok(errDb < -55, `${freqHz} Hz round-trip error ${errDb.toFixed(1)} dB`)
  }
})

test('round trip preserves level to within 0.02 dB below 19 kHz', () => {
  const n = 32768
  for (const freqHz of [50, 1000, 8000, 15000, 19000]) {
    const x = sine(freqHz, n)
    const y = roundTrip(x)
    let so = 0
    let si = 0
    for (let i = 8000; i < n - 1024; i++) {
      so += y[i] * y[i]
      si += x[i] * x[i]
    }
    const gainDb = 10 * Math.log10(so / si)
    assert.ok(Math.abs(gainDb) < 0.02, `${freqHz} Hz gain ${gainDb.toFixed(3)} dB`)
  }
})

test('a hard nonlinearity in the middle no longer folds into the band', () => {
  // tanh(4x) on a 9.2 kHz tone is the worst case the compressors can produce:
  // its third harmonic lands above Nyquist and, unprocessed, reflects to
  // 16.5 kHz. Anything not at a multiple of the fundamental is a folded image.
  const N = 65536
  const k0 = 13655 // ≈ 9189 Hz, chosen so harmonics land on distinct bins
  const n = SR * 2
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * k0 * i) / N)

  const shape = (v) => Math.tanh(4 * v)

  const worstAliasDbc = (out) => {
    const win = out.subarray(out.length - N)
    const w = new Float32Array(N)
    for (let i = 0; i < N; i++) w[i] = win[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
    const fft = getFFT(N)
    const re = new Float64Array(N / 2 + 1)
    const im = new Float64Array(N / 2 + 1)
    fft.rfft(w, re, im)
    const mag = (b) => re[b] * re[b] + im[b] * im[b]

    const isHarmonic = new Uint8Array(N / 2 + 1)
    for (let h = 1; h * k0 <= N / 2; h++) {
      for (let d = -40; d <= 40; d++) {
        const b = h * k0 + d
        if (b >= 0 && b <= N / 2) isHarmonic[b] = 1
      }
    }
    let worst = 0
    for (let b = 40; b <= N / 2; b++) {
      if (!isHarmonic[b] && mag(b) > worst) worst = mag(b)
    }
    return 10 * Math.log10(worst / mag(k0))
  }

  const naive = new Float64Array(n)
  for (let i = 0; i < n; i++) naive[i] = shape(x[i])
  const naiveDbc = worstAliasDbc(naive)
  const overDbc = worstAliasDbc(roundTrip(x, shape))

  assert.ok(naiveDbc > -30, `baseline should alias badly, got ${naiveDbc.toFixed(1)} dBc`)
  assert.ok(overDbc < -90, `oversampled alias ${overDbc.toFixed(1)} dBc`)
  assert.ok(
    naiveDbc - overDbc > 60,
    `expected >60 dB improvement, got ${(naiveDbc - overDbc).toFixed(1)} dB`,
  )
})

test('output does not depend on block size', () => {
  const n = 8192
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = 0.5 * Math.sin((2 * Math.PI * 1234 * i) / SR) * (1 + 0.7 * Math.sin((2 * Math.PI * 7 * i) / SR))
  }
  const shape = (v) => Math.tanh(2 * v)

  const withBlock = (B) => {
    const os = new Oversampler()
    const out = new Float64Array(n)
    for (let off = 0; off < n; off += B) {
      const len = Math.min(B, n - off)
      const hi = os.up(x.subarray(off, off + len), len)
      for (let j = 0; j < len * OVERSAMPLE_FACTOR; j++) hi[j] = shape(hi[j])
      os.down(out.subarray(off, off + len), len)
    }
    return out
  }

  const a = withBlock(128)
  for (const B of [64, 256, 333]) {
    const b = withBlock(B)
    let maxDiff = 0
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]))
    assert.ok(maxDiff < 1e-12, `block ${B} differs by ${maxDiff}`)
  }
})

test('DelayLine delays by exactly its length', () => {
  for (const len of [0, 1, 7, 50]) {
    const line = new DelayLine(len)
    const out = []
    for (let i = 0; i < 200; i++) out.push(line.push(i + 1))
    for (let i = len; i < 200; i++) {
      assert.equal(out[i], i + 1 - len, `length ${len} at ${i}`)
    }
  }
})

// ── 8x profile (COMPRESSOR_OVERSAMPLE_8X) ───────────────────────────────────

test('the 8x profile reconstructs as cleanly as the 4x one', async () => {
  // EXPERIMENTAL PATH, built to answer whether the soft clipper's residual is
  // fold-back from 4x. It is not on any shipping chain, but it has to be
  // correct or the answer it gives is worthless — two improvised instruments
  // had already produced confident nonsense on this question.
  const { Oversampler, COMPRESSOR_OVERSAMPLE, COMPRESSOR_OVERSAMPLE_8X } =
    await import('../../src/audio/dsp/oversample.js')
  const SR = 48000, N = SR
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR)
      + 0.2 * Math.sin((2 * Math.PI * 7000 * i) / SR)
  }
  for (const profile of [COMPRESSOR_OVERSAMPLE, COMPRESSOR_OVERSAMPLE_8X]) {
    const os = new Oversampler(profile)
    const y = new Float32Array(N)
    for (let o = 0; o < N; o += 128) {
      const n = Math.min(128, N - o)
      os.up(x.subarray(o, o + n), n)
      os.down(y.subarray(o, o + n), n)
    }
    const D = profile.latencySamples
    let e = 0, r = 0, c = 0
    for (let i = SR / 2; i + D < N; i++) { const d = y[i + D] - x[i]; e += d * d; r += x[i] * x[i]; c++ }
    const dbc = 20 * Math.log10(Math.sqrt(e / c) / Math.sqrt(r / c))
    assert.ok(dbc < -65,
      `${profile.name} round-trip error ${dbc.toFixed(1)} dBc — the path is broken`)
  }
})

test('the 8x latency is a whole number of base-rate samples, and differs from 4x', async () => {
  // ⚠ 52 RATHER THAN 50, so anything differencing the two paths must align on
  // each profile's own latency. Assuming they matched is exactly the class of
  // error that invalidated two earlier attempts at this measurement.
  const { COMPRESSOR_OVERSAMPLE, COMPRESSOR_OVERSAMPLE_8X } =
    await import('../../src/audio/dsp/oversample.js')
  assert.equal(COMPRESSOR_OVERSAMPLE.latencySamples, 50)
  assert.equal(COMPRESSOR_OVERSAMPLE_8X.latencySamples, 52)
  assert.equal(COMPRESSOR_OVERSAMPLE_8X.factor, 8)
  assert.ok(Number.isInteger(COMPRESSOR_OVERSAMPLE_8X.upsampleDelaySamples))
})

test('the soft clipper reports the latency of whichever profile it was given', async () => {
  const { SoftClipperKernel } = await import('../../src/audio/softClipperProcessor.js')
  assert.equal(new SoftClipperKernel(48000).latencySamples, 50)
  assert.equal(new SoftClipperKernel(48000, { oversample: 8 }).latencySamples, 52)
  // An unrecognised value must fall back to the shipping path rather than
  // producing a third behaviour.
  assert.equal(new SoftClipperKernel(48000, { oversample: 3 }).latencySamples, 50)
})
