import { test } from 'node:test'
import assert from 'node:assert/strict'

import { expint1, lsaGain, learnNoiseProfile } from '../../src/audio/dsp/spectralDenoise.js'
import { processDenoiserBuffer, DENOISER_LATENCY_SAMPLES } from '../../src/audio/denoiserProcessor.js'

const SR = 44100

/** Deterministic white noise. */
function noise(n, amp, seed = 1) {
  let s = seed >>> 0
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = ((s / 4294967296) * 2 - 1) * amp
  }
  return out
}

/** A crude voiced "phrase": harmonics of 140 Hz, on for 1 s, off for 0.6 s. */
function phrases(n) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    if (t % 1.6 > 1) continue
    let v = 0
    for (let h = 1; h <= 20; h++) v += Math.sin(2 * Math.PI * 140 * h * t) / h
    out[i] = 0.15 * v
  }
  return out
}

function rmsDb(x, a = 0, b = x.length) {
  let acc = 0
  for (let i = a; i < b; i++) acc += x[i] * x[i]
  return 10 * Math.log10(acc / (b - a) + 1e-30)
}

test('E1 matches known values', () => {
  // E1(0.5) = 0.5597736, E1(1) = 0.2193839, E1(3) = 0.01304838
  assert.ok(Math.abs(expint1(0.5) - 0.5597736) < 1e-6)
  assert.ok(Math.abs(expint1(1) - 0.2193839) < 1e-4)
  assert.ok(Math.abs(expint1(3) - 0.01304838) < 1e-5)
})

test('the LSA gain is in (0, 1], rises with SNR and tends to the Wiener gain at high SNR', () => {
  assert.ok(lsaGain(0.01, 1) > 0 && lsaGain(0.01, 1) < 0.2)
  assert.ok(lsaGain(1, 2) < lsaGain(10, 11))
  assert.ok(Math.abs(lsaGain(100, 101) - 100 / 101) < 1e-3)
  assert.ok(lsaGain(1e-3, 1e-3) <= 1)
})

test('auto profile learning finds the pauses and reports the gap', () => {
  const n = SR * 8
  const v = phrases(n)
  const nz = noise(n, 0.01)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = v[i] + nz[i]
  const p = learnNoiseProfile(x)
  assert.ok(p.ok)
  // Uniform noise of amplitude 0.01 has RMS 0.01/√3 → −44.8 dBFS.
  assert.ok(Math.abs(p.noiseDb - -44.8) < 1.5, `noise ${p.noiseDb}`)
  assert.ok(p.gapDb > 20, `gap ${p.gapDb}`)
})

test('no profile: a pure delay of the latency', () => {
  const x = noise(SR, 0.3)
  const { channelData } = processDenoiserBuffer([x], SR, { profile: null })
  const y = channelData[0]
  let maxErr = 0
  for (let i = DENOISER_LATENCY_SAMPLES; i < x.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(y[i] - x[i - DENOISER_LATENCY_SAMPLES]))
  }
  assert.ok(maxErr < 1e-6, `max error ${maxErr}`)
})

test('noise in the pauses drops by about the Reduction, the voice is barely touched', () => {
  const n = SR * 8
  const v = phrases(n)
  const nz = noise(n, 0.01, 7)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = v[i] + nz[i]
  const { profile } = learnNoiseProfile(x)

  const L = DENOISER_LATENCY_SAMPLES
  const { channelData } = processDenoiserBuffer([x], SR, { profile, reductionDb: 12 })
  const y = channelData[0].subarray(L)

  // A pause well inside the file: the cycle is 1.6 s with the voice off for its last 0.6, so 5.8–6.4 s.
  const a = Math.round(5.9 * SR), b = Math.round(6.3 * SR)
  const drop = rmsDb(x, a, b) - rmsDb(y, a, b)
  assert.ok(drop > 9 && drop < 13, `pause drop ${drop.toFixed(2)} dB`)

  // In a phrase the voice dominates; level must stay within 1 dB.
  const c = Math.round(4.9 * SR), d = Math.round(5.5 * SR)
  const voiceLoss = rmsDb(x, c, d) - rmsDb(y, c, d)
  assert.ok(Math.abs(voiceLoss) < 1, `voice change ${voiceLoss.toFixed(2)} dB`)

  // And the output is closer to the clean voice than the input was.
  let errIn = 0, errOut = 0
  for (let i = c; i < d; i++) {
    errIn += (x[i] - v[i]) ** 2
    errOut += (y[i] - v[i]) ** 2
  }
  assert.ok(errOut < errIn * 0.5, `in-phrase error ${10 * Math.log10(errOut / errIn)} dB`)
})

test('stereo: one shared gain, so identical channels stay identical', () => {
  const n = SR * 3
  const x = noise(n, 0.05, 3)
  const { profile } = learnNoiseProfile(x, { mode: 'all' })
  const { channelData } = processDenoiserBuffer([x, x], SR, { profile })
  for (let i = 0; i < n; i += 97) assert.equal(channelData[0][i], channelData[1][i])
})
