/**
 * Geometry and edits for the focus rail — the node strip under the resonance
 * plot. See src/audio/resonanceFocus.js for what a focus node IS.
 *
 * Split out of the component for the same reason resonanceZoneEdit.js is: every
 * one of these is a pure function of (nodes, axis, gesture) and none of them
 * needs a canvas. The drawing stays in the component; this keeps the arithmetic
 * that decides what a drag meant, which is the half that can be wrong in a way
 * nobody notices — a node editor whose frequency mapping is off by an octave
 * still looks like a working node editor.
 *
 * ⚠ THE RAIL IS ITS OWN STRIP, NOT AN OVERLAY ON THE TRACE, and that is the
 * fix for the failure already on record. The discarded Gaussian nodes put their
 * handles on the threshold line, which is `reference + selectivity` and
 * therefore moves with the audio at ~46 frames a second — reported from use as
 * a control bouncing three or four times a second and impossible to aim. A bias
 * curve is a STATIC function of frequency. It does not move, ever, so its
 * handles hold still and can be hit.
 *
 * It also stops the gesture promising something the effect cannot do. A bell
 * drawn over a spectrum reads as "pinpoint this frequency and notch it", and a
 * node never notches anything — it moves a detection threshold, so on a clean
 * part of the spectrum it does nothing at any setting. On its own rail, below
 * the plot, with dB-of-sensitivity on its axis, it reads as what it is.
 */

import {
  RESONANCE_FOCUS_MAX_NODES,
  RESONANCE_FOCUS_RANGES,
  focusBiasAt,
} from '../../audio/resonanceFocus.js'

/** How close the pointer must be to a node to grab it, in pixels. */
export const NODE_HIT_PX = 11
/** Drawn radius. Smaller than the hit radius, as every target on this plot is. */
export const NODE_R = 4

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
 * The rail's vertical mapping: +biasDb at the top, 0 in the middle, -biasDb at
 * the bottom.
 *
 * SYMMETRIC AROUND A CENTRE LINE, deliberately, because the quantity is signed
 * and its zero is the whole point of the model. A rail whose zero sat at the
 * bottom would draw "leave this alone" and "work a little harder here" as
 * neighbouring positions near one end, when they are opposite statements.
 */
export function yFromBias(db, rail) {
  const half = rail.h / 2
  return half - (clamp(db, -rail.maxDb, rail.maxDb) / rail.maxDb) * half
}

export function biasFromY(y, rail) {
  const half = rail.h / 2
  return clamp(((half - y) / half) * rail.maxDb, -rail.maxDb, rail.maxDb)
}

/** Where a node's handle sits: its own frequency, at its own amount. */
export function nodePoint(node, axis, rail) {
  return { x: xFromHz(node.hz, axis), y: yFromBias(node.biasDb, rail) }
}

/**
 * Index of the node under a point, or -1.
 *
 * Nearest wins, so two nodes stacked at the same frequency are both reachable
 * by aiming at their amounts — which is the only thing that distinguishes them
 * on this rail.
 */
