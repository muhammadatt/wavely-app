/**
 * Spectral hole detection — finding the notches that corrupt a baseline.
 *
 * WHAT THIS IS FOR. `estimateBaseline` builds its reference by anchoring to a
 * 0.4-octave context window on either side of a scan region and interpolating
 * between the two medians. That is a chord, and a chord is only a fair
 * reference when the two windows are representative of the region's
 * neighbourhood. A deep notch sitting inside one of those windows drags its
 * anchor down, the chord tips, and the perfectly ordinary spectrum on the far
 * side of the region now towers over a reference that has fallen out from
 * under it. The region reports a large, confident hump that is not there.
 *
 * The failure is not hypothetical and it is not symmetric. A notch between two
 * scan regions corrupts BOTH of them — the region below anchors its top in the
 * notch, the region above anchors its bottom in the same notch — so a single
 * hole produces a matched pair of phantom cuts on either side of itself. A
 * file with a 17 dB dip at 5 kHz, which is what a previously applied surgical
 * EQ cut looks like, asks for a large cut in upper_presence AND a large cut in
 * brilliance, neither of which needs cutting. Iteration then drives both to
 * their caps, because correcting a phantom never removes it and every pass
 * spends its full budget again.
 *
 * The existing `floorDb` guard does not catch this. It rejects anchors that are
 * DEAD — below the envelope peak by DEAD_REGION_DB — which is the brick-walled
 * case. A notch anchor is not dead. It is alive, and wrong, which is worse:
 * dead anchors are obvious and a notch anchor looks like a measurement.
 *
 * WHY MORPHOLOGICAL CLOSING AND NOT A TREND. The detector has to find a valley
 * on a spectrum that is ALSO steeply sloped — a voice envelope falls 40 dB
 * across the range this searches — and it must not confuse the two. Every
 * smoothing-based reference fails that test: a running median or a
 * high-percentile trend over a symmetric window is biased upward on a slope in
 * proportion to the slope, so a steep roll-off reads as a continuous deficit
 * and the detector fires down the entire descent.
 *
 * Greyscale closing has the property that is actually wanted:
 *
 *     deficit(f) = min( max env over [f-W, f], max env over [f, f+W] ) - env(f)
 *
 * On a monotone signal this is identically zero, at any slope. Dilation
 * followed by erosion returns a monotone signal unchanged, so tilt cannot
 * produce a false hole no matter how severe it is. On a valley narrower than
 * the structuring element it returns the depth. It is the one estimator here
 * that is exactly slope-invariant rather than approximately so.
 *
 * WHY min OF THE TWO SHOULDERS rather than max over the whole window. Taking
 * the maximum across the full window makes every cliff edge look like a hole:
 * at the top of a brick-walled file, the window reaches back into live audio
 * and forward into nothing, so the dead side reads as a 26 dB deficit and the
 * detector plants a hole on the lowpass edge. Requiring BOTH shoulders to
 * stand above the floor is what makes a hole a hole — a valley has two sides,
 * an edge has one — and it costs nothing on real notches, which have two sides
 * by definition.
 *
 * Dependency-free, no Web Audio, no DOM. Pure arrays in, plain objects out.
 */

/**
 * Analysis grid resolution, in octaves.
 *
 * Fine enough that the shoulder search lands on the actual peak rather than a
 * quantized neighbour, coarse enough that the window scans stay cheap: the
 * whole detection is O(grid x window) and both are small at this step.
 */
const GRID_OCTAVES = 1 / 24

/**
 * Half-width of the structuring element, in octaves.
 *
 * This is the widest valley the detector will fill, and therefore the widest
 * notch it can see. It has to be more than half the widest hole worth
 * catching, because the shoulders are found by looking W either side of the
 * floor: a valley spanning a full octave needs W of at least 0.5 to be closed
 * at all, and 0.75 leaves margin for a notch whose floor sits off-centre.
 *
 * Larger is not free. W also sets how far a legitimate resonance-and-recovery
 * pattern has to be from its neighbours before the gap between two peaks reads
 * as a hole, and formant spacing in speech is on the order of an octave. At
 * 0.75 the ordinary peak-trough-peak of a vowel spectrum stays well under
 * MIN_DEPTH_DB; at 1.5 it would not.
 */
const WINDOW_OCTAVES = 0.75

