/**
 * Geometry and edits for the sensitivity nodes on the resonance plot.
 *
 * Split out of the component because every one of these is a pure function of
 * (nodes, axis, gesture) and none of them needs a canvas. The plot keeps the
 * drawing; this keeps the arithmetic that decides what a drag meant, which is
 * the half that can be wrong in a way nobody notices — a node editor whose
 * frequency mapping is off by an octave still looks like a working node editor.
 */

import {
  RESONANCE_WEIGHT_DEFAULT_OCTAVES,
  RESONANCE_WEIGHT_MAX_DB,
  RESONANCE_WEIGHT_MAX_NODES,
  RESONANCE_WEIGHT_MAX_OCTAVES,
  RESONANCE_WEIGHT_MIN_OCTAVES,
} from '../../audio/resonanceParams.js'

/** dB of threshold offset per pixel of vertical drag. */
export const NODE_DRAG_DB_PER_PX = 0.15
/** Log rate for a width drag. 100 px is about a factor of 1.8. */
export const NODE_DRAG_WIDTH_RATE = 0.006
/** Grab radius, in pixels of horizontal distance. */
export const NODE_HIT_PX = 11
/** Gain a freshly placed node starts at. */
export const NODE_NEW_GAIN_DB = 6

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
 * Nearest node within the grab radius, BY FREQUENCY ALONE.
 *
 * Deliberately not a radial hit test. A node's handle rides the threshold
 * curve, which moves with the audio, so it bobs vertically several pixels a
 * frame — asking someone to land on a moving target vertically would make the
 * editor feel broken on loud material and fine on silence. A node's identity is
 * its frequency, and nodes are separated in frequency, so the column is enough.
 */
export function nodeAt(nodes, x, axis, radiusPx = NODE_HIT_PX) {
  let best = null
  let bestDx = radiusPx
  for (const node of nodes) {
    const dx = Math.abs(xFromHz(node.freqHz, axis) - x)
    if (dx <= bestDx) {
      bestDx = dx
      best = node
    }
  }
  return best
}

export function nodeOctaves(node) {
  return clamp(
    node?.octaves ?? RESONANCE_WEIGHT_DEFAULT_OCTAVES,
    RESONANCE_WEIGHT_MIN_OCTAVES,
    RESONANCE_WEIGHT_MAX_OCTAVES,
  )
}

/** A new array with one node patched. Never mutates — see resWeightNodes. */
export function patchNode(nodes, id, patch) {
  return nodes.map(n => (n.id === id ? { ...n, ...patch } : n))
}

export function removeNode(nodes, id) {
  return nodes.filter(n => n.id !== id)
}

/**
 * Place a node, or return the list unchanged when the ceiling is reached.
 *
 * Unchanged rather than throwing or silently trimming: the caller compares
 * identity to decide whether anything happened, and a full list is a normal
 * state rather than an error.
 */
export function addNode(nodes, freqHz, axis, id) {
  if (nodes.length >= RESONANCE_WEIGHT_MAX_NODES) return nodes
  return [...nodes, {
    id,
    freqHz: Math.round(clamp(freqHz, axis.minHz, axis.maxHz)),
    gainDb: NODE_NEW_GAIN_DB,
    octaves: RESONANCE_WEIGHT_DEFAULT_OCTAVES,
    enabled: true,
  }]
}

/** Keyboard-sized step: octaves along the axis, dB of offset, width factor. */
export function nudgeNode(nodes, id, { octaves = 0, db = 0, widthFactor = 1 }, axis) {
  const node = nodes.find(n => n.id === id)
  if (!node) return nodes
  return patchNode(nodes, id, {
    freqHz: Math.round(clamp(node.freqHz * Math.pow(2, octaves), axis.minHz, axis.maxHz)),
    gainDb: clamp(node.gainDb + db, -RESONANCE_WEIGHT_MAX_DB, RESONANCE_WEIGHT_MAX_DB),
    octaves: clamp(
      nodeOctaves(node) * widthFactor,
      RESONANCE_WEIGHT_MIN_OCTAVES,
      RESONANCE_WEIGHT_MAX_OCTAVES,
    ),
  })
}

/**
 * Apply a drag, from the values the node had when it was grabbed.
 *
 * From the grab rather than incrementally, so a drag that runs into a clamp and
 * comes back returns to where it started instead of having lost the excursion.
 * `drag.width` picks the width axis; otherwise horizontal is frequency and
 * vertical is offset, up being more sensitive.
 */
export function dragNode(nodes, drag, dx, dy, axis) {
  if (drag.width) {
    return patchNode(nodes, drag.id, {
      octaves: clamp(
        drag.octaves * Math.exp(dx * NODE_DRAG_WIDTH_RATE),
        RESONANCE_WEIGHT_MIN_OCTAVES,
        RESONANCE_WEIGHT_MAX_OCTAVES,
      ),
    })
  }
  return patchNode(nodes, drag.id, {
    freqHz: Math.round(clamp(
      hzFromX(xFromHz(drag.freqHz, axis) + dx, axis), axis.minHz, axis.maxHz)),
    gainDb: clamp(
      drag.gainDb - dy * NODE_DRAG_DB_PER_PX,
      -RESONANCE_WEIGHT_MAX_DB,
      RESONANCE_WEIGHT_MAX_DB,
    ),
  })
}
