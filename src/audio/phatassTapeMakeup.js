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
 * Renders the WHOLE region (a capped window can only read the peak low)
 * through the chain as it reaches the makeup: Warmth, its guard, TAPE. The
 * shelf and Soften are left out — they come after the makeup and only lower
 * the peak — and so are Output and any previous makeup.
 *
 * Pure: no worklet, no DOM; runs in the measurement worker and under node.
 */

import { processPhatassBuffer } from './phatassProcessor.js'
import { toKernelParams, PHATASS_DEFAULTS } from './phatassParams.js'

function peakOf(chs, from, to) {
  let m = 0
  for (const c of chs) for (let i = from; i < to; i++) {
    const a = Math.abs(c[i])
    if (a > m) m = a
  }
  return m
}

const toDb = x => (x > 0 ? 20 * Math.log10(x) : -Infinity)

/**
 * @param {Float32Array[]} channelData the region, as `renderRegionToBuffer` gives it
 * @param {number} sampleRate
 * @param {object} params PHAT*SS UI params (merged over the defaults here)
 * @returns {{ makeupDb: number, peakDb: number, inputPeakDb: number }} the dB
 *   to give back (≥ 0; 0 with TAPE off), and the peaks it came from, dBFS
 */
export function measureTapeMakeup(channelData, sampleRate, params) {
  const p = { ...PHATASS_DEFAULTS, ...params }
  const n = channelData[0].length
  const inPk = peakOf(channelData, 0, n)
  if (!(Number(p.tape) > 0) || !(inPk > 0)) {
    return { makeupDb: 0, peakDb: toDb(inPk), inputPeakDb: toDb(inPk) }
  }
  const kp = toKernelParams({ ...p, tame: 0, soften: false, output: 0, tapeMakeupDb: 0 })
  // Padded so the latency's worth of tail comes out too.
  const pad = 4096
  const padded = channelData.map((c) => {
    const x = new Float32Array(n + pad)
    x.set(c)
    return x
  })
  const { channelData: out, latencySamples: L } = processPhatassBuffer(padded, sampleRate, kp)
  const outPk = peakOf(out, L, Math.min(L + n + 64, n + pad))
  const makeupDb = outPk > 0 ? Math.max(0, toDb(inPk) - toDb(outPk)) : 0
  return { makeupDb, peakDb: toDb(outPk), inputPeakDb: toDb(inPk) }
}
