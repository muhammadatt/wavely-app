/**
 * PHAT*SS presets.
 *
 * The preset params are the panel's controls and nothing else. Everything
 * MEASURED (voice level, Warmth's band references, the guard's ceiling, TAPE's
 * makeup, the output trim) is a property of the file, not the patch, and a
 * preset that carried one would apply another file's calibration. The bench's
 * rows (low push, head-bump override, loop step, output trim) are not on the
 * panel and stay out too, so a menu click can never flip a bench setting.
 *
 * One factory preset ships, the plugin's own opening state; voicings beyond
 * it are the owner's to cut.
 */

import { definePluginPresets } from './store.js'
import {
  PHATASS_DEFAULTS, WARMTH_MAX, TAPE_MAX_DB, OUTPUT_MIN_DB, OUTPUT_MAX_DB, INPUT_MIN_DB, INPUT_MAX_DB,
  ODD_EVEN_MAX, TAPE_CURVES, HF_MODES,
} from '../phatassParams.js'

export const PHATASS_PRESET_PLUGIN = 'phatass'

export const PHATASS_PARAM_KEYS = ['inputDb', 'warmth', 'oddEven', 'tape', 'tapeCurve', 'hf', 'mix', 'output']

function clamp(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n < lo ? lo : n > hi ? hi : n
}

function normalize(p) {
  const d = PHATASS_DEFAULTS
  return {
    inputDb: clamp(p.inputDb, INPUT_MIN_DB, INPUT_MAX_DB, d.inputDb),
    warmth: clamp(p.warmth, 0, WARMTH_MAX, d.warmth),
    oddEven: clamp(p.oddEven, 0, ODD_EVEN_MAX, d.oddEven),
    tape: clamp(p.tape, 0, TAPE_MAX_DB, d.tape),
    tapeCurve: TAPE_CURVES.includes(p.tapeCurve) ? p.tapeCurve : d.tapeCurve,
    hf: HF_MODES.includes(p.hf) ? p.hf : d.hf,
    mix: clamp(p.mix, 0, 1, d.mix),
    output: clamp(p.output, OUTPUT_MIN_DB, OUTPUT_MAX_DB, d.output),
  }
}

export const PHATASS_PRESETS = [
  {
    id: 'factory:default',
    name: 'Default',
    description: 'The panel as it opens: Warmth and Tape off, 30 IPS, fully wet.',
    params: Object.fromEntries(PHATASS_PARAM_KEYS.map(k => [k, PHATASS_DEFAULTS[k]])),
  },
]

export function registerPhatassPresets() {
  return definePluginPresets({
    pluginId: PHATASS_PRESET_PLUGIN,
    paramKeys: PHATASS_PARAM_KEYS,
    factory: PHATASS_PRESETS,
    normalize,
  })
}

registerPhatassPresets()
