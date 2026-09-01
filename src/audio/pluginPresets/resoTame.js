/**
 * ResoTame factory presets.
 *
 * ⚠ THIS PLUGIN HAS TWO AUTHORING MODELS AND A PRESET BELONGS TO EXACTLY ONE.
 * FOCUS ships — a global detector plus a sparse overlay of nodes biasing the
 * threshold — and ZONES are what it replaced, still reachable behind
 * `?resoTargeting=zones` so a patch built under them can be opened. The kernel
 * dispatches on which is present: a non-null `focus` TAKES OVER from `zones`.
 *
 * So the two are not translations of each other and must not be offered as if
 * they were. A zone set pushed while focus is live is inert; a focus patch
 * pushed while zones are live silently switches the model out from under a
 * panel still showing zone controls. Both would look like a working menu.
 *
 * WHICH TABLE IS REGISTERED IS DECIDED BY `resolveTargeting()`, once, at module
 * load — the same moment and the same answer the composable uses, so the menu
 * cannot offer a preset for a model the panel is not running. The unused table
 * still exists in this file: it is the authored content for the other model,
 * not dead code, and flipping the flag is what reaches it.
 *
 * Two things are deliberately NOT preset params under either model:
 *
 *   `refMode` — the cepstral/peak reference. It is a build-level research
 *   override resolved once at module load, and the two references disagree
 *   about what Selectivity measures by an order of magnitude. A preset that
 *   carried it would silently re-scale every threshold figure below; worse, it
 *   would let a menu click change which detector is running.
 *
 *   The monitoring modes — DELTA, the per-zone delta, the focus SOLO — and the
 *   selected zone or node. `applyResonanceRegion` spreads its param object
 *   straight into the kernel, so a monitoring mode in a preset is one Apply
 *   away from rendering a difference signal, or a one-node pass, into the
 *   timeline. `focus.solo` is the dangerous one: it is an ordinary field on the
 *   focus patch, so nothing about it would LOOK wrong. `normalize` drops it.
 *
 * THRESHOLD RUNS BACKWARDS AND A NODE'S AMOUNT DOES NOT. `selectivity` is a
 * threshold, so higher means less is cut — stock 20, and the effect is
 * essentially idle from about 28 up. A node's `biasDb` is stated the way a
 * person thinks about it: POSITIVE IS "work harder here", and it is subtracted
 * from the global. So a preset that stands a band down carries a NEGATIVE bias.
 *
 * Every figure here is against the SHIPPED PEAK reference.
 */

import { definePluginPresets } from './store.js'
import {
  RESONANCE_ZONE_RANGES, RESONANCE_ZONE_STOCK,
  RESONANCE_ZONE_MIN, RESONANCE_ZONE_MAX,
  RESONANCE_ATTACK_MIN_MS, RESONANCE_RELEASE_MIN_MS,
} from '../resonanceParams.js'
import {
  RESONANCE_FOCUS_GLOBAL, RESONANCE_FOCUS_RANGES, RESONANCE_FOCUS_MAX_NODES,
  FOCUS_SHAPES,
} from '../resonanceFocus.js'
import { resolveTargeting } from '../resonanceTargeting.js'

/**
 * THE PLUGIN ID CARRIES THE TARGETING MODEL, AND IT HAS TO.
 *
 * The factory table can be chosen per model, but the USER's collection is
 * keyed by plugin id and persists across sessions — so a preset saved under
 * zones would appear in a focus session's menu carrying `focus: null`, and
 * selecting it would push a null focus, which the kernel reads as "use the zone
 * set". The model would switch under a panel still showing focus controls, from
 * a menu click, with nothing saying so.
 *
 * Two ids means two collections that cannot see each other, which is the right
 * answer for two authoring models that are not translations of one another.
 * Nothing is lost: flipping the flag back brings that session's own presets
 * with it.
 */
export function resoTamePluginId(targeting = resolveTargeting()) {
  return `resonance-suppressor:${targeting}`
}

export const RESO_TAME_PRESET_PLUGIN = resoTamePluginId()

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

function normalizeZones(input) {
  let zones = Array.isArray(input) ? input : []
  zones = zones.slice(0, RESONANCE_ZONE_MAX).map(normalizeZone)
  zones.sort((a, b) => a.hiHz - b.hiHz)
  // The top zone always reaches the top of the spectrum: a set whose highest
  // boundary is below Nyquist leaves a band with no zone over it, which is not
  // a state the editor can produce and not one the kernel has an answer for.
  if (zones.length < RESONANCE_ZONE_MIN) {
    return [normalizeZone({ id: 'z1', hiHz: 20000 }, 0)]
  }
  zones[zones.length - 1].hiHz = 20000
  return zones
}

