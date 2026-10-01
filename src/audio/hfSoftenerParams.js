/**
 * HF Softener's UI params: defaults and the mappings to kernel params, for the
 * softener and for its Reso stage. Split out of effects/hfSoftener.js so
 * node can import it — the wrapper pulls Vite `?worker&url` specifiers.
 */

import { hfResoKernelParams } from './hfSoftenerResoStage.js'
import { HF_SOFTENER_TUNING } from './hfSoftenerProcessor.js'

/**
 * Guard (0–100 %) → the lisp guard's floor, dB relative to the held voice.
 * 0 is off; 1–100 run −22 → −10 in a straight line, so 50 % is the −16 that
 * shipped as the switch's ON. Measured on two real narration clips and the
 * "Fix slide" clip: −20 and below cut the same as the guard off at the default
 * Duck 40 / EQ 20 (and within 0.4 dB at Duck 80 / EQ 60), so the knob's bottom
 * joins OFF without a step; at −10 a strident "s" keeps only −2 to −5.5 dB of
 * cut and its tilt turns positive (+1 to +3 dB) — the strict end.
 */
export const GUARD_FLOOR_LOOSE_DB = -22
export const GUARD_FLOOR_STRICT_DB = -10
export function guardToFloorDb(guard) {
  const g = Math.min(100, Math.max(0, Number(guard) || 0))
  return GUARD_FLOOR_LOOSE_DB + (g / 100) * (GUARD_FLOOR_STRICT_DB - GUARD_FLOOR_LOOSE_DB)
}
/** The Guard amount, honouring the retired boolean (`lispGuard: false` = 0). */
export function guardOf(params) {
  if (params.lispGuard === false) return 0
  return params.guard ?? HF_SOFTENER_DEFAULTS.guard
}

export const HF_SOFTENER_DEFAULTS = {
  // The two cutting stages, in chain order. Duck turns the whole "s" down with
  // its shape intact; EQ then cuts the top of what the duck left — its
  // detector hears the ducked signal. Each is a macro over threshold, ratio and
  // depth (duckTo* / amountTo* in hfSoftenerProcessor.js).
  duck: 40, // %
  amount: 20, // %, the EQ stage
  context: 50, // %, Module C depth; 0 = fixed threshold
  rotator: 'sidechain', // 'off' | 'sidechain' | 'inpath'
  release: 40, // ms, HF release outside vowels — fixed, not on the panel
  vowelRelease: true, // let go fast when a vowel starts
  shape: 'band', // 'shelf' | 'band'
  // Lisp guard strength, 0–100 %: no cut may take an "s" further below the
  // voice than a floor this sets (guardToFloorDb). 0 = off; 50 = −16 dB.
  guard: 50,
  // Plosive bursts (T, K, P) — caught by timing and cut harder, guard lifted.
  plosives: true,
  band: 4500, // Hz, the EQ band's lower corner, 3000–6000 — see bandTuningFor
  // 0–100 %: the band-limited ResoTame ahead of the softener, a macro over its
  // threshold, depth and max cut (HF_RESO_KNOTS). 0 takes the stage out of the
  // chain entirely — no latency, bit-identical to the softener alone.
  resoAmount: 0,
  detect: 4000, // Hz, the detector's high-pass corner, 3000–8000 — see detectCompDb
  air: 0, // dB of Air Band lift after the cut — Air Boost's curve, 0–6, the user's own
  // HF COMP: ADDS the measured compensation to `air` (see hfSoftenerAutoAir.js).
  comp: true,
  compAir: 0, // dB, measured by useHFSoftener; never a user setting
  airMode: 'voiced', // 'voiced' (vowels only — never lifts the "s" or the gaps) | 'static'
  // Measured from the whole file, not a user setting — see useHFSoftener.
  levelOffset: 0, // dB, file gated RMS minus nominal
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  return {
    amount: params.amount / 100,
    context: params.context / 100,
    rotator: params.rotator,
    releaseMs: params.release,
    vowelRelease: params.vowelRelease,
    shape: params.shape,
    lispGuard: guardOf(params) > 0,
    lispGuardFloorDb: guardToFloorDb(guardOf(params)),
    bursts: params.plosives !== false,
    bandHz: params.band ?? HF_SOFTENER_DEFAULTS.band,
    levelOffsetDb: params.levelOffset,
    detectHz: params.detect,
    airDb: (params.air ?? 0) + (params.comp ? (params.compAir ?? 0) : 0),
    airMode: params.airMode,
    duck: (params.duck ?? 0) / 100,
  }
}

/** The Reso pre-stage is in whenever its knob is above 0. */
export function resoOn(params) {
  return (params.resoAmount ?? 0) > 0
}

/** The pre-stage's kernel params: the macro, and the lisp guard when it is on. */
export function resoKernelParams(params) {
  const g = guardOf(params)
  return hfResoKernelParams(params.resoAmount / 100, {
    lispGuard: g > 0,
    guardShiftDb: guardToFloorDb(g) - HF_SOFTENER_TUNING.lispGuardFloorDb,
  })
}
