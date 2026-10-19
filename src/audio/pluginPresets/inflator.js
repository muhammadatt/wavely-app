/**
 * Inflator presets.
 *
 * Only the panel's six controls are preset params. One factory preset ships,
 * the plugin's own opening state, so the Modula header's browser always has a
 * place to return to; voicings beyond it are the owner's to cut.
 */

import { definePluginPresets } from './store.js'
import {
  INFLATOR_DEFAULTS, INFLATOR_INPUT_MIN_DB, INFLATOR_INPUT_MAX_DB,
  INFLATOR_OUTPUT_MIN_DB, INFLATOR_OUTPUT_MAX_DB, CURVE_MIN_PCT, CURVE_MAX_PCT,
} from '../inflatorParams.js'

export const INFLATOR_PRESET_PLUGIN = 'inflator'

export const INFLATOR_PARAM_KEYS = ['inputDb', 'effect', 'curve', 'outputDb', 'clip', 'bandSplit']

function clamp(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n < lo ? lo : n > hi ? hi : n
}

/** The same ranges the panel's controls clamp to. */
function normalize(p) {
  return {
    inputDb: clamp(p.inputDb, INFLATOR_INPUT_MIN_DB, INFLATOR_INPUT_MAX_DB, INFLATOR_DEFAULTS.inputDb),
    effect: clamp(p.effect, 0, 1, INFLATOR_DEFAULTS.effect),
    curve: clamp(p.curve, CURVE_MIN_PCT, CURVE_MAX_PCT, INFLATOR_DEFAULTS.curve),
    outputDb: clamp(p.outputDb, INFLATOR_OUTPUT_MIN_DB, INFLATOR_OUTPUT_MAX_DB, INFLATOR_DEFAULTS.outputDb),
    clip: !!p.clip,
    bandSplit: !!p.bandSplit,
  }
}

export const INFLATOR_PRESETS = [
  {
    id: 'factory:default',
    name: 'Default',
    description: 'The panel as it opens: half Effect, a flat curve, no split, no clip.',
    params: { ...INFLATOR_DEFAULTS },
  },
]

export function registerInflatorPresets() {
  return definePluginPresets({
    pluginId: INFLATOR_PRESET_PLUGIN,
    paramKeys: INFLATOR_PARAM_KEYS,
    factory: INFLATOR_PRESETS,
    normalize,
  })
}

registerInflatorPresets()