/**
 * How deep a valley has to be before it is treated as a hole.
 *
 * This is a threshold on a measurement that is zero for any monotone spectrum,
 * so it is not competing with spectral tilt and can sit low. What it IS
 * competing with is the natural corrugation between formants, which on the
 * cepstrally-liftered envelope this runs on is a few dB — the liftering has
 * already removed the harmonic structure, and what remains is the formant
 * envelope itself.
 *
 * 6 dB is above that corrugation and far below the size of a hole that matters.
 * A notch shallower than 6 dB tips an anchor by at most a couple of dB, which
 * the region's own threshold and SCALE absorb; one deeper than 6 dB does not.
 */
const MIN_DEPTH_DB = 6

/**
 * Fraction of a scan region that may sit inside a hole before the region is
 * unassessable.
 *
 * A region half inside a notch has no honest reading available from within
 * itself: the half in the hole is not the voice, and the half outside is being
 * measured against a chord anchored in the half that is. Repairing the anchors
 * fixes a region that merely NEIGHBOURS a hole; it cannot fix one that mostly
 * IS the hole, because there is no clean neighbourhood left to anchor to on
 * that side and no clean content left to measure.
 *
 * A half is the natural line and not a tuned one — below it the region is
 * mostly voice with a notch intruding, above it the region is mostly notch.
 */
export const MAX_HOLE_COVERAGE = 0.5

/**
 * Find the spectral holes in a cepstral envelope.
 *
 * Returns holes low-frequency first, each spanning SHOULDER TO SHOULDER: from
 * the peak of the envelope on one side of the valley to the peak on the other.
 * That span is deliberately generous, and generous is the right error. What the
 * span is used for is deciding which frequencies may not be trusted as a
 * reference, and the contaminated zone is not the floor of the notch — it is
 * the whole descent into it and the whole climb out. A span drawn at
 * half-depth, which is the narrower and more obvious choice, leaves the
 * shoulders of the notch inside the context windows and reproduces a weakened
 * version of the same bug.
 *
 * Shoulder-to-shoulder is also the robust choice numerically. The deficit curve
 * has local wiggles of a dB or two, so a span defined by walking outward while
 * the deficit stays above some level terminates early and erratically wherever
 * a wiggle dips under it. The positions of the two flanking maxima do not
 * wobble.
 *
 * @param {Float64Array} freqsHz bin centre frequencies, ascending
 * @param {Float64Array} envelopeDb envelope level per bin
 * @param {number} deadFloorDb bins below this carry no content and cannot form
 *   a hole, a shoulder, or a floor — see DEAD_REGION_DB in analysis.js
 * @param {number} minHz low edge of the search
 * @param {number} maxHz high edge of the search
 * @returns {Array<{centerHz:number, depthDb:number, lowHz:number, highHz:number}>}
 */
export function detectSpectralHoles(
  freqsHz, envelopeDb, deadFloorDb, minHz, maxHz,
) {
  if (!(maxHz > minHz) || freqsHz.length < 2) return []

  const n = Math.floor(Math.log2(maxHz / minHz) / GRID_OCTAVES) + 1
  if (n < 3) return []

  // Resample onto a uniform log-frequency grid. The window scans below are
  // fixed spans in octaves, and only a log-uniform grid makes that a fixed
  // number of samples rather than a search at every point.
  const gridHz = new Float64Array(n)
  const gridDb = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const f = minHz * Math.pow(2, i * GRID_OCTAVES)
    gridHz[i] = f
    gridDb[i] = interpolateAt(freqsHz, envelopeDb, f)
  }

  const w = Math.max(1, Math.round(WINDOW_OCTAVES / GRID_OCTAVES))
  const live = i => gridDb[i] >= deadFloorDb

  // Deficit: how far this bin sits below the LOWER of its two shoulders.
  const deficit = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (!live(i)) continue
    let lo = -Infinity
    let hi = -Infinity
    for (let j = Math.max(0, i - w); j <= i; j++) if (live(j) && gridDb[j] > lo) lo = gridDb[j]
    for (let j = i; j <= Math.min(n - 1, i + w); j++) if (live(j) && gridDb[j] > hi) hi = gridDb[j]
    // A one-sided window has no far shoulder and so no valley to measure. This
    // is the brick-wall case and the two ends of the search range at once.
    if (lo === -Infinity || hi === -Infinity) continue
    deficit[i] = Math.min(lo, hi) - gridDb[i]
  }

  const holes = []
  let i = 0
  while (i < n) {
    if (deficit[i] < MIN_DEPTH_DB) {
      i++
      continue
    }
    let end = i
    while (end + 1 < n && deficit[end + 1] >= MIN_DEPTH_DB) end++

    let floor = i
    for (let k = i; k <= end; k++) if (deficit[k] > deficit[floor]) floor = k

    // Shoulders: the flanking maxima that define the valley.
    let lowIdx = floor
    for (let k = Math.max(0, floor - w); k <= floor; k++) {
      if (live(k) && gridDb[k] > gridDb[lowIdx]) lowIdx = k
    }
    let highIdx = floor
    for (let k = floor; k <= Math.min(n - 1, floor + w); k++) {
      if (live(k) && gridDb[k] > gridDb[highIdx]) highIdx = k
    }

    holes.push({
      centerHz: round(gridHz[floor], 1),
      depthDb: round(deficit[floor], 2),
      lowHz: round(gridHz[lowIdx], 1),
      highHz: round(gridHz[highIdx], 1),
    })
    i = end + 1
  }

  return mergeOverlapping(holes)
}

