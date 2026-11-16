import { SR, renderAligned } from './shared.mjs'
import { processInflatorBuffer, INFLATOR_LATENCY_SAMPLES } from '../../src/audio/inflatorProcessor.js'
import { INFLATOR_DEFAULTS } from '../../src/audio/inflatorParams.js'

/**
 * useInflator.apply → processing.js applyInflatorRegion: no measurement before
 * the render (the Inflator measures nothing per file), then the kernel with
 * its latency trimmed.
 *
 * The params mapping is `toKernelParams` in `src/audio/effects/inflator.js`,
 * copied here (it is 1:1) because that wrapper imports the worklet loader,
 * whose `?worker&url` import only resolves under Vite.
 */
const toKernelParams = p => ({
  inputDb: p.inputDb,
  effect: p.effect,
  curve: p.curve,
  outputDb: p.outputDb,
  clip: p.clip,
  bandSplit: p.bandSplit,
})

export default function render(channels, settings) {
  const panel = { ...INFLATOR_DEFAULTS, ...settings }
  const kp = toKernelParams(panel)
  const out = renderAligned(channels, INFLATOR_LATENCY_SAMPLES, ch => processInflatorBuffer(ch, SR, kp).channelData)
  return { channels: out, note: `effect ${Math.round(panel.effect * 100)}, curve ${panel.curve}` }
}
