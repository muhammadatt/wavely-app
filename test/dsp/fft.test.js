/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FFT, getFFT, rfftBinCount, rfftFreqs } from '../../src/audio/dsp/fft.js'

/** Reference DFT — O(n²), used to pin the fast path at small sizes. */
function naiveDft(re, im) {
  const n = re.length
  const outRe = new Float64Array(n)
  const outIm = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let sr = 0
    let si = 0
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n
      const c = Math.cos(ang)
      const s = Math.sin(ang)
      sr += re[t] * c - im[t] * s
      si += re[t] * s + im[t] * c
    }
    outRe[k] = sr
    outIm[k] = si
  }
  return { outRe, outIm }
}

function maxAbsDiff(a, b) {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

test('rejects non-power-of-two sizes', () => {
  assert.throws(() => new FFT(1000), /power of two/)
  assert.throws(() => new FFT(1), /power of two/)
})

test('getFFT memoizes per size', () => {
  assert.equal(getFFT(256), getFFT(256))
  assert.notEqual(getFFT(256), getFFT(512))
})

test('forward matches a naive DFT', () => {
  const n = 64
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    re[i] = Math.sin((2 * Math.PI * 5 * i) / n) + 0.3 * Math.cos((2 * Math.PI * 11 * i) / n)
    im[i] = 0.1 * Math.sin((2 * Math.PI * 3 * i) / n)
  }
  const { outRe, outIm } = naiveDft(re, im)

  const fft = new FFT(n)
  fft.forward(re, im)

  assert.ok(maxAbsDiff(re, outRe) < 1e-10, `real diff ${maxAbsDiff(re, outRe)}`)
  assert.ok(maxAbsDiff(im, outIm) < 1e-10, `imag diff ${maxAbsDiff(im, outIm)}`)
})

test('inverse undoes forward', () => {
  const n = 256
  const fft = new FFT(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const re0 = new Float64Array(n)
  const im0 = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    re0[i] = re[i] = Math.random() * 2 - 1
    im0[i] = im[i] = Math.random() * 2 - 1
  }
  fft.forward(re, im)
  fft.inverse(re, im)
  assert.ok(maxAbsDiff(re, re0) < 1e-12)
  assert.ok(maxAbsDiff(im, im0) < 1e-12)
})

test('rfft of a pure tone puts all energy in one bin', () => {
  const n = 1024
  const sampleRate = 44100
  const bin = 64
  const freq = (bin * sampleRate) / n
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate)

  const fft = new FFT(n)
  const bins = rfftBinCount(n)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(x, re, im)

  const mag = k => Math.hypot(re[k], im[k])
  const peak = mag(bin)
  assert.ok(peak > n / 4, `expected a strong peak, got ${peak}`)
  for (let k = 0; k < bins; k++) {
    if (Math.abs(k - bin) <= 1) continue
    assert.ok(mag(k) < peak * 1e-6, `leakage at bin ${k}: ${mag(k)} vs peak ${peak}`)
  }
})

test('rfft/irfft round-trips real signals', () => {
  const n = 2048
  const fft = new FFT(n)
  const bins = rfftBinCount(n)
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = Math.random() * 2 - 1

  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  const y = new Float64Array(n)
  fft.rfft(x, re, im)
  fft.irfft(re, im, y)

  assert.ok(maxAbsDiff(x, y) < 1e-12, `round-trip error ${maxAbsDiff(x, y)}`)
})

test('irfft of a real half-spectrum is real and symmetric (the cepstrum path)', () => {
  // resonance_suppressor.py inverts a real-valued log-magnitude spectrum with
  // no imaginary part, relying on the result being real and symmetric.
  const n = 512
  const fft = new FFT(n)
  const bins = rfftBinCount(n)
  const magDb = new Float64Array(bins)
  for (let k = 0; k < bins; k++) magDb[k] = -20 + 10 * Math.sin(k / 7)

  const ceps = new Float64Array(n)
  fft.irfft(magDb, null, ceps)

  // Symmetric about zero quefrency: c[k] === c[n-k].
  for (let k = 1; k < n / 2; k++) {
    assert.ok(
      Math.abs(ceps[k] - ceps[n - k]) < 1e-12,
      `asymmetry at ${k}: ${ceps[k]} vs ${ceps[n - k]}`,
    )
  }

  // And the round trip back through rfft recovers the input.
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(ceps, re, im)
  // rfft returns the unscaled transform of a 1/N-scaled sequence, so undo it.
  for (let k = 0; k < bins; k++) re[k] *= 1
  assert.ok(maxAbsDiff(re, magDb) < 1e-10, `cepstral round-trip ${maxAbsDiff(re, magDb)}`)
})

test('rfftFreqs matches numpy rfftfreq', () => {
  const f = rfftFreqs(2048, 44100)
  assert.equal(f.length, 1025)
  assert.equal(f[0], 0)
  assert.ok(Math.abs(f[1] - 44100 / 2048) < 1e-12)
  assert.ok(Math.abs(f[1024] - 22050) < 1e-9)
})
