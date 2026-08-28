/**
 * Where a voice's zone boundaries belong.
 *
 * THE STOCK BOUNDARIES ARE THE MALE REGION TABLE, APPLIED TO EVERY VOICE.
 * DEFAULT_RESONANCE_ZONES currently splits at 180 / 1100 Hz, and those numbers
 * come from the MALE_REGIONS edges: 1100 is within an eighth of an octave of
 * `lower_presence`'s bottom (1200), and 180 is the geometric centre of
 * `body_warmth` (183.3). (When a sibilance boundary is re-added it will be
 * `upper_presence`'s top — 5000 for a male voice.)
 *
 * VoiceRx already measures the thing those numbers stand in for. Its region
 * tables MOVE with the voice — mud is 200-420 Hz for a male narrator and
 * 280-550 for a female one, because a region is a fixed interval above the
 * fundamental rather than a fixed frequency — and `classifyVoice` interpolates
 * between them where the two tables meet. Left at the shipped values, a female
 * narrator's fundamental at ~220 Hz falls in z2 rather than z1: the zone whose
 * whole purpose is the fundamental region does not contain her fundamental.
 *
 * ⚠ TWO MECHANISMS, NOT ONE, and an earlier version of this note claimed
 * otherwise. The boundaries divide into:
 *
 *  - DERIVED from the measured pitch — the sub-fundamental corner
 *    (`rumbleCornerHz`) and Z2's top (`fundamentalTopHz`). Neither is a scaled
 *    stock value, and the shipped 180 is not used for anything at all.
 *  - SCALED from the shipped value by its own anchor's ratio against the
 *    calibration voice — presence, and sibilance if the set is re-split. These
 *    are the ones that have been listened to, and a male voice reproduces them
 *    EXACTLY, so nothing already calibrated moves.
 *
 * The scaled half invents nothing: every number comes out of the region tables.
 * The derived half carries two constants of its own, `HARMONIC_REACH` and
 * `MIN_F0_MARGIN`, both argued at their definitions.
 *
 * ⚠ THE CORPUS CANNOT VALIDATE THIS. Every real narrator clip this codebase has
 * measured against is male or near it, so the placement is a near-no-op on all
 * of them. That is the desired property and also the limitation: demonstrating
 * that it does anything at all needs a female narrator recording, and there
 * isn't one in `data/corpus/`.
 *
 * Pure — no audio, no Web Audio, no DOM. The measurement it consumes lives in
 * voiceProfile.js; this module only decides where the lines go.
 */

import { classifyVoice, SCAN_HIGH, SCAN_LOW } from './voicerx/regions.js'
import {
  DEFAULT_RESONANCE_ZONES,
  RESONANCE_ZONE_MIN_OCTAVES,
  RESONANCE_ZONE_STOCK,
  zoneBounds,
} from './resonanceParams.js'

/** The processed band, matching ANALYSIS_FLOOR_HZ and Nyquist in the kernel. */
export const PLACEMENT_FLOOR_HZ = 20
export const PLACEMENT_CEIL_HZ = 20000

/**
 * The anchors for the scaled boundaries, and why each one is the edge it is.
 *
 * ⚠ THERE IS NO `fundamental` ANCHOR ANY MORE. It was `body_warmth`'s geometric
 * centre — 183.3 Hz for a male voice, which is where the shipped 180 came from
 * — and it was replaced by `fundamentalTopHz` because a region-table anchor
 * does not know where the fundamental is. See the measurements there.
 *
 * `presence` — `lower_presence`'s bottom edge, i.e. exactly where the voice
 * stops being body and starts being articulation. Male 1200, female 1500.
 *
 * `sibilance` — `upper_presence`'s top edge, where `brilliance` takes over and
 * sibilance starts to dominate. Male 5000, female 6000 — and the stock 5000 is
 * this edge unchanged, which is the clearest single piece of evidence that the
 * stock set is the male table.
 */
const ANCHORS = {
  presence: r => r.lower_presence[SCAN_LOW],
  sibilance: r => r.upper_presence[SCAN_HIGH],
}

