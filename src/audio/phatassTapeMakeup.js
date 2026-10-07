/**
 * PHAT*SS — TAPE's automatic makeup: how much TAPE actually took off the
 * selection's peak, so the kernel can give exactly that back.
 *
 * ⚠ MEASURED, NEVER THE KNOB'S NUMBER. The knob is solved so a peak whose
 * harmonics stay in band loses exactly its number; a sibilant peak loses
 * ~75 % of it, because the cubic's harmonics land above Nyquist and the
 * oversampler filters them out. Knob-sized makeup would lift that peak past
 * the source — the one thing peak-restoring makeup must not do.
 *
 * TAPE is FIRST in the chain, so what reaches the makeup is TAPE alone on the
 * source: nothing else in the plugin moves this number, and Warmth's knobs
 * never trigger a re-measure. Two ways to measure it:
 *
 *   exact — render TAPE over the WHOLE region (a capped window can only read
 *           the peak low). ~6 s per 10 min of audio. Apply uses this.
 *   fast  — render only where the answer can be. The region is cut into
 *           blocks, sorted by input peak, and rendered loudest first; TAPE
 *           only lowers a peak (a block can come out at most ~0.5 dB over its
 *           input peak, band-limited ringing at the hard-clip end, `RING_DB`),
 *           so the search stops at the first block whose input peak plus that
 *           margin cannot beat the best output so far. Each block gets a short
 *           pre-roll (512), which settles the oversampler but not TAPE's 5 Hz
 *           DC blocker — on 5 Hz syllable envelopes that read a block up to
 *           0.04 dB off — so the few blocks within `SHORT_ERR_DB` of the top
 *           are rendered again with 8192 of pre-roll, where it has settled.
 *           Preview uses this. Measured on 10 min of narration against the
 *           exact render: bright 0.32 / 0.50 / 1.4 s at TAPE 0.5 / 2 / 6, dull
 *           1.2 / 2.3 / 3.6 s (flatter peaks put more blocks within reach),
 *           against ~6 s exact, every reading equal to 0.0001 dB. ⚠ Not exact
 *           by construction (it trusts the two margins), which is why apply
 *           still measures the exact way.
 *
 * ⚠ WITH `tapeOrder: 'last'` (Warmth → guard → TAPE, kept to audition) TAPE's
 * input is Warmth's output, so the fast search does not apply: both paths render
 * the chain up to the makeup (Warmth, guard, TAPE) over the whole region — the
 * pre-October-2026 measurement, ~40 s per 10 min.
 *
 * RMS MAKEUP (`tapeMakeup: 'rms'`, bench only): give back what TAPE took off the
 * selection's RMS instead of its peak, so the body stays put and the peaks come
 * down. TAPE FIRST is a memoryless curve on the source (oversampler and DC
 * blocker aside), so the output energy is predicted from a histogram of the
 * source's sample levels — no render: one integer-binned pass over the region
 * (`levelHistogram`, 256 bins per octave read from the float's bits) and one
 * curve evaluation per non-empty bin. Measured against rendered TAPE on guitar
 * and drums, cubic and tanh, TAPE 1–6: within 0.02 dB at every setting. Preview
 * uses the prediction; apply (`exact`) renders TAPE and compares RMS directly.
 * In 'last' order both render the chain up to the makeup with TAPE on and off.
 * ⚠ RMS, not LUFS: K-weighting the added harmonics reads up to 0.2 dB louder on
 * drums, which a histogram cannot see.
 *
 * Pure: no worklet, no DOM; runs in the measurement worker and under node.
 */

import { processSaturationBenchBuffer, SaturationBenchKernel, layerGain } from './dsp/saturationLayers.js'
import { shaperCurve } from './dsp/shaperCurves.js'
import { toKernelParams, PHATASS_DEFAULTS } from './phatassParams.js'
import { processPhatassBuffer } from './phatassProcessor.js'

/** Block size for the fast search, samples. */
const BLOCK = 1024
/** Pre-roll before each block (the oversampler settles in ~50 samples). */
const PRE_ROLL = 512
/** Tail after each block, so a peak at its end comes out. */
const POST_ROLL = 128
/** How far either side of a block the oversampler's filters reach, samples. */
const REACH = 64
/** How far a block's output peak may exceed its input peak, dB. */
const RING_DB = 0.5
/** Pre-roll for the refining pass: long enough for TAPE's 5 Hz DC blocker. */
const PRE_ROLL_LONG = 8192
/** How far the short pre-roll may misread a block, dB (measured ≤ 0.04). */
const SHORT_ERR_DB = 0.1

