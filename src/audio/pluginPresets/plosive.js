/**
 * Plosive Tamer presets.
 *
 * The panel's controls and nothing else. The voice level POP's rumble gate is
 * relative to is MEASURED on the file and stays out.
 *
 * ⚠ Only Default is the plugin's own opening state; the other two are
 * starting points reasoned from the stages' design, not auditioned voicings.
 */

import { definePluginPresets } from './store.js'
import {
  PLOSIVE_DEFAULTS, POP_DEPTH_MAX_DB, POP_FREQ_MIN_HZ, POP_FREQ_MAX_HZ, POP_RELEASE_MIN_MS, POP_RELEASE_MAX_MS,
  BURST_DEPTH_MAX_DB, BURST_FREQ_MIN_HZ, BURST_FREQ_MAX_HZ, BURST_LENGTH_MIN_MS, BURST_LENGTH_MAX_MS,
  OUTPUT_MIN_DB, OUTPUT_MAX_DB,
} from '../plosiveParams.js'

export const PLOSIVE_PRESET_PLUGIN = 'plosive'

export const PLOSIVE_PARAM_KEYS = [
  'popDepth', 'popFreq', 'popSensitivity', 'popRelease',
  'burstDepth', 'burstFreq', 'burstSensitivity', 'burstLength', 'output',
]

function clamp(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n < lo ? lo : n > hi ? hi : n
}

function normalize(p) {
  const d = PLOSIVE_DEFAULTS
  return {
    popDepth: clamp(p.popDepth, 0, POP_DEPTH_MAX_DB, d.popDepth),
    popFreq: clamp(p.popFreq, POP_FREQ_MIN_HZ, POP_FREQ_MAX_HZ, d.popFreq),
    popSensitivity: clamp(p.popSensitivity, 0, 100, d.popSensitivity),
    popRelease: clamp(p.popRelease, POP_RELEASE_MIN_MS, POP_RELEASE_MAX_MS, d.popRelease),
    burstDepth: clamp(p.burstDepth, 0, BURST_DEPTH_MAX_DB, d.burstDepth),
    burstFreq: clamp(p.burstFreq, BURST_FREQ_MIN_HZ, BURST_FREQ_MAX_HZ, d.burstFreq),
    burstSensitivity: clamp(p.burstSensitivity, 0, 100, d.burstSensitivity),
    burstLength: clamp(p.burstLength, BURST_LENGTH_MIN_MS, BURST_LENGTH_MAX_MS, d.burstLength),
    output: clamp(p.output, OUTPUT_MIN_DB, OUTPUT_MAX_DB, d.output),
  }
}

const defaults = Object.fromEntries(PLOSIVE_PARAM_KEYS.map(k => [k, PLOSIVE_DEFAULTS[k]]))

export const PLOSIVE_PRESETS = [
  {
    id: 'factory:default',
    name: 'Default',
    description: 'The panel as it opens: POP 12 dB below 120 Hz, BURST 6 dB above 3 kHz.',
    params: defaults,
  },
  {
    id: 'factory:pops-only',
    name: 'Pops Only',
    description: 'P and B thumps only; T, K and P releases are left alone.',
    params: { ...defaults, burstDepth: 0 },
  },
  {
    id: 'factory:close-mic',
    name: 'Close Mic',
    description: 'Close, unscreened mic: deeper and more eager on both, the pop corner a little higher.',
    params: { ...defaults, popDepth: 18, popFreq: 150, popSensitivity: 65, burstDepth: 9, burstSensitivity: 60 },
  },
]

export function registerPlosivePresets() {
  return definePluginPresets({
    pluginId: PLOSIVE_PRESET_PLUGIN,
    paramKeys: PLOSIVE_PARAM_KEYS,
    factory: PLOSIVE_PRESETS,
    normalize,
  })
}

registerPlosivePresets()
