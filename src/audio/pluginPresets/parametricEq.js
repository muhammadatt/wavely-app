/**
 * Parametric EQ presets.
 *
 * A preset is the whole band set — shape, frequency, gain, width and on/off per
 * band — and nothing else: ids, the solo, the analyzer and the axis range are
 * panel state. Bands are stored LOW TO HIGH, so two sets that differ only in
 * the order they were made in are the same preset and the browser lights it.
 *
 * Capped at the panel's eight bands (useManualEq's GENERAL_MAX_BANDS): a stored
 * set from a build that allowed more cannot push bands the faceplate has no
 * strip for. One factory preset ships — the four flat bands the panel opens
 * with — so the browser always has a place to return to.
 */

import { definePluginPresets } from './store.js'
import { FILTER_TYPES, PARAM_RANGES, DEFAULT_GENERAL_BANDS, qRangeFor } from '../eqBands.js'

export const PARAMETRIC_EQ_PRESET_PLUGIN = 'manual-eq'
export const PARAMETRIC_EQ_MAX_BANDS = 8

function clamp(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n < lo ? lo : n > hi ? hi : n
}

/** A band as a preset stores it: five fields, clamped, rounded past float dust. */
export function presetBand(b) {
  const type = FILTER_TYPES.includes(b?.type) ? b.type : 'peaking'
  const [qLo, qHi] = qRangeFor(type)
  const r = (x, d) => Number(x.toFixed(d))
  return {
    type,
    frequencyHz: r(clamp(b?.frequencyHz, ...PARAM_RANGES.frequencyHz, 1000), 2),
    gainDb: r(clamp(b?.gainDb, ...PARAM_RANGES.gainDb, 0), 2),
    q: r(clamp(b?.q, qLo, qHi, 1), 3),
    enabled: b?.enabled !== false,
  }
}

function normalize(p) {
  const list = Array.isArray(p.bands) ? p.bands : []
  return {
    bands: list.map(presetBand)
      .sort((a, b) => a.frequencyHz - b.frequencyHz)
      .slice(0, PARAMETRIC_EQ_MAX_BANDS),
  }
}

export const PARAMETRIC_EQ_PRESETS = [
  {
    id: 'factory:default',
    name: 'Default',
    description: 'The four flat bands the EQ opens with: a low shelf, two bells and a high shelf, all at 0 dB.',
    params: { bands: DEFAULT_GENERAL_BANDS.map(b => ({ ...b, gainDb: 0, enabled: true })) },
  },
]

export function registerParametricEqPresets() {
  return definePluginPresets({
    pluginId: PARAMETRIC_EQ_PRESET_PLUGIN,
    paramKeys: ['bands'],
    factory: PARAMETRIC_EQ_PRESETS,
    normalize,
  })
}

registerParametricEqPresets()
