/**
 * Run with:  npm test
 *
 * CELL_MOD_SHAPE — the exponent on the T4 cell's ripple term.
 *
 * ⚠ THE POINT OF THESE TESTS IS THAT THE DEFAULT CHANGES NOTHING. The constant
 * exists so `npm run la2a:cellmod` has a dimension to fit against a hardware
 * capture; it ships at 1.0, which is the law that was already there. A kernel
 * that never sets it must be SAMPLE-IDENTICAL to one built before it existed,
 * not merely close — the shipped presets, the rendered files and the rest of
 * this suite all sit on that.
 *
 * ⚠ WHICH IS WHY THE KERNEL TAKES AN `=== 1` BRANCH RATHER THAN CALLING
 * `Math.pow(x, 1)`. The two agree to within a rounding error that is invisible
 * on any single sample and accumulates through the oversampled path, and
 * "invisible" is not the claim being made here.
 *
 * See CELL_MOD_SHAPE in la2aProcessor.js for what the exponent is for and what
 * the capture says about it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  processLA2ABuffer, CELL_MOD_SHAPE, CELL_MOD_MAX,
} from '../../src/audio/la2aProcessor.js'

const SR = 44100

/** Voice-ish: harmonic buzz gated into syllables, loud enough to compress. */
function stimulus(seconds = 2) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    phase += (2 * Math.PI * 130) / SR
    let s = 0
    for (let h = 1; h <= 10; h++) s += Math.sin(phase * h) / (h * h)
    x[i] = 0.6 * s * Math.max(0, Math.sin(2 * Math.PI * 3 * t)) ** 2
  }
  return x
}

const render = params => processLA2ABuffer([stimulus()], SR, {
  peakReduction: 65, tube: false, lookaheadMs: 0, gainDb: 0, ...params,
}).channelData[0]

test('CELL_MOD_SHAPE ships at the linear law', () => {
  assert.equal(CELL_MOD_SHAPE, 1.0)
})

test('the default is sample-identical to not passing the parameter at all', () => {
  const bare = render({})
  const explicit = render({ cellModShape: CELL_MOD_SHAPE })
  assert.equal(bare.length, explicit.length)
  for (let i = 0; i < bare.length; i++) {
    assert.equal(bare[i], explicit[i], `sample ${i} moved with an explicit default`)
  }
})

test('a non-default shape actually reaches the audio', () => {
  const bare = render({})
  const shaped = render({ cellModShape: 2.5 })
  let moved = 0
  for (let i = 0; i < bare.length; i++) if (bare[i] !== shaped[i]) moved++
  assert.ok(moved > bare.length * 0.25,
    `expected the shape to move most samples, moved ${moved}/${bare.length}`)
})

test('the shape is inert when the cell is off', () => {
  const off = render({ cellMod: 0 })
  const offShaped = render({ cellMod: 0, cellModShape: 3.0 })
  for (let i = 0; i < off.length; i++) {
    assert.equal(off[i], offShaped[i], `sample ${i} moved with the cell disabled`)
  }
})

/**
 * The behavioural claim the constant exists for: at a matched depth, a higher
 * exponent concentrates the cell's attenuation on the loudest samples.
 *
 * ⚠ MEASURED THE WAY THE BENCH MEASURES IT, WHICH IS NOT THE OBVIOUS WAY. The
 * first version of this test binned samples by amplitude against the WHOLE
 * signal's peak and read the result backwards — every band came back with a
 * GAIN, and the quiet bands with the most of it. That is correct behaviour
 * being measured wrongly: the cell's term is a RIPPLE about the smoothed
 * envelope (`rect / env - 1`), so it attenuates a waveform's crests and lifts
 * its troughs, and a global amplitude bin puts the troughs of a loud syllable
 * in the same bucket as a quiet one.
 *
 * So bands are fractions of EACH WINDOW's own peak, inside the loudest windows
 * only, against a local gain fitted below them — the same construction as
 * `npm run la2a:cellmod`, and for the same reason. See that script's header.
 */

