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
 * Threshold (the kernel's `selectivity`, the same control ResoTame's panel
 * calls Threshold) is on the HF Softener's panel; everything else is fixed.
 * The default was chosen by measurement on synthetic voice with a 7.5 kHz ring
 * riding the voice envelope (frame 512):
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
 * The Threshold knob's range, dB of protrusion above the local spectrum —
 * ResoTame's own range.
 *
 * On rings it decides WHICH qualify, not how deep: a ring that clears it comes
 * down ~16–19 dB at any setting, so it shows on mild rings (a faint 7.5 kHz
 * ring at 36 / 28 / 24 dB: −3.5 / −15.6 / −17.6 dB).
 *
 * On sibilance it is the HANDOVER. Synthetic voice, Amount 40 %, normal "s":
 *
 *   threshold          36     24     20     16     12      9      6      3
 *   ResoTame on "s"   0.00  −0.01  −0.41  −2.04  −5.98  −9.41 −10.25 −10.77
 *   softener on "s"  −3.25  −3.25  −3.00  −1.98  −0.37   0.00   0.00   0.00
 *   both, "s" band   −2.74  −2.75  −2.93  −3.70  −6.29  −9.41 −10.25 −10.77
 *   vowels 5–12 kHz  −0.73  −0.74  −0.74  −0.67  −0.98  −1.40  −1.49  −1.58
 *   air 13–20 kHz    −0.77  −0.77  −0.73  −0.62  −0.65  −1.01  −1.19  −1.31
 *
 * Vowels below 4 kHz: 0.00 throughout. ⚠ BELOW ~20 THE LISP GUARD NO LONGER
 * BOUNDS THE TOTAL: it caps only the softener's cut, and at 9 ResoTame alone
 * takes a normal "s" 9.4 dB where the guard stops the softener at ~6.7. The
 * cut saturates by ~6 — the "s" is noise, and only so much of it protrudes.
 */
export const HF_RESO_THRESHOLD_DEFAULT_DB = 24
export const HF_RESO_THRESHOLD_MIN_DB = 3
export const HF_RESO_THRESHOLD_MAX_DB = 36

const OFF = { enabled: false, depth: 0, sharpness: 0.8, selectivity: 20, maxCut: 12, protect: false }

/** 5–12 kHz only; the zones either side are switched off. */
export function hfResoZones(thresholdDb = HF_RESO_THRESHOLD_DEFAULT_DB) {
  const t = Number.isFinite(thresholdDb) ? thresholdDb : HF_RESO_THRESHOLD_DEFAULT_DB
  const selectivity = Math.min(HF_RESO_THRESHOLD_MAX_DB, Math.max(HF_RESO_THRESHOLD_MIN_DB, t))
  return [
    { id: 'z1', hiHz: 5000, ...OFF },
    { id: 'z2', hiHz: 12000, enabled: true, depth: 1, sharpness: 0.8, selectivity, maxCut: 24, protect: false },
    { id: 'z3', hiHz: 20000, ...OFF },
  ]
}

export const HF_RESO_ZONES = hfResoZones()

/** Kernel params for the pre-stage, ready to cross a structured clone. */
export function hfResoKernelParams(thresholdDb = HF_RESO_THRESHOLD_DEFAULT_DB) {
  return toKernelParams({ ...RESONANCE_DEFAULTS, zones: hfResoZones(thresholdDb), focus: null })
}
