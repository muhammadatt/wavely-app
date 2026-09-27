/**
 * The HF Softener's optional ResoTame pre-stage: a band-limited, short-frame
 * resonance suppressor that runs AHEAD of the softener when its RESO switch is
 * on.
 *
 * The two stages split the work, and the Threshold knob sets where. High, it
 * takes only narrow peaks that stand far above the local spectrum — a whistly
 * "s", a mic or room ring — which the softener could only reach by cutting the
 * whole band, and leaves the broadband spike of an ordinary "s" to the
 * softener. Lowered, it takes the sibilance too, spectrally rather than as a
 * band dip, and the softener backs off by itself: its detector hears what
 * ResoTame already removed, and its lisp guard reads the same level.
 *
 * The panel's Reso knob is an amount macro over threshold, depth and max cut
 * (see HF_RESO_KNOTS). The table below is the earlier THRESHOLD-ONLY
 * measurement (depth 1, max cut 24), kept for what it showed about the two
 * stages' overlap — synthetic voice with a 7.5 kHz ring riding the voice
 * envelope (frame 512):
 *
 *   zone 5–12 kHz               ring     ordinary "s"   13–20 kHz
 *   stock (sel 20, cut 36)     −28.5 dB    −0.41 dB      −0.03 dB
 *   sel 20, cut 24             −19.5       −0.41         −0.03
 *   sel 24, cut 24  ← this     −19.5       −0.01          0.00
 *   sel 10, cut 12             −10.0       −3.32         −0.76
 *
 * ⚠ SELECTIVITY 24 IS WHAT KEEPS THE TWO STAGES FROM OVERLAPPING. Anything
 * looser starts cutting the ordinary "s" too — the softener's job — and the
 * two cuts stack on the same sibilant, which is the lisp. At 24 an ordinary
 * "s" moves 0.01 dB and only genuine peaks are touched.
 *
 * Frame 512 is the short-frame instance built for exactly this (PR #137): the
 * F0 tracker cannot run at this frame and is skipped, which is harmless above
 * 5 kHz, and it measured the same efficacy on a planted ring as frame 2048.
 * Its latency is the frame, 512 samples — 11.6 ms at 44.1 kHz.
 *
 * Dependency-light on purpose: it imports only resonanceParams.js, so tests
 * can load it under node.
 */

import { RESONANCE_DEFAULTS, toKernelParams } from './resonanceParams.js'

export const HF_RESO_FRAME_SIZE = 512
export const HF_RESO_LATENCY_SAMPLES = HF_RESO_FRAME_SIZE

/**
 * THE RESO KNOB IS AN AMOUNT MACRO, 0–1, MOVING THRESHOLD, DEPTH AND MAX CUT
 * TOGETHER — not ResoTame's Threshold. As a bare threshold it was a switch:
 * with depth 1 anything clearing it is removed entirely (∞:1), so the knob
 * decided WHETHER to cut and never HOW MUCH, and the "s" crossed from −0.4 to
 * −7.3 dB within 6 dB of travel. Reported as "goes from doing very little to
 * taking off too much top end".
 *
 * The law is a knot table, interpolated linearly, fitted by measurement on a
 * synthetic voice with realistic upper formants (energy above 3 kHz at −19.9
 * dB of the vowel — the stock test voice is low-passed and exaggerates vowel
 * losses):
 *
 *   - first half: RINGS. Depth ramps 0 → 0.8 while the threshold falls
 *     21 → 12, so 0 % is off and faint rings come in steadily;
 *   - second half: SIBILANCE. Depth holds at 0.8 and the threshold follows the
 *     INVERTED measured curve of "s" cut vs threshold, so each 10 % takes a
 *     similar bite; max cut climbs to 18 dB.
 *
 *   amount      10    20    30    40    50    60    70    80    90   100 %
 *   "s" 5–9k   0.0   0.0   0.0   0.0  −0.2  −1.5  −2.7  −4.6  −5.9  −7.5 dB
 *   faint ring −0.4  −1.2  −3.7  −6.6  −8.6 −10.3 −11.5 −12.8 −13.8 −15.1
 *   strong ring −5.9 −7.0  −8.0  −9.0 −10.0 −11.1 −12.1 −13.2 −14.3 −15.4
 *   vowels 5–12k 0.0  0.0   0.0   0.0   0.0  −0.3  −0.6  −1.0  −1.3  −1.7
 *   air 13–20k  0.0   0.0   0.0   0.0   0.0  −0.2  −0.4  −0.6  −0.7  −0.9
 *
 * ⚠ The lisp guard still does not bound this stage's cut; the macro's ceiling
 * (−7.5 dB on the "s" at 100 %) is what keeps it near the guard's floor.
 */
export const HF_RESO_KNOTS = [
  // [amount, threshold dB, depth, max cut dB]
  [0, 21, 0, 6],
  [0.5, 12, 0.8, 12],
  [0.6, 9.4, 0.8, 13.2],
  [0.8, 7.0, 0.8, 15.6],
  [0.9, 6.4, 0.8, 16.8],
  [1, 5, 0.8, 18],
]

export const HF_RESO_AMOUNT_DEFAULT = 0.3

/** Threshold, depth and max cut for a Reso amount, 0–1. */
export function hfResoMacro(amount = HF_RESO_AMOUNT_DEFAULT) {
  const a = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : HF_RESO_AMOUNT_DEFAULT
  const K = HF_RESO_KNOTS
  let i = 1
  while (i < K.length - 1 && a > K[i][0]) i++
  const [a0, t0, d0, m0] = K[i - 1]
  const [a1, t1, d1, m1] = K[i]
  const f = (a - a0) / (a1 - a0)
  return {
    selectivity: t0 + (t1 - t0) * f,
    depth: d0 + (d1 - d0) * f,
    maxCut: m0 + (m1 - m0) * f,
  }
}

const OFF = { enabled: false, depth: 0, sharpness: 0.8, selectivity: 20, maxCut: 12, protect: false }

/** 5–12 kHz only; the zones either side are switched off. */
export function hfResoZones(amount = HF_RESO_AMOUNT_DEFAULT) {
  const { selectivity, depth, maxCut } = hfResoMacro(amount)
  return [
    { id: 'z1', hiHz: 5000, ...OFF },
    { id: 'z2', hiHz: 12000, enabled: true, depth, sharpness: 0.8, selectivity, maxCut, protect: false },
    { id: 'z3', hiHz: 20000, ...OFF },
  ]
}

export const HF_RESO_ZONES = hfResoZones()

/** Kernel params for the pre-stage, ready to cross a structured clone. */
export function hfResoKernelParams(amount = HF_RESO_AMOUNT_DEFAULT) {
  return toKernelParams({ ...RESONANCE_DEFAULTS, zones: hfResoZones(amount), focus: null })
}