/** dB below a local linear fit, per band of each window's own peak. */
function deviationProfile(dry, wet, sampleRate) {
  const W = Math.round(0.010 * sampleRate)
  const n = Math.floor(dry.length / W)
  const order = []
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let j = i * W; j < i * W + W; j++) sum += dry[j] * dry[j]
    order.push([sum, i])
  }
  const windows = order.sort((a, b) => b[0] - a[0]).slice(0, 120).map(p => p[1])
  const bands = [[0.40, 0.60], [0.90, 1.00]]
  const acc = bands.map(() => [])

  for (const i of windows) {
    let peak = 0
    for (let j = i * W; j < i * W + W; j++) peak = Math.max(peak, Math.abs(dry[j]))
    if (peak <= 0) continue
    let sxy = 0
    let sxx = 0
    for (let j = i * W; j < i * W + W; j++) {
      const a = Math.abs(dry[j])
      if (a > 0.08 * peak && a < 0.30 * peak) { sxy += dry[j] * wet[j]; sxx += dry[j] * dry[j] }
    }
    if (sxx <= 0) continue
    const g = sxy / sxx
    if (!(g > 0)) continue
    bands.forEach((b, bi) => {
      let sw = 0
      let sd = 0
      let c = 0
      for (let j = i * W; j < i * W + W; j++) {
        const a = Math.abs(dry[j])
        if (a >= b[0] * peak && a <= b[1] * peak) { sw += wet[j] ** 2; sd += (g * dry[j]) ** 2; c++ }
      }
      if (c > 4) acc[bi].push(20 * Math.log10(Math.sqrt(sw / c) / Math.sqrt(sd / c)))
    })
  }
  return acc.map((a) => {
    const sorted = [...a].sort((p, q) => p - q)
    return sorted[Math.floor(sorted.length / 2)]
  })
}

/**
 * ⚠ THE ASSERTION IS ON THE RATIO BETWEEN BANDS, NOT ON A DIRECTION, AND THAT
 * IS NOT TIMIDITY. The cell's term is a ripple about the detector's smoothed
 * envelope, so whether a band comes out above or below the local fit depends on
 * where the waveform's own crest factor sits relative to that envelope — this
 * synthetic buzz reads POSITIVE where a real narration capture reads NEGATIVE,
 * with the same constants and the same code. What the exponent does in both
 * cases is REDISTRIBUTE the effect between the bands, so that is what is
 * pinned. `npm run la2a:cellmod` compares a capture and the model through the
 * identical path on the identical dry signal, which is what makes its rows
 * comparable despite this.
 */
test('the exponent redistributes the cell between the bands', () => {
  const reference = render({ cellMod: 0 })
  const ratioAt = (shape) => {
    const p = deviationProfile(reference, render({ cellModShape: shape, cellModMax: CELL_MOD_MAX }), SR)
    assert.ok(p.every(Number.isFinite), `profile came back empty at shape ${shape}: ${p}`)
    return p[1] / p[0]
  }

  const r1 = ratioAt(1.0)
  const r2 = ratioAt(2.0)
  const r3 = ratioAt(3.0)

  assert.ok(r1 > r2 && r2 > r3,
    `the ratio should move monotonically with the exponent: ${r1.toFixed(2)} / ${r2.toFixed(2)} / ${r3.toFixed(2)}`)
  assert.ok(r1 / r3 > 1.3,
    `and move enough to be measurable: ${r1.toFixed(2)} -> ${r3.toFixed(2)}`)
})

/**
 * At a FIXED exponent, depth scales the profile without reshaping it much —
 * the other half of what makes the two parameters separable at all. If this
 * ever stopped holding, `npm run la2a:cellmod:fit` would be fitting one
 * parameter twice.
 */
test('depth scales the profile without reshaping it', () => {
  const reference = render({ cellMod: 0 })
  const ratioAt = (mult) => {
    const p = deviationProfile(reference,
      render({ cellModShape: 1.0, cellModMax: CELL_MOD_MAX * mult }), SR)
    return { ratio: p[1] / p[0], top: p[1] }
  }
  const thin = ratioAt(1)
  const thick = ratioAt(3)

  assert.ok(Math.abs(thick.top) > Math.abs(thin.top) * 1.8,
    `more depth should mean more deviation: ${thin.top.toFixed(3)} -> ${thick.top.toFixed(3)}`)
  assert.ok(Math.abs(thick.ratio / thin.ratio - 1) < 0.25,
    `depth should not reshape the profile: ${thin.ratio.toFixed(2)} -> ${thick.ratio.toFixed(2)}`)
})
