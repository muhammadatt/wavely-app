/**
 * Geometry and edits for the focus nodes, which live INSIDE the resonance plot.
 * See src/audio/resonanceFocus.js for what a focus node IS.
 *
 * Split out of the component for the same reason resonanceZoneEdit.js is: every
 * one of these is a pure function of (nodes, axis, gesture) and none of them
 * needs a canvas. The drawing stays in the component; this keeps the arithmetic
 * that decides what a drag meant, which is the half that can be wrong in a way
 * nobody notices — a node editor whose frequency mapping is off by an octave
 * still looks like a working node editor.
 *
 * ⚠ THERE IS NO RAIL. It began as a separate strip under the plot, which was
 * rejected as a second instrument beside the one it describes; the curve now
 * floats over the spectrum, on the material it is aimed at.
 *
 * ⚠ ITS DATUM IS STATIC, AND THAT IS THE ONE HARD CONSTRAINT. The obvious
 * reading of "over the spectrum" is to hang the handles on the THRESHOLD
 * staircase, since that is the line a node actually biases. Measured: the
 * spectrum band is 70 dB over ~139 px, so 1 dB is ~2 px, and a per-bin envelope
 * swings tens of dB between a vowel and a pause. On a ±12 dB syllabic probe —
 * conservative against real speech — the threshold line at one node's frequency
 * travels **43 px in two seconds and up to 7 px between consecutive frames**.
 * That is the discarded Gaussian nodes' "impossible to aim" report in numbers.
 * So the curve keeps the threshold's PLACE and not its MOTION: a fixed datum,
 * with nothing moving unless a knob does.
 *
 * The static datum also stops the gesture promising something the effect cannot
 * do. A bell drawn on a spectrum reads as "pinpoint this frequency and notch
 * it", and a node never notches anything — it moves a detection threshold, so
 * over a clean part of the spectrum it does nothing at any setting. A curve
 * that visibly is not the spectrum, and visibly is not the threshold, reads as
 * the third thing it is.
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
 * Where the curve sits in the plot, and how steeply it responds.
 *
 * Both are fractions of the SPECTRUM BAND — the middle of the plot's three
 * tiled bands, between the reduction lane above and the FOUND strip below — so
 * the curve grows with the plot when it is resized, as everything else in it
 * does.
 *
 * ⚠ THE TWO TOGETHER HAVE TO KEEP THE CURVE INSIDE THE BAND, which is what
 * decides the numbers rather than taste. The datum sits 0.22 of the band down
 * from its top, roughly where a threshold sits over speech; full travel either
 * way is 0.20 of the band, so the curve lives in [0.02, 0.42] of the band and
 * cannot reach either the reduction lane or the noise floor. A curve that
 * escaped its band would be drawn over a lane measuring something else entirely
 * — the mistake the plot's own two-lane split was undone for.
 *
 * At the shipping height that is 1.54 px per dB, which is within 5% of the
 * 1.61 px/dB the separate rail had — so the drag has the same feel it had
 * before it moved.
 */
export const FOCUS_DATUM_FRAC = 0.22
export const FOCUS_HALF_SPAN_FRAC = 0.20

/**
 * The vertical mapping, from the spectrum band's own edges.
 *
 * ⚠ POSITIVE BIAS GOES DOWN. "More cut" lowers the threshold toward the
 * material, and on this plot down IS toward the material — the spectrum is
 * below and the reduction trace already hangs downward for "more". A curve that
 * rose for "more cut" would be the only thing on the plate running the other
 * way.
 */
export function focusScope(bandTop, bandBottom, maxDb) {
  const band = Math.max(1, bandBottom - bandTop)
  return {
    maxDb,
    datum: bandTop + band * FOCUS_DATUM_FRAC,
    pxPerDb: (band * FOCUS_HALF_SPAN_FRAC) / maxDb,
  }
}

export function yFromBias(db, scope) {
  return scope.datum + clamp(db, -scope.maxDb, scope.maxDb) * scope.pxPerDb
}

export function biasFromY(y, scope) {
  return clamp((y - scope.datum) / scope.pxPerDb, -scope.maxDb, scope.maxDb)
}

/** Where a node's handle sits: its own frequency, at its own amount. */
export function nodePoint(node, axis, scope) {
  return { x: xFromHz(node.hz, axis), y: yFromBias(node.biasDb, scope) }
}

/**
 * Index of the node under a point, or -1.
 *
 * Nearest wins, so two nodes stacked at the same frequency are both reachable
 * by aiming at their amounts — which is the only thing that distinguishes them
 * on the curve.
 */
export function nodeAt(nodes, x, y, axis, scope, radiusPx = NODE_HIT_PX) {
  let best = -1
  let bestD = radiusPx * radiusPx
  for (let i = 0; i < nodes.length; i++) {
    const p = nodePoint(nodes[i], axis, scope)
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
 * and draws the bottom octaves as straight segments between three samples.
 * The same argument the spectrum display's log resample makes.
 */
export function biasCurvePoints(nodes, axis, scope, step = 1) {
  const pts = []
  for (let x = 0; x <= axis.w; x += step) {
    const db = focusBiasAt(nodes, hzFromX(x, axis))
    pts.push({ x, y: yFromBias(db, scope), db })
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
     * A node created at zero would be invisible on the curve and inaudible in
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
 * wheel. That split is not arbitrary: where and how much are what you sweep by
 * ear against the audio, and how wide is what you set once and read.
 */
export function moveNode(nodes, index, x, y, axis, scope) {
  if (index < 0 || index >= nodes.length) return nodes
  return patchNode(nodes, index, {
    hz: clamp(hzFromX(x, axis), RESONANCE_FOCUS_RANGES.hz.min, RESONANCE_FOCUS_RANGES.hz.max),
    biasDb: biasFromY(y, scope),
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
