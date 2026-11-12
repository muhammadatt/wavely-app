/**
 * Saturation Workbench presets.
 *
 * A preset is the whole stack: the layers (curve, drive, amount, band,
 * pre-emphasis, mute) and the IN / OUT trims. Everything MEASURED stays out —
 * each layer's reference peak and the voicing offset come from the file, so a
 * preset means the same distortion on a quiet narration and a hot one — and so
 * does the SOLO, which is a listening aid and never part of a patch.
 *
 * Layers in use are contiguous at the top; the unused slots ride along as the
 * slot's own factory layer, switched off, so a preset never leaves a stale layer
 * behind for the + tab to resurrect.
 *
 * ⚠ The voicings below are REASONED from what each curve and band does, not
 * auditioned. Drive reads in dB above the matched point (see the panel), so a
 * high band wants +12 to +27 where a full-band layer wants single digits.
 */

import { definePluginPresets } from './store.js'
import { SAT_BENCH_LAYER_PRESETS } from '../saturationBenchParams.js'
import {
  SAT_BENCH_MAX_LAYERS, SAT_BAND_MIN_HZ, SAT_BAND_MAX_HZ, SAT_EMPH_QUICK, normalizeLayer,
} from '../dsp/saturationLayers.js'

export const SATURATION_BENCH_PRESET_PLUGIN = 'saturation-bench'

export const SATURATION_BENCH_PARAM_KEYS = ['layers', 'inputDb', 'outputDb']

export const SATURATION_BENCH_TRIM_MIN_DB = -24
export const SATURATION_BENCH_TRIM_MAX_DB = 24

function clamp(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n < lo ? lo : n > hi ? hi : n
}

/** One layer as the panel stores it: the kernel's fields, minus what is measured. */
function panelLayer(p, slot) {
  const l = normalizeLayer({ ...SAT_BENCH_LAYER_PRESETS[slot], ...p })
  delete l.refPeakDb
  return { ...l, muted: !!p?.muted, mode: 'full' }
}

/**
 * Four slots, in-use layers first and at least one of them. A stored preset can
 * be anything the cloud returns, so every slot is rebuilt from clamped fields.
 */
function normalize(p) {
  const given = Array.isArray(p.layers) ? p.layers : []
  const slots = []
  for (let k = 0; k < SAT_BENCH_MAX_LAYERS; k++) slots.push(panelLayer(given[k] ?? { on: false }, k))
  const used = slots.filter(l => l.on)
  const spare = slots.filter(l => !l.on)
  if (used.length === 0) {
    const first = panelLayer({ ...SAT_BENCH_LAYER_PRESETS[0] }, 0)
    return finish([first, ...spare.slice(0, SAT_BENCH_MAX_LAYERS - 1)], p)
  }
  return finish([...used, ...spare], p)
}

function finish(layers, p) {
  return {
    layers,
    inputDb: clamp(p.inputDb, SATURATION_BENCH_TRIM_MIN_DB, SATURATION_BENCH_TRIM_MAX_DB, 0),
    outputDb: clamp(p.outputDb, SATURATION_BENCH_TRIM_MIN_DB, SATURATION_BENCH_TRIM_MAX_DB, 0),
  }
}

// ── Factory voicings ────────────────────────────────────────────────────────

const FLAT = { emphType: 'hishelf', emphHz: 2300, emphQ: 0.71, emphDb: 0 }

/** A layer in use; anything not named is a full-band, flat-emphasis layer at 0 dB. */
function layer(curve, driveDb, o = {}) {
  return {
    on: true, muted: false, curve, driveDb, amountDb: o.amountDb ?? 0,
    ...(o.emph ?? FLAT), emphOn: o.emph !== undefined,
    loHz: o.lo ?? SAT_BAND_MIN_HZ, hiHz: o.hi ?? SAT_BAND_MAX_HZ, mode: 'full',
  }
}

/** The four slots a preset names; the rest are the slot's own layer, off. */
function stack(...used) {
  return Array.from({ length: SAT_BENCH_MAX_LAYERS }, (_, k) =>
    (used[k] ? used[k] : { ...SAT_BENCH_LAYER_PRESETS[k], on: false }))
}

const bell = (hz, db, q = 1) => ({ emphType: 'bell', emphHz: hz, emphQ: q, emphDb: db })
const loShelf = (hz, db, q = 0.71) => ({ emphType: 'loshelf', emphHz: hz, emphQ: q, emphDb: db })

export const SATURATION_BENCH_PRESETS = [
  {
    id: 'factory:default',
    name: 'Default',
    description: 'The panel as it opens: a full-band Quartic for density and a Tanh exciter above 3 kHz.',
    params: {
      layers: SAT_BENCH_LAYER_PRESETS.map(l => ({ ...l, muted: false })),
      inputDb: 0,
      outputDb: 0,
    },
  },
  {
    id: 'factory:warm-body',
    name: 'Warm Body',
    description: 'One Quartic layer under 1 kHz, its low shelf pushed into the curve: weight and density without edge.',
    params: {
      layers: stack(layer('quartic', 6, { hi: 1000, emph: loShelf(250, 6) })),
      inputDb: 0,
      outputDb: 0,
    },
  },
  {
    id: 'factory:air-exciter',
    name: 'Air Exciter',
    description: 'A Tanh layer above 3 kHz fed with the highs pulled down first, so it adds brightness on vowels and spares the S.',
    params: {
      layers: stack(layer('tanh', 27, { lo: 3000, emph: SAT_EMPH_QUICK.reverse })),
      inputDb: 0,
      outputDb: 0,
    },
  },
  {
    id: 'factory:tape-glue',
    name: 'Tape Glue',
    description: 'Full-band Hysteresis at a moderate drive, added a little under the dry: soft onsets and a bound-together feel.',
    params: {
      layers: stack(layer('hysteresis', 9, { amountDb: -6 })),
      inputDb: 0,
      outputDb: 0,
    },
  },
  {
    id: 'factory:presence',
    name: 'Presence',
    description: 'A Cubic layer on 1.5–8 kHz with a bell at 3 kHz leaning on the curve: forward, articulate mids.',
    params: {
      layers: stack(layer('cubic', 12, { amountDb: -4, lo: 1500, hi: 8000, emph: bell(3000, 6) })),
      inputDb: 0,
      outputDb: 0,
    },
  },
  {
    id: 'factory:three-band-stack',
    name: 'Three-Band Stack',
    description: 'Quartic on the lows, Tanh through the mids and Atan on the top, each on its own band: a fuller, evenly coloured voice.',
    params: {
      layers: stack(
        layer('quartic', 8, { hi: 300 }),
        layer('tanh', 6, { amountDb: -3, lo: 300, hi: 5000 }),
        layer('atan', 18, { amountDb: -3, lo: 5000, hi: SAT_BAND_MAX_HZ }),
      ),
      inputDb: 0,
      outputDb: 0,
    },
  },
]

export function registerSaturationBenchPresets() {
  return definePluginPresets({
    pluginId: SATURATION_BENCH_PRESET_PLUGIN,
    paramKeys: SATURATION_BENCH_PARAM_KEYS,
    factory: SATURATION_BENCH_PRESETS,
    normalize,
  })
}

registerSaturationBenchPresets()