/**
 * A focus patch, normalised — and with `solo` DROPPED rather than clamped.
 *
 * Solo is a monitoring mode that happens to live on the same object as the
 * parameters, which is what makes it worth a line of its own here: everything
 * else on this patch is a setting, so an omission would read as an oversight
 * rather than as the whole point. A preset that carried it would render a
 * one-node pass into the timeline on the next Apply.
 */
function normalizeFocus(input) {
  if (!input) return null
  const R = RESONANCE_FOCUS_RANGES
  const S = RESONANCE_FOCUS_GLOBAL
  const g = input.global ?? {}
  const nodes = (Array.isArray(input.nodes) ? input.nodes : [])
    .slice(0, RESONANCE_FOCUS_MAX_NODES)
    .map((n, i) => ({
      id: String(n?.id ?? `n${i + 1}`),
      // An unrecognised shape falls back to the default rather than passing
      // through, matching `focusNode` — a typo must not produce a fourth
      // behaviour.
      shape: FOCUS_SHAPES.includes(n?.shape) ? n.shape : 'bell',
      hz: clamp(n?.hz ?? 1000, R.hz.min, R.hz.max),
      spanOct: clamp(n?.spanOct ?? 1, R.spanOct.min, R.spanOct.max),
      biasDb: clamp(n?.biasDb ?? 0, R.biasDb.min, R.biasDb.max),
      enabled: (n?.enabled ?? true) !== false,
    }))
  return {
    global: {
      depth: clamp(g.depth ?? S.depth, R.depth.min, R.depth.max),
      sharpness: clamp(g.sharpness ?? S.sharpness, R.sharpness.min, R.sharpness.max),
      selectivity: clamp(g.selectivity ?? S.selectivity, R.selectivity.min, R.selectivity.max),
      maxCut: clamp(g.maxCut ?? S.maxCut, R.maxCut.min, R.maxCut.max),
      protect: (g.protect ?? S.protect) !== false,
      protectCeilHz: clamp(
        g.protectCeilHz ?? S.protectCeilHz, R.protectCeilHz.min, R.protectCeilHz.max),
    },
    nodes,
  }
}

/**
 * `focus` is normalised AGAINST THE MODEL THIS COLLECTION BELONGS TO.
 *
 * In a focus session a null patch is repaired to the stock global rather than
 * passed through, because null is not a missing value here — it is the
 * instruction to read the zone set instead, i.e. to switch models. In a zone
 * session the reverse: any patch is dropped to null, so nothing coming out of
 * storage can take the model over.
 */
function makeNormalize(targeting) {
  const focusModel = targeting !== 'zones'
  return (params) => normalizeParams(params, focusModel)
}

function normalizeParams(params, focusModel) {
  return {
    attack: clamp(params.attack ?? 200, RESONANCE_ATTACK_MIN_MS, 400),
    release: clamp(params.release ?? 500, RESONANCE_RELEASE_MIN_MS, 2000),
    mode: params.mode === 'hard' ? 'hard' : 'soft',
    mix: clamp(params.mix ?? 1, 0, 1),
    trim: clamp(params.trim ?? 0, -12, 12),
    zones: normalizeZones(params.zones),
    focus: focusModel
      ? (normalizeFocus(params.focus) ?? { global: { ...RESONANCE_FOCUS_GLOBAL }, nodes: [] })
      : null,
  }
}

/**
 * Both models' keys, whichever table is registered.
 *
 * The union rather than one model's half, because the whitelist's job is to
 * refuse everything that is NOT a param — and a preset stating the inert value
 * for the model it was not authored in is what makes it complete rather than
 * partial. `focus: null` is that inert value for a zone preset; the stock zone
 * set is it for a focus preset, since a non-null focus takes over anyway.
 */
export const RESO_TAME_PARAM_KEYS = ['attack', 'release', 'mode', 'mix', 'trim', 'zones', 'focus']

/** A zone at the stock settings with the given overrides — presets stay readable. */
function zone(id, hiHz, over = {}) {
  return { id, hiHz, ...RESONANCE_ZONE_STOCK, ...over }
}

/** A focus node. `biasDb` positive means "work harder here". */
function node(id, hz, biasDb, over = {}) {
  return { id, shape: 'bell', hz, spanOct: 1, biasDb, enabled: true, ...over }
}

/**
 * The stock zone set, restated so a focus preset is complete.
 *
 * Exported because the panel needs the same value: in focus mode the zone half
 * is inert, and the panel has to REPORT it as whatever the presets state or
 * every preset would read as MODIFIED against a zone set nobody in that session
 * can see or edit.
 */
