import { SR } from './shared.mjs'
import { detectHum, MAX_ANALYSIS_SECONDS } from '../../src/audio/dsp/humDetect.js'
import { processHumNotchBuffer, HUM_NOTCH_KERNEL_DEFAULTS } from '../../src/audio/humNotchProcessor.js'

// ⚠ effects/humNotch.js (HUM_NOTCH_DEFAULTS, toKernelParams) imports its worklet
// loader through a Vite `?worker&url` import, which Node cannot load. Its
// mapping is a rename (depth → depthDb) and its defaults equal the kernel's
// (q 30, depth 18), so the kernel's defaults stand in for them here.
const HUM_NOTCH_DEFAULTS = { q: HUM_NOTCH_KERNEL_DEFAULTS.q, depth: HUM_NOTCH_KERNEL_DEFAULTS.depthDb }
const toKernelParams = p => ({ frequencies: p.frequencies, q: p.q, depthDb: p.depth })

/**
 * Hum Remover: useHumRemover's analyze() then apply().
 *   analyze — processing.js analyzeHumRegion: a centred MAX_ANALYSIS_SECONDS
 *     window of the region, mixed to mono, through humWorker.js's detectHum
 *     with the panel's mains fundamental; every harmonic the detector flagged
 *     and did not attribute to a pitched source is ticked, as the panel does.
 *   apply — processing.js applyHumNotchRegion: the hum-notch worklet (zero
 *     latency) with { frequencies, q, depth } over HUM_NOTCH_DEFAULTS; here its
 *     kernel's processHumNotchBuffer, the same code.
 *
 * Settings (pluginSettingsExtra humRemoverSettings): `fundamental` 50 | 60
 * (panel default 60), `q`, `depth`. The ticked harmonics are measured, never
 * stored — the "Try it" link opens the panel waiting for Analyse.
 */
export default function render(channels, settings) {
  const fundamental = [50, 60].includes(settings.fundamental) ? settings.fundamental : 60
  const q = Number.isFinite(settings.q) ? settings.q : HUM_NOTCH_DEFAULTS.q
  const depth = Number.isFinite(settings.depth) ? settings.depth : HUM_NOTCH_DEFAULTS.depth

  // analyzeHumRegion's window and mono mixdown (renderRegionToBuffer rounding).
  const n = channels[0].length
  const dur = n / SR
  let a = 0, b = dur
  if (dur > MAX_ANALYSIS_SECONDS) { const mid = dur / 2; a = mid - MAX_ANALYSIS_SECONDS / 2; b = mid + MAX_ANALYSIS_SECONDS / 2 }
  const s0 = Math.floor(a * SR)
  const len = Math.ceil((b - a) * SR)
  const mono = new Float32Array(len)
  for (const ch of channels) for (let i = 0; i < len && s0 + i < n; i++) mono[i] += ch[s0 + i]
  if (channels.length > 1) for (let i = 0; i < len; i++) mono[i] /= channels.length

  const result = detectHum(mono, SR, { fundamental })
  const frequencies = result.detectionDetail.filter(d => d.flagged && !d.matchesPitchedSource).map(d => d.frequency)

  const kp = toKernelParams({ ...HUM_NOTCH_DEFAULTS, frequencies, q, depth })
  const out = processHumNotchBuffer(channels, SR, kp).channelData
  return { channels: out, note: `${fundamental} Hz mains, notches [${frequencies.join(', ')}] Hz, Q ${q}, depth ${depth} dB` }
}