export function nodeAt(nodes, x, y, axis, rail, radiusPx = NODE_HIT_PX) {
  let best = -1
  let bestD = radiusPx * radiusPx
  for (let i = 0; i < nodes.length; i++) {
    const p = nodePoint(nodes[i], axis, rail)
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y)
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * The bias curve as a polyline, one point per pixel column.
 *
 * Sampled in PIXELS rather than in frequency because that is what gets drawn:
 * sampling evenly in Hz puts nine tenths of the points in the top two octaves
 * and draws the bottom of the rail as straight segments between three samples.
 * The same argument the spectrum display's log resample makes.
 */
export function biasCurvePoints(nodes, axis, rail, step = 1) {
  const pts = []
  for (let x = 0; x <= axis.w; x += step) {
    const db = focusBiasAt(nodes, hzFromX(x, axis))
    pts.push({ x, y: yFromBias(db, rail), db })
  }
  return pts
}

/** A new node with the stock shape, centred where it was asked for. */
export function makeFocusNode(hz, id) {
  return {
    id,
    hz: clamp(hz, RESONANCE_FOCUS_RANGES.hz.min, RESONANCE_FOCUS_RANGES.hz.max),
    /**
     * One octave, and +6 dB of sensitivity.
     *
     * A node created at zero would be invisible on the rail and inaudible in
     * the file, so the gesture that makes one would look broken — the same
     * failure the ceiling presets shipped, where a click was accepted and
     * discarded. It is created DOING something, in the direction the gesture
     * implies: you point at a resonance because you want more done about it.
     * 6 dB is roughly a third of the travel, which is enough to hear and small
     * enough not to wreck a band by accident.
     */
    spanOct: 1,
    biasDb: 6,
    enabled: true,
  }
}

/** Replace one node, leaving the array's identity fresh for Vue. */
export function patchNode(nodes, index, patch) {
  if (index < 0 || index >= nodes.length) return nodes
  const next = nodes.slice()
  next[index] = { ...next[index], ...patch }
  return next
}

/** Clamp and set one named field on a node. */
export function setNodeParam(nodes, index, name, value) {
  const r = RESONANCE_FOCUS_RANGES[name]
  if (!r) return nodes
  return patchNode(nodes, index, { [name]: clamp(value, r.min, r.max) })
}

/**
 * Move a node in both axes at once — a drag sets frequency AND amount.
 *
 * Two of a node's three numbers on one gesture, and the third (span) on the
 * wheel or in the field beside the rail. That split is not arbitrary: where and
 * how much are what you sweep by ear against the audio, and how wide is what
 * you set once and read.
 */
export function moveNode(nodes, index, x, y, axis, rail) {
  if (index < 0 || index >= nodes.length) return nodes
  return patchNode(nodes, index, {
    hz: clamp(hzFromX(x, axis), RESONANCE_FOCUS_RANGES.hz.min, RESONANCE_FOCUS_RANGES.hz.max),
    biasDb: biasFromY(y, rail),
  })
}

/**
 * Widen or narrow a node, geometrically.
 *
 * A fixed dB step would take forever at the wide end and jump at the narrow
 * one, because span is read on a log axis — the same reason frequency is.
 */
export const SPAN_WHEEL_RATIO = 1.12

export function scaleNodeSpan(nodes, index, direction) {
  if (index < 0 || index >= nodes.length) return nodes
  const r = RESONANCE_FOCUS_RANGES.spanOct
  const next = nodes[index].spanOct * Math.pow(SPAN_WHEEL_RATIO, direction)
  return patchNode(nodes, index, { spanOct: clamp(next, r.min, r.max) })
}

/**
 * Add a node, up to the cap.
 *
 * Returns the array unchanged when full rather than dropping the newest or the
 * oldest. A silently discarded edit is the worst of the available failures —
 * the caller checks `canAddFocusNode` and disables the gesture instead.
 */
export function addNode(nodes, node) {
  if (nodes.length >= RESONANCE_FOCUS_MAX_NODES) return nodes
  return [...nodes, node]
}

export function canAddFocusNode(nodes) {
  return nodes.length < RESONANCE_FOCUS_MAX_NODES
}

export function removeNode(nodes, index) {
  if (index < 0 || index >= nodes.length) return nodes
  return nodes.filter((_, i) => i !== index)
}

export function toggleNode(nodes, index) {
  if (index < 0 || index >= nodes.length) return nodes
  return patchNode(nodes, index, { enabled: nodes[index].enabled === false })
}

/**
 * The node nearest a frequency, within a tolerance in octaves, or -1.
 *
 * How a click on a named resonance in the plot above finds the node it already
 * made, so pointing at the same ring twice adjusts one node instead of stacking
 * two on top of each other.
 */
export function nodeNearHz(nodes, hz, tolOct = 1 / 6) {
  let best = -1
  let bestOct = tolOct
  for (let i = 0; i < nodes.length; i++) {
    const oct = Math.abs(Math.log2(hz / nodes[i].hz))
    if (oct <= bestOct) {
      bestOct = oct
      best = i
    }
  }
  return best
}