/**
 * The anchors for the UPPER boundaries, in frequency order.
 *
 * The fundamental boundary is not in this list any more — it is derived from
 * the measured F0 rather than scaled from a stock value; see
 * `fundamentalTopHz`. Everything above it is still a ratio against the
 * calibration voice, so the boundaries that have been listened to do not move.
 *
 * ⚠ THE SHIPPED ZONE SET IS NOT A FIXED LENGTH, and assuming it was cost this
 * module a silent failure. It was three boundaries (180 / 1100 / 5000) when
 * this was written; the panel has since folded the upper-mid and air zones
 * together and ships two (180 / 1100), and a hard `length !== 3` guard turned
 * that into `placeResonanceZones` returning null — FIT enabled, pressed, and
 * doing nothing, with no error anywhere. The list is read as "one anchor per
 * upper boundary", so re-splitting at 5 kHz brings `sibilance` back with no
 * edit here.
 */
const ANCHOR_ORDER = ['presence', 'sibilance']

/**
 * How far above the fundamental Z2 reaches, and why it is a multiple of F0.
 *
 * ⚠ THE OLD RULE DID NOT CONTAIN WHAT THE ZONE IS NAMED AFTER. Z2's top was
 * `body_warmth`'s geometric centre, which is a region-table anchor and has no
 * relationship to a harmonic series: measured across F0 90-240 it contained the
 * fundamental every time and the SECOND HARMONIC exactly never (2F0 landed
 * above the boundary at every F0 above 90), and the headroom above F0 collapsed
 * as the voice rose — 0.71 octaves at F0 110, 0.17 at 170, 0.04 at 240. A zone
 * whose whole purpose is the fundamental region was sized by something that
 * does not know where the fundamental is.
 *
 * 2.5 rather than 2.0 so the 2nd harmonic sits INSIDE the zone with margin
 * rather than on its edge, where the 1/6-octave crossfade would split it
 * between two settings.
 */
const HARMONIC_REACH = 2.5

/**
 * The fundamental must be inside its own zone, whatever else happens.
 *
 * This is the guarantee that outranks the mud cap. `classifyVoice` saturates —
 * every voice above F0 200 gets the female table — so a cap read off that table
 * is a CONSTANT above 200 Hz while F0 keeps rising, and at F0 340 the cap alone
 * would put Z2's top at 280 Hz, below the speaker's own fundamental. 1.2 leaves
 * about a fifth of an octave of margin above F0, which is enough that ordinary
 * pitch movement around the median does not fall out of the zone on every
 * emphatic syllable.
 *
 * ⚠ Where this binds, Z2 DOES cross into mud. That is the intended precedence:
 * a zone that excludes the fundamental is broken, a zone that overlaps mud is
 * merely wide.
 */
const MIN_F0_MARGIN = 1.2

/**
 * Where Z2 stops: reach for the 2nd harmonic, stop at mud, never below F0.
 *
 * ⚠ THE CAP BINDS ON ALMOST EVERY REAL VOICE, and saying so is the honest
 * description of this rule. `2.5 x F0` only comes in under mud's bottom edge
 * below about F0 80 (male table) or F0 112 (female), so for a typical narrator
 * Z2 ends exactly where mud begins — 200 Hz for a male voice, 280 for a female
 * one. That is a defensible definition of the fundamental region in its own
 * right, and it is what keeps Z3 meaning "mud, boxy, nasal" rather than
 * swallowing the bottom of it.
 *
 * ⚠ SO 2F0 IS NOT GUARANTEED. At F0 110 the 2nd harmonic is 220 Hz and the cap
 * puts the boundary at 200, so it falls into Z3. Reaching it would mean Z2
 * running to 275 Hz and taking the bottom of mud with it. The reach is
 * best-effort; the F0 containment below is the guarantee.
 */
function fundamentalTopHz(medianF0Hz, regions) {
  const mudStartsHz = regions.mud[SCAN_LOW]
  return Math.max(
    Math.min(HARMONIC_REACH * medianF0Hz, mudStartsHz),
    MIN_F0_MARGIN * medianF0Hz,
  )
}

/** The reference voice the stock numbers were calibrated on. */
const CALIBRATION_F0_HZ = 110

