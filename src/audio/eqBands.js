/**
 * Manual EQ band model and role taxonomy.
 *
 * Pure data and pure functions — no Web Audio, no DOM, no Vue. The kernel, the
 * curve renderer, both plugins and the tests all read the band shape from here,
 * so there is one definition of what a band is.
 *
 * THE GOVERNING RULE (manual EQ spec §2.1): constraints govern the reachable
 * set, not the representable set. A plugin restricts what the user can *do*; it
 * never restricts what can exist. Nothing in this module clamps, snaps or drops
 * a band to suit whoever is displaying it, and there is deliberately no
 * function here that could — which is what lets VoiceRx hand its bands to the
 * EQ by moving objects rather than by translating between two band formats.
 *
 * The rule was originally about mode switching, when EQ and VoiceRx were two
 * views onto one pool. They are separate plugins with separate pools now (see
 * useEqInstance.js), and the rule outlived the design that prompted it.
 *
 * EVERY BAND CARRIES EVERY FIELD, from the first commit, whoever created it.
 * General-created bands get `role: null` and `canonicalQ: null` rather than
 * omitting the keys. Retrofitting role metadata later would mean migrating
 * saved chains, which is a migration worth not needing.
 */

import { REGION_ORDER, SCAN_LOW, SCAN_HIGH } from './voicerx/regions.js'

/**
 * UI clutter limit, not a CPU one — biquads are cheap. The cascade is sized to
 * this so slots can be filled with pass-throughs instead of reallocating.
 */
export const MAX_BANDS = 12

/** Filter types the engine understands. VoiceRx uses only the first three. */
export const FILTER_TYPES = [
  'peaking', 'lowshelf', 'highshelf', 'highpass', 'lowpass', 'notch',
]

/**
 * Parameter ranges for General mode (spec §7.4, §8.1).
 *
 * ±18 dB is deliberate and is NOT the pipeline's ±5 dB corrective clamp
 * relaxed. The pipeline clamps because an automated decision ships with no
 * human ear in the loop; here a human is auditioning continuously, which is the
 * safeguard the pipeline lacks. The two numbers look related and are justified
 * differently — see spec §1.1. Do not harmonise them.
 *
 * A general EQ that cannot pull 15 dB out of a resonant room mode is broken for
 * its own use case, and a spare-bedroom recording is exactly that use case.
 */
export const PARAM_RANGES = {
  frequencyHz: [20, 20000],
  gainDb: [-18, 18],
  q: {
    peaking: [0.3, 10],
    lowshelf: [0.3, 2],
    highshelf: [0.3, 2],
    highpass: [0.3, 10],
    lowpass: [0.3, 10],
    notch: [4, 30],
  },
}

/**
 * The role taxonomy — VoiceRx's control surface.
 *
 * Each role is a view onto one Stage 3a detection region (see voicerx/regions.js);
 * `region` is the join key. Frequency ranges are NOT stored here on purpose:
 * they come from the resolved region table, which shifts with the classified
 * voice type. A role's legal range for a female narrator is not the same as for
 * a male one, and freezing a nominal range in this table is exactly the mistake
 * the manual EQ spec's §5 table flags with its calibration warning.
 *
 * `type` is the filter shape used when a band is created for this role. At the
 * spectrum edges that is a shelf, which diverges from Stage 3a — the server
 * emits peaking bands throughout because it renders through FFmpeg's
 * `equalizer`. A shelf is the musically correct shape for rumble and air, the
 * manual tool has shelves available, and a human is listening; so the manual
 * tool uses them and the realised curve differs slightly from the server's for
 * those two roles.
 *
 * `canonicalQ` is the default for a MANUALLY added band. A suggested band
 * carries the Q measured from the anomaly's half-power width instead, which is
 * what makes the `qModified` marker meaningful rather than decorative.
 *
 * `description` defines the word. The whole promise of this control surface is
 * that you can reach for a characteristic without knowing what frequency it
 * lives at, which only works if the characteristic names something you can
 * hear — so every role says what its region sounds like, in terms that do not
 * lean on the role's own name to explain it. These are deliberately NOT the
 * symptom sentences from voicerx/suggestions.js: those assert a fault that was
 * measured ("this reads muddy"), and a control sitting at rest has measured
 * nothing.
 *
 * `describe` is the running commentary — what turning this role has done, in
 * words, and it must answer for both directions. Roles whose region is only
 * ever *scanned* one way are still draggable both ways (regions.js is explicit
 * that scan direction is not slider bias), so a role that ignored the sign
 * would claim "less mud" over a boost.
 */
