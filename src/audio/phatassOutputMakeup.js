/**
 * PHAT*SS — the bench's automatic OUTPUT trim (`outputMakeup`): a gain on the
 * plugin's output, on top of Output, that puts the whole chain's peak ('peak')
 * or RMS ('rms') back on the selection's. TAPE's own makeup is untouched and
 * stays peak-restoring; this is a separate stage at the end.
 *
 * Measured by RENDERING the chain with the trim and Output at 0. There is no
 * render-free shortcut: Warmth adds level that depends on the band content,
 * its guard and the tape shelf are dynamic, and Soften reacts to onsets.
 *
 *   exact — the whole region. Apply uses this, after TAPE's makeup has been
 *           measured the exact way (the render needs it).
 *   fast  — a selection of at most `PREVIEW_CAP_S` is rendered whole, so the
 *           preview is exact there. A longer one renders `BLOCKS` half-second
 *           blocks, each with `PRE_ROLL_S` of run-in for the shelf, the guard
 *           and TAPE's DC blocker:
 *           - rms: one block per equal stratum, jittered inside it (evenly
 *             spaced blocks alias against loops), out/in energy over
 *             the SAME blocks — an estimate of the ratio, not of either level;
 *           - peak: the blocks with the loudest input, against the source's
 *             own peak. ⚠ A LOWER BOUND on the output peak: the Warmth guard
 *             lets a quiet block rise up to the selection's peak, so a block
 *             outside the loudest can hold the true output peak, and preview
 *             can then trim a little hot. Apply measures the whole region.
 *
 * The cap is where sampling starts to pay: 40 blocks with their run-in render
 * ~30 s of audio either way (~1.9 s here, against ~6 s for 100 s whole).
 * Measured against the whole render (narration 24 / 46 s, drums ×3 53 s, a
 * 103 s mix of narration, guitar and drums; Warmth 5–8, TAPE 2–4, Tame 5–7):
 * RMS within 0.00–0.11 dB on single-source material and 0.18 on the mix, whose
 * sections differ the most; PEAK within 0.02.
 *
 * Pure: no worklet, no DOM; runs in the measurement worker and under node.
 */

import { toKernelParams, PHATASS_DEFAULTS } from './phatassParams.js'
import { processPhatassBuffer } from './phatassProcessor.js'

/** Selections up to this long are measured whole even in preview, seconds. */
export const PREVIEW_CAP_S = 30
/** Blocks rendered for a longer selection in preview. */
const BLOCKS = 40
/** Block length, seconds. */
const BLOCK_S = 0.5
/** Run-in before each block, seconds. */
const PRE_ROLL_S = 0.25

const toDb = x => (x > 0 ? 20 * Math.log10(x) : -Infinity)

/** Render [from, to) with `pre` samples of run-in; return the stats of [from, to). */
function renderSpan(channelData, sampleRate, kp, from, to, pre) {
  const a = Math.max(0, from - pre)
  const tail = 4096
  const len = to - a + tail
  const ins = channelData.map((c) => {
    const x = new Float32Array(len)
    x.set(c.subarray(a, to))
    return x
  })
  const { channelData: out, latencySamples: L } = processPhatassBuffer(ins, sampleRate, kp)
  const off = from - a + L
  let pk = 0
  let eo = 0
  let ei = 0
  for (let ch = 0; ch < out.length; ch++) {
    const y = out[ch]
    const x = channelData[ch]
    for (let i = 0; i < to - from; i++) {
      const v = y[off + i]
      const av = Math.abs(v)
      if (av > pk) pk = av
      eo += v * v
      ei += x[from + i] * x[from + i]
    }
  }
  return { pk, eo, ei }
}

function sourcePeak(channelData, from, to) {
  let m = 0
  for (const c of channelData) for (let i = from; i < to; i++) {
    const a = Math.abs(c[i])
    if (a > m) m = a
  }
  return m
}

/**
 * @param {Float32Array[]} channelData the region, as `renderRegionToBuffer` gives it
 * @param {number} sampleRate
 * @param {object} params PHAT*SS UI params, with TAPE's makeup already measured
 * @param {{ exact?: boolean }} [options] exact (default) renders the whole
 *   region; `exact: false` is the capped preview measurement
 * @returns {{ makeupDb: number, outPeakDb: number, inputPeakDb: number }} the
 *   signed trim (0 with the mode off), and the peaks it came from, dBFS
 */
export function measureOutputMakeup(channelData, sampleRate, params, { exact = true } = {}) {
  const p = { ...PHATASS_DEFAULTS, ...params }
  const n = channelData[0].length
  const inPk = sourcePeak(channelData, 0, n)
  const mode = p.outputMakeup
  if ((mode !== 'peak' && mode !== 'rms') || !(inPk > 0) || !(n > 0)) {
    return { makeupDb: 0, outPeakDb: toDb(inPk), inputPeakDb: toDb(inPk) }
  }
  const kp = toKernelParams({ ...p, output: 0, outputMakeup: 'off', outputMakeupDb: 0 })
  const block = Math.round(BLOCK_S * sampleRate)
  let pk = 0
  let eo = 0
  let ei = 0
  const add = (r) => {
    if (r.pk > pk) pk = r.pk
    eo += r.eo
    ei += r.ei
  }
  if (exact || n <= PREVIEW_CAP_S * sampleRate || n <= BLOCKS * block) {
    add(renderSpan(channelData, sampleRate, kp, 0, n, 0))
  } else {
    const pre = Math.round(PRE_ROLL_S * sampleRate)
    const count = Math.floor(n / block)
    let starts
    if (mode === 'rms') {
      // One block per equal stratum, at a golden-ratio offset inside it: evenly
      // spaced blocks alias against a loop or a regular delivery (a 30 s test
      // track with a 3.7 s pattern read 0.36 dB off), jittered ones do not.
      const stratum = n / BLOCKS
      starts = Array.from({ length: BLOCKS }, (_, k) => {
        const jitter = ((k + 1) * 0.6180339887498949) % 1
        return Math.floor(k * stratum + jitter * Math.max(0, stratum - block))
      })
    } else {
      const ranked = Array.from({ length: count }, (_, k) => [sourcePeak(channelData, k * block, (k + 1) * block), k * block])
      ranked.sort((x, y) => y[0] - x[0])
      starts = ranked.slice(0, BLOCKS).map(r => r[1])
    }
    for (const s of starts) add(renderSpan(channelData, sampleRate, kp, s, Math.min(n, s + block), pre))
  }
  const makeupDb = mode === 'peak'
    ? (pk > 0 ? toDb(inPk) - toDb(pk) : 0)
    : (eo > 0 && ei > 0 ? 10 * Math.log10(ei / eo) : 0)
  return { makeupDb, outPeakDb: toDb(pk), inputPeakDb: toDb(inPk) }
}
