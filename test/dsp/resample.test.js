/**
 * Save's sample-rate converter: length, passband gain, and that content above
 * the target's Nyquist is removed rather than folded back down.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resample, resampledLength } from '../../src/audio/dsp/resample.js'

function sine(freq, rate, seconds, amp = 0.5) {
  const n = Math.round(rate * seconds)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * i / rate)
  return out
}

/** Amplitude of `freq` in x by correlation over the middle (away from the edges). */
function toneAmp(x, freq, rate) {
  const a = Math.floor(x.length * 0.2), b = Math.floor(x.length * 0.8)
  let re = 0, im = 0
  for (let i = a; i < b; i++) {
    re += x[i] * Math.cos(2 * Math.PI * freq * i / rate)
    im += x[i] * Math.sin(2 * Math.PI * freq * i / rate)
  }
  return 2 * Math.hypot(re, im) / (b - a)
}

const db = r => 20 * Math.log10(r)

test('equal rates return the input untouched', () => {
  const x = sine(1000, 48000, 0.1)
  assert.equal(resample(x, 48000, 48000), x)
})

test('length scales by the ratio', () => {
  assert.equal(resampledLength(48000, 48000, 44100), 44100)
  assert.equal(resample(new Float32Array(4800), 48000, 44100).length, 4410)
  assert.equal(resample(new Float32Array(441), 44100, 96000).length, 960)
})

test('a 1 kHz tone keeps its level and frequency, down and up', () => {
  for (const [from, to] of [[48000, 44100], [44100, 48000], [44100, 22050], [32000, 96000]]) {
    const y = resample(sine(1000, from, 0.25), from, to)
    const a = toneAmp(y, 1000, to)
    assert.ok(Math.abs(db(a / 0.5)) < 0.01, `${from}→${to}: ${db(a / 0.5).toFixed(4)} dB`)
  }
})

test('passband is flat to within 0.05 dB at 18 kHz going 48 → 44.1 kHz', () => {
  const y = resample(sine(18000, 48000, 0.25), 48000, 44100)
  assert.ok(Math.abs(db(toneAmp(y, 18000, 44100) / 0.5)) < 0.05)
})

test('content above the new Nyquist is removed, not aliased', () => {
  // 23 kHz at 48 kHz would fold to 21.1 kHz at 44.1 kHz.
  const y = resample(sine(23000, 48000, 0.25), 48000, 44100)
  const alias = toneAmp(y, 44100 - 23000, 44100)
  assert.ok(db(alias / 0.5) < -80, `alias at ${db(alias / 0.5).toFixed(1)} dB`)
})
