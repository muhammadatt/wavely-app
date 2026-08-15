/**
 * Pultec EQP-1A stage curves for the Scheps vocal chain.
 *
 * Dependency-free apart from ./biquad.js — imported by an AudioWorklet kernel.
 *
 * Andrew Scheps' vocal trick is two passive EQs around an opto compressor: the
 * pre stage attenuates the lows and lifts around 8 kHz, so the LA-2A's
 * sidechain sees a signal with the low end already out of it (which is the
 * whole point — the cell then rides the presence and the body rather than
 * ducking on every plosive), and the post stage roughly reverses both moves.
 * "Roughly" is load-bearing: the reversal is not exact, and what does not
 * cancel is the sound.
 *
 * Each stage here is ONE fitted cascade covering both of its bands, not a band
 * per filter. The measured data (`data/pultec_curves/*.csv`) is a per-stage
 * response — the two bands of a passive EQP-1A interact through a shared
 * inductor network, so they were measured together and are reproduced together.
 * That also means the pre stage's low cut and the post stage's low boost are
 * fitted independently rather than being one definition with a flipped sign;
 * on the hardware they are not mirror images, and the CSVs show it (Thick:
 * -4.64 dB at 100 Hz against +8.65 dB back).
 *
 * The constants below are generated. See scripts/fit-pultec-curves.mjs for the
 * topology, the joint 44.1/48/96 kHz objective and the measured fit error.
 */

import { peaking, lowShelf, highShelf } from './biquad.js'

/** Character ids, in panel order. */
export const PULTEC_CHARACTERS = ['thick', 'presence']

/**
 * Coefficients for one stage of one character.
 *
 * @param {number} sampleRate
 * @param {'thick'|'presence'} character
 * @param {'pre'|'post'} stage
 */
export function pultecSections(sampleRate, character, stage) {
  const spec = PULTEC_STAGES[character]?.[stage]
  if (!spec) throw new Error(`unknown Pultec stage: ${character}/${stage}`)
  return spec.map((s) => {
    if (s.type === 'lowShelf') return lowShelf(sampleRate, s.freqHz, s.width, s.gainDb, 'octaves')
    if (s.type === 'highShelf') return highShelf(sampleRate, s.freqHz, s.width, s.gainDb, 'octaves')
    return peaking(sampleRate, s.freqHz, s.width, s.gainDb, 'q')
  })
}

/**
 * Sections for the wet path's whole EQ, pre then post, for the curve display.
 *
 * Cascading the two is exactly what the kernel does — the compressor between
 * them is not a filter — so this is the net curve the wet signal actually gets,
 * not a redrawn approximation of it.
 */
export function pultecNetSections(sampleRate, character) {
  return [
    ...pultecSections(sampleRate, character, 'pre'),
    ...pultecSections(sampleRate, character, 'post'),
  ]
}

// ── fitted sections (generated) ─────────────────────────────────────────────
//
// Regenerate with:  node scripts/fit-pultec-curves.mjs --write
// Worst max |err| vs. the measured curves across 44100/48000/96000 Hz: 0.666 dB.

export const PULTEC_STAGES = {
  thick: {
    pre: [
      { type: 'lowShelf', freqHz: 3921.7863, width: 1.80589, gainDb: -4.7471 },
      { type: 'highShelf', freqHz: 12682.3844, width: 1.05974, gainDb: -2.9924 },
      { type: 'peaking', freqHz: 10810.1574, width: 0.08927, gainDb: 6.4728 },
    ],
    post: [
      { type: 'lowShelf', freqHz: 546.1806, width: 2.56309, gainDb: 8.9667 },
      { type: 'highShelf', freqHz: 10470.3306, width: 2.86958, gainDb: -5.6734 },
      { type: 'peaking', freqHz: 2316.7020, width: 0.77929, gainDb: -0.5314 },
      { type: 'peaking', freqHz: 14599.0204, width: 0.19211, gainDb: -2.7178 },
    ],
  },
  presence: {
    pre: [
      { type: 'lowShelf', freqHz: 1339.0123, width: 2.78873, gainDb: -4.2304 },
      { type: 'highShelf', freqHz: 4334.5142, width: 1.71543, gainDb: 1.6067 },
      { type: 'peaking', freqHz: 4805.7734, width: 0.26493, gainDb: 2.2580 },
      { type: 'peaking', freqHz: 21000.0000, width: 1.39524, gainDb: -1.0757 },
    ],
    post: [
      { type: 'lowShelf', freqHz: 1295.9232, width: 3.30783, gainDb: 6.5377 },
      { type: 'highShelf', freqHz: 5103.3577, width: 3.39739, gainDb: -3.7401 },
      { type: 'peaking', freqHz: 1208.6685, width: 0.41627, gainDb: -1.6866 },
      { type: 'peaking', freqHz: 20866.0249, width: 1.80577, gainDb: -0.6597 },
    ],
  },
}
