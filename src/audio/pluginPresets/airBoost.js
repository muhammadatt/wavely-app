/**
 * Air Boost presets.
 *
 * The panel's two controls. One factory preset ships, the plugin's own
 * opening state; voicings beyond it are the owner's to cut.
 */

import { definePluginPresets } from './store.js'
import {
  AIR_BAND_DEFAULTS, AIR_MAX_DB, AIR_OUTPUT_MIN_DB, AIR_OUTPUT_MAX_DB,
} from '../airBandParams.js'

export const AIR_BOOST_PRESET_PLUGIN = 'air-boost'

export const AIR_BOOST_PARAM_KEYS = ['air', 'output']

function clamp(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n < lo ? lo : n > hi ? hi : n
}

function normalize(p) {
  return {
    air: clamp(p.air, 0, AIR_MAX_DB, AIR_BAND_DEFAULTS.air),
    output: clamp(p.output, AIR_OUTPUT_MIN_DB, AIR_OUTPUT_MAX_DB, AIR_BAND_DEFAULTS.output),
  }
}

export const AIR_BOOST_PRESETS = [
  {
    id: 'factory:default',
    name: 'Default',
    description: 'The panel as it opens: 6 dB of air, no output trim.',
    params: { ...AIR_BAND_DEFAULTS },
  },
]

export function registerAirBoostPresets() {
  return definePluginPresets({
    pluginId: AIR_BOOST_PRESET_PLUGIN,
    paramKeys: AIR_BOOST_PARAM_KEYS,
    factory: AIR_BOOST_PRESETS,
    normalize,
  })
}

registerAirBoostPresets()
