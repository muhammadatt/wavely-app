import { SR, renderAligned } from './shared.mjs'
import { processManualEqBuffer, EQ_LATENCY_SAMPLES } from '../../src/audio/eqProcessor.js'
import { presetBand } from '../../src/audio/pluginPresets/parametricEq.js'

/**
 * useEqInstance.renderRegion → processing.js applyManualEqRegion: no
 * measurement before the render, the band set and the IN / OUT trims through
 * the kernel, latency trimmed, solo never forwarded.
 *
 * The bands go through `presetBand` (sorted low to high), as the editor's
 * "Try it" path does through the preset whitelist before `applyPreset`.
 *
 * The params mapping is `toKernelParams` in `src/audio/effects/manualEq.js`,
 * copied here because that wrapper imports the worklet loader, whose
 * `?worker&url` import only resolves under Vite. MANUAL_EQ_DEFAULTS (empty
 * bands, 0 dB trims) lives there too, hence the inline defaults below.
 */
const toKernelParams = p => ({
  bands: (p.bands ?? []).map(b => ({
    type: b.type, frequencyHz: b.frequencyHz, gainDb: b.gainDb, q: b.q, enabled: b.enabled,
  })),
  inputGainDb: p.input ?? 0,
  outputGainDb: p.output ?? 0,
  soloIndex: null,
  soloProbe: null,
})

export default function render(channels, settings) {
  const bands = (settings.bands ?? []).map(presetBand).sort((a, b) => a.frequencyHz - b.frequencyHz)
  const kp = toKernelParams({ input: 0, output: 0, ...settings, bands })
  const out = renderAligned(channels, EQ_LATENCY_SAMPLES, ch => processManualEqBuffer(ch, SR, kp).channelData)
  const active = bands.filter(b => b.enabled && b.gainDb !== 0)
    .map(b => `${b.gainDb > 0 ? '+' : ''}${b.gainDb} dB @ ${b.frequencyHz} Hz`).join(', ')
  return { channels: out, note: active || 'flat' }
}
