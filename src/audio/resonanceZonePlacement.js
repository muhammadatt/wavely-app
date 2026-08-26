/**
 * Where a voice's zone boundaries belong.
 *
 * THE STOCK BOUNDARIES ARE THE MALE REGION TABLE, APPLIED TO EVERY VOICE.
 * DEFAULT_RESONANCE_ZONES splits at 180 / 1100 / 5000 Hz, and its comment
 * explains them as "above most narrators' fundamentals", "the bottom of the
 * presence range" and "where sibilance starts to dominate". Those are the
 * MALE_REGIONS edges written out in prose: 5000 is exactly `upper_presence`'s
 * top, 1100 is within an eighth of an octave of `lower_presence`'s bottom
 * (1200), and 180 is the geometric centre of `body_warmth` (183.3).
 *
 * VoiceRx already measures the thing those numbers stand in for. Its region
 * tables MOVE with the voice — mud is 200-420 Hz for a male narrator and
 * 280-550 for a female one, because a region is a fixed interval above the
 * fundamental rather than a fixed frequency — and `classifyVoice` interpolates
 * between them continuously. So the same three boundaries, measured rather than
 * assumed, sit 0.26-0.47 octaves higher for a female narrator. Left where they
 * are, her fundamental at ~220 Hz falls in z2 rather than z1: the zone whose
 * whole purpose is the fundamental region does not contain her fundamental.
 *
 * WHAT IS DERIVED IS A RATIO, NOT A FREQUENCY, and that is the point. The stock
 * numbers are the ones that have been listened to; they are simply the ones
 * that were listened to on male narration. Each boundary is scaled by its own
 * anchor's ratio against the male table, so a male voice reproduces the stock
 * set EXACTLY and nothing already calibrated moves. Nothing new is invented —
 * every number here comes out of the region tables.
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
 * The three anchors, and why each one is the edge it is.
 *
 * `fundamental` — the geometric CENTRE of `body_warmth` rather than one of its
 * edges. body_warmth is the chest/fundamental region, and the boundary wants to
 * sit inside it: above the fundamental itself, below the mud that begins where
 * body ends. Its centre is 183.3 Hz for a male voice, which is where the stock
 * 180 came from.
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
  fundamental: r => Math.sqrt(r.body_warmth[SCAN_LOW] * r.body_warmth[SCAN_HIGH]),
  presence: r => r.lower_presence[SCAN_LOW],
  sibilance: r => r.upper_presence[SCAN_HIGH],
}

/**
 * The anchors in frequency order, one per calibrated boundary.
 *
 * ⚠ THE SHIPPED ZONE SET IS NOT A FIXED LENGTH, and assuming it was cost this
 * module a silent failure. It was three boundaries (180 / 1100 / 5000) when
 * this was written; the panel has since folded the upper-mid and air zones
 * together and ships two (180 / 1100), and a hard `length !== 3` guard turned
 * that into `placeResonanceZones` returning null — FIT enabled, pressed, and
 * doing nothing, with no error anywhere.
 *
 * So the list is read as "the anchors for however many boundaries there are",
 * low to high, and `calibratedBoundaries` reads the set itself. Re-splitting at
 * 5 kHz brings `sibilance` back with no edit here. The assumption that remains
 * — that the shipped boundaries are these anchors in this order — is what the
 * placement means, and it is pinned per-boundary in the tests rather than
 * left to the count.
 */
const ANCHOR_ORDER = ['fundamental', 'presence', 'sibilance']

/** The reference voice the stock numbers were calibrated on. */
const CALIBRATION_F0_HZ = 110

/**
 * Boundaries for a voice, low to high: [subF0, fundamental, presence, sibilance].
 *
 * The first is the rumble corner — measured, not scaled, because "below this
 * there cannot be voice" is a statement about this speaker rather than about a
 * region table. The other three are the stock boundaries scaled by their
 * anchors' ratios against the calibration voice.
 *
 * @param {number} medianF0Hz  median of the tracker's voiced-frame estimates
 * @param {number} cornerHz    rumbleCornerHz() for the same F0 population
 * @param {number[]} stock     the calibrated boundaries, male-derived
 */
export function voiceZoneBoundaries(medianF0Hz, cornerHz, stock) {
  const n = stock?.length ?? 0
  if (!(medianF0Hz > 0) || !(cornerHz > 0) || n < 1 || n > ANCHOR_ORDER.length) return null

  const { regions, voiceType } = classifyVoice(medianF0Hz)
  const { regions: reference } = classifyVoice(CALIBRATION_F0_HZ)

  const scaled = ANCHOR_ORDER.slice(0, n).map((name, i) => {
    const anchor = ANCHORS[name]
    const ref = anchor(reference)
    return ref > 0 ? (stock[i] * anchor(regions)) / ref : stock[i]
  })

  return { voiceType, boundaries: orderBoundaries([cornerHz, ...scaled]) }
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
 * FIVE ZONES, BECAUSE THE SUB-FUNDAMENTAL REGION IS PARTITIONED OFF. Below the
 * corner there is no voice content, but there is very often sub-vocal energy —
 * HVAC, traffic, handling, plosive thump — and while it shares a zone with the
 * fundamental it is not separately controllable. It is not only that the
 * settings are shared: the detector's spread kernel reaches ±96 bins, and
 * reduction is spread BEFORE the per-zone depth and ceiling are applied, so a
 * deep cut taken on a 45 Hz rumble smears up into the fundamental unless a
 * boundary confines it. Partitioning is what makes "leave the voice alone and
 * deal with the rumble" expressible at all.
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
    // 180 Hz and 5 kHz sits three quarters of the way along the span as drawn.
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
 * dropped; what remains is [fundamental, presence, sibilance].
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
