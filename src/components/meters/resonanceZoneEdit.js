/**
 * Geometry and edits for the sensitivity zones on the resonance plot.
 *
 * Split out of the component because every one of these is a pure function of
 * (zones, axis, gesture) and none of them needs a canvas. The plot keeps the
 * drawing; this keeps the arithmetic that decides what a drag meant, which is
 * the half that can be wrong in a way nobody notices — a zone editor whose
 * frequency mapping is off by an octave still looks like a working zone editor.
 */

import {
  RESONANCE_ZONE_MAX,
  RESONANCE_ZONE_MIN,
  RESONANCE_ZONE_MIN_OCTAVES,
  RESONANCE_ZONE_SENS_MAX_DB,
  zoneBounds,
} from '../../audio/resonanceParams.js'

/** How close the pointer must be to a boundary to grab it, in pixels. */
export const BOUNDARY_HIT_PX = 7

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** Frequency under a pixel column, on the plot's log axis. */
export function hzFromX(x, axis) {
  const t = clamp(x / Math.max(1, axis.w), 0, 1)
  return axis.minHz * Math.pow(2, t * Math.log2(axis.maxHz / axis.minHz))
}

/** Pixel column of a frequency, clamped to the plot. */
export function xFromHz(hz, axis) {
  const span = Math.log2(axis.maxHz / axis.minHz)
  return (Math.log2(clamp(hz, axis.minHz, axis.maxHz) / axis.minHz) / span) * axis.w
}

/**
 * Index of the boundary near a pixel column, or -1.
 *
 * Boundaries are the splits BETWEEN zones, so there are zones.length - 1 of
 * them and boundary i is `zones[i].hiHz`. The band limits at either end are not
 * boundaries — they are their own control, and letting a drag here move them
 * would give the same parameter two editors that disagree.
 */
export function boundaryAt(zones, x, axis, radiusPx = BOUNDARY_HIT_PX) {
  let best = -1
  let bestDx = radiusPx
  for (let i = 0; i < zones.length - 1; i++) {
    const dx = Math.abs(xFromHz(zones[i].hiHz, axis) - x)
    if (dx <= bestDx) {
      bestDx = dx
      best = i
    }
  }
  return best
}

/** Index of the zone containing a pixel column. */
export function zoneIndexAt(zones, x, axis, floorHz, ceilHz) {
  const hz = hzFromX(x, axis)
  const bounds = zoneBounds(zones, floorHz, ceilHz)
  for (let i = 0; i < bounds.length; i++) if (hz <= bounds[i].hiHz) return i
  return bounds.length - 1
}

/** A new array with one zone patched. Never mutates. */
export function patchZone(zones, index, patch) {
  return zones.map((z, i) => (i === index ? { ...z, ...patch } : z))
}

/**
 * Move a boundary, held off its neighbours by RESONANCE_ZONE_MIN_OCTAVES.
 *
 * The stop is against the ADJACENT BOUNDARIES rather than against the band
 * limits, so dragging one boundary never reorders the zones or collapses one to
 * nothing. A zone that could reach zero width would be a setting with no
 * frequency range, which is a state the strip can display and the user cannot
 * undo by dragging — the boundary that closed it is now on top of another one.
 */
export function moveBoundary(zones, index, freqHz, floorHz, ceilHz) {
  if (index < 0 || index >= zones.length - 1) return zones
  const gap = Math.pow(2, RESONANCE_ZONE_MIN_OCTAVES)
  const lo = index > 0 ? zones[index - 1].hiHz * gap : floorHz * gap
  const hi = index < zones.length - 2 ? zones[index + 1].hiHz / gap : ceilHz / gap
  if (hi < lo) return zones
  return patchZone(zones, index, { hiHz: Math.round(clamp(freqHz, lo, hi)) })
}

export function setSensitivity(zones, index, db) {
  if (index < 0 || index >= zones.length) return zones
  return patchZone(zones, index, {
    sensitivityDb: clamp(db, -RESONANCE_ZONE_SENS_MAX_DB, RESONANCE_ZONE_SENS_MAX_DB),
  })
}

export function setDepth(zones, index, depth) {
  if (index < 0 || index >= zones.length) return zones
  return patchZone(zones, index, { depth: clamp(depth, 0, 1) })
}

export function toggleZone(zones, index) {
  if (index < 0 || index >= zones.length) return zones
  return patchZone(zones, index, { enabled: zones[index].enabled === false })
}

/**
 * Split the zone under a frequency in two, inheriting its settings.
 *
 * INHERITING RATHER THAN RESETTING. A split is "this span needs to be two
 * spans", not "throw away what I set here" — resetting the new pair to neutral
 * would silently undo work every time someone subdivided a zone they had
 * already tuned. Returns the list unchanged when there is no room, by identity,
 * so the caller can tell nothing happened.
 */
export function splitZone(zones, freqHz, axis, id, floorHz, ceilHz) {
  if (zones.length >= RESONANCE_ZONE_MAX) return zones
  const bounds = zoneBounds(zones, floorHz, ceilHz)
  const gap = Math.pow(2, RESONANCE_ZONE_MIN_OCTAVES)
  let index = bounds.length - 1
  for (let i = 0; i < bounds.length; i++) {
    if (freqHz <= bounds[i].hiHz) { index = i; break }
  }
  const { loHz, hiHz } = bounds[index]
  const at = clamp(freqHz, loHz * gap, hiHz / gap)
  if (!(at > loHz && at < hiHz)) return zones
  const source = zones[index]
  const next = zones.slice()
  next.splice(index, 0, { ...source, id, hiHz: Math.round(at) })
  return next
}

/**
 * Remove a boundary, merging the zone below it into the zone above.
 *
 * The upper zone's settings survive, because the boundary being removed is the
 * lower zone's `hiHz` — dropping that entry is the whole edit, and the entry
 * that remains already spans the merged range.
 */
export function removeBoundary(zones, index) {
  if (zones.length <= RESONANCE_ZONE_MIN || index < 0 || index >= zones.length - 1) return zones
  return zones.filter((_, i) => i !== index)
}
