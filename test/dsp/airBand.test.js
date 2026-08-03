/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AirBandKernel,
  airBandSections,
  processAirBandBuffer,
} from '../../src/audio/airBandProcessor.js'
import { magnitudeResponseDb } from '../../src/audio/dsp/biquad.js'
import { getFFT, rfftBinCount } from '../../src/audio/dsp/fft.js'

const SR = 44100
const N = 32768

/** True frequency response of the kernel, measured from its impulse response. */
function measuredResponseDb(params, freqs) {
  const amp = 0.25
  const imp = new Float32Array(N)
  imp[0] = amp
  const { channelData } = processAirBandBuffer([imp], SR, params)

  const fft = getFFT(N)
  const bins = rfftBinCount(N)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(channelData[0], re, im)

  return freqs.map(f => {
    const k = Math.round((f * N) / SR)
    return 20 * Math.log10(Math.hypot(re[k], im[k]) / amp)
  })
}

const PROBE = [100, 300, 600, 1200, 2400, 4800, 9600, 14000, 18000]

test('kernel response matches the curve the UI draws', () => {
  // AirBandModal renders magnitudeResponseDb(airBandSections(...)). If these
  // disagree the display is lying about what is being applied.
  for (const gainDb of [3, 6, 12]) {
    const analytic = magnitudeResponseDb(airBandSections(SR, gainDb), PROBE, SR)
    const measured = measuredResponseDb({ gainDb }, PROBE)
    for (let i = 0; i < PROBE.length; i++) {
      assert.ok(
        Math.abs(analytic[i] - measured[i]) < 0.02,
        `gain ${gainDb} at ${PROBE[i]} Hz: curve ${analytic[i].toFixed(4)}, kernel ${measured[i].toFixed(4)}`,
      )
    }
  }
})

test('gain scales linearly from the reference plateau', () => {
  // 6 dB is half of 12 dB in per-band gain terms, so the shelf plateau should
  // land near half as much lift.
  const at6 = measuredResponseDb({ gainDb: 6 }, [18000])[0]
  const at12 = measuredResponseDb({ gainDb: 12 }, [18000])[0]
  assert.ok(at6 > 4 && at6 < 7, `6 dB setting lifted ${at6.toFixed(2)} dB at 18 kHz`)
  assert.ok(
    Math.abs(at12 / at6 - 2) < 0.06,
    `expected roughly double, got ${at12.toFixed(2)} vs ${at6.toFixed(2)}`,
  )
})

test('is transparent at zero air', () => {
  const n = 4096
  const sig = new Float32Array(n)
  for (let i = 0; i < n; i++) sig[i] = 0.4 * Math.sin(i / 6) + 0.2 * Math.sin(i / 1.7)
  const { channelData } = processAirBandBuffer([sig], SR, { gainDb: 0 })
  let maxErr = 0
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(channelData[0][i] - sig[i]))
  assert.ok(maxErr < 1e-6, `not transparent at 0 dB: max error ${maxErr}`)
})

test('leaves the low end alone at operating gain', () => {
  // The whole point of the Maag shape: presence without touching body. At the
  // preset gain of 6 dB, sub-300 Hz must stay effectively untouched or the
  // stage would raise the noise floor it is meant to leave alone.
  const lf = measuredResponseDb({ gainDb: 6 }, [50, 100, 200, 300])
  for (const v of lf) assert.ok(Math.abs(v) < 0.03, `LF moved by ${v.toFixed(4)} dB`)
})

test('output trim is a clean gain', () => {
  const n = 2048
  const sig = new Float32Array(n)
  for (let i = 0; i < n; i++) sig[i] = 0.3 * Math.sin(i / 9)
  const flat = processAirBandBuffer([sig], SR, { gainDb: 4, outputGainDb: 0 }).channelData[0]
  const trimmed = processAirBandBuffer([sig], SR, { gainDb: 4, outputGainDb: -6 }).channelData[0]
  const expected = Math.pow(10, -6 / 20)
  for (let i = 512; i < n; i++) {
    assert.ok(
      Math.abs(trimmed[i] - flat[i] * expected) < 1e-6,
      `trim mismatch at ${i}`,
    )
  }
})

test('channels are filtered independently', () => {
  const n = 512
  const impulse = new Float32Array(n)
  impulse[0] = 1
  const silence = new Float32Array(n)
  const { channelData } = processAirBandBuffer([impulse, silence], SR, { gainDb: 8 })
  let energy = 0
  for (let i = 0; i < n; i++) energy += Math.abs(channelData[1][i])
  assert.equal(energy, 0, 'silent channel picked up the other channel’s impulse')
  assert.ok(channelData[0][0] !== 0, 'signal channel produced nothing')
})

test('block size does not change the result', () => {
  const n = 5000
  const sig = new Float32Array(n)
  for (let i = 0; i < n; i++) sig[i] = Math.sin(i / 11) * 0.3

  const oneShot = processAirBandBuffer([sig], SR, { gainDb: 6 }).channelData[0]

  const kernel = new AirBandKernel(SR)
  kernel.setParams({ gainDb: 6 })
  const chunked = new Float32Array(n)
  let off = 0
  for (const size of [1, 7, 128, 999, 333]) {
    while (off < n) {
      const len = Math.min(size, n - off)
      kernel.process(
        [sig.subarray(off, off + len)],
        [chunked.subarray(off, off + len)],
        len,
      )
      off += len
      if (len === size) break
    }
  }
  // Finish whatever remains in 128-sample blocks.
  while (off < n) {
    const len = Math.min(128, n - off)
    kernel.process([sig.subarray(off, off + len)], [chunked.subarray(off, off + len)], len)
    off += len
  }

  let maxErr = 0
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(oneShot[i] - chunked[i]))
  assert.ok(maxErr < 1e-6, `block-size dependence: max error ${maxErr}`)
})
