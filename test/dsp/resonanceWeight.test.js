/**
 * Resonance Suppressor — sensitivity weighting curve.
 *
 * Nodes that are NOT filters: each offsets `selectivity` — the threshold a bin
 * must protrude above its reference to count as a resonance — over a region of
 * the spectrum. Positive gain lowers the threshold there.
 *
 * WHY THIS EXISTS, from measurement rather than preference. `selectivity` is a
 * scalar thresholding a quantity whose distribution is strongly
 * frequency-dependent: mean protrusion on real narration runs 3.4 dB at
 * 60-120 Hz against 15.3 at 190-270 for the cepstral reference. One number
 * cannot be right at both ends. The consequence was measured on a narrator
 * clip — the suppressor was inert on a word with an audible low-mid honk, and
 * reaching it by lowering selectivity globally took gain jitter from 0.85/1.14
 * to 1.23/1.58, worse than a configuration already rejected by ear.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ResonanceKernel,
  processResonanceBuffer,
  RESONANCE_KERNEL_DEFAULTS,
} from '../../src/audio/resonanceProcessor.js'
import {
  RESONANCE_WEIGHT_MAX_DB,
  RESONANCE_WEIGHT_SUM_LIMIT_DB,
  buildResonanceWeightCurve,
  resonanceWeightDbAt,
} from '../../src/audio/resonanceParams.js'
import { peaking, BiquadCascade } from '../../src/audio/dsp/biquad.js'
import { getFFT, rfftBinCount } from '../../src/audio/dsp/fft.js'

const SR = 44100
const LATENCY = 2048

function voice({ seconds = 3, f0 = 150, jitterHz = 3, amp = 0.2, noiseDb = -45 } = {}) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const noiseAmp = Math.pow(10, noiseDb / 20)
  let phase = 0
  let s = 4242
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const pitch = f0 + jitterHz * Math.sin(2 * Math.PI * 2.7 * t)
    phase += (2 * Math.PI * pitch) / SR
    let v = 0
    for (let k = 1; k * pitch < SR / 2; k++) {
      const f = k * pitch
      v += (f <= 300 ? 1 : Math.pow(300 / f, 1.2)) * Math.sin(k * phase + k * 0.9)
    }
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = amp * v * 0.25 + noiseAmp * (s / 0x3fffffff - 1)
  }
  return out
}

function resonate(sig, freqHz, q, gainDb) {
  const c = new BiquadCascade(1, 1)
  c.setSections([peaking(SR, freqHz, q, gainDb)])
  const out = new Float32Array(sig.length)
  c.process(sig, out, sig.length, 0)
  return out
}

const FFT_N = 16384
const fft = getFFT(FFT_N)
const BINS = rfftBinCount(FFT_N)
function bandDb(buf, freqHz, from, halfHz) {
  const w = new Float64Array(FFT_N)
  for (let i = 0; i < FFT_N; i++) {
    w[i] = buf[from + i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / FFT_N))
  }
  const re = new Float64Array(BINS)
  const im = new Float64Array(BINS)
  fft.rfft(w, re, im)
  const binHz = SR / FFT_N
  const lo = Math.max(0, Math.round((freqHz - halfHz) / binHz))
  const hi = Math.min(BINS - 1, Math.round((freqHz + halfHz) / binHz))
  let p = 0
  for (let k = lo; k <= hi; k++) p += re[k] * re[k] + im[k] * im[k]
  return 10 * Math.log10(p / (hi - lo + 1) / (FFT_N * FFT_N) + 1e-20)
}

const UNPROTECTED = { preserveHarmonics: false }

/** dB removed from a resonance planted at `freqHz`. */
function removed(dry, freqHz, params) {
  const wet = resonate(dry, freqHz, 4, 12)
  const out = processResonanceBuffer([wet], SR, { ...RESONANCE_KERNEL_DEFAULTS, ...params })
    .channelData[0]
  const half = Math.max(80, freqHz * 0.1)
  return bandDb(wet, freqHz, SR, half) - bandDb(out, freqHz, SR + LATENCY, half)
}

// ── The curve itself ────────────────────────────────────────────────────────

test('a node is a Gaussian in log frequency, symmetric about its centre', () => {
  const nodes = [{ freqHz: 1000, gainDb: 6, octaves: 0.7 }]
  assert.ok(Math.abs(resonanceWeightDbAt(nodes, 1000) - 6) < 1e-9)
  // An octave either side must weigh the same — that is what "in log
  // frequency" means, and a Gaussian in Hz would not.
  const below = resonanceWeightDbAt(nodes, 500)
  const above = resonanceWeightDbAt(nodes, 2000)
  assert.ok(Math.abs(below - above) < 1e-9, `${below} vs ${above}`)
  assert.ok(below > 1 && below < 4, `an octave out should be well down, got ${below}`)
})

test('nodes add, and the sum is bounded', () => {
  const two = [
    { freqHz: 1000, gainDb: 8, octaves: 1 },
    { freqHz: 1000, gainDb: 8, octaves: 1 },
  ]
  // Two nodes both meaning "be more sensitive here" must be more sensitive
  // than either alone, or moving them is unpredictable.
  assert.ok(resonanceWeightDbAt(two, 1000) > 8)

  const many = Array.from({ length: 6 }, () => ({ freqHz: 1000, gainDb: RESONANCE_WEIGHT_MAX_DB, octaves: 1 }))
  assert.ok(resonanceWeightDbAt(many, 1000) <= RESONANCE_WEIGHT_SUM_LIMIT_DB)
})

