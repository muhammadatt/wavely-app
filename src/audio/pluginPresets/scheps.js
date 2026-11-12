/**
 * Scheps Parallel presets.
 *
 * The panel's controls and nothing else: Character, Squash, Mix, Output and
 * whether AUTO owns the wet trim. The trim itself, the dry/wet correlation, the
 * density, the ceiling and the input alignment are MEASURED on the file and
 * stay out — a preset that carried one would level another file's material.
 *
 * One factory preset ships, the plugin's own opening state; voicings beyond it
 * are the owner's to cut.
 */

import { definePluginPresets } from './store.js'
import { SCHEPS_DEFAULTS } from '../effects/schepsParams.js'

export const SCHEPS_PRESET_PLUGIN = 'scheps-parallel'

export const SCHEPS_PARAM_KEYS = ['character', 'squash', 'mix', 'output', 'autoTrim']

export const SCHEPS_CHARACTERS = ['thick', 'presence']
export const SCHEPS_OUTPUT_MIN_DB = -12
export const SCHEPS_OUTPUT_MAX_DB = 12

function clamp(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n < lo ? lo : n > hi ? hi : n
}

function normalize(p) {
  const d = SCHEPS_DEFAULTS
  return {
    character: SCHEPS_CHARACTERS.includes(p.character) ? p.character : d.character,
    squash: clamp(p.squash, 0, 100, d.squash),
    mix: clamp(p.mix, 0, 100, d.mix),
    output: clamp(p.output, SCHEPS_OUTPUT_MIN_DB, SCHEPS_OUTPUT_MAX_DB, d.output),
    autoTrim: p.autoTrim === undefined ? true : !!p.autoTrim,
  }
}

export const SCHEPS_PRESETS = [
  {
    id: 'factory:default',
    name: 'Default',
    description: 'The panel as it opens: Thick, the calibrated Squash, auto trim on.',
    params: {
      character: SCHEPS_DEFAULTS.character,
      squash: SCHEPS_DEFAULTS.squash,
      mix: SCHEPS_DEFAULTS.mix,
      output: SCHEPS_DEFAULTS.output,
      autoTrim: true,
    },
  },
]

export function registerSchepsPresets() {
  return definePluginPresets({
    pluginId: SCHEPS_PRESET_PLUGIN,
    paramKeys: SCHEPS_PARAM_KEYS,
    factory: SCHEPS_PRESETS,
    normalize,
  })
}

registerSchepsPresets()
