/**
 * ResoTame factory presets.
 *
 * This is the one plugin here whose preset is mostly a SHAPE rather than a set
 * of numbers: the zones carry a boundary and five settings each, and which
 * spans exist is as much of the preset as what each one does.
 *
 * Two things are deliberately NOT preset params:
 *
 *   `refMode` — the cepstral/peak reference. It is a build-level research
 *   override resolved once at module load (`?resoRef=cepstral`), and the two
 *   references disagree about what `selectivity` measures by an order of
 *   magnitude. A preset that carried it would silently re-scale every
 *   selectivity figure below; worse, it would let a menu click change which
 *   detector the plugin is running.
 *
 *   The monitoring modes — DELTA and the per-zone delta — and the selected
 *   zone. `applyResonanceRegion` spreads its param object straight into the
 *   kernel, so a monitoring mode in a preset is one Apply away from rendering
 *   a difference signal into the timeline. The store's whitelist is what makes
 *   that unexpressible; this note is why the whitelist reads as it does.
 *
 * SELECTIVITY IS A THRESHOLD, AND HIGHER IS LESS. Stock is 20, the top of the
 * range is 36, and the effect is essentially idle at 28 and above. So a zone
 * left in a preset at 26–30 is one being deliberately stood down without being
 * switched off — which keeps it available to a user who then wants to bring it
 * in, where a disabled zone reads as OFF on the display.
 *
 * Every selectivity here is against the SHIPPED PEAK reference.
 */

import { definePluginPresets } from './store.js'
import {
  RESONANCE_ZONE_RANGES, RESONANCE_ZONE_STOCK,
  RESONANCE_ZONE_MIN, RESONANCE_ZONE_MAX,
  RESONANCE_ATTACK_MIN_MS, RESONANCE_RELEASE_MIN_MS,
} from '../resonanceParams.js'

export const RESO_TAME_PRESET_PLUGIN = 'resonance-suppressor'

function clamp(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return n < lo ? lo : n > hi ? hi : n
}

/**
 * A zone, normalised against the same ranges `zoneSettings` clamps to.
 *
 * The boundary is clamped and the set is re-sorted below, because a stored
 * zone set with boundaries out of order is not a zone set the display or the
 * kernel can read — and unlike a knob value, nothing on the way in has already
 * checked it.
 */
function normalizeZone(zone, index) {
  const R = RESONANCE_ZONE_RANGES
  return {
    id: String(zone?.id ?? `z${index + 1}`),
    hiHz: clamp(zone?.hiHz ?? 20000, 20, 20000),
    depth: clamp(zone?.depth ?? RESONANCE_ZONE_STOCK.depth, R.depth.min, R.depth.max),
    sharpness: clamp(zone?.sharpness ?? RESONANCE_ZONE_STOCK.sharpness, R.sharpness.min, R.sharpness.max),
    selectivity: clamp(zone?.selectivity ?? RESONANCE_ZONE_STOCK.selectivity, R.selectivity.min, R.selectivity.max),
    maxCut: clamp(zone?.maxCut ?? RESONANCE_ZONE_STOCK.maxCut, R.maxCut.min, R.maxCut.max),
    protect: (zone?.protect ?? RESONANCE_ZONE_STOCK.protect) !== false,
    enabled: (zone?.enabled ?? true) !== false,
  }
}

function normalize(params) {
  let zones = Array.isArray(params.zones) ? params.zones : []
  zones = zones.slice(0, RESONANCE_ZONE_MAX).map(normalizeZone)
  zones.sort((a, b) => a.hiHz - b.hiHz)
  // The top zone always reaches the top of the spectrum: a set whose highest
  // boundary is below Nyquist leaves a band with no zone over it, which is not
  // a state the editor can produce and not one the kernel has an answer for.
  if (zones.length < RESONANCE_ZONE_MIN) {
    zones = [normalizeZone({ id: 'z1', hiHz: 20000 }, 0)]
  } else {
    zones[zones.length - 1].hiHz = 20000
  }
  return {
    attack: clamp(params.attack ?? 300, RESONANCE_ATTACK_MIN_MS, 400),
    release: clamp(params.release ?? 1500, RESONANCE_RELEASE_MIN_MS, 2000),
    mode: params.mode === 'hard' ? 'hard' : 'soft',
    mix: clamp(params.mix ?? 1, 0, 1),
    trim: clamp(params.trim ?? 0, -12, 12),
    zones,
  }
}