export const ROLES = [
  {
    id: 'rumble',
    region: 'sub_bass',
    label: 'Rumble',
    type: 'lowshelf',
    canonicalQ: 0.7,
    bias: 'cut',
    description: 'Weight underneath the voice — traffic, air conditioning, knocks on the desk.',
    describe: gainDb => (gainDb >= 0 ? 'more rumble' : 'less rumble'),
  },
  {
    id: 'body',
    region: 'body_warmth',
    label: 'Body',
    type: 'peaking',
    canonicalQ: 1.2,
    bias: 'bidirectional',
    description: 'The chest behind the voice. Too little and it reads thin; too much and it booms.',
    describe: gainDb => (gainDb >= 0 ? 'more body' : 'less boom'),
  },
  {
    id: 'mud',
    region: 'mud',
    label: 'Mud',
    type: 'peaking',
    canonicalQ: 2.0,
    bias: 'cut',
    description: 'Crowding just above the fundamental. Speech thickens and stops sounding open.',
    describe: gainDb => (gainDb >= 0 ? 'more mud' : 'less mud'),
  },
  {
    id: 'boxiness',
    region: 'boxy_honky',
    label: 'Boxiness',
    type: 'peaking',
    canonicalQ: 2.5,
    bias: 'cut',
    description: 'A hollow ring, as though the voice were recorded inside a carton.',
    describe: gainDb => (gainDb >= 0 ? 'boxier' : 'less boxy'),
  },
  {
    id: 'nasality',
    region: 'nasal',
    label: 'Nasality',
    type: 'peaking',
    canonicalQ: 3.0,
    bias: 'cut',
    description: 'A pinched quality, the sound of speaking with a blocked nose.',
    describe: gainDb => (gainDb >= 0 ? 'more nasal' : 'less nasal'),
  },
  {
    // No counterpart in the manual EQ spec's §5 table. Stage 3a scans
    // lower_presence (1.2-2.5 kHz) for a dip, which is the "muffled, words are
    // hard to pick out" complaint — common enough in narration that leaving it
    // out would be a hole in the taxonomy.
    id: 'clarity',
    region: 'lower_presence',
    label: 'Clarity',
    type: 'peaking',
    canonicalQ: 1.2,
    bias: 'bidirectional',
    description: 'How cleanly one word separates from the next.',
    describe: gainDb => (gainDb >= 0 ? 'clearer diction' : 'softer diction'),
  },
  {
    // Presence and harshness are one band (spec §5.1): same region, opposite
    // sign. Two controls would let a user boost one and cut the other over the
    // same frequencies, which is incoherent and unreadable on the curve.
    id: 'presence',
    region: 'upper_presence',
    label: 'Presence',
    type: 'peaking',
    canonicalQ: 1.5,
    bias: 'bidirectional',
    description: 'How far forward the voice sits in the ear. Pushed too far it turns harsh.',
    describe: gainDb => (gainDb >= 0 ? 'more presence' : 'less harsh'),
  },
  {
    id: 'sibilance',
    region: 'brilliance',
    label: 'Sibilance',
    type: 'peaking',
    canonicalQ: 3.5,
    bias: 'cut',
    description: 'The edge on S and T sounds, the part that whistles or spits.',
    describe: gainDb => (gainDb >= 0 ? 'more sibilant' : 'less sibilant'),
  },
  {
    id: 'air',
    region: 'air',
    label: 'Air',
    type: 'highshelf',
    canonicalQ: 0.7,
    bias: 'bidirectional',
    description: 'Openness at the very top — the sense of space around the voice.',
    describe: gainDb => (gainDb >= 0 ? 'more air' : 'less fizz'),
  },
]

const ROLE_BY_ID = new Map(ROLES.map(r => [r.id, r]))
const ROLE_BY_REGION = new Map(ROLES.map(r => [r.region, r]))

export function getRole(roleId) {
  return ROLE_BY_ID.get(roleId) ?? null
}

export function roleForRegion(regionName) {
  return ROLE_BY_REGION.get(regionName) ?? null
}

/** Roles in display order, low frequency to high — follows the region order. */
export const ROLES_IN_ORDER = REGION_ORDER.map(r => ROLE_BY_REGION.get(r)).filter(Boolean)

/**
 * A role's legal frequency range under a resolved region table.
 * @returns {[number, number]|null}
 */
export function roleFreqRange(roleId, regions) {
  const role = getRole(roleId)
  if (!role || !regions) return null
  const region = regions[role.region]
  if (!region) return null
  return [region[SCAN_LOW], region[SCAN_HIGH]]
}

let bandSeq = 0

