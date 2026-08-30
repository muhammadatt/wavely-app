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
 * ⚠ THE DATUM TRACKS THE THRESHOLD KNOB NOW, AND IT USED TO BE A CONSTANT. It
 * sat at a fixed 0.22 of the band whatever the global Threshold was set to — a
 * layout number wearing the appearance of a reading, so the one line on the
 * plate that means "zero bias, this is where the detector sits" could not be
 * moved by the control that moves the detector. It travels
 * [FOCUS_DATUM_MIN_FRAC, FOCUS_DATUM_MAX_FRAC] as Selectivity runs from its
 * maximum to its minimum: HIGHER selectivity is LESS cut, and on this plot less
 * cut is up.
 *
 * ⚠ THE DEFAULT POSITION MOVED, 0.22 to about 0.35, AND IT COULD NOT NOT MOVE.
 * The curve has to stay inside the band — full bias either way is 0.20 of it, so
 * the datum is confined to [0.20, 0.80] — and 0.22 leaves only 0.02 of headroom
 * above. Anchoring the shipped default there caps the whole travel at 0.041 of
 * the band, which is 5.7 px at the shipping height: a rail that technically
 * tracks the knob and visibly does not. Keeping the guarantee and losing the
 * exact starting position is the better trade; a curve that escaped its band
 * would be drawn over a lane measuring something else entirely, which is the
 * mistake the plot's own two-lane split was undone for.
 *
 * ⚠ `pxPerDb` IS UNCHANGED BY ANY OF THIS. Only the origin moves, so the curve's
 * shape and the drag's feel are identical at every threshold — a mapping that
 * stretched as the rail moved would make turning Threshold silently re-scale
 * every node's amount.
 *
 * At the shipping height that is 1.54 px per dB, which is within 5% of the
 * 1.61 px/dB the separate rail had — so the drag has the same feel it had
 * before it moved.
 */
export const FOCUS_DATUM_MIN_FRAC = 0.20
export const FOCUS_DATUM_MAX_FRAC = 0.50
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
export function focusScope(bandTop, bandBottom, maxDb, thresholdT = 0.5) {
  const band = Math.max(1, bandBottom - bandTop)
  // 0 is the least selective setting — the most cut — and sits lowest, because
  // down is toward the material everywhere else on this plate.
  const t = clamp(thresholdT, 0, 1)
  const frac = FOCUS_DATUM_MAX_FRAC - t * (FOCUS_DATUM_MAX_FRAC - FOCUS_DATUM_MIN_FRAC)
  return {
    maxDb,
    datum: bandTop + band * frac,
    pxPerDb: (band * FOCUS_HALF_SPAN_FRAC) / maxDb,
  }
}

/**
 * The inverse: a y on the plate back to a threshold position, 0..1.
 *
 * ⚠ IT INVERTS `focusScope`'s DATUM MAPPING AND MUST STAY ITS EXACT MIRROR. The
 * panel has recorded twice what a second copy of a mapping costs — a hit test
 * derived independently fails silently, as handles that cannot be grabbed where
 * they are drawn — so this is written as the algebraic inverse of the one
 * expression above rather than as its own idea of where the rail is.
 *
 * Clamped, so a drag past either end parks at the end instead of running the
 * value off its range.
 */
export function thresholdFractionFromY(y, bandTop, bandBottom) {
  const band = Math.max(1, bandBottom - bandTop)
  const frac = (y - bandTop) / band
  const span = FOCUS_DATUM_MAX_FRAC - FOCUS_DATUM_MIN_FRAC
  return clamp((FOCUS_DATUM_MAX_FRAC - frac) / span, 0, 1)
}

/** A 0..1 position back to a value in a control's range. */
export function selectivityFromFraction(t, range) {
  return range.min + clamp(t, 0, 1) * (range.max - range.min)
}

/**
 * Where a Selectivity value sits in its own range, as 0..1 — the only thing
 * `focusScope` needs to know about the threshold.
 *
 * A fraction rather than the dB, so the mapping from a control's range to a
 * position on the plate lives in one place and the scope needs no opinion about
 * what Selectivity means.
 */
export function thresholdFraction(selectivity, range) {
  const span = range.max - range.min
  return span > 0 ? clamp((selectivity - range.min) / span, 0, 1) : 0.5
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

/**
 * Each node's position when read LEFT TO RIGHT, and the array order that walks
 * them that way.
 *
 * ⚠ THE ARRAY IS NOT SORTED, AND MUST NOT BE. Nodes are stored in the order they
 * were added, and selection, solo and the drag in progress are all indices into
 * that array — re-sorting on every frequency change would renumber them under a
 * drag, which is the one moment the index has to hold still. So the order is a
 * VIEW: `focusRanks` gives each node its left-to-right number for display, and
 * `focusOrder` gives the sequence the arrow keys walk.
 *
 * Ties break on the array index, so two nodes stacked at one frequency still
 * have a stable, distinct number rather than swapping on a repaint.
 */
export function focusOrder(nodes) {
  return nodes
    .map((n, i) => ({ i, hz: n.hz }))
    .sort((a, b) => (a.hz - b.hz) || (a.i - b.i))
    .map(e => e.i)
}

export function focusRanks(nodes) {
  const ranks = new Array(nodes.length)
  focusOrder(nodes).forEach((nodeIndex, rank) => { ranks[nodeIndex] = rank })
  return ranks
}

/** The node one step left or right of `index`, by frequency. Wraps. */
export function focusNeighbour(nodes, index, dir) {
  if (nodes.length === 0) return -1
  const order = focusOrder(nodes)
  const at = order.indexOf(index)
  if (at < 0) return order[dir > 0 ? 0 : order.length - 1]
  return order[(at + dir + order.length) % order.length]
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