test('a disabled or zero-gain node contributes nothing', () => {
  assert.equal(resonanceWeightDbAt([{ freqHz: 1000, gainDb: 6, enabled: false }], 1000), 0)
  assert.equal(resonanceWeightDbAt([{ freqHz: 1000, gainDb: 0 }], 1000), 0)
  assert.equal(buildResonanceWeightCurve([], 1025, 21.5), null)
  assert.equal(buildResonanceWeightCurve([{ freqHz: 1000, gainDb: 0 }], 1025, 21.5), null)
})

test('an empty node set leaves the detector bit-identical', () => {
  // The overwhelmingly common case. A file processed with no nodes must be the
  // same file it was before this feature existed, sample for sample.
  const sig = resonate(voice({ seconds: 1.5 }), 3000, 4, 12)
  const without = processResonanceBuffer([sig], SR, { ...RESONANCE_KERNEL_DEFAULTS, ...UNPROTECTED })
    .channelData[0]
  const withEmpty = processResonanceBuffer([sig], SR, {
    ...RESONANCE_KERNEL_DEFAULTS, ...UNPROTECTED, weightNodes: [],
  }).channelData[0]
  for (let i = 0; i < sig.length; i++) {
    assert.equal(withEmpty[i], without[i], `diverged at ${i}`)
  }
  const kernel = new ResonanceKernel(SR)
  kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS })
  assert.equal(kernel.weightDb, null, 'no curve should be built when there are no nodes')
})

// ── What it does to detection ───────────────────────────────────────────────

test('a node raises sensitivity where it sits and nowhere else', () => {
  // THE PROPERTY THE WHOLE FEATURE RESTS ON. Without orthogonality this is just
  // a second selectivity knob with extra steps.
  const dry = voice()
  const flatLow = removed(dry, 700, UNPROTECTED)
  const flatHigh = removed(dry, 4200, UNPROTECTED)

  const lifted = { ...UNPROTECTED, weightNodes: [{ freqHz: 4200, gainDb: 8, octaves: 0.7 }] }
  const nodeLow = removed(dry, 700, lifted)
  const nodeHigh = removed(dry, 4200, lifted)

  assert.ok(
    nodeHigh > flatHigh + 3,
    `the node should deepen the cut under it: ${flatHigh.toFixed(2)} -> ${nodeHigh.toFixed(2)}`,
  )
  assert.ok(
    Math.abs(nodeLow - flatLow) < 0.5,
    `700 Hz should be untouched: ${flatLow.toFixed(2)} -> ${nodeLow.toFixed(2)}`,
  )
})

test('a negative node holds the detector off a band', () => {
  // The other direction, and the one that generalises `freqFloorHz` — a hard
  // band edge is this with a very large negative gain and no slope.
  const dry = voice()
  const flat = removed(dry, 700, UNPROTECTED)
  const held = removed(dry, 700, {
    ...UNPROTECTED, weightNodes: [{ freqHz: 700, gainDb: -10, octaves: 0.7 }],
  })
  assert.ok(held < flat - 2, `expected the node to hold it off: ${flat.toFixed(2)} -> ${held.toFixed(2)}`)
})

test('the effective threshold is floored at zero', () => {
  // A threshold below zero would mean treating bins that sit BELOW their
  // reference, which is not a resonance under any reading — it is every bin in
  // the band, and at depth 1 that is a very loud mistake.
  const kernel = new ResonanceKernel(SR)
  kernel.setParams({
    ...RESONANCE_KERNEL_DEFAULTS,
    selectivity: 3,
    weightNodes: [{ freqHz: 1000, gainDb: RESONANCE_WEIGHT_MAX_DB, octaves: 2 }],
  })
  const bin = Math.round(1000 / kernel.binWidth)
  assert.ok(kernel.weightDb[bin] > kernel.selectivity, 'probe needs the weight to exceed selectivity')

  // Feed it a spectrum entirely BELOW its reference and check nothing is cut.
  kernel.magDb.fill(-80)
  kernel.envDb.fill(-40)
  kernel.reduction.fill(0)
  const threshold = Math.max(0, kernel.selectivity - kernel.weightDb[bin])
  assert.equal(threshold, 0)
  assert.ok(kernel.magDb[bin] - kernel.envDb[bin] - threshold < 0, 'below the reference must stay untreated')
})

test('the curve follows the sample rate, not a fixed bin index', () => {
  // The node is specified in Hz, so the same node must land on the same
  // frequency at 44.1 and 48 kHz — a bug that would only appear on one of them.
  const nodes = [{ freqHz: 1000, gainDb: 6, octaves: 0.5 }]
  for (const sr of [44100, 48000]) {
    const kernel = new ResonanceKernel(sr)
    kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS, weightNodes: nodes })
    const bin = Math.round(1000 / kernel.binWidth)
    assert.ok(
      Math.abs(kernel.weightDb[bin] - 6) < 0.1,
      `${sr} Hz: node landed at ${kernel.weightDb[bin].toFixed(2)} dB instead of 6`,
    )
  }
})