function peakOf(chs, from, to) {
  let m = 0
  for (const c of chs) for (let i = from; i < to; i++) {
    const a = Math.abs(c[i])
    if (a > m) m = a
  }
  return m
}

const toDb = x => (x > 0 ? 20 * Math.log10(x) : -Infinity)

function msOf(chs, from, to) {
  let s = 0
  for (const c of chs) for (let i = from; i < to; i++) s += c[i] * c[i]
  return s / (chs.length * Math.max(1, to - from))
}

function padded(channelData, pad) {
  const n = channelData[0].length
  return channelData.map((c) => {
    const x = new Float32Array(n + pad)
    x.set(c)
    return x
  })
}

/** TAPE alone over the whole region: `{ out, L, n }`, padded so the latency's worth of tail comes out too. */
function renderTape(channelData, sampleRate, layer) {
  const n = channelData[0].length
  const { channelData: out, latencySamples: L } = processSaturationBenchBuffer(padded(channelData, 4096), sampleRate, { layers: [layer] }, { slots: 1 })
  return { out, L, n, end: Math.min(L + n + 64, n + 4096) }
}

/** TAPE last: the whole chain as it reaches the makeup — shelf, Soften, Output and makeup out. */
function renderChain(channelData, sampleRate, p) {
  const n = channelData[0].length
  const kp = toKernelParams({ ...p, tame: 0, soften: 0, output: 0, tapeMakeupDb: 0 })
  const { channelData: out, latencySamples: L } = processPhatassBuffer(padded(channelData, 8192), sampleRate, kp)
  return { out, L, n, end: Math.min(L + n + 64, n + 8192) }
}

/**
 * The region's sample levels, binned on the float's own bits: |x|'s exponent
 * and top 8 mantissa bits, so 256 bins per octave (0.024 dB wide) with no log
 * per sample. Each bin keeps its count and its energy; bin 0 (zeros and
 * denormals) carries no energy worth predicting and is dropped.
 */
export function levelHistogram(channelData) {
  const count = new Float64Array(1 << 16)
  const energy = new Float64Array(1 << 16)
  for (const c of channelData) {
    const bits = new Uint32Array(c.buffer, c.byteOffset, c.length)
    for (let i = 0; i < c.length; i++) {
      const b = (bits[i] & 0x7fffffff) >>> 15
      count[b]++
      energy[b] += c[i] * c[i]
    }
  }
  count[0] = 0
  energy[0] = 0
  return { count, energy }
}

/**
 * Output/input energy of a memoryless curve run as f(g·x)/g over a level
 * histogram, dB (≤ 0 for the TAPE curves). Each bin is represented by its rms
 * level; the bins are narrow enough that this is the render to 0.02 dB.
 */
export function predictTapeRmsDb(hist, layer) {
  const f = shaperCurve(layer.curve).f
  const g = layerGain(layer.curve, layer.driveDb, layer.refPeakDb)
  let out = 0
  let inp = 0
  const { count, energy } = hist
  for (let b = 1; b < count.length; b++) {
    const k = count[b]
    if (!k) continue
    const y = f(g * Math.sqrt(energy[b] / k)) / g
    out += k * y * y
    inp += energy[b]
  }
  return inp > 0 && out > 0 ? 10 * Math.log10(out / inp) : 0
}

