/**
 * The HF Softener's optional ResoTame pre-stage: a band-limited, short-frame
 * resonance suppressor that runs AHEAD of the softener when its RESO switch is
 * on.
 *
 * The two stages split the work, and the Reso knob sets where. Low, it
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
 * decided WHETHER to cut and never HOW MUCH. Reported as "goes from doing
 * very little to taking off too much top end".
 *
 * ⚠⚠ AND IT RAN ON ResoTame's 200/500 ms BALLISTICS, WHICH MADE IT A SLOW EQ.
 * An "s" is 30–40 ms: at a 200 ms attack an isolated one reached −1.6 dB at
 * 100 %, and the −7.5 the table used to print was reduction BUILT ON THE
 * VOWELS and carried into the "s" by the 500 ms release — so the "s" cut and
 * the vowel cost were one quantity. On a real narrator whose vowels plateau
 * to 10 kHz and then roll off steeply it cost 6.8 dB of vowel 8–12 kHz at
 * 100 % (1.2 at 30 %). Now: 15/25 ms (see HF_RESO_RELEASE_MS), so an "s" is
 * cut by its own frames (isolated: −4.3), and VOICED FRAMES HOLD THE MACRO'S
 * 0 % THRESHOLD (`voicedSelectivityFloorDb` = 21): on vowels the knob moves
 * only depth and max cut — rings — and the falling threshold reaches only
 * unvoiced frames, which is where the sibilance is.
 *
 * ⚠ What the floor gives up is FAINT rings inside vowels (synthetic, 100 %:
 * −15.1 → −7.7 dB). A single frame cannot tell a ring at the level of the
 * vowel's own top end from a vowel spectrum that bends there; a strong ring
 * is still taken in full (−17.0).
 *
 * The knots are the previous law WARPED so the "s" comes down in even steps
 * on REAL narration — two clips, David Greenberg and "Messy and Bright",
 * averaged (the synthetic voice's "s" no longer tracks real sibilance once
 * the carryover is gone). Measured before the warp at these ballistics:
 *
 *   old amount     30    50    60    70    80    90   100 %
 *   DG vowels   −0.8  −1.4  −1.9  −2.1  −2.3  −2.4  −2.7 dB (8–12 kHz)
 *   DG "s"      −0.8  −2.4  −3.7  −4.4  −5.0  −5.3  −5.9
 *   M&B vowels  −0.1  −0.4  −0.6  −0.7  −0.9  −0.9  −1.1
 *   M&B "s"     −1.1  −3.3  −4.9  −5.6  −6.3  −6.7  −7.3
 *   (was, at 100 %: DG vowels −6.8 / "s" −4.5, M&B −4.3 / −5.3)
 *
 * ⚠ The lisp guard still does not bound this stage's cut; the macro's ceiling
 * is what keeps it near the guard's floor.
 */
export const HF_RESO_KNOTS = [
  // [amount, threshold dB, depth, max cut dB]
  [0, 21, 0, 6],
  [0.1, 16.55, 0.396, 8.97],
  [0.2, 14.71, 0.559, 10.19],
  [0.3, 13.36, 0.679, 11.09],
  [0.4, 12.33, 0.771, 11.78],
  [0.5, 11.19, 0.8, 12.37],
  [0.6, 10.01, 0.8, 12.92],
  [0.7, 8.85, 0.8, 13.75],
  [0.8, 7.68, 0.8, 14.92],
  [0.9, 6.5, 0.8, 16.59],
  [1, 5, 0.8, 18],
]

/**
 * Ballistics: an "s" has to be cut by its own frames. ResoTame is slow to keep
 * gain movement off the low harmonics, where it reads as pitch; nothing that
 * low reaches a 5–12 kHz zone. Release measured at Reso 100 %, two real clips:
 * 80 → 25 ms takes the vowel just after an "s" from −3.76 / −3.44 dB to
 * −1.98 / −1.17 (8–12 kHz), costs the "s" 0.15 / 0.20 dB, and frame-to-frame
 * gain flutter on vowels FALLS (0.90 → 0.83 dB) rather than rising. 25 ms is
 * ResoTame's own knob minimum (RESONANCE_RELEASE_MIN_MS); at frame 512 the hop
 * is ~2.9 ms, so it is well resolved.
 */
export const HF_RESO_ATTACK_MS = 15
export const HF_RESO_RELEASE_MS = 25

/** Voiced frames never go below the macro's 0 % threshold. */
export const HF_RESO_VOICED_FLOOR_DB = HF_RESO_KNOTS[0][1]

export const HF_RESO_AMOUNT_DEFAULT = 0.2

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
/**
 * The lisp guard's floor in THIS stage's units: frame energy 4.5–12 kHz
 * against the held 200 Hz–3 kHz energy. The softener's floor (−16) is in ITS
 * units (a 4 kHz peak follower against the same held voice), and on the "s"
 * frames of two real narration clips this stage's measure read 1.0 / 1.9 dB
 * lower (median; the synthetic voice disagrees at +3.4) — so −17.5 puts the
 * two guards on the same level and the TOTAL cut, Reso + softener, stops
 * where the softener alone would have.
 */
export const HF_RESO_LISP_GUARD_FLOOR_DB = -17.5

/**
 * The lisp guard's other half here: on a frame whose 5–10 kHz leads its 2–4
 * kHz — a peaked /s/ — no cut may go deeper than HF_RESO_FRICATIVE_CAP_DB,
 * sliding from the zone's Max Cut toward it between these tilts (dB). The softener's lisp
 * guard uses the same tilt and thresholds (`tiltFlatDb` / `tiltPeakedDb`),
 * pinned equal by a test. See `peakedFricativeCapDb` in resonanceProcessor.js.
 */
export const HF_RESO_FRICATIVE_TILT_DB = [3, 10]
export const HF_RESO_FRICATIVE_CAP_DB = 6

export function hfResoKernelParams(amount = HF_RESO_AMOUNT_DEFAULT, { lispGuard = true, fricCapDb = HF_RESO_FRICATIVE_CAP_DB } = {}) {
  return {
    ...toKernelParams({
      ...RESONANCE_DEFAULTS,
      attack: HF_RESO_ATTACK_MS,
      release: HF_RESO_RELEASE_MS,
      zones: hfResoZones(amount),
      focus: null,
    }),
    voicedSelectivityFloorDb: HF_RESO_VOICED_FLOOR_DB,
    // ⚠ EXPLICIT NULLS WHEN OFF, NOT ABSENT KEYS: the kernel MERGES a params
    // message into what it has, so an omitted key keeps its old value and the
    // panel's Lisp Guard switch could turn the guard on but never off again.
    lispGuardFloorDb: lispGuard ? HF_RESO_LISP_GUARD_FLOOR_DB : null,
    peakedFricativeTiltDb: HF_RESO_FRICATIVE_TILT_DB,
    peakedFricativeCapDb: lispGuard ? fricCapDb : null,
  }
}