export const RESO_TAME_STOCK_ZONES = [zone('z1', 180), zone('z2', 1100), zone('z3', 20000)]

/** The global detector at stock, with the given overrides. */
function global_(over = {}) {
  return { ...RESONANCE_FOCUS_GLOBAL, ...over }
}

/**
 * ── FOCUS PRESETS (the shipping model) ──────────────────────────────────────
 *
 * Each is a global threshold plus two or three nodes. Read a node as "work
 * this much harder (or less hard) around here": the stock global is 20, the
 * effect is idle from about 28 up, and 3 is as hard as the detector goes — so
 * a −10 bias on a band is close to standing it down and a +8 is working it.
 */
export const RESO_TAME_FOCUS_PRESETS = [
  {
    id: 'factory:narration-default',
    name: 'Narration Default',
    description: 'The global detector, no nodes. A starting point, not a result.',
    params: {
      attack: 200,
      release: 500,
      mode: 'soft',
      mix: 1,
      trim: 0,
      zones: RESO_TAME_STOCK_ZONES,
      // THE EMPTY NODE LIST IS THE PRESET, not a placeholder for one. A flat
      // bias is exactly the stock patch, so this is the "put it back" entry —
      // the thing a menu of four opinionated presets most needs and the one
      // nobody thinks to author.
      focus: { global: global_(), nodes: [] },
    },
  },
  {
    id: 'factory:sibilance-tame',
    name: 'Sibilance Tame',
    description: 'Works the top with a shelf, and stands the rest down.',
    params: {
      // Faster than stock, because sibilance is a short event: at 200 ms of
      // attack the notch is still opening while the "s" is ending.
      attack: 80,
      release: 300,
      mode: 'soft',
      mix: 1,
      trim: 0,
      zones: RESO_TAME_STOCK_ZONES,
      focus: {
        // maxCut well below the 36 dB stock: a de-esser that can take 36 dB
        // out of a band takes the consonant with it, and the complaint that
        // follows is a lisp rather than a ring.
        global: global_({ maxCut: 12 }),
        nodes: [
          // A SHELF, NOT A BELL, and that is the reason shelves exist: "all the
          // air" aimed with a bell wide enough to cover 5–16 kHz also lifts the
          // midrange on its way past.
          node('n1', 5000, 8, { shape: 'high', spanOct: 1.2 }),
          // Everything below the corner explicitly stood down, so the extra
          // depth is spent where it was aimed.
          node('n2', 2000, -10, { shape: 'low', spanOct: 1.5 }),
        ],
      },
    },
  },
  {
    id: 'factory:room-ring',
    name: 'Room Ring',
    description: 'Low and low-mid modes — a small untreated room.',
    params: {
      // Slow. A room mode rings for as long as the room does, which is the
      // regime the ballistics sweep found: at matched cut a longer release is
      // better per dB removed, and spreads the same average over the phrase
      // instead of concentrating it in momentary deep notches.
      attack: 300,
      release: 1200,
      mode: 'soft',
      mix: 1,
      trim: 0,
      zones: RESO_TAME_STOCK_ZONES,
      focus: {
        global: global_({ maxCut: 18 }),
        nodes: [
          node('n1', 110, 8, { spanOct: 1.2 }),
          node('n2', 260, 6, { spanOct: 1 }),
          node('n3', 3000, -8, { shape: 'high', spanOct: 1.5 }),
        ],
      },
    },
  },
  {
    id: 'factory:boxy-honky',
    name: 'Boxy / Honky',
    description: 'Two nodes over the low mids, where cardboard and nasality sit.',
    params: {
      attack: 200,
      release: 700,
      mode: 'soft',
      mix: 1,
      trim: 0,
      zones: RESO_TAME_STOCK_ZONES,
      focus: {
        global: global_({ maxCut: 12 }),
        nodes: [
          node('n1', 450, 8, { spanOct: 1.2 }),
          node('n2', 1300, 6, { spanOct: 1 }),
          node('n3', 150, -8, { shape: 'low', spanOct: 1 }),
        ],
      },
    },
  },
  {
    id: 'factory:gentle-polish',
    name: 'Gentle Polish',
    description: 'Shallow everywhere, blended back. For a file that is nearly right.',
    params: {
      attack: 300,
      release: 1200,
      mode: 'soft',
      // The only preset here that does not run fully wet. A 6 dB ceiling at a
      // threshold of 26 blended at 0.8 is a treatment you have to A/B to hear,
      // which is the correct amount for a file with nothing obviously wrong.
      mix: 0.8,
      trim: 0,
      zones: RESO_TAME_STOCK_ZONES,
      focus: {
        // No nodes: the point is that it is even-handed. Raising the global
        // threshold is how this model says "less of everything", where the zone
        // model needed the same number written into every zone.
        global: global_({ selectivity: 26, maxCut: 6, depth: 0.5 }),
        nodes: [],
      },
    },
  },
]

