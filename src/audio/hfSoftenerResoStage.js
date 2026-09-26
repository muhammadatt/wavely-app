/**
 * The HF Softener's optional ResoTame pre-stage: a band-limited, short-frame
 * resonance suppressor that runs AHEAD of the softener when its RESO switch is
 * on.
 *
 * The two stages split the work. ResoTame takes narrow peaks that stand above
 * the local spectrum — a whistly "s", a mic or room ring — which the softener
 * could only reach by cutting the whole band. The softener takes the broadband
 * episodic spike of an ordinary "s", which is not a peak and which ResoTame
 * passes. Ordered this way, a steady ring no longer lifts the softener's
 * detector and keeps it riding.
 *
 * Settings are fixed here rather than on a panel, chosen by measurement on
 * synthetic voice with a 7.5 kHz ring riding the voice envelope (frame 512):
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

const OFF = { enabled: false, depth: 0, sharpness: 0.8, selectivity: 20, maxCut: 12, protect: false }

/** 5–12 kHz only; the zones either side are switched off. */
export const HF_RESO_ZONES = [
  { id: 'z1', hiHz: 5000, ...OFF },
  { id: 'z2', hiHz: 12000, enabled: true, depth: 1, sharpness: 0.8, selectivity: 24, maxCut: 24, protect: false },
  { id: 'z3', hiHz: 20000, ...OFF },
]

/** Kernel params for the pre-stage, ready to cross a structured clone. */
export function hfResoKernelParams() {
  return toKernelParams({ ...RESONANCE_DEFAULTS, zones: HF_RESO_ZONES, focus: null })
}
