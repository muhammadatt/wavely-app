/**
 * HF Softener: the automatic Air amount.
 *
 * Removing sibilance makes a file sound duller even though no vowel changed —
 * on real narration the cut takes ≤ 0.16 dB off vowel top end but 2–7 dB off
 * the FILE's top end above 5 kHz, because the "s" carries most of it. Air can
 * put some of that impression back, and in VOICED mode it does so on the
 * vowels without handing the cut back to the "s" (0.3 dB at Air 4 against
 * STATIC's ~3).
 *
 * So the automatic amount follows the chain's measured top-end loss — the
 * softener's cut plus the Reso pre-stage's when it is in, everything Amount,
 * Split, Detect and Reso are doing — as a FRACTION of it, capped at the knob's
 * range:
 *
 *   loss   = 10·log10( E_out(>5 kHz) / E_in(>5 kHz) )   over the analysis window, Air 0
 *   airDb  = clamp( −loss · AIR_AUTO_FRACTION, 0, AIR_MAKEUP_MAX_DB )
 *
 * Half, not all: this is compensation for the first impression, not a
 * restoration — restoring the whole loss on the vowels would over-brighten
 * them to stand in for sibilance that is supposed to be gone.
 *
 * Node-importable: no worklet registration reaches here through these imports.
 */

import { processHFSoftenerBuffer, AIR_MAKEUP_MAX_DB } from './hfSoftenerProcessor.js'
import { processResonanceBuffer } from './resonanceProcessor.js'
import { BiquadCascade, highpass } from './dsp/biquad.js'

export const AIR_AUTO_FRACTION = 0.5
export const AIR_AUTO_BAND_HZ = 5000

function topEnergy(channels, sampleRate) {
  const sections = [highpass(sampleRate, AIR_AUTO_BAND_HZ, 0.7), highpass(sampleRate, AIR_AUTO_BAND_HZ, 0.7)]
  let e = 0
  for (const x of channels) {
    const c = new BiquadCascade(2, 1)
    c.setSections(sections)
    const y = new Float64Array(x.length)
    c.process(x, y, x.length, 0)
    for (let i = 0; i < y.length; i++) e += y[i] * y[i]
  }
  return e
}

/**
 * Top-end change through the chain, dB (≤ 0 for a cut).
 *
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @param {object} kernelParams softener kernel params (Air is forced to 0)
 * @param {object|null} resoParams ResoTame kernel params for the pre-stage, or null
 * @param {number} resoFrameSize
 */
export function measureTopLossDb(channelData, sampleRate, kernelParams, resoParams = null, resoFrameSize = 512) {
  let x = channelData
  if (resoParams) {
    const r = processResonanceBuffer(channelData, sampleRate, resoParams, { frameSize: resoFrameSize })
    x = r.channelData.map(c => {
      const o = new Float32Array(c.length)
      o.set(c.subarray(r.latencySamples))
      return o
    })
  }
  const y = processHFSoftenerBuffer(x, sampleRate, { ...kernelParams, airDb: 0 }).channelData
  const before = topEnergy(channelData, sampleRate)
  if (!(before > 0)) return 0
  const after = topEnergy(y, sampleRate)
  return 10 * Math.log10(Math.max(after, 1e-30) / before)
}

/** The Air knob's automatic value for a measured loss, dB, to 0.1. */
export function autoAirDb(lossDb) {
  const v = Math.min(AIR_MAKEUP_MAX_DB, Math.max(0, -lossDb * AIR_AUTO_FRACTION))
  return Math.round(v * 10) / 10
}
