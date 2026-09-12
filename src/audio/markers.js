import { v4 as uuidv4 } from 'uuid'

/**
 * Markers — the named cut points on a timeline.
 *
 * ── THERE IS NO REGION OBJECT, AND THAT IS THE WHOLE DESIGN ─────────────────
 * A "region" (or slice, or item) is not stored. It is the span between two
 * adjacent markers, plus the head (0 → first marker) and the tail (last marker
 * → end of timeline). `markerSpans` is the only place that knowledge lives, and
 * everything downstream — the panel's list, split-at-markers, the gap veil on
 * the canvas, label export — reads slices from it.
 *
 * Storing regions as well would mean two representations of one fact, and the
 * question "what happens when a region's edge and a marker disagree" has no
 * good answer. Naming a slice means naming the marker that opens it.
 *
 * ── A MARKER IS A TIMELINE POSITION, NOT AN ANCHOR INTO THE AUDIO ───────────
 * Which means every edit that changes the timeline's length moves markers, and
 * the `markersAfter*` transforms below exist one-for-one against the mutations
 * in `operations.js`. The alternative — anchoring to (sourceBufferId,
 * sourceTime) — survives rearrangement, but a marker whose source audio is
 * pasted twice then exists twice, and one whose audio is cut exists nowhere;
 * neither has a sane answer in a panel that lists markers in time order.
 *
 * Everything here is pure and returns new arrays. No Vue, no state.
 */

/**
 * Two markers closer together than this are the same marker.
 *
 * 1 ms is below the resolution of any gesture — at the maximum zoom the
 * waveform offers it is still well under a pixel — but comfortably above the
 * float error that accumulates when a marker is shifted by a few successive
 * edits. Without a floor here, dragging one marker onto another leaves two
 * markers a nanosecond apart, which renders as one flag, splits the timeline
 * into a zero-length segment, and exports as an empty slice.
 */
export const MARKER_EPSILON = 0.001

/** @typedef {{ id: string, time: number, name: string, kind: 'user'|'gap' }} Marker */

/**
 * A marker's kind decides what the span it *opens* means.
 *
 *   'user'  ordinary content — the default
 *   'gap'   dead air: the span from this marker to the next is droppable
 *
 * Kind lives on the opening marker rather than on the span because the span
 * isn't a thing that can hold a field. See the module note above.
 */
export const MARKER_KINDS = ['user', 'gap']

/** @returns {Marker} */
export function createMarker(time, { name = '', kind = 'user' } = {}) {
  return { id: uuidv4(), time, name, kind }
}

/**
 * Sort by time and collapse near-duplicates.
 *
 * `preferId` survives its group, so dragging a marker onto a neighbour removes
 * the neighbour rather than the marker under the pointer — a drag that deleted
 * the thing being dragged would read as the app losing it.
 */
export function normalizeMarkers(markers, preferId = null) {
  const sorted = [...markers].sort((a, b) => a.time - b.time)
  const out = []
  for (const m of sorted) {
    const prev = out[out.length - 1]
    if (prev && Math.abs(m.time - prev.time) < MARKER_EPSILON) {
      if (m.id === preferId) out[out.length - 1] = m
      continue
    }
    out.push(m)
  }
  return out
}

export function addMarker(markers, marker) {
  return normalizeMarkers([...markers, marker])
}

export function removeMarker(markers, id) {
  return markers.filter(m => m.id !== id)
}

export function moveMarker(markers, id, time) {
  const next = markers.map(m => (m.id === id ? { ...m, time: Math.max(0, time) } : m))
  return normalizeMarkers(next, id)
}

export function renameMarker(markers, id, name) {
  return markers.map(m => (m.id === id ? { ...m, name } : m))
}

export function setMarkerKind(markers, id, kind) {
  if (!MARKER_KINDS.includes(kind)) return markers
  return markers.map(m => (m.id === id ? { ...m, kind } : m))
}

/**
 * The slices a marker set defines over a timeline of `totalDuration`.
 *
 * Boundaries are 0, every marker time inside the timeline, and totalDuration.
 * A span takes its name and kind from the marker that opens it; the head span
 * has no opening marker and so is always unnamed 'user'.
 *
 * Zero-length spans are dropped — a marker sitting on 0 or on the end of the
 * timeline is legal (it can be dragged off again) but defines nothing.
 *
 * @returns {{ start: number, end: number, name: string, kind: string, index: number }[]}
 */
export function markerSpans(markers, totalDuration) {
  if (!(totalDuration > 0)) return []

  const inside = normalizeMarkers(markers).filter(
    m => m.time > MARKER_EPSILON && m.time < totalDuration - MARKER_EPSILON
  )

  const spans = []
  let start = 0
  let opener = null

  for (const m of [...inside, null]) {
    const end = m ? m.time : totalDuration
    if (end - start > MARKER_EPSILON) {
      spans.push({
        start,
        end,
        name: opener?.name ?? '',
        kind: opener?.kind ?? 'user',
        index: spans.length,
      })
    }
    start = end
    opener = m
  }

  return spans
}

// ── Edit-following ───────────────────────────────────────────────────────────
// One transform per length-changing mutation in operations.js. The mutations
// that preserve length need nothing, and there are more of them than you would
// guess: silenceRegion swaps in a SilenceSegment of exactly equal duration,
// every split only inserts a boundary, and replaceRegionWithBuffer pins the new
// segment to `sourceEnd = end - start` regardless of how long the buffer handed
// to it actually is. So there is no transform for an effect render.

/**
 * `deleteRegion(segments, start, end)`.
 *
 * Markers strictly inside the cut marked audio that no longer exists, so they
 * go. A marker sitting exactly on `end` lands on `start` by the arithmetic
 * below and is then merged with anything already there — which is what you
 * want: the two edges of a removed span become one boundary.
 */
export function markersAfterDelete(markers, start, end) {
  if (!(end > start)) return markers
  const removed = end - start
  const out = []
  for (const m of markers) {
    if (m.time <= start) out.push(m)
    else if (m.time >= end) out.push({ ...m, time: m.time - removed })
    // strictly inside — dropped
  }
  return normalizeMarkers(out)
}

/** `trimToSelection(segments, start, end)` — keep what's inside, rebase to 0. */
export function markersAfterTrimTo(markers, start, end) {
  if (!(end > start)) return markers
  return normalizeMarkers(
    markers
      .filter(m => m.time >= start && m.time <= end)
      .map(m => ({ ...m, time: m.time - start }))
  )
}

/**
 * `insertSegments(segments, position, …)`.
 *
 * Markers at or after the insertion point move by the inserted duration. A
 * marker exactly on `position` moves with the audio that followed it rather
 * than staying to open the newly inserted material — pasting room tone in
 * front of "Chapter 2" should leave the marker on Chapter 2.
 */
export function markersAfterInsert(markers, position, duration) {
  if (!(duration > 0)) return markers
  return normalizeMarkers(
    markers.map(m => (m.time >= position ? { ...m, time: m.time + duration } : m))
  )
}

/** Drop markers that have fallen off either end of the timeline. */
export function clampMarkers(markers, totalDuration) {
  return markers.filter(m => m.time >= 0 && m.time <= totalDuration + MARKER_EPSILON)
}