function fastPeak(channelData, sampleRate, layer) {
  const n = channelData[0].length
  const blocks = []
  // A block's bound reads its input a little past both edges: an output sample
  // hears the input within the oversampler's reach, not only its own block.
  for (let s = 0; s < n; s += BLOCK) {
    blocks.push([peakOf(channelData, Math.max(0, s - REACH), Math.min(n, s + BLOCK + REACH)), s])
  }
  blocks.sort((a, b) => b[0] - a[0])
  const ring = Math.pow(10, RING_DB / 20)
  const kernel = new SaturationBenchKernel(sampleRate, { slots: 1 })
  const off = { ...layer, on: false }
  const L = kernel.latencySamples
  const renderBlock = (s, pre) => {
    const a = Math.max(0, s - pre)
    const b = Math.min(n, s + BLOCK + POST_ROLL)
    const len = b - a + L
    const ins = channelData.map((c) => {
      const x = new Float32Array(len)
      x.set(c.subarray(a, b))
      return x
    })
    const outs = ins.map(() => new Float32Array(len))
    // Off then on: switching a layer on starts its oversampler and filters from rest.
    kernel.setParams({ layers: [off] }, true)
    kernel.setParams({ layers: [layer] }, true)
    for (let o = 0; o < len; o += 128) {
      const m = Math.min(128, len - o)
      kernel.process(ins.map(c => c.subarray(o, o + m)), outs.map(c => c.subarray(o, o + m)), m)
    }
    // Only the block itself counts; the rolls are there to settle the filters.
    const from = s - a + L
    return peakOf(outs, from, Math.min(len, from + Math.min(BLOCK, n - s)))
  }
  // Pass 1, short pre-roll: which blocks can hold the peak. The stop rule
  // allows for the short pre-roll reading a block low by up to SHORT_ERR_DB.
  const err = Math.pow(10, SHORT_ERR_DB / 20)
  let best = 0
  const found = []
  for (const [inPk, s] of blocks) {
    if (inPk * ring * err <= best) break
    const pk = renderBlock(s, PRE_ROLL)
    found.push([pk, s])
    if (pk > best) best = pk
  }
  // Pass 2, long pre-roll, on the few blocks the short one put within reach of
  // the top: the DC blocker has settled there, so these read as the exact render.
  let exact = 0
  for (const [pk, s] of found) {
    if (pk * err * err < best) continue
    const v = renderBlock(s, PRE_ROLL_LONG)
    if (v > exact) exact = v
  }
  return exact
}

/**
 * @param {Float32Array[]} channelData the region, as `renderRegionToBuffer` gives it
 * @param {number} sampleRate
 * @param {object} params PHAT*SS UI params (merged over the defaults here)
 * @param {{ exact?: boolean }} [options] exact (default) renders the whole
 *   region; `exact: false` is the fast bounded search, for live preview
 * @returns {{ makeupDb: number, peakDb: number, inputPeakDb: number }} the dB
 *   to give back (≥ 0; 0 with TAPE off), and the peaks it came from, dBFS
 */
export function measureTapeMakeup(channelData, sampleRate, params, { exact = true } = {}) {
  const p = { ...PHATASS_DEFAULTS, ...params }
  const n = channelData[0].length
  const inPk = peakOf(channelData, 0, n)
  if (!(Number(p.tape) > 0) || !(inPk > 0)) {
    return { makeupDb: 0, peakDb: toDb(inPk), inputPeakDb: toDb(inPk) }
  }
  const kp = toKernelParams(p)
  if (kp.tapeMakeup === 'rms') return { ...rmsMakeup(channelData, sampleRate, p, kp, exact), inputPeakDb: toDb(inPk) }
  let outPk
  if (kp.tapeOrder === 'last') {
    const r = renderChain(channelData, sampleRate, p)
    outPk = peakOf(r.out, r.L, r.end)
  } else if (exact) {
    const r = renderTape(channelData, sampleRate, kp.tapeLayer)
    outPk = peakOf(r.out, r.L, r.end)
  } else {
    outPk = fastPeak(channelData, sampleRate, kp.tapeLayer)
  }
  const makeupDb = outPk > 0 ? Math.max(0, toDb(inPk) - toDb(outPk)) : 0
  return { makeupDb, peakDb: toDb(outPk), inputPeakDb: toDb(inPk) }
}

/** `tapeMakeup: 'rms'`: what TAPE took off the selection's RMS. `peakDb` is NaN when not rendered. */
function rmsMakeup(channelData, sampleRate, p, kp, exact) {
  let lossDb
  let peakDb = NaN
  if (kp.tapeOrder === 'last') {
    // TAPE hears Warmth: the chain up to the makeup, TAPE on against TAPE off.
    const on = renderChain(channelData, sampleRate, p)
    const off = renderChain(channelData, sampleRate, { ...p, tape: 0 })
    lossDb = 10 * Math.log10(msOf(on.out, on.L, on.L + on.n) / msOf(off.out, off.L, off.L + off.n))
    peakDb = toDb(peakOf(on.out, on.L, on.end))
  } else if (exact) {
    const r = renderTape(channelData, sampleRate, kp.tapeLayer)
    lossDb = 10 * Math.log10(msOf(r.out, r.L, r.L + r.n) / msOf(channelData, 0, r.n))
    peakDb = toDb(peakOf(r.out, r.L, r.end))
  } else {
    lossDb = predictTapeRmsDb(levelHistogram(channelData), kp.tapeLayer)
  }
  return { makeupDb: Number.isFinite(lossDb) ? Math.max(0, -lossDb) : 0, peakDb }
}
