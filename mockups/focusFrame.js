/**
 * A synthetic ResoTame display frame, for the focus-targeting mockups.
 *
 * MOCKUP SCAFFOLDING — not shipped, not imported by the app. It exists so the
 * candidate node treatments can be judged against the REAL plot with plausible
 * curves in it, rather than against an empty box. See mockups/focus.html.
 *
 * ⚠ The reduction curve is computed from the focus patch being drawn, so the
 * picture is self-consistent: moving a node really does change where the cut
 * lands. That matters for judging the treatments — a node layer that looks fine
 * over a static cut can still fail to explain the cut it caused.
 */
import { RESONANCE_DISPLAY_BINS } from '../src/audio/resonanceParams.js'
import { focusThresholdFn } from '../src/audio/resonanceFocus.js'

const MIN_HZ = 20
const MAX_HZ = 20000

/** A narration-shaped magnitude spectrum, with a few resonances planted in it. */
function magnitudeAt(hz) {
  // Broad speech shape: a fundamental region, a presence bump, a roll-off.
  const l = Math.log2(hz)
  let db = -34
  db -= Math.max(0, l - Math.log2(320)) * 5.2      // roll-off above the body
  db -= Math.max(0, Math.log2(90) - l) * 14        // steep below the fundamental
  db += 3 * Math.exp(-0.5 * Math.pow((l - Math.log2(2600)) / 0.55, 2)) // presence
  // Planted resonances — the things a suppressor is pointed at.
  // Deliberately narrow and tall: the detector compares against a smoothed
  // envelope, so a peak only reads as a resonance to the extent it PROTRUDES
  // from its own neighbourhood. Broad bumps are tone, not resonance — which is
  // the distinction the whole effect rests on.
  for (const [f, g, q] of [[196, 24, 0.05], [430, 22, 0.05], [1150, 23, 0.05],
    [3180, 24, 0.05], [6400, 22, 0.055]]) {
    db += g * Math.exp(-0.5 * Math.pow((l - Math.log2(f)) / q, 2))
  }
  // A little scatter, deterministic so every render is identical.
  db += 1.6 * Math.sin(hz * 0.031) + 1.1 * Math.sin(hz * 0.0071 + 2)
  return db
}

/**
 * A frame, as `getDisplay()` returns one.
 *
 * `reference` is a smoothed version of the magnitude — the peak envelope the
 * shipping reference draws — so the resonances protrude from it exactly as they
 * do in the real thing.
 */
export function makeFrame(focus, bins = RESONANCE_DISPLAY_BINS, t = 0) {
  const span = Math.log2(MAX_HZ / MIN_HZ)
  const hzAt = d => MIN_HZ * Math.pow(2, (d / (bins - 1)) * span)

  // ⚠ TIME-VARYING, AND THAT IS THE POINT OF THE `t`. A still frame cannot
  // answer the only question that matters for putting handles on the threshold
  // line: how far does that line TRAVEL. Real speech swings a per-bin envelope
  // by tens of dB between a vowel and a pause, so the probe modulates level at
  // a syllabic rate and tilts the spectrum as it goes — a pause is not merely
  // quieter, it is a different shape.
  const syl = Math.sin(t * 2 * Math.PI * 3.1)          // ~3 Hz, syllabic
  const phrase = Math.sin(t * 2 * Math.PI * 0.35)      // phrase-level drift
  const level = 9 * syl + 3 * phrase
  const tilt = 3 * Math.sin(t * 2 * Math.PI * 2.3)

  const mag = new Float32Array(bins)
  for (let d = 0; d < bins; d++) {
    const hz = hzAt(d)
    mag[d] = magnitudeAt(hz) + level + tilt * (Math.log2(hz) - Math.log2(500)) * 0.35
  }

  // The envelope: a wide moving average in log frequency, which is what the
  // peak reference is to within the detail this mockup needs.
  const reference = new Float32Array(bins)
  const halfWin = Math.round(bins * 0.055)
  for (let d = 0; d < bins; d++) {
    let sum = 0
    let n = 0
    for (let k = Math.max(0, d - halfWin); k <= Math.min(bins - 1, d + halfWin); k++) {
      sum += mag[k]
      n++
    }
    reference[d] = sum / n
  }

  // The detector reads a max-filtered magnitude, not the raw curve.
  const detect = new Float32Array(bins)
  for (let d = 0; d < bins; d++) {
    let m = -200
    for (let k = Math.max(0, d - 2); k <= Math.min(bins - 1, d + 2); k++) m = Math.max(m, mag[k])
    detect[d] = m
  }

  // Reduction, from the patch actually being drawn — see the header note.
  const thresholdAt = focusThresholdFn(focus)
  const depth = focus?.global?.depth ?? 1
  const maxCut = focus?.global?.maxCut ?? 36
  const reduction = new Float32Array(bins)
  for (let d = 0; d < bins; d++) {
    const over = detect[d] - (reference[d] + thresholdAt(hzAt(d)))
    reduction[d] = over > 0 ? Math.min(over * depth, maxCut) : 0
  }
  // A little spectral spread, as the kernel's spread kernel gives.
  const spread = new Float32Array(bins)
  for (let d = 0; d < bins; d++) {
    let m = 0
    for (let k = Math.max(0, d - 3); k <= Math.min(bins - 1, d + 3); k++) {
      m = Math.max(m, reduction[k] * (1 - Math.abs(k - d) / 5))
    }
    spread[d] = m
  }

  const held = new Float32Array(bins)
  for (let d = 0; d < bins; d++) held[d] = spread[d] * 1.18 + 0.4

  return {
    bins,
    minHz: MIN_HZ,
    maxHz: MAX_HZ,
    mag,
    reference,
    detect,
    reduction: spread,
    reductionHeld: held,
  }
}
