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
  RESONANCE_ZONE_RANGES,
  RESONANCE_ZONE_STOCK,
  zoneBounds,
  zoneSettings,
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

/** Set one of a zone's three settings, clamped to that parameter's range. */
export function setZoneParam(zones, index, name, value) {
  const range = RESONANCE_ZONE_RANGES[name]
  if (index < 0 || index >= zones.length || !range) return zones
  return patchZone(zones, index, { [name]: clamp(value, range.min, range.max) })
}

/**
 * Add or remove zones until there are `count` of them.
 *
 * Growing splits the WIDEST zone in octaves, shrinking removes the boundary
 * with the narrowest zone under it — so repeatedly stepping the count up and
 * down tends back toward evenly spread boundaries rather than piling splits
 * into one corner of the spectrum. Returns the list unchanged, by identity,
 * when it is already the right length or there is no room.
 */
export function setZoneCount(zones, count, axis, floorHz, ceilHz, idFor) {
  let next = zones
  const target = clamp(count, RESONANCE_ZONE_MIN, RESONANCE_ZONE_MAX)
  let guard = RESONANCE_ZONE_MAX * 2
  while (next.length < target && guard-- > 0) {
    const b = zoneBounds(next, floorHz, ceilHz)
    let widest = 0
    for (let i = 1; i < b.length; i++) {
      if (b[i].hiHz / b[i].loHz > b[widest].hiHz / b[widest].loHz) widest = i
    }
    const mid = Math.sqrt(b[widest].loHz * b[widest].hiHz)
    const grown = splitZone(next, mid, axis, idFor(next.length), floorHz, ceilHz)
    if (grown === next) break
    next = grown
  }
  guard = RESONANCE_ZONE_MAX * 2
  while (next.length > target && guard-- > 0) {
    const b = zoneBounds(next, floorHz, ceilHz)
    let narrowest = 0
    for (let i = 1; i < b.length; i++) {
      if (b[i].hiHz / b[i].loHz < b[narrowest].hiHz / b[narrowest].loHz) narrowest = i
    }
    const shrunk = removeBoundary(next, Math.min(narrowest, next.length - 2))
    if (shrunk === next) break
    next = shrunk
  }
  return next
}

export function toggleZone(zones, index) {
  if (index < 0 || index >= zones.length) return zones
  return patchZone(zones, index, { enabled: zones[index].enabled === false })
}

/** Harmonic protection for one zone. Absent means protected — see ZONE_STOCK. */
export function toggleZoneProtect(zones, index) {
  if (index < 0 || index >= zones.length) return zones
  return patchZone(zones, index, { protect: zones[index].protect === false })
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

/**
 * Deepest live cut inside each zone, for the per-zone readouts on the plot.
 *
 * The display's one number used to be a single global `PEAK <hz> · -<db>`
 * spanning the whole spectrum. That is the objection that got the
 * gain-reduction meter replaced by this plot in the first place — one number
 * cannot distinguish a surgical notch from the same depth spread across half
 * the spectrum — quietly reintroduced in the text line above it, and it had
 * outlived the detector besides: the detector is multiband and the readout was
 * not.
 *
 * DEEPEST CUT, NOT THE MEAN. A zone's mean is dominated by the bins the effect
 * is correctly leaving alone, so it reads near zero whatever is happening in
 * the band. "How deep is the deepest cut here" is the question the knobs
 * underneath are answering.
 *
 * A SILENT ZONE READS `null`, NOT 0. Zero is a measurement — a bypassed band
 * printing `-0.0` says the effect looked and found nothing, where the truth is
 * that it never looked. The caller renders the two differently.
 *
 * The reduction array is on the display's LOG grid, so the zone's Hz span is
 * converted rather than assumed, rounding outward — floor on the low edge, ceil
 * on the high — so a zone narrower than one display cell still reads the cell
 * it sits inside instead of reporting nothing.
 */
export function zonePeakReductions(zones, reduction, bins, minHz, maxHz, soloZone = -1, floorHz = 20, ceilHz = 20000) {
  const bounds = zoneBounds(zones, floorHz, ceilHz)
  const octaves = Math.log2(maxHz / minHz)
  const binAt = hz => (Math.log2(clamp(hz, minHz, maxHz) / minHz) / octaves) * (bins - 1)
  const out = new Array(zones.length)
  for (let i = 0; i < zones.length; i++) {
    const silent = soloZone >= 0 ? i !== soloZone : !zoneSettings(zones[i]).enabled
    if (silent) { out[i] = null; continue }
    const lo = Math.max(0, Math.floor(binAt(bounds[i].loHz)))
    const hi = Math.min(bins - 1, Math.ceil(binAt(bounds[i].hiHz)))
    let peak = 0
    for (let d = lo; d <= hi; d++) if (reduction[d] > peak) peak = reduction[d]
    out[i] = peak
  }
  return out
}
