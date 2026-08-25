import test from 'node:test'
import assert from 'node:assert/strict'
import {
  measurePeakCeilingDb, CEILING_PRESETS, DEFAULT_CEILING_PRESET, presetById,
} from '../../src/audio/ceilingPresets.js'

const SR = 48000

/**
 * Narration-shaped probe: syllable bodies well below the peak, plus plosive
 * transients that reach it.
 *
 * ⚠ WHAT MATTERS IS THE SPREAD OF THE BLOCK-PEAK DISTRIBUTION. A probe whose
 * syllables are all the same loudness has almost none, so every percentile
 * lands within a dB of every other and a preset ladder measured on it looks
 * flat whether or not it works. Real narration has 8-12 dB between its typical
 * block peak and its loudest.
 */
function narration(seconds, peakDb, seed = 11) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const peakAmp = Math.pow(10, peakDb / 20)
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const burstN = Math.round(0.012 * SR)
  let i = 0
  let syl = 0
  while (i < n) {
    const sylN = Math.round((0.08 + rnd() * 0.14) * SR)
    const gapN = Math.round((0.02 + rnd() * 0.06) * SR)
    const amp = peakAmp * Math.pow(10, (-16 + 8 * rnd()) / 20)
    const f0 = 100 + rnd() * 60
    const plosive = syl++ % 5 === 0
    for (let j = 0; j < sylN && i < n; j++, i++) {
      const env = Math.sin((Math.PI * j) / sylN) ** 1.5
      const t = i / SR
      let v = (amp * env * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t)
        + 0.33 * Math.sin(6 * Math.PI * f0 * t) + 0.25 * Math.sin(8 * Math.PI * f0 * t))) / 2.08
      if (plosive && j < burstN) {
        const pe = 1 - j / burstN
        v += peakAmp * 0.95 * pe * pe * Math.sin((2 * Math.PI * 95 * j) / SR)
      }
      out[i] = v
    }
    for (let j = 0; j < gapN && i < n; j++, i++) out[i] = peakAmp * 0.002 * (rnd() - 0.5)
  }
  return out
}

test('the preset table is a descending ladder with a default that exists', () => {
  assert.ok(CEILING_PRESETS.length >= 2)
  for (let i = 1; i < CEILING_PRESETS.length; i++) {
    assert.ok(CEILING_PRESETS[i].percentile < CEILING_PRESETS[i - 1].percentile,
      `${CEILING_PRESETS[i].id} must clip more than ${CEILING_PRESETS[i - 1].id}`)
  }
  assert.ok(presetById(DEFAULT_CEILING_PRESET), 'the default preset must be in the table')
  assert.equal(presetById('nope'), null)
})

test('a lower percentile puts the ceiling lower — the ladder means what it says', () => {
  const sig = [narration(10, -1)]
  const ceilings = CEILING_PRESETS.map(p => measurePeakCeilingDb(sig, SR, p.percentile))
  for (const c of ceilings) assert.ok(Number.isFinite(c))
  for (let i = 1; i < ceilings.length; i++) {
    assert.ok(ceilings[i] < ceilings[i - 1],
      `${CEILING_PRESETS[i].id} ${ceilings[i].toFixed(2)} should sit below ${CEILING_PRESETS[i - 1].id} ${ceilings[i - 1].toFixed(2)}`)
  }
  // And the ladder should span something worth having — a few tenths of a dB
  // across four presets would make them indistinguishable in use.
  assert.ok(ceilings[0] - ceilings[ceilings.length - 1] > 2,
    `the ladder spans only ${(ceilings[0] - ceilings[ceilings.length - 1]).toFixed(2)} dB`)
})

test('the ceiling tracks level exactly — a quiet take gets the same treatment', () => {
  // This is the property that lets a named preset mean anything at all: the
  // same recording 12 dB quieter must get a ceiling 12 dB lower, or SOFT means
  // something different on every file.
  const base = narration(10, -1)
  for (const shift of [-18, -6, 6]) {
    const g = Math.pow(10, shift / 20)
    const moved = Float32Array.from(base, v => v * g)
    for (const p of [0.97, 0.85]) {
      const a = measurePeakCeilingDb([base], SR, p)
      const b = measurePeakCeilingDb([moved], SR, p)
      assert.ok(Math.abs(b - (a + shift)) < 0.01,
        `p${p} at ${shift} dB: moved by ${(b - a).toFixed(3)} dB`)
    }
  }
})

test('silence does not drag the ceiling down', () => {
  // Without the voiced floor, pauses and room tone dominate the distribution
  // and every percentile collapses toward the noise floor — the ceiling would
  // land tens of dB too low and the stage would shred the file.
  const speech = narration(6, -1)
  const padded = new Float32Array(speech.length * 3)
  padded.set(speech, 0)
  for (let i = speech.length; i < padded.length; i++) padded[i] = 1e-5 * ((i % 7) - 3)

  for (const p of [0.97, 0.93, 0.85, 0.78]) {
    const clean = measurePeakCeilingDb([speech], SR, p)
    const withSilence = measurePeakCeilingDb([padded], SR, p)
    assert.ok(Math.abs(withSilence - clean) < 3,
      `p${p}: ${clean.toFixed(2)} clean vs ${withSilence.toFixed(2)} with two thirds silence`)
  }
})

test('nothing measurable returns null rather than a number', () => {
  assert.equal(measurePeakCeilingDb([new Float32Array(0)], SR, 0.9), null)
  assert.equal(measurePeakCeilingDb([new Float32Array(10)], SR, 0.9), null, 'shorter than a block')
  assert.equal(measurePeakCeilingDb([new Float32Array(SR)], SR, 0.9), null, 'digital silence')
})

test('the loudest channel decides — a peak ceiling has to answer to it', () => {
  const loud = narration(6, -1)
  const quiet = Float32Array.from(loud, v => v * 0.1)
  const mono = measurePeakCeilingDb([loud], SR, 0.9)
  const stereo = measurePeakCeilingDb([quiet, loud], SR, 0.9)
  assert.ok(Math.abs(stereo - mono) < 0.01,
    `a quiet second channel moved the ceiling by ${(stereo - mono).toFixed(3)} dB`)
})