/**
 * ── ZONE PRESETS (the model behind `?resoTargeting=zones`) ──────────────────
 *
 * Authored in absolute per-zone settings, which is what that model has: a zone
 * carrying selectivity 20 is saying "twenty", not "no opinion", so the whole
 * spectrum has to be partitioned and every partition tuned. `focus: null` is
 * what keeps the kernel reading these rather than a focus patch.
 */
export const RESO_TAME_ZONE_PRESETS = [
  {
    id: 'factory:narration-default',
    name: 'Narration Default',
    description: 'The shipped three zones. A starting point, not a result.',
    params: {
      attack: 200,
      release: 500,
      mode: 'soft',
      mix: 1,
      trim: 0,
      // Below 180 Hz is rumble and the fundamental, above 1.1 kHz is sibilance
      // and ring. Restated rather than imported so this preset survives
      // DEFAULT_RESONANCE_ZONES moving.
      zones: RESO_TAME_STOCK_ZONES,
      focus: null,
    },
  },
  {
    id: 'factory:sibilance-tame',
    name: 'Sibilance Tame',
    description: 'Works the top only. Everything below 5 kHz stood down.',
    params: {
      attack: 80,
      release: 300,
      mode: 'soft',
      mix: 1,
      trim: 0,
      zones: [
        zone('z1', 180, { selectivity: 30 }),
        zone('z2', 5000, { selectivity: 30 }),
        zone('z3', 20000, { selectivity: 15, maxCut: 12 }),
      ],
      focus: null,
    },
  },
  {
    id: 'factory:room-ring',
    name: 'Room Ring',
    description: 'Low and low-mid modes — a small untreated room.',
    params: {
      attack: 300,
      release: 1200,
      mode: 'soft',
      mix: 1,
      trim: 0,
      zones: [
        zone('z1', 120, { selectivity: 14, maxCut: 18 }),
        zone('z2', 500, { selectivity: 16, maxCut: 15 }),
        zone('z3', 20000, { depth: 0.3, selectivity: 28 }),
      ],
      focus: null,
    },
  },
  {
    id: 'factory:boxy-honky',
    name: 'Boxy / Honky',
    description: 'Four zones over the low mids, where cardboard and nasality sit.',
    params: {
      attack: 200,
      release: 700,
      mode: 'soft',
      mix: 1,
      trim: 0,
      zones: [
        zone('z1', 180, { depth: 0.2, selectivity: 28 }),
        zone('z2', 700, { selectivity: 14, maxCut: 12 }),
        zone('z3', 2000, { selectivity: 16, maxCut: 10 }),
        zone('z4', 20000, { depth: 0.3, selectivity: 28 }),
      ],
      focus: null,
    },
  },
  {
    id: 'factory:gentle-polish',
    name: 'Gentle Polish',
    description: 'Shallow everywhere, blended back. For a file that is nearly right.',
    params: {
      attack: 300,
      release: 1200,
      mode: 'soft',
      mix: 0.8,
      trim: 0,
      zones: [
        zone('z1', 180, { depth: 0.5, selectivity: 26, maxCut: 6 }),
        zone('z2', 1100, { depth: 0.5, selectivity: 26, maxCut: 6 }),
        zone('z3', 20000, { depth: 0.5, selectivity: 26, maxCut: 6 }),
      ],
      focus: null,
    },
  },
]

/** The table for a targeting model. Exported so a test can register either. */
export function resoTamePresetsFor(targeting) {
  return targeting === 'zones' ? RESO_TAME_ZONE_PRESETS : RESO_TAME_FOCUS_PRESETS
}

/**
 * Registration is a named function AND is called on import.
 *
 * Called on import because the registry has to answer the same way whatever
 * order the user opened windows in. Named because the store is a module-level
 * registry and a test that resets it needs a way to put the shipping
 * collection back — without one, the first test to reset would silently
 * un-register this plugin for every test after it.
 *
 * `targeting` defaults to whatever the session resolved, which is the same
 * answer `useResonance` got. A test passes the other one.
 */
export function registerResoTamePresets(targeting = resolveTargeting()) {
  return definePluginPresets({
    pluginId: resoTamePluginId(targeting),
    paramKeys: RESO_TAME_PARAM_KEYS,
    factory: resoTamePresetsFor(targeting),
    normalize: makeNormalize(targeting),
  })
}

registerResoTamePresets()
