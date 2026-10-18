/**
 * HF Softener presets.
 *
 * The panel's controls and nothing else: Duck and EQ (the panel's Amount and
 * Split are a view over this pair; Shape is pinned to shelf), Guard, Plosives,
 * Band (no longer on the panel), Detect (low and high), Air, AUTO (stored as
 * `comp`) and Soften. Air Mode is pinned to VOICED and is
 * not a preset param; what is MEASURED (AUTO's figure, the file's level) is
 * a property of the file, never the patch; the pinned tuning (Context,
 * Rotator, Release, Reso) stays out so a menu click can never move it.
 *
 * One factory preset ships, the plugin's own opening state; voicings beyond it
 * are the owner's to cut.
 */

import { definePluginPresets } from './store.js'
import { HF_SOFTENER_DEFAULTS } from '../hfSoftenerParams.js'
import {
  AIR_MAKEUP_MAX_DB, BAND_HZ_MIN, BAND_HZ_MAX, DETECT_HZ_MIN, DETECT_HZ_MAX, DETECT_HI_MIN, DETECT_HI_MAX,
} from '../hfSoftenerProcessor.js'
import { SOFTEN_MAX } from '../hfSoftenerSoftenStage.js'

export const HF_SOFTENER_PRESET_PLUGIN = 'hf-softener'

export const HF_SOFTENER_PARAM_KEYS = [
  'duck', 'amount', 'guard', 'plosives', 'band', 'detect', 'detectHigh', 'air', 'comp', 'soften',
]

function clamp(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n < lo ? lo : n > hi ? hi : n
}

function normalize(p) {
  const d = HF_SOFTENER_DEFAULTS
  return {
    duck: clamp(p.duck, 0, 100, d.duck),
    amount: clamp(p.amount, 0, 100, d.amount),
    guard: clamp(p.guard, 0, 100, d.guard),
    plosives: p.plosives === undefined ? d.plosives : !!p.plosives,
    band: clamp(p.band, BAND_HZ_MIN, BAND_HZ_MAX, d.band),
    detect: clamp(p.detect, DETECT_HZ_MIN, DETECT_HZ_MAX, d.detect),
    detectHigh: clamp(p.detectHigh, DETECT_HI_MIN, DETECT_HI_MAX, d.detectHigh),
    air: clamp(p.air, 0, AIR_MAKEUP_MAX_DB, d.air),
    comp: p.comp === undefined ? d.comp : !!p.comp,
    soften: clamp(p.soften, 0, SOFTEN_MAX, d.soften),
  }
}

export const HF_SOFTENER_PRESETS = [
  {
    id: 'factory:default',
    name: 'Default',
    description: 'The panel as it opens: Duck 40 / EQ 20 on the shelf shape, Guard 50, listening from 4 kHz and cutting from 4.5.',
    params: Object.fromEntries(HF_SOFTENER_PARAM_KEYS.map(k => [k, HF_SOFTENER_DEFAULTS[k]])),
  },
]

export function registerHfSoftenerPresets() {
  return definePluginPresets({
    pluginId: HF_SOFTENER_PRESET_PLUGIN,
    paramKeys: HF_SOFTENER_PARAM_KEYS,
    factory: HF_SOFTENER_PRESETS,
    normalize,
  })
}

registerHfSoftenerPresets()
