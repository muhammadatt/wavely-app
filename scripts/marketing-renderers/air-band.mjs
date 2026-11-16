import { SR } from './shared.mjs'
import { processAirBandBuffer } from '../../src/audio/airBandProcessor.js'
import { AIR_BAND_DEFAULTS } from '../../src/audio/airBandParams.js'

/**
 * useAirBand.renderRegion → processing.js applyAirBandRegion: no measurement
 * before the render and no latency to trim (the kernel is a zero-latency
 * biquad cascade, and the apply path passes none).
 *
 * The params mapping is `toKernelParams` in `src/audio/effects/airBand.js`,
 * copied here because that wrapper imports the worklet loader, whose
 * `?worker&url` import only resolves under Vite.
 */
const toKernelParams = p => ({ gainDb: p.air, outputGainDb: p.output })

export default function render(channels, settings) {
  const panel = { ...AIR_BAND_DEFAULTS, ...settings }
  const out = processAirBandBuffer(channels, SR, toKernelParams(panel)).channelData
  return { channels: out, note: `air ${panel.air} dB, output ${panel.output} dB` }
}
