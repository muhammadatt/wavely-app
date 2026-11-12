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
// Worst max |err| vs. the measured curves across 44100/48000/96000 Hz: 0.281 dB.

export const PULTEC_STAGES = {
  thick: {
    pre: [
      { type: 'lowShelf', freqHz: 2441.5503, width: 2.64525, gainDb: -4.6843 },
      { type: 'peaking', freqHz: 9358.0206, width: 0.08000, gainDb: 3.1968 },
      { type: 'peaking', freqHz: 7540.3876, width: 0.64377, gainDb: 3.8125 },
      { type: 'peaking', freqHz: 20996.6501, width: 1.60762, gainDb: -1.8018 },
    ],
    post: [
      { type: 'lowShelf', freqHz: 2830.6648, width: 5.39397, gainDb: 8.9693 },
      { type: 'highShelf', freqHz: 3183.1599, width: 2.87804, gainDb: -6.8110 },
      { type: 'peaking', freqHz: 3260.1691, width: 0.18634, gainDb: -3.5216 },
      { type: 'peaking', freqHz: 21000.0000, width: 1.84286, gainDb: -0.7124 },
    ],
  },
  presence: {
    pre: [
      { type: 'lowShelf', freqHz: 1277.2913, width: 2.51105, gainDb: -4.2373 },
      { type: 'highShelf', freqHz: 1552.4790, width: 3.97918, gainDb: 1.5740 },
      { type: 'peaking', freqHz: 7322.4454, width: 0.43528, gainDb: 2.2298 },
      { type: 'peaking', freqHz: 21000.0000, width: 1.44917, gainDb: -0.9976 },
    ],
    post: [
      { type: 'lowShelf', freqHz: 2226.4171, width: 4.51613, gainDb: 6.5381 },
      { type: 'highShelf', freqHz: 13106.9514, width: 2.38455, gainDb: -2.0866 },
      { type: 'peaking', freqHz: 2448.1859, width: 0.28261, gainDb: -2.9878 },
      { type: 'peaking', freqHz: 16867.3780, width: 0.19667, gainDb: -0.9622 },
    ],
  },
}
