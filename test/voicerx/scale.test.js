/**
 * Scale invariance, asserted at the envelope rather than through the bands.
 *
 * WHY THIS TEST EXISTS. Both detectors floored their log-power spectrum with an
 * absolute `+ 1e-10`, which made the entire analysis depend on how loud the file
 * happened to be: bins below the constant were flattened up to it, bins above
 * kept their value, and applying gain moved which side of it a bin fell on. The
 * real-corpus invariance check caught the symptom — v2 dropped a 12.1 kHz band
 * on a gated file when the input was lifted 6 dB — and the first two attempts to
 * reproduce it BOTH FAILED, because they went through the full band pipeline
 * where the effect was under threshold on every synthetic case tried.
 *
 * That is the lesson worth keeping. An end-to-end check can only see a defect
 * large enough to change a decision, so it finds the bug on one file in
 * thirteen and misses it everywhere else. Asserting the invariant at the layer
 * that must hold it makes the same defect visible on any signal at all, and a
 * band cannot move if the envelope it came from cannot move.
 *
 * The property: multiplying the input by a constant must shift every bin of the
 * log envelope by exactly the same amount. Not approximately — a magnitude
 * spectrum genuinely cannot see gain, so any spread at all is a bug.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderCase, SR } from './signals.js'
import { CASES } from './cases.js'
import { measure } from '../../src/audio/voicerx/v2/envelope.js'
import { logPowerSpectrum } from '../../src/audio/voicerx/analysis.js'

const base = renderCase(CASES.find(c => c.name === 'clean male'))

function scaled(audio, g) {
  const out = new Float32Array(audio.length)
  for (let i = 0; i < audio.length; i++) out[i] = audio[i] * g
  return out
}

/**
 * Push the quietest frames down, the way a mastering gate does.
 *
 * 13 of the 31 real-corpus windows have pause floors below -80 dBFS and one
 * sits at -240; the synthetic corpus has none, which is the specific gap that
 * let this bug reach a real file first. The depths below straddle the old
 * constant rather than sitting safely to one side of it — the failure peaked in
 * a narrow window of levels, so -40 and -140 alone would have missed it.
 */
function gated(audio, depthDb) {
  const F = 1024
  const g = 10 ** (depthDb / 20)
  const out = Float32Array.from(audio)
  const energies = []
  for (let s = 0; s + F <= audio.length; s += F) {
    let sum = 0
    for (let i = 0; i < F; i++) sum += audio[s + i] ** 2
    energies.push(Math.sqrt(sum / F))
  }
  const threshold = [...energies].sort((a, b) => a - b)[Math.floor(energies.length * 0.3)]
  for (let f = 0, s = 0; s + F <= audio.length; s += F, f++) {
    if (energies[f] <= threshold) for (let i = 0; i < F; i++) out[s + i] *= g
  }
  return out
}

/** Largest disagreement between any two bins about how far the envelope moved. */
function shiftSpreadDb(a, b, freqsHz) {
  let lo = Infinity
  let hi = -Infinity
  for (let k = 1; k < a.length; k++) {
    if (freqsHz[k] < 60 || freqsHz[k] > 20000) continue
    const d = b[k] - a[k]
    if (d < lo) lo = d
    if (d > hi) hi = d
  }
  return hi - lo
}

test('logPowerSpectrum shifts by a constant when the input is scaled', () => {
  const bins = 64
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  // Deliberately enormous dynamic range: a strong low end falling away to bins
  // near nothing, which is the shape of a real voice frame and the shape that
  // an absolute floor mistreats.
  for (let k = 0; k < bins; k++) {
    re[k] = 10 ** (-k / 4)
    im[k] = 10 ** (-k / 5)
  }

  const out1 = new Float64Array(bins)
  const out2 = new Float64Array(bins)
  logPowerSpectrum(re, im, out1, bins)

  const g = 2
  const re2 = re.map(v => v * g)
  const im2 = im.map(v => v * g)
  logPowerSpectrum(re2, im2, out2, bins)

  const want = Math.log(g * g)
  for (let k = 0; k < bins; k++) {
    assert.ok(Math.abs((out2[k] - out1[k]) - want) < 1e-9,
      `bin ${k} moved by ${out2[k] - out1[k]}, expected ${want}`)
  }
})

test('a silent frame yields a flat spectrum rather than -Infinity', () => {
  const bins = 16
  const out = new Float64Array(bins)
  logPowerSpectrum(new Float64Array(bins), new Float64Array(bins), out, bins)
  for (let k = 0; k < bins; k++) assert.equal(out[k], 0)
})

for (const depthDb of [0, -30, -60, -90, -110]) {
  const label = depthDb === 0 ? 'ungated' : `pauses gated to ${depthDb} dB`
  test(`v2 envelope is scale-invariant — ${label}`, () => {
    const audio = depthDb === 0 ? base : gated(base, depthDb)
    const quiet = measure(audio, SR)
    const loud = measure(scaled(audio, 2), SR)
    assert.ok(quiet.ok && loud.ok, 'both analyses should run')

    const envSpread = shiftSpreadDb(quiet.envelopeDb, loud.envelopeDb, quiet.freqsHz)
    assert.ok(envSpread < 1e-6, `voiced envelope bins disagreed by ${envSpread.toFixed(4)} dB`)

    if (quiet.noiseDb && loud.noiseDb) {
      // The noise envelope is the one that actually broke: only v2 runs the
      // cepstrum on pause frames, which is why v1 held at 100% on the same
      // corpus while v2 did not.
      const noiseSpread = shiftSpreadDb(quiet.noiseDb, loud.noiseDb, quiet.freqsHz)
      assert.ok(noiseSpread < 1e-6, `noise envelope bins disagreed by ${noiseSpread.toFixed(4)} dB`)
    }
  })
}
