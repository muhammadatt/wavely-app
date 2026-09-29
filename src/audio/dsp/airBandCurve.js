/**
 * The Maag-style Air Band curve: five overlapping bells plus a wide high shelf,
 * all scaling from one gain. Shared by Air Boost (airBandProcessor.js) and the
 * HF Softener's Air makeup, so both are the same curve by construction.
 *
 * Pure coefficients and no worklet registration, so any worklet kernel can
 * import it: airBandProcessor.js registers 'air-band-processor', and importing
 * THAT into a second worklet would register it twice in one AudioContext.
 */

import { peaking, highShelf } from './biquad.js'

// Per-band gains are quoted at this plateau and scaled linearly from it, so
// the fitted constants below stay identical to server/pipeline/airBoost.js.
export const REFERENCE_PLATEAU_DB = 12.5932

export const AIR_BANDS = [
  // Parametric bells, Q = 0.5. The 2.4/4.8/9.6 kHz gains are negative: they
  // are corrective shaping that pulls the shelf's broad plateau down into the
  // Maag's slower sigmoid, not audible cuts. The summed response is
  // non-negative at every frequency.
  { freqHz: 600, type: 'bell', q: 0.5, gRef: -0.02733 },
  { freqHz: 1200, type: 'bell', q: 0.5, gRef: -0.30754 },
  { freqHz: 2400, type: 'bell', q: 0.5, gRef: -1.18676 },
  { freqHz: 4800, type: 'bell', q: 0.5, gRef: -0.90883 },
  { freqHz: 9600, type: 'bell', q: 0.5, gRef: 0.91883 },
  // Wide high shelf carrying the bulk of the lift. 3.023 octaves ≈ Q 0.4 —
  // far gentler than the S = 1 a stock BiquadFilterNode highshelf would give,
  // which is why the coefficients are built here rather than delegated.
  { freqHz: 14000, type: 'shelf', wOct: 3.023, gRef: 22.54678 },
]

/** Band coefficients for a given air gain — shared with the curve display. */
export function airBandSections(sampleRate, gainDb) {
  const scale = gainDb / REFERENCE_PLATEAU_DB
  return AIR_BANDS.map(b =>
    b.type === 'bell'
      ? peaking(sampleRate, b.freqHz, b.q, b.gRef * scale, 'q')
      : highShelf(sampleRate, b.freqHz, b.wOct, b.gRef * scale, 'octaves'),
  )
}

