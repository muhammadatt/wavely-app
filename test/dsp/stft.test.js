/**
 * Run with:  npm test
 *
 * The reconstruction and latency tests here are the contract the resonance
 * suppressor depends on. If latency is not exactly fftSize, the offline apply
 * path trims the wrong amount and written-back audio is time-shifted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StftProcessor, hannPeriodic } from '../../src/audio/dsp/stft.js'

function noise(n, seed = 1) {
  // Deterministic LCG so failures are reproducible.
  let s = seed
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = (s / 0x3fffffff) - 1
  }
  return out
}

/** Push `input` through in blocks of `blockSize`, returning the output stream. */
function runBlocks(stft, input, blockSize, frameFn = null) {
  const out = new Float64Array(input.length)
  const inBlk = new Float64Array(blockSize)
  const outBlk = new Float64Array(blockSize)
  for (let i = 0; i < input.length; i += blockSize) {
    const n = Math.min(blockSize, input.length - i)
    for (let k = 0; k < n; k++) inBlk[k] = input[i + k]
    stft.process(inBlk, outBlk, n, frameFn)
    for (let k = 0; k < n; k++) out[i + k] = outBlk[k]
  }
  return out
}

test('hannPeriodic matches the scipy fftbins=True definition', () => {
  const w = hannPeriodic(8)
  assert.equal(w[0], 0)
  // Periodic (not symmetric): w[N/2] is the peak and w[N-1] !== w[1] mirror.
  assert.ok(Math.abs(w[4] - 1) < 1e-12)
  for (let i = 0; i < 8; i++) {
    const expected = 0.5 * (1 - Math.cos((2 * Math.PI * i) / 8))
    assert.ok(Math.abs(w[i] - expected) < 1e-15)
  }
})

test('rejects a hop that does not divide the fft size', () => {
  assert.throws(() => new StftProcessor({ fftSize: 2048, hopSize: 300 }), /multiple/)
})

test('reports latency of exactly fftSize', () => {
  const stft = new StftProcessor({ fftSize: 2048, hopSize: 512 })
  assert.equal(stft.latencySamples, 2048)
})

test('pass-through reconstructs the input delayed by exactly fftSize', () => {
  const fftSize = 2048
  const hopSize = 512
  const stft = new StftProcessor({ fftSize, hopSize })
  const n = 20000
  const input = noise(n)
  const output = runBlocks(stft, input, 128)

  // Compare output[i + latency] against input[i] over the fully-overlapped
  // region, skipping the ramp-in where fewer frames have accumulated.
  const latency = stft.latencySamples
  let maxErr = 0
  for (let i = fftSize; i + latency < n; i++) {
    maxErr = Math.max(maxErr, Math.abs(output[i + latency] - input[i]))
  }
  assert.ok(maxErr < 1e-9, `reconstruction error ${maxErr}`)
})

test('the measured delay is fftSize, not merely consistent', () => {
  // Independent check that does not assume the answer: cross-correlate an
  // impulse response to find where the energy actually lands.
  const fftSize = 1024
  const hopSize = 256
  const stft = new StftProcessor({ fftSize, hopSize })
  const n = 8192
  const input = new Float64Array(n)
  input[3000] = 1

  const output = runBlocks(stft, input, 128)
  let peakIdx = -1
  let peak = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(output[i]) > peak) {
      peak = Math.abs(output[i])
      peakIdx = i
    }
  }
  assert.ok(peak > 0.5, `impulse should survive, peak was ${peak}`)
  assert.equal(peakIdx - 3000, fftSize, `measured delay ${peakIdx - 3000}`)
})

test('output is independent of the block size it was fed in', () => {
  const n = 12000
  const input = noise(n, 7)
  const a = runBlocks(new StftProcessor({ fftSize: 1024, hopSize: 256 }), input, 128)
  const b = runBlocks(new StftProcessor({ fftSize: 1024, hopSize: 256 }), input, 999)
  const c = runBlocks(new StftProcessor({ fftSize: 1024, hopSize: 256 }), input, 1)
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-12, `block-size mismatch at ${i}`)
    assert.ok(Math.abs(a[i] - c[i]) < 1e-12, `single-sample mismatch at ${i}`)
  }
})

test('spectral modification takes effect', () => {
  // Zero every bin above 100 and confirm a high tone disappears while a low
  // tone survives — proves frameFn actually reaches the synthesis path.
  const sampleRate = 44100
  const fftSize = 2048
  const stft = new StftProcessor({ fftSize, hopSize: 512 })
  const n = 16384
  const input = new Float64Array(n)
  const lowHz = (40 * sampleRate) / fftSize
  const highHz = (400 * sampleRate) / fftSize
  for (let i = 0; i < n; i++) {
    input[i] =
      0.5 * Math.sin((2 * Math.PI * lowHz * i) / sampleRate) +
      0.5 * Math.sin((2 * Math.PI * highHz * i) / sampleRate)
  }

  const output = runBlocks(stft, input, 128, (re, im, bins) => {
    for (let k = 100; k < bins; k++) {
      re[k] = 0
      im[k] = 0
    }
  })

  // Measure residual energy at each tone in the settled region.
  const settled = output.subarray(4096, 12288)
  const goertzel = (buf, freq) => {
    let sr = 0
    let si = 0
    for (let i = 0; i < buf.length; i++) {
      const ang = (2 * Math.PI * freq * (i + 4096)) / sampleRate
      sr += buf[i] * Math.cos(ang)
      si += buf[i] * Math.sin(ang)
    }
    return (2 * Math.hypot(sr, si)) / buf.length
  }
  const lowAmp = goertzel(settled, lowHz)
  const highAmp = goertzel(settled, highHz)

  assert.ok(lowAmp > 0.4, `low tone should survive, amplitude ${lowAmp}`)
  assert.ok(highAmp < 0.01, `high tone should be removed, amplitude ${highAmp}`)
})

test('reset restores identical behaviour', () => {
  const input = noise(6000, 3)
  const stft = new StftProcessor({ fftSize: 1024, hopSize: 256 })
  const a = runBlocks(stft, input, 128)
  stft.reset()
  const b = runBlocks(stft, input, 128)
  for (let i = 0; i < input.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-15, `mismatch after reset at ${i}`)
  }
})