/**
 * Boundaries for a voice, low to high: [subF0, ...calibrated].
 *
 * The first two are DERIVED from the measured pitch and owe nothing to the
 * stock set: the rumble corner, because "below this there cannot be voice" is a
 * statement about this speaker; and Z2's top, because the zone has to contain
 * the fundamental it is named after. The rest are the stock boundaries
 * (currently just `presence`, 1100 Hz for a male voice) scaled by their
 * anchors' ratios against the calibration voice.
 *
 * ⚠ `stock[0]` is therefore READ BUT NOT USED — it is the shipped fundamental
 * boundary, and it only contributes its position in the list. Only stock[1..]
 * is scaled.
 *
 * @param {number} medianF0Hz  median of the tracker's voiced-frame estimates
 * @param {number} cornerHz    rumbleCornerHz() for the same F0 population
 * @param {number[]} stock     the calibrated boundaries, male-derived
 */
export function voiceZoneBoundaries(medianF0Hz, cornerHz, stock) {
  // n counts the shipped boundaries: one fundamental boundary plus one per
  // anchor, so the set may be one longer than ANCHOR_ORDER.
  const n = stock?.length ?? 0
  if (!(medianF0Hz > 0) || !(cornerHz > 0) || n < 1 || n > ANCHOR_ORDER.length + 1) return null

  const { regions, voiceType } = classifyVoice(medianF0Hz)
  const { regions: reference } = classifyVoice(CALIBRATION_F0_HZ)

  // The first shipped boundary is the fundamental one, and it is DERIVED from
  // the measured pitch rather than scaled from its stock value — the stock 180
  // is not used at all. Everything above it is a ratio against the calibration
  // voice, so those boundaries reproduce the shipped set exactly on a male
  // narrator.
  const scaled = ANCHOR_ORDER.slice(0, n - 1).map((name, i) => {
    const anchor = ANCHORS[name]
    const ref = anchor(reference)
    return ref > 0 ? (stock[i + 1] * anchor(regions)) / ref : stock[i + 1]
  })

  return {
    voiceType,
    boundaries: orderBoundaries([
      cornerHz, fundamentalTopHz(medianF0Hz, regions), ...scaled,
    ]),
  }
}

/**
 * Hold the boundaries apart and inside the band.
 *
 * The scaling cannot reorder them — every anchor scales by a ratio near 1 and
 * they start more than an octave apart — but the corner is measured
 * independently, so nothing structural guarantees it stays clear of a
 * fundamental boundary on a voice the tracker reads oddly. A zone editor whose
 * boundaries can cross produces a zone of negative width, which the strip will
 * draw and the user cannot undo by dragging.
 *
 * ⚠ EACH BOUNDARY IS CLAMPED AGAINST BOTH ENDS BEFORE THE MONOTONE PASS, and a
 * single running floor was not enough: with an absurd input every boundary
 * clamps to the top and then the running floor pushes the next one PAST it, so
 * the guard produced exactly the crossing it exists to prevent. The room is
 * never in doubt — four boundaries at a quarter-octave minimum need 1.25
 * octaves and the band is about ten — so the two-sided bound is always
 * satisfiable.
 */
function orderBoundaries(raw) {
  const gap = Math.pow(2, RESONANCE_ZONE_MIN_OCTAVES)
  const n = raw.length
  const out = []
  let floor = PLACEMENT_FLOOR_HZ * gap
  for (let i = 0; i < n; i++) {
    // Leave room above for every boundary that still has to fit.
    const ceil = PLACEMENT_CEIL_HZ / Math.pow(gap, n - i)
    const v = Math.min(Math.max(raw[i], floor), Math.max(floor, ceil))
    out.push(Math.round(v))
    floor = v * gap
  }
  return out
}

/** The zone fields a placement carries over. Mirrors copyZones, minus id/hiHz. */
const SETTING_KEYS = ['depth', 'sharpness', 'selectivity', 'maxCut', 'protect', 'enabled']

function settingsOf(zone) {
  const out = {}
  for (const k of SETTING_KEYS) out[k] = zone?.[k] ?? RESONANCE_ZONE_STOCK[k]
  return out
}