/**
 * Fold holes whose spans touch into one.
 *
 * Runs of the deficit curve are disjoint by construction, but their
 * shoulder-to-shoulder spans need not be: two notches a third of an octave
 * apart share the small peak between them as a shoulder, so both spans reach
 * across it. Left separate they would double-count in `holeCoverage` and
 * describe the same contaminated stretch twice in the findings.
 *
 * The merged hole keeps the DEEPER floor as its centre and depth. The deeper of
 * two adjacent notches is the one the user cut, and the shallower is usually
 * its skirt.
 */
function mergeOverlapping(holes) {
  if (holes.length < 2) return holes
  const out = [holes[0]]
  for (let i = 1; i < holes.length; i++) {
    const prev = out[out.length - 1]
    const h = holes[i]
    if (h.lowHz > prev.highHz) {
      out.push(h)
      continue
    }
    const deeper = h.depthDb > prev.depthDb ? h : prev
    out[out.length - 1] = {
      centerHz: deeper.centerHz,
      depthDb: deeper.depthDb,
      lowHz: Math.min(prev.lowHz, h.lowHz),
      highHz: Math.max(prev.highHz, h.highHz),
    }
  }
  return out
}

/** Is this frequency inside any hole? */
export function inAnyHole(holes, hz) {
  for (const h of holes) if (hz >= h.lowHz && hz <= h.highHz) return true
  return false
}

/**
 * What fraction of a span, measured in log-frequency, is inside a hole.
 *
 * Log-frequency because that is the axis every other width in this analysis is
 * measured on — a hole covering 4-5 kHz of a 2.5-5 kHz region covers a third of
 * it by ear and by octave, and only a fifth of it by hertz. The ear's answer is
 * the one that should decide whether the region is still readable.
 */
export function holeCoverage(holes, lowHz, highHz) {
  if (!holes.length || !(highHz > lowHz)) return 0
  const span = Math.log2(highHz / lowHz)
  let covered = 0
  for (const h of holes) {
    const lo = Math.max(lowHz, h.lowHz)
    const hi = Math.min(highHz, h.highHz)
    if (hi > lo) covered += Math.log2(hi / lo)
  }
  return Math.min(1, covered / span)
}

/** Linear interpolation of a bin-sampled curve at an arbitrary frequency. */
function interpolateAt(freqsHz, valuesDb, hz) {
  const last = freqsHz.length - 1
  if (hz <= freqsHz[0]) return valuesDb[0]
  if (hz >= freqsHz[last]) return valuesDb[last]

  // The caller's bins are uniformly spaced in hertz (rfft output), so the index
  // is arithmetic rather than a search.
  const step = freqsHz[1] - freqsHz[0]
  const x = step > 0 ? (hz - freqsHz[0]) / step : 0
  const k = Math.min(last - 1, Math.max(0, Math.floor(x)))
  const t = x - k
  return valuesDb[k] * (1 - t) + valuesDb[k + 1] * t
}

function round(v, places) {
  const f = Math.pow(10, places)
  return Math.round(v * f) / f
}
