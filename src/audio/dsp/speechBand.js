/**
 * THE BAND TWO PATHS ARE MATCHED IN.
 *
 * ⚠ SHARED BECAUSE IT IS A DECISION, NOT A DEFINITION. Matching a compressed
 * copy against its source broadband lets whatever has the largest
 * low-frequency move dominate the match — and both plugins that need this have
 * a Pultec stage either side of their compressor, which is exactly such a move.
 * Restricting the comparison to the speech band is what stops the EQ deciding
 * the level match.
 *
 * ⚠ IT IS THE MATCHING DOMAIN ONLY. Anything that is a statement about the
 * samples that actually leave — a peak, a ceiling, a delivered loudness — is
 * measured BROADBAND. Scheps records getting that distinction right; the same
 * split applies to the vocal chain's dynamics section.
 */

import { BiquadCascade, highpass, lowpass } from './biquad.js'

/**
 * Speech band, in Hz, for the trim measurement — see `speechWeight`.
 */
const SPEECH_BAND_HZ = [300, 4000]

export { SPEECH_BAND_HZ }

/** The input, restricted to the band the two paths are compared in. */
export function speechWeight(x, sampleRate) {
  const cascade = new BiquadCascade(2, 1)
  cascade.setSections([
    highpass(sampleRate, SPEECH_BAND_HZ[0], Math.SQRT1_2),
    lowpass(sampleRate, Math.min(SPEECH_BAND_HZ[1], sampleRate * 0.45), Math.SQRT1_2),
  ])
  const y = new Float32Array(x.length)
  cascade.process(x, y, x.length, 0)
  return y
}

