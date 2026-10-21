/**
 * HF Softener's UI params: defaults and the mappings to kernel params, for the
 * softener and for its Reso stage. Split out of effects/deEsser.js so
 * node can import it — the wrapper pulls Vite `?worker&url` specifiers.
 */

import { hfResoKernelParams } from './deEsserResoStage.js'
import { softenKernelParams } from './deEsserSoftenStage.js'
import { HF_SOFTENER_TUNING } from './deEsserProcessor.js'

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
  // depth (duckTo* / amountTo* in deEsserProcessor.js).
  duck: 40, // %
  amount: 20, // %, the EQ stage
  context: 50, // %, Module C depth; 0 = fixed threshold
  rotator: 'sidechain', // 'off' | 'sidechain' | 'inpath'
  release: 40, // ms, HF release outside vowels — fixed, not on the panel
  vowelRelease: true, // let go fast when a vowel starts
  // ⚠ PINNED TO SHELF and off the panel (owner's call): the EQ cuts everything
  // above the Band corner. The kernel still takes 'band' (cut the sibilance band
  // and return to flat above it), for the bench and the tests.
  shape: 'shelf', // 'shelf' | 'band'
  // Lisp guard strength, 0–100 %: no cut may take an "s" further below the
  // voice than a floor this sets (guardToFloorDb). 0 = off; 50 = −16 dB.
  guard: 100,
  band: 4500, // Hz, the EQ band's lower corner, 3000–6000 — see bandTuningFor
  // 0–100 %: the band-limited ResoTame after the softener, a macro over its
  // threshold, depth and max cut (HF_RESO_KNOTS). 0 takes the stage out of the
  // chain entirely — no latency, bit-identical to the softener alone.
  // ⚠ OFF THE PANEL since October 2026: its knob's slot went to Soften. Kept
  // (and tested) so it can come back; nothing sets it.
  resoAmount: 0,
  // 0–10: SOFTEN, the onset softener at the end of the chain
  // (deEsserSoftenStage.js — moved here from PHAT*SS). 0 takes it out of the
  // chain entirely: no latency, bit-identical to the softener alone.
  soften: 0,
  detect: 4000, // Hz, the detector's high-pass corner, 3000–8000 — see detectCompDb
  // Hz, the detector's low-pass corner, 4000–20000; 20000 is OFF (detector is high-pass only).
  detectHigh: 20000,
  air: 0, // dB of Air Band lift after the cut — Air Boost's curve, 0–6: the one value in effect
  // AUTO (HF RESTORE): while on, the measurement owns `air` — it writes the
  // knob (deEsserAutoAir.js) — and touching the knob takes over and turns it
  // off, keeping the value, as the compressors' auto makeup does. The key keeps
  // its old name (`comp`) so saved presets still read.
  comp: true,
  // 'voiced' (vowels only — never lifts the "s" or the gaps) | 'static'.
  // ⚠ PINNED TO VOICED and off the panel since the Modula redesign (owner's
  // call): STATIC hands the cut back on every "s" and lifts the room in the
  // gaps. The kernel still takes both, for the bench and the tests.
  airMode: 'voiced',
  // Measured from the whole file, not a user setting — see useDeEsser.
  levelOffset: 0, // dB, file gated RMS minus nominal
}

/**
 * The panel's AMOUNT and SPLIT are a view over the two cutting stages, Duck
 * (wide band) and EQ (split band): the Amount is shared between them, `split`
 * being the % that goes to the EQ. Duck and EQ stay the state and what presets
 * store, so nothing here changes the kernel or a saved patch.
 *
 * ⚠ THIS IS NOT THE OLD AMOUNT + SPLIT (retired in the kernel, see the dev log):
 * that divided ONE target between two serial gains, which changes nothing since
 * a gain and a filter commute. This divides two MACROS, each driving its own
 * stage, so the Split moves real threshold, ratio and depth.
 */
export function splitAmount(total, split) {
  const t = Math.min(100, Math.max(0, Number(total) || 0))
  const s = Math.min(100, Math.max(0, Number(split) || 0)) / 100
  const r = v => Math.round(v * 100) / 100
  return { duck: r(t * (1 - s)), amount: r(t * s) }
}

/** The inverse: the Amount (capped at 100) and the Split (null when both stages are 0). */
export function amountSplitOf(duck, amount) {
  const sum = (Number(duck) || 0) + (Number(amount) || 0)
  return { total: Math.min(100, sum), split: sum > 0 ? Math.round((100 * (Number(amount) || 0)) / sum) : null }
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
    bandHz: params.band ?? HF_SOFTENER_DEFAULTS.band,
    levelOffsetDb: params.levelOffset,
    detectHz: params.detect,
    detectHiHz: params.detectHigh ?? HF_SOFTENER_DEFAULTS.detectHigh,
    airDb: params.air ?? 0,
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

/** The Soften post-stage is in whenever its knob is above 0. */
export function softenOn(params) {
  return (Number(params.soften) || 0) > 0
}

/** The Soften post-stage's kernel params (the HF Limiter's kernel, shelf out). */
export function softenStageKernelParams(params) {
  return softenKernelParams(params.soften, params.levelOffset)
}
