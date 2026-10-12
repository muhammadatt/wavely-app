/**
 * One chunk of a parallel apply (see chunkedApply.js). Runs in the measurement
 * worker; node-importable for the tests.
 *
 * A chunk renders through a CHAIN of stages, mirroring applyWorkletRegion's
 * worklet graph: the plugin's own kernel, then any post-stages (the HF
 * Softener's Reso and Soften). Each stage gets the previous one's whole output
 * stream, as the next worklet node does, so the chain's latency is the sum.
 */

import { processLA2ABuffer } from './la2aProcessor.js'
import { processSchepsBuffer } from './schepsProcessor.js'
import { processFET1176Buffer } from './fet1176Processor.js'
import { processResonanceBuffer } from './resonanceProcessor.js'
import { processSaturationBenchBuffer } from './dsp/saturationLayers.js'
import { processHFSoftenerBuffer } from './hfSoftenerProcessor.js'
import { processHFLimiterBuffer } from './hfLimiterProcessor.js'
import { processPhatassBuffer } from './phatassProcessor.js'

/**
 * The kernels a chunk may render, by name. Each takes the same kernel params
 * (and, for ResoTame, the same processorOptions) its worklet is constructed
 * with, and returns the raw, latency-delayed stream.
 *
 * ⚠ TUBE SATURATION IS NOT HERE, DELIBERATELY. Its skew sign is a sticky latch
 * and its voiced gate holds a valley floor; both depend on history arbitrarily
 * far back (see VOCAL_SAT_PREROLL_S), so no run-in makes a seam exact and a
 * chunk could lean its asymmetry the other way from its neighbour.
 */
export const CHUNK_RENDERERS = {
  la2a: (ch, sr, p) => processLA2ABuffer(ch, sr, p),
  scheps: (ch, sr, p) => processSchepsBuffer(ch, sr, p),
  fet1176: (ch, sr, p) => processFET1176Buffer(ch, sr, p),
  resonance: (ch, sr, p, o) => processResonanceBuffer(ch, sr, p, { frameSize: o?.frameSize }),
  saturationBench: (ch, sr, p) => processSaturationBenchBuffer(ch, sr, p),
  hfSoftener: (ch, sr, p) => processHFSoftenerBuffer(ch, sr, p),
  hfLimiter: (ch, sr, p) => processHFLimiterBuffer(ch, sr, p),
  phatass: (ch, sr, p) => processPhatassBuffer(ch, sr, p),
}

/**
 * Render one chunk: `channelData` is its input [from, to); `stages` is
 * [{ renderer, kernelParams, options }], the plugin first. Returns its part of
 * the region with `latency` (the whole chain's, as the main thread trims it)
 * and `skip` removed.
 */
export function renderChunk(channelData, sampleRate, { stages, latency, skip, length }) {
  let data = channelData
  for (const st of stages) {
    const render = CHUNK_RENDERERS[st.renderer]
    if (!render) throw new Error(`no chunk renderer for "${st.renderer}"`)
    data = render(data, sampleRate, st.kernelParams, st.options).channelData
  }
  const at = latency + skip
  return data.map((c) => {
    const y = new Float32Array(length)
    y.set(c.subarray(at, at + length))
    return y
  })
}