/**
 * Rewrite a zone set's geometry from a measured voice.
 *
 * ONE MORE ZONE THAN THE SHIPPED BOUNDARIES, BECAUSE THE SUB-FUNDAMENTAL
 * REGION IS PARTITIONED OFF. Below the corner there is no voice content, but
 * there is very often sub-vocal energy — HVAC, traffic, handling, plosive
 * thump — and while it shares a zone with the fundamental it is not separately
 * controllable. It is not only that the settings are shared: the detector's
 * spread kernel reaches ±96 bins, and reduction is spread BEFORE the per-zone
 * depth and ceiling are applied, so a deep cut taken on a 45 Hz rumble smears
 * up into the fundamental unless a boundary confines it. Partitioning is what
 * makes "leave the voice alone and deal with the rumble" expressible at all.
 *
 * EQ is usually the better answer down there and this does not pretend
 * otherwise — a fixed high-pass removes rumble without a detector having an
 * opinion about it. But not every file arrives high-passed, and this is a
 * front-end tool that is often a user's first step.
 *
 * SETTINGS ARE CARRIED OVER, NOT RESET, and the new zone inherits from whatever
 * zone used to cover it — the geometric centre of each new span picks its
 * source. That is `splitZone`'s rule ("this span needs to be two spans", not
 * "throw away what I set here") generalised to a whole re-partition, and it
 * makes the placement GEOMETRY-ONLY: on an untouched panel every zone carries
 * identical settings, so the re-partition changes no sound at all. What it buys
 * is the ability to make it change sound, which is the honest claim.
 *
 * @returns {null | { zones: object[], boundaries: number[], voiceType: string }}
 *   null when there is nothing to place from — the caller must leave the zones
 *   alone rather than substituting a fallback set.
 */
export function placeResonanceZones(zones, profile) {
  const stock = calibratedBoundaries()
  const placed = voiceZoneBoundaries(profile?.medianF0Hz, profile?.cornerHz, stock)
  if (!placed) return null

  const { boundaries, voiceType } = placed
  const source = Array.isArray(zones) && zones.length > 0 ? zones : null
  const bounds = source ? zoneBounds(source, PLACEMENT_FLOOR_HZ, PLACEMENT_CEIL_HZ) : []
  const edges = [PLACEMENT_FLOOR_HZ, ...boundaries, PLACEMENT_CEIL_HZ]

  const out = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const last = i + 2 === edges.length
    // Geometric, because the axis is logarithmic: the arithmetic midpoint of
    // 180 Hz and 1100 Hz sits well past centre as drawn on a log scale.
    const centre = Math.sqrt(edges[i] * edges[i + 1])
    const from = source
      ? source[Math.max(0, bounds.findIndex(b => centre <= b.hiHz))] ?? source[source.length - 1]
      : null
    out.push({ id: `z${i + 1}`, hiHz: last ? PLACEMENT_CEIL_HZ : edges[i + 1], ...settingsOf(from) })
  }
  return { zones: out, boundaries, voiceType }
}

/**
 * The calibrated boundaries, read off the shipping zone set rather than repeated.
 *
 * If DEFAULT_RESONANCE_ZONES is ever re-listened to and moved, the scaling moves
 * with it. A literal here would anchor the placement to numbers the app no
 * longer ships — the two-copies-of-one-calibration drift this codebase keeps
 * recording.
 *
 * The last zone's `hiHz` is the top of the band, not a boundary, so it is
 * dropped; what remains is the calibrated boundaries in frequency order
 * (currently [fundamental, presence], i.e. two values).
 */
function calibratedBoundaries() {
  return DEFAULT_RESONANCE_ZONES.slice(0, -1).map(z => z.hiHz)
}

/**
 * How many zones a placement produces: the shipped boundaries, plus the
 * sub-fundamental split, plus one because n boundaries make n+1 zones.
 *
 * Derived rather than written down for the same reason the boundaries are —
 * the shipped set has already changed length once underneath this file.
 * Pinned against RESONANCE_ZONE_MAX in the tests.
 */
export function placedZoneCount() {
  return calibratedBoundaries().length + 2
}
