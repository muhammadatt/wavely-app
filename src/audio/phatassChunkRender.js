/**
 * One chunk of a parallel PHAT*SS apply (see phatassChunks.js). Runs in the
 * measurement worker; node-importable for the tests.
 */

import { processPhatassBuffer } from './phatassProcessor.js'

/**
 * Render one chunk: `channelData` is its input [from, to); returns its part of
 * the region, latency removed.
 */
export function renderPhatassChunk(channelData, sampleRate, kernelParams, skip, length) {
  const { channelData: out, latencySamples } = processPhatassBuffer(channelData, sampleRate, kernelParams)
  const at = latencySamples + skip
  return out.map((c) => {
    const y = new Float32Array(length)
    y.set(c.subarray(at, at + length))
    return y
  })
}