export const RESO_TAME_PARAM_KEYS = ['attack', 'release', 'mode', 'mix', 'trim', 'zones']

/** A zone at the stock settings with the given overrides — presets stay readable. */
function zone(id, hiHz, over = {}) {
  return { id, hiHz, ...RESONANCE_ZONE_STOCK, ...over }
}

export const RESO_TAME_PRESETS = [
  {
    id: 'factory:narration-default',
    name: 'Narration Default',
    description: 'The shipped three zones and ballistics. A starting point, not a result.',
    params: {
      attack: 300,
      release: 1500,
      mode: 'soft',
      mix: 1,
      trim: 0,
      // The shipped boundaries: below 180 Hz is rumble and the fundamental,
      // above 1.1 kHz is sibilance and ring. Restated rather than imported so
      // this preset survives DEFAULT_RESONANCE_ZONES moving.
      zones: [zone('z1', 180), zone('z2', 1100), zone('z3', 20000)],
    },
  },
  {
    id: 'factory:sibilance-tame',
    name: 'Sibilance Tame',
    description: 'Works the top only. Everything below 5 kHz stood down.',
    params: {
      // Faster than stock, because sibilance is a short event: at 300 ms of
      // attack the notch is still opening while the "s" is ending.
      attack: 120,
      release: 700,
      mode: 'soft',
      mix: 1,
      trim: 0,
      zones: [
        zone('z1', 180, { selectivity: 30 }),
        zone('z2', 5000, { selectivity: 30 }),
        // maxCut well below the 36 dB stock: a de-esser that can take 36 dB
        // out of a band takes the consonant with it, and the complaint that
        // follows is a lisp rather than a ring.
        zone('z3', 20000, { selectivity: 15, maxCut: 12 }),
      ],
    },
  },
  {
    id: 'factory:room-ring',
    name: 'Room Ring',
    description: 'Low and low-mid modes — a small untreated room.',
    params: {
      // Slow. A room mode rings for as long as the room does, so this is the
      // regime the ballistics sweep found: at matched cut a longer release is
      // better per dB removed, and spreads the same average over the phrase
      // instead of concentrating it in momentary deep notches.
      attack: 400,
      release: 2000,
      mode: 'soft',
      mix: 1,
      trim: 0,
      zones: [
        zone('z1', 120, { selectivity: 14, maxCut: 18 }),
        zone('z2', 500, { selectivity: 16, maxCut: 15 }),
        zone('z3', 20000, { depth: 0.3, selectivity: 28 }),
      ],
    },
  },
  {
    id: 'factory:boxy-honky',
    name: 'Boxy / Honky',
    description: 'Four zones over the low mids, where cardboard and nasality sit.',
    params: {
      attack: 250,
      release: 1200,
      mode: 'soft',
      mix: 1,
      trim: 0,
      zones: [
        zone('z1', 180, { depth: 0.2, selectivity: 28 }),
        zone('z2', 700, { selectivity: 14, maxCut: 12 }),
        zone('z3', 2000, { selectivity: 16, maxCut: 10 }),
        zone('z4', 20000, { depth: 0.3, selectivity: 28 }),
      ],
    },
  },
  {
    id: 'factory:gentle-polish',
    name: 'Gentle Polish',
    description: 'Shallow everywhere, blended back. For a file that is nearly right.',
    params: {
      attack: 400,
      release: 2000,
      mode: 'soft',
      // The only preset here that does not run fully wet. A 6 dB ceiling at
      // half depth blended at 0.8 is a treatment you have to A/B to hear,
      // which is the correct amount for a file with nothing obviously wrong.
      mix: 0.8,
      trim: 0,
      zones: [
        zone('z1', 180, { depth: 0.5, selectivity: 26, maxCut: 6 }),
        zone('z2', 1100, { depth: 0.5, selectivity: 26, maxCut: 6 }),
        zone('z3', 20000, { depth: 0.5, selectivity: 26, maxCut: 6 }),
      ],
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
export function registerResoTamePresets() {
  return definePluginPresets({
    pluginId: RESO_TAME_PRESET_PLUGIN,
    paramKeys: RESO_TAME_PARAM_KEYS,
    factory: RESO_TAME_PRESETS,
    normalize,
  })
}

registerResoTamePresets()
