/**
 * Tube Saturation panel params, defaults and option lists — with NO worklet
 * loader behind them.
 *
 * ⚠ THAT SEPARATION IS THE WHOLE REASON THIS FILE EXISTS, and it is the same
 * split as `la2aParams.js` and `softClipperParams.js` for the same reason. The
 * effect wrapper imports `vocalSatWorkletLoader.js`, whose `?worker&url` import
 * only resolves under Vite, so anything pulling in the wrapper cannot be
 * imported from Node — and the shipping patch is exactly what the test suite
 * needs to reach. It was moved here the first time a test tried to assert that
 * the panel's defaults do not silently disable one another.
 *
 * `effects/vocalSat.js` re-exports all of it, so existing importers are
 * unaffected.
 */

import {
  MODE_SERIES, MODE_PARALLEL, CURVE_SHAPE, CURVE_CUBIC,
  ASYM_MODE_OFFSET, ASYM_MODE_SPLIT,
} from './vocalSatProcessor.js'

export {
  MODE_SERIES, MODE_PARALLEL, CURVE_SHAPE, CURVE_CUBIC,
  ASYM_MODE_OFFSET, ASYM_MODE_SPLIT,
}

/**
 * How the asymmetry is produced. Peers: two mechanisms for the same colour,
 * with different costs, not more and less of one thing.
 */
export const VOCAL_SAT_ASYM_MODES = [
  { id: ASYM_MODE_OFFSET, label: 'OFFSET',
    title: 'Runs the curve off centre. Louder warmth, but it makes the two peak bounds unequal and pushes onsets forward' },
  { id: ASYM_MODE_SPLIT, label: 'SPLIT',
    title: 'Different knee order per polarity. Subtler warmth at no cost in onset softening. Needs the SHAPE curve' },
]

/**
 * The two curve families, for the panel's second rocker. Peers, like the
 * topology pair: a bounded-order polynomial and a rational clipping function
 * are two different things, not more and less of one thing.
 */
export const VOCAL_SAT_CURVES = [
  {
    id: CURVE_SHAPE,
    label: 'SHAPE',
    title: 'Rational curve with an adjustable knee order — Hardness applies to this one',
  },
  {
    id: CURVE_CUBIC,
    label: 'CUBIC',
    title: 'Degree-3 polynomial: third harmonic only, no high-order grit, but only while Drive keeps it in range',
  },
]

/**
 * The two topologies, for the panel's rocker.
 *
 * They are PEERS, not on/off — which is the case DeviceChoiceRocker exists for.
 * Parallel adds a saturated copy under an untouched dry path; series puts the
 * curve in the path. Neither is the absence of the other.
 */
export const VOCAL_SAT_MODES = [
  {
    id: MODE_PARALLEL,
    label: 'PARA',
    title: 'Parallel — the dry signal passes at unity and a saturated copy is added under it',
  },
  {
    id: MODE_SERIES,
    label: 'SERIES',
    title: 'Series — the curve is in the signal path, so it can absorb transients',
  },
]

// Same names and defaults the panel already used, so the UI is unchanged.
/**
 * The panel's shipping patch.
 *
 * ⚠ NOT THE SAME THING AS VOCAL_SAT_KERNEL_DEFAULTS, and the two are
 * deliberately different. Those mirror `vocal_saturation.py` and are what
 * `processVocalSatBuffer` runs with no arguments, so the parity tests and the
 * bit-identity assertions rest on them; this is the sound the plugin opens
 * with. Changing this file does not move those.
 *
 * ⚠ THIS PATCH IS AUDITIONED, NOT DERIVED. It was arrived at by ear after the
 * series/cubic/tame/auto-drive work and is a deliberate departure from the
 * parallel-add stage this plugin used to be. Measured on a 220 Hz tone it runs
 * about 1.7% THD with 0.1% of that above the 5th harmonic — gentle and
 * essentially grit-free, which is the point of it.
 *
 * ⚠ HARDNESS IS INERT AT THIS PATCH AND THAT IS NOT A MISTAKE TO FIX HERE. In
 * SPLIT mode at Asymmetry 100 the knee pair reaches the bounds — 8 and 2 —
 * whatever Hardness says, so 2, 3, 5 and 8 all measure identically (THD 1.66%,
 * H2 -36.5 dB). The value below is where the knob sits, not something the sound
 * depends on. Backing Asymmetry off makes it live again: at 60, Hardness 2 to 8
 * runs THD 1.62% down to 0.45% and H2 -36.9 to -48.6 dB. See splitKnees.
 */
export const VOCAL_SAT_DEFAULTS = {
  drive: 1,
  // 65% wet against 35% dry. In SERIES this is a real crossfade, not the add
  // the parallel topology does — see MODE_SERIES.
  wetDry: 0.65,
  asymmetry: 100,
  // SPLIT rather than OFFSET: same warmth mechanism-wise, but it keeps the
  // curve's two bounds matched, so it does not undo the onset softening the
  // rest of this patch is built around.
  asymMode: ASYM_MODE_SPLIT,
  mode: MODE_SERIES,
  emphasis: 50,
  soften: 25,
  tame: 49,
  // Just under 50, where the threshold would sit exactly on the curve's edge —
  // so this trims peaks rather than strictly holding the signal in domain.
  autoDrive: 100,
  hardness: 5,
  curve: CURVE_SHAPE,
  lowCrossover: 190,
  midCrossover: 5800,
  lowDriveMult: 3,
  midDriveMult: 3,
  highDriveMult: 2.5,
  // The medium's own bandwidth, 0-100. 0 is absent, not flat — see
  // HF_LOSS_CORNER_HZ.
  hfLoss: 0,
}

/** Map UI param names to kernel param names — 1:1 for this effect. */
export function toKernelParams(params) {
  return {
    drive: params.drive,
    wetDry: params.wetDry,
    asymmetry: params.asymmetry,
    asymMode: params.asymMode,
    mode: params.mode,
    emphasis: params.emphasis,
    soften: params.soften,
    tame: params.tame,
    autoDrive: params.autoDrive,
    hardness: params.hardness,
    curve: params.curve,
    lowCrossover: params.lowCrossover,
    midCrossover: params.midCrossover,
    lowDriveMult: params.lowDriveMult,
    midDriveMult: params.midDriveMult,
    highDriveMult: params.highDriveMult,
    hfLoss: params.hfLoss,
  }
}
