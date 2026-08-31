/**
 * FET Punch (1176) factory presets.
 *
 * ⚠ IMPORTS NOTHING FROM `effects/fet1176Compressor.js` — that module reaches
 * the worklet loader and its `?worker&url` specifier, which only Vite
 * resolves, so importing it would put this whole collection out of reach of
 * `node --test`. Factory presets state every param, so there is no default to
 * inherit anyway.
 *
 * What the knobs mean, since three of them are dials rather than units:
 *
 *   INPUT DRIVE (0–100) drives the fixed internal threshold AND the audio
 *   path, so it is depth and level at once. That is why AUTO makeup matters
 *   more here than on OptoSmooth: a 20-point move swings the output by tens
 *   of dB.
 *
 *   ATTACK and RELEASE are 1–7 dials where 7 is FASTEST (20 us / 50 ms), as
 *   on the hardware. A preset asking for a slow attack asks for a LOW number.
 *
 *   SC HPF is a side-chain corner in Hz, 0 = off. It keeps a plosive or a
 *   rumble out of the detector without touching the audio.
 *
 *   MIX below 1 is parallel compression — the reason the deepest presets here
 *   are not also the loudest.
 */

import { definePluginPresets } from './store.js'

export const FET_PUNCH_PRESET_PLUGIN = 'fet-punch'

const OUTPUT_MIN_DB = -36
const OUTPUT_MAX_DB = 24
const RATIOS = ['4', '8', '12', '20', 'all']

function clamp(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return n < lo ? lo : n > hi ? hi : n
}

/**
 * ⚠ THE OUTPUT IS CANONICALISED TO 0 WHILE AUTO IS ON — see the same note on
 * OptoSmooth. It matters more here: Input drives the audio path as well as the
 * detector, so the measured makeup moves by tens of dB across that knob's
 * travel and a preset stating an output would be stale immediately.
 */
function normalize(params) {
  const autoMakeup = params.autoMakeup !== false
  return {
    inputDrive: clamp(params.inputDrive ?? 50, 0, 100),
    output: autoMakeup ? 0 : clamp(params.output ?? 0, OUTPUT_MIN_DB, OUTPUT_MAX_DB),
    // Dials, so they round: a stored 4.5 is not a position this control has.
    attack: Math.round(clamp(params.attack ?? 4, 1, 7)),
    release: Math.round(clamp(params.release ?? 4, 1, 7)),
    // An unrecognised ratio falls back to the stock position rather than
    // reaching the kernel — the kernel's own guard would drop it silently.
    ratio: RATIOS.includes(String(params.ratio)) ? String(params.ratio) : '4',
    fetDrive: clamp(params.fetDrive ?? 0.35, 0, 1),
    scHpf: clamp(params.scHpf ?? 0, 0, 500),
    mix: clamp(params.mix ?? 1, 0, 1),
    autoMakeup,
  }
}

export const FET_PUNCH_PARAM_KEYS = [
  'inputDrive', 'output', 'attack', 'release', 'ratio', 'fetDrive', 'scHpf', 'mix', 'autoMakeup',
]

export const FET_PUNCH_PRESETS = [
  {
    id: 'factory:vocal-punch',
    name: 'Vocal Punch',
    description: '4:1, medium ballistics. The one to reach for first.',
    params: {
      inputDrive: 55,
      output: 0,
      attack: 4,
      release: 5,
      ratio: '4',
      fetDrive: 0.35,
      scHpf: 0,
      mix: 1,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:consonant-control',
    name: 'Consonant Control',
    description: '8:1 with a fast attack and the lows out of the detector.',
    params: {
      inputDrive: 60,
      output: 0,
      // Fast enough to catch a consonant rather than ride behind it, with the
      // side-chain high-passed at 120 Hz so the fundamental is not what sets
      // the gain reduction.
      attack: 6,
      release: 5,
      ratio: '8',
      fetDrive: 0.3,
      scHpf: 120,
      mix: 1,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:gentle-ride',
    name: 'Gentle Ride',
    description: 'Slow attack, low drive — onsets pass, the body steadies.',
    params: {
      inputDrive: 40,
      output: 0,
      // A LOW attack number is a SLOW attack. Letting the onset through is
      // the whole point: this is the setting that keeps a narrator's diction
      // while taking the swing out of the phrase underneath it.
      attack: 2,
      release: 3,
      ratio: '4',
      fetDrive: 0.2,
      scHpf: 80,
      mix: 1,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:parallel-thickener',
    name: 'Parallel Thickener',
    description: '12:1 squashed hard and blended under the dry signal.',
    params: {
      // Deep and fast, then mixed back at 40%: the wet path is doing something
      // that would be unusable on its own, which is what parallel is for.
      inputDrive: 75,
      output: 0,
      attack: 7,
      release: 7,
      ratio: '12',
      fetDrive: 0.5,
      scHpf: 100,
      mix: 0.4,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:all-buttons-in',
    name: 'All Buttons In',
    description: 'The 1176 stunt setting, kept usable by the Mix knob.',
    params: {
      inputDrive: 70,
      output: 0,
      attack: 7,
      release: 7,
      ratio: 'all',
      fetDrive: 0.6,
      scHpf: 0,
      // Half wet. All-buttons-in is a distortion and ballistics effect more
      // than a compressor, and at Mix 1 it is a texture rather than a
      // treatment — which is not what a narration plugin should default to
      // when someone presses a preset out of curiosity.
      mix: 0.5,
      autoMakeup: true,
    },
  },
]

/**
 * Registration is a named function AND is called on import.
 *
 * Called on import because the registry has to answer the same way whatever
 * order the user opened windows in. Named because the store is a module-level
 * registry and a test that resets it needs a way to put the shipping
 * collection back — without one, the first test to reset would silently
 * un-register this plugin for every test after it.
 */
export function registerFetPunchPresets() {
  return definePluginPresets({
    pluginId: FET_PUNCH_PRESET_PLUGIN,
    paramKeys: FET_PUNCH_PARAM_KEYS,
    factory: FET_PUNCH_PRESETS,
    normalize,
  })
}

registerFetPunchPresets()
