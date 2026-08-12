/**
 * VoiceRx v2 — finding the anomalies, continuously.
 *
 * NO REGIONS HERE, AND THAT IS THE POINT. v1 scans nine fixed bands, each in
 * one direction, and everything awkward in it descends from that: overlapping
 * bands find one resonance twice and need a merge step; the female table has
 * gaps where a frequency belongs to no band at all; each band's context window
 * lies inside its neighbour's scan range, which couples them and is one of the
 * reasons the correction loop needs three passes. And the grid creates blind
 * spots that no amount of tuning reaches — `lower_presence` is dip-only, so a
 * resonance anywhere between 1.2 and 2.5 kHz is undetectable however large it
 * is. The corpus confirms it: a planted +12 dB peak at 1500 and 2000 Hz is
 * missed outright, and deficiency detection overall sits at 29%.
 *
 * A resonance is a local maximum of the residual and a deficiency is a local
 * minimum. Both are found the same way, anywhere they occur, at whatever width
 * they happen to have. Regions come back at the very end, as a LABEL for
 * something already measured — which is the only job they were ever good at.
 *
 * WHY PROMINENCE AND NOT JUST HEIGHT. A bump partway up the side of a larger
 * peak has height above the trend without being a separate thing; correcting it
 * as one puts a filter on a shoulder. Topographic prominence — how far you must
 * descend from a peak before you can climb to a higher one — is the standard
 * answer and it separates "a feature" from "part of a feature" without needing
 * a width threshold to do it.
 */

import { GRID_OCTAVES } from './trend.js'

/**
 * Residual magnitude below which a feature is not worth naming.
 *
 * Set above what a clean voice produces. The corpus's worst residual on
 * undamaged material is 1.49 dB at the chosen trend span, so anything under
 * 2 dB is indistinguishable from the ordinary corrugation of a formant
 * envelope and correcting it would be correcting the voice.
 */
const MIN_HEIGHT_DB = 2.0

/**
 * Prominence a feature needs to stand as its own.
 *
 * Lower than MIN_HEIGHT_DB on purpose: a genuine resonance sitting on a rising
 * slope has full height but modest prominence, and requiring the two to match
 * would discard it. This only has to exclude ripples on the flank of something
 * bigger.
 */
const MIN_PROMINENCE_DB = 1.0

/**
 * Widest feature that can be a defect rather than the voice's own shape.
 *
 * Beyond about two octaves the "feature" is a tilt, and tilt is what the trend
 * is for. Without this the residual at the extreme ends of the grid — where the
 * fit window is one-sided and the trend is least reliable — produces enormous
 * slow features that are entirely artefacts of the edge.
 */
const MAX_WIDTH_OCTAVES = 2.0

/**
 * Narrowest feature that counts as a TONAL defect.
 *
 * VoiceRx corrects tonal balance — its controls are Mud, Boxy, Nasal, Presence,
 * Sibilance, all broad characteristics of how a voice reads. It is not a
 * surgical notch tool; the manual EQ is there for that. So the question a
 * feature has to pass is not "is it real" but "is it the kind of thing this
 * tool is for", and below roughly a critical band the answer is no however real
 * it is. The ear integrates tonal colour over about a third of an octave at
 * these frequencies, so a 4 dB peak an eighth of an octave wide is not heard as
 * harshness — it is heard as nothing much, and correcting it with a Q of 8 is
 * inaudible at best.
 *
 * Measured rather than assumed. On the reference clip the features that made
 * v2's output unusable — ten bands where the shipping detector emits two —
 * measure 0.042, 0.125 and 0.125 octaves. The planted defects the corpus wants
 * found measure 0.25 (Q8) to 0.63 (Q1). The gap between those two groups is
 * where this sits, and it is wide enough that the exact value inside it does
 * not matter much.
 */
const MIN_WIDTH_OCTAVES = 0.22

/**
 * Locate extrema of `residual` in one direction.
 *
 * @param {Float64Array} hz grid frequencies
 * @param {Float64Array} residual envelope minus trend, dB
 * @param {Uint8Array} mask which grid points carry voice
 * @param {number} n grid length
 * @param {1|-1} sign 1 for peaks (resonances), -1 for troughs (deficiencies)
 */
function findExtrema(hz, residual, mask, n, sign) {
  const out = []

  for (let i = 1; i < n - 1; i++) {
    if (!mask[i] || !mask[i - 1] || !mask[i + 1]) continue
    const v = sign * residual[i]
    if (!(v > sign * residual[i - 1] && v >= sign * residual[i + 1])) continue
    if (v < MIN_HEIGHT_DB) continue

    // Sub-grid centre by parabolic interpolation through the three points. The
    // grid is 1/24 octave, so without this a centre can be up to 1.4% off in
    // frequency for no reason other than quantisation.
    const y0 = sign * residual[i - 1]
    const y1 = v
    const y2 = sign * residual[i + 1]
    const denom = y0 - 2 * y1 + y2
    const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0
    const centreHz = hz[i] * Math.pow(2, clamp(shift, -1, 1) * GRID_OCTAVES)

    // Half-height width, walking out until the residual falls to half the peak
    // or the mask ends.
    let lo = i
    while (lo > 0 && mask[lo - 1] && sign * residual[lo - 1] >= v / 2) lo--
    let hi = i
    while (hi < n - 1 && mask[hi + 1] && sign * residual[hi + 1] >= v / 2) hi++
    const widthOctaves = (hi - lo) * GRID_OCTAVES
    if (widthOctaves > MAX_WIDTH_OCTAVES || widthOctaves < MIN_WIDTH_OCTAVES) continue

    const prominence = prominenceAt(residual, mask, n, i, sign)
    if (prominence < MIN_PROMINENCE_DB) continue

    out.push({
      kind: sign > 0 ? 'resonance' : 'deficiency',
      index: i,
      centreHz,
      heightDb: v,
      // Falls back to a third of an octave when the excursion never comes back
      // down inside the mask — the same default v1 uses, and for the same
      // reason: an unmeasurable width is not a zero width.
      widthOctaves: widthOctaves > 0 ? widthOctaves : 0.33,
      prominenceDb: prominence,
      lowHz: hz[lo],
      highHz: hz[hi],
    })
  }

  return out
}

/**
 * Topographic prominence: how far the residual descends from this extremum
 * before it can reach a higher one, on the worse of the two sides.
 */
function prominenceAt(residual, mask, n, i, sign) {
  const peak = sign * residual[i]

  let left = peak
  for (let j = i - 1; j >= 0 && mask[j]; j--) {
    const v = sign * residual[j]
    if (v > peak) break
    if (v < left) left = v
  }

  let right = peak
  for (let j = i + 1; j < n && mask[j]; j++) {
    const v = sign * residual[j]
    if (v > peak) break
    if (v < right) right = v
  }

  return peak - Math.max(left, right)
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Every anomaly in the residual, both directions, strongest first.
 *
 * Sorted by height rather than by frequency because the consumer's first
 * question is "what is most wrong with this", and because a cap on how many
 * corrections to offer should keep the biggest rather than the lowest.
 */
export function findFeatures(hz, residual, mask, n) {
  return [
    ...findExtrema(hz, residual, mask, n, 1),
    ...findExtrema(hz, residual, mask, n, -1),
  ].sort((a, b) => b.heightDb - a.heightDb)
}
