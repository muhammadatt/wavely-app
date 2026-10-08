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
 * HEAD BUMP (bench): the low shelf ahead of TAPE is applied to the region once,
 * up front, and both paths measure TAPE on that — while the makeup still
 * restores the SOURCE's peak (the bump lifts the kick into the curve; what
 * comes back out is put on the selection's own peak).
 *
 * TAPE COMPRESSION (bench) is handled the same way: the region runs through
 * the bump and the compressor once, up front (cheap: no oversampling), and TAPE
 * is measured on that. The compressor has memory (16.5 ms release), so this is
 * the continuous stream the kernel sees, not a per-block approximation; the
 * fast search then only has TAPE to bound, as before.
 *
 * HEAD BUMP POST (bench): the bump follows the curve, so the measurement renders
 * TAPE over the whole region and shelves its output — the exact way, in preview
 * as well (the shelf's memory outlasts the fast search's short pre-roll). The
 * lift can leave the peak above the source, so this is the one case where the
 * makeup may come out NEGATIVE.
 *
 * Pure: no worklet, no DOM; runs in the measurement worker and under node.
 */

import { processSaturationBenchBuffer, SaturationBenchKernel } from './dsp/saturationLayers.js'
import { toKernelParams, PHATASS_DEFAULTS, TAPE_HEAD_BUMP_HZ, TAPE_HEAD_BUMP_Q } from './phatassParams.js'
import { BiquadCascade, lowShelf } from './dsp/biquad.js'
import { processPhatassBuffer } from './phatassProcessor.js'
import { TapeCompressor } from './dsp/tapeComp.js'

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
/**
 * The same with a low push, which makes the short pre-roll misread more (a
 * bare 55 Hz kick at TAPE 3 / +18 read 0.4 dB off with the 0.1 dB margin).
 */
const SHORT_ERR_PUSH_DB = 1

function peakOf(chs, from, to) {
  let m = 0
  for (const c of chs) for (let i = from; i < to; i++) {
    const a = Math.abs(c[i])
    if (a > m) m = a
  }
  return m
}

const toDb = x => (x > 0 ? 20 * Math.log10(x) : -Infinity)

function exactPeak(channelData, sampleRate, layer) {
  const n = channelData[0].length
  // Padded so the latency's worth of tail comes out too.
  const pad = 4096
  const padded = channelData.map((c) => {
    const x = new Float32Array(n + pad)
    x.set(c)
    return x
  })
  const { channelData: out, latencySamples: L } = processSaturationBenchBuffer(padded, sampleRate, { layers: [layer] }, { slots: 1 })
  return peakOf(out, L, Math.min(L + n + 64, n + pad))
}

/** TAPE last: the whole chain as it reaches the makeup — shelf, Soften, Output and makeup out. */
function chainPeak(channelData, sampleRate, p) {
  const n = channelData[0].length
  const pad = 8192
  const padded = channelData.map((c) => {
    const x = new Float32Array(n + pad)
    x.set(c)
    return x
  })
  const kp = toKernelParams({ ...p, tame: 0, soften: 0, output: 0, tapeMakeupDb: 0 })
  const { channelData: out, latencySamples: L } = processPhatassBuffer(padded, sampleRate, kp)
  return peakOf(out, L, Math.min(L + n + 64, n + pad))
}

/** TAPE then the head bump over the whole region (post position), its peak. */
function postBumpPeak(channelData, sampleRate, kp) {
  const n = channelData[0].length
  const pad = 4096
  const padded = channelData.map((c) => {
    const x = new Float32Array(n + pad)
    x.set(c)
    return x
  })
  const { channelData: out, latencySamples: L } = processSaturationBenchBuffer(padded, sampleRate, { layers: [kp.tapeLayer] }, { slots: 1 })
  return peakOf(headBumped(out, sampleRate, kp.headBumpDb), L, Math.min(L + n + 64, n + pad))
}

/** The region through the head bump, as TAPE hears it in the kernel. */
function headBumped(channelData, sampleRate, db) {
  const c = lowShelf(sampleRate, TAPE_HEAD_BUMP_HZ, TAPE_HEAD_BUMP_Q, db)
  return channelData.map((x) => {
    const bq = new BiquadCascade(1, 1)
    bq.setSection(0, c)
    const y = new Float32Array(x.length)
    bq.process(x, y, x.length, 0)
    return y
  })
}

/** The region through the tape compressor, as TAPE hears it in the kernel. */
function compressed(channelData, sampleRate, compParams) {
  const tc = new TapeCompressor(sampleRate)
  tc.setParams(compParams)
  const out = channelData.map(x => Float32Array.from(x))
  const n = out[0].length
  for (let o = 0; o < n; o += 128) {
    const m = Math.min(128, n - o)
    tc.process(out.map(c => c.subarray(o, o + m)), m)
  }
  return out
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
  const err = Math.pow(10, (layer.emphDb > 0 ? SHORT_ERR_PUSH_DB : SHORT_ERR_DB) / 20)
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
  // The head bump and compressor sit inside the chain render already; otherwise TAPE hears the source through them.
  const post = kp.headBumpPos === 'post' && kp.headBumpDb > 0
  let tapeIn = kp.tapeOrder !== 'last' && kp.headBumpDb > 0 && !post ? headBumped(channelData, sampleRate, kp.headBumpDb) : channelData
  if (kp.tapeOrder !== 'last' && kp.tapeComp?.on) tapeIn = compressed(tapeIn, sampleRate, kp.tapeComp)
  // A post bump comes after the curve: always the exact render, then the bump, then the peak.
  const outPk = kp.tapeOrder === 'last'
    ? chainPeak(channelData, sampleRate, p)
    : post ? postBumpPeak(tapeIn, sampleRate, kp)
      : exact ? exactPeak(tapeIn, sampleRate, kp.tapeLayer) : fastPeak(tapeIn, sampleRate, kp.tapeLayer)
  // Post, the lift can put the peak above the source: then the makeup is a cut.
  const raw = outPk > 0 ? toDb(inPk) - toDb(outPk) : 0
  const makeupDb = kp.headBumpPos === 'post' ? raw : Math.max(0, raw)
  return { makeupDb, peakDb: toDb(outPk), inputPeakDb: toDb(inPk) }
}