/** Short, collision-free within a session — these never leave the browser. */
function nextBandId() {
  bandSeq += 1
  return `band_${bandSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * RBJ bandwidth in octaves for a Q — how wide a peaking band actually reaches.
 *
 * The number a user can act on is the span in hertz this implies, not Q itself:
 * "reaches 240 to 420 Hz" is a fact about their recording, where "Q 2.4" is a
 * fact about a filter. Shared by the plot's solo shading and VoiceRx's width
 * read-out so the two cannot drift.
 */
export function bandwidthOctaves(q) {
  return (2 / Math.LN2) * Math.asinh(1 / (2 * Math.max(q, 0.05)))
}

/** Legal Q range for a filter type. */
export function qRangeFor(type) {
  return PARAM_RANGES.q[type] ?? PARAM_RANGES.q.peaking
}

/**
 * Create a band. Every field is populated; role fields are null unless a role
 * is supplied along with the resolved region table it was tagged from.
 *
 * @param {object} spec
 * @param {string} [spec.type='peaking']
 * @param {number} spec.frequencyHz
 * @param {number} [spec.gainDb=0]
 * @param {number} [spec.q]
 * @param {boolean} [spec.enabled=true]
 * @param {string|null} [spec.role=null]
 * @param {object|null} [spec.regions=null] resolved region table, required with `role`
 * @param {'suggestion'|'manual_voicerx'|'manual_general'} [spec.origin='manual_general']
 */
export function createBand({
  type = 'peaking',
  frequencyHz,
  gainDb = 0,
  q,
  enabled = true,
  role = null,
  regions = null,
  origin = 'manual_general',
} = {}) {
  const roleDef = role ? getRole(role) : null
  const resolvedType = roleDef ? roleDef.type : type
  const canonicalQ = roleDef ? roleDef.canonicalQ : null
  const resolvedQ = q ?? canonicalQ ?? 1.0
  const range = roleDef ? roleFreqRange(role, regions) : null

  return {
    id: nextBandId(),
    type: resolvedType,
    frequencyHz: clamp(frequencyHz, ...PARAM_RANGES.frequencyHz),
    gainDb: clamp(gainDb, ...PARAM_RANGES.gainDb),
    q: clamp(resolvedQ, ...qRangeFor(resolvedType)),
    enabled,
    role: range ? role : null,
    roleFreqRangeHz: range,
    canonicalQ: range ? canonicalQ : null,
    qModified: range ? Math.abs(resolvedQ - canonicalQ) > 1e-9 : false,
    origin,
  }
}

/**
 * Role forfeiture (spec §5.3).
 *
 * Moving a role-tagged band outside its legal range drops the tag: silent,
 * automatic, no dialog. The band's audio behaviour is unchanged — it keeps its
 * frequency, gain, Q and type, and sounds identical. All that changes is that
 * VoiceRx stops offering a control for it and starts counting it as a general
 * band, which is the honest description of what it has become.
 *
 * Mutates and returns the band, so callers can use it inline after a drag.
 */
export function applyForfeiture(band) {
  if (band.role === null || !band.roleFreqRangeHz) return band
  const [lo, hi] = band.roleFreqRangeHz
  if (band.frequencyHz >= lo && band.frequencyHz <= hi) return band

  band.role = null
  band.roleFreqRangeHz = null
  band.canonicalQ = null
  band.qModified = false
  return band
}

/**
 * The reverse direction: which role, if any, would accept this band's current
 * frequency. Used to *offer* re-tagging — never to apply it. An untagged band
 * that drifts into a role's range is not evidence the user wanted that role.
 *
 * @returns {string|null} role id
 */
export function candidateRoleFor(band, regions) {
  if (band.role !== null || !regions) return null
  for (const role of ROLES_IN_ORDER) {
    const range = roleFreqRange(role.id, regions)
    if (range && band.frequencyHz >= range[0] && band.frequencyHz <= range[1]) {
      return role.id
    }
  }
  return null
}

/** Tag an untagged band with a role, adopting the role's canonical Q and type. */
export function tagBand(band, roleId, regions) {
  const range = roleFreqRange(roleId, regions)
  const roleDef = getRole(roleId)
  if (!range || !roleDef) return band

  band.role = roleId
  band.roleFreqRangeHz = range
  band.canonicalQ = roleDef.canonicalQ
  band.type = roleDef.type
  band.q = clamp(roleDef.canonicalQ, ...qRangeFor(roleDef.type))
  band.qModified = false
  return band
}

/** Restore a role band's canonical Q, clearing the "modified" marker. */
export function resetBandQ(band) {
  if (band.canonicalQ === null) return band
  band.q = clamp(band.canonicalQ, ...qRangeFor(band.type))
  band.qModified = false
  return band
}

/**
 * Set a band's Q, tracking whether it has diverged from the role canon.
 * VoiceRx hides the Q control but preserves any value already there (spec §2.4).
 */
export function setBandQ(band, q) {
  band.q = clamp(q, ...qRangeFor(band.type))
  band.qModified = band.canonicalQ !== null && Math.abs(band.q - band.canonicalQ) > 1e-9
  return band
}

/**
 * Set a band's frequency, applying forfeiture if it leaves the role's range.
 * The single entry point for frequency changes — a drag, a numeric entry and a
 * suggestion apply must all forfeit identically.
 */
export function setBandFrequency(band, frequencyHz) {
  band.frequencyHz = clamp(frequencyHz, ...PARAM_RANGES.frequencyHz)
  return applyForfeiture(band)
}

/**
 * Move a band, keeping it inside its role. The wall, where forfeiture is the
 * trapdoor.
 *
 * The two policies suit opposite pools. In the general EQ a band that leaves
 * the mud range has stopped being Mud, and dropping the tag is the honest
 * record of that. In VoiceRx the range *is* the control: a band that slipped
 * out of it would keep filtering while vanishing from the only surface that
 * offers a knob for it, so there the boundary has to stop the drag instead.
 *
 * An untagged band has no role to be held inside and falls through to the
 * ordinary parameter clamp.
 */
export function clampBandToRole(band, frequencyHz) {
  if (band.role === null || !band.roleFreqRangeHz) {
    return setBandFrequency(band, frequencyHz)
  }
  const [lo, hi] = band.roleFreqRangeHz
  band.frequencyHz = clamp(
    clamp(frequencyHz, lo, hi),
    ...PARAM_RANGES.frequencyHz,
  )
  return band
}

/** Bands VoiceRx has no control for, but which are still in the audio path. */
export function untaggedBands(bands) {
  return bands.filter(b => b.role === null)
}

/**
 * Does this band change the sound at all?
 *
 * A bell or shelf at 0 dB is exactly unity and can be ignored; a pass filter or
 * a notch cuts by construction and counts even at 0 dB, because gain is not
 * what it is doing. Used for the band counts and for whether Apply has any work
 * to do — General mode opens with a neutral starting layout on screen, and
 * counting those four as "active" would claim an edit nobody made.
 */
export function isBandActive(band) {
  if (!band.enabled) return false
  if (band.type === 'highpass' || band.type === 'lowpass' || band.type === 'notch') return true
  return band.gainDb !== 0
}

// ── Positional shapes ───────────────────────────────────────────────────────

/**
 * Which shapes a band may take, given where it sits among the others.
 *
 * Cuts and shelves act on everything past their corner, so they only mean
 * anything at the ends of the chain — a low shelf with another band below it is
 * lifting audio that a later filter has already dealt with. Restricting by
 * position rather than reserving fixed slots keeps this true without inventing
 * a special class of band: drag a bell below the high-pass and the two simply
 * swap what they offer.
 *
 * A single band is at both ends at once, so it gets everything.
 */
const SHAPES_LOWEST = ['highpass', 'lowshelf', 'peaking', 'notch']
const SHAPES_MIDDLE = ['peaking', 'notch']
const SHAPES_HIGHEST = ['lowpass', 'highshelf', 'peaking', 'notch']

export function shapesForBand(band, bands) {
  if (bands.length <= 1) return [...FILTER_TYPES]

  const sorted = [...bands].sort((a, b) => a.frequencyHz - b.frequencyHz)
  const i = sorted.findIndex(b => b.id === band.id)

  let allowed
  if (i <= 0) allowed = SHAPES_LOWEST
  else if (i === sorted.length - 1) allowed = SHAPES_HIGHEST
  else allowed = SHAPES_MIDDLE

  // The band's current shape stays on the menu even when its position no longer
  // offers it. A shelf that has been overtaken is still the user's shelf —
  // converting it silently would change their audio to tidy up our own rule.
  const set = new Set([...allowed, band.type])
  return FILTER_TYPES.filter(t => set.has(t))
}

/**
 * The layout General mode opens with: a shelf at each end and two bells in the
 * middle, all at 0 dB and all deletable.
 *
 * Every shape here is exactly unity at 0 dB, so opening the window cannot
 * change what the user hears — a high-pass in this set would start cutting the
 * moment the panel appeared. The point is to replace an empty plot, which too
 * many people will not click on, with a layout that shows what the tool does.
 */
export const DEFAULT_GENERAL_BANDS = [
  { type: 'lowshelf', frequencyHz: 80, q: 0.7 },
  { type: 'peaking', frequencyHz: 300, q: 1.0 },
  { type: 'peaking', frequencyHz: 3000, q: 1.0 },
  { type: 'highshelf', frequencyHz: 10000, q: 0.7 },
]

/** The band carrying a given role, or null. One band per role by construction. */
export function bandForRole(bands, roleId) {
  return bands.find(b => b.role === roleId) ?? null
}
