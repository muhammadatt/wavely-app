/**
 * HF Limiter presets.
 *
 * The panel's controls and nothing else. The voice level the Threshold is
 * relative to is MEASURED on the file and stays out, which is what lets one
 * preset mean the same thing on a quiet narration and a hot one.
 *
 * One factory preset ships, the plugin's own opening state; voicings beyond it
 * (the Fatso Warmth 7 match, say) are the owner's to cut.
 */

import { definePluginPresets } from './store.js'
import {
  HF_LIMITER_DEFAULTS, FREQ_MIN_HZ, FREQ_MAX_HZ, THRESHOLD_MIN_DB, THRESHOLD_MAX_DB,
  RANGE_MAX_DB, RELEASE_MIN_MS, RELEASE_MAX_MS, TAIL_MAX_MS, TRANSIENT_MAX_DB,
} from '../hfLimiterParams.js'

export const HF_LIMITER_PRESET_PLUGIN = 'hf-limiter'

export const HF_LIMITER_PARAM_KEYS = [
  'freq', 'threshold', 'range', 'release', 'tail', 'transient', 'shape', 'output',
]

export const HF_LIMITER_SHAPES = ['tight', 'warm']
export const HF_LIMITER_OUTPUT_MIN_DB = -12
export const HF_LIMITER_OUTPUT_MAX_DB = 12

function clamp(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n < lo ? lo : n > hi ? hi : n
}

function normalize(p) {
  const d = HF_LIMITER_DEFAULTS
  return {
    freq: clamp(p.freq, FREQ_MIN_HZ, FREQ_MAX_HZ, d.freq),
    threshold: clamp(p.threshold, THRESHOLD_MIN_DB, THRESHOLD_MAX_DB, d.threshold),
    range: clamp(p.range, 0, RANGE_MAX_DB, d.range),
    release: clamp(p.release, RELEASE_MIN_MS, RELEASE_MAX_MS, d.release),
    tail: clamp(p.tail, 0, TAIL_MAX_MS, d.tail),
    transient: clamp(p.transient, 0, TRANSIENT_MAX_DB, d.transient),
    shape: HF_LIMITER_SHAPES.includes(p.shape) ? p.shape : d.shape,
    output: clamp(p.output, HF_LIMITER_OUTPUT_MIN_DB, HF_LIMITER_OUTPUT_MAX_DB, d.output),
  }
}

export const HF_LIMITER_PRESETS = [
  {
    id: 'factory:default',
    name: 'Default',
    description: 'The panel as it opens: WARM at 12 kHz, −8 dB, Range 12, 60 ms.',
    params: Object.fromEntries(HF_LIMITER_PARAM_KEYS.map(k => [k, HF_LIMITER_DEFAULTS[k]])),
  },
]

export function registerHfLimiterPresets() {
  return definePluginPresets({
    pluginId: HF_LIMITER_PRESET_PLUGIN,
    paramKeys: HF_LIMITER_PARAM_KEYS,
    factory: HF_LIMITER_PRESETS,
    normalize,
  })
}

registerHfLimiterPresets()
