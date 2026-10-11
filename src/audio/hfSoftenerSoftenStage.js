/**
 * The HF Softener's optional SOFTEN stage: an onset softener on the band above
 * 500 Hz, last in the chain (Duck → EQ → Air → [Reso] → Soften), in the chain
 * whenever its knob is above 0. When the band rises SUDDENLY — a click, a lip
 * smack, a hard T or K, the snap of an onset — it is turned down for a few
 * milliseconds; steady sound is left alone. A gain on a band, never distortion.
 *
 * ⚠ IT MOVED HERE FROM PHAT*SS (October 2026, owner's call, taking the panel
 * slot of the Reso knob). The LAW IS UNCHANGED (`softenLaw`, the same numbers,
 * the same 500 Hz corner and the same 32 dB gate under the voice level), so
 * Soften s here renders what PHAT*SS's Soften s did with the rest of PHAT*SS
 * out. Its history — the broadband onset softener it replaced, the knobs it
 * lost — is PHAT*SS's, in docs/claude-dev-log.md.
 *
 * IT RUNS ON THE HF LIMITER'S WORKLET, not its own: the detector is the HF
 * Limiter's Transient (`ShelfLimiterStage`: fast and slow followers, rise over
 * a 3 dB floor, its own lookahead smoother) given its own one-pole band with
 * `transientCornerHz`, with the shelf itself OUT (Range 0, g = 1). So the
 * stage brings the HF Limiter's constant latency — the shelf's 3 ms, which the
 * lookahead needs to have the cut in place when an onset arrives — and that is
 * why it is a post-stage like Reso rather than part of the zero-latency
 * softener kernel. The apply path trims it with the rest.
 *
 * Dependency-light on purpose (node can import it).
 */

import { shelfLatencySamples } from './dsp/hfLimit.js'

/** Top of the Soften knob. */
export const SOFTEN_MAX = 10
/** Soften's ceiling on one cut, dB per step (36 at 10; the HF Limiter's own Transient stops at 12). */
export const SOFTEN_DB_PER_STEP = 3.6
/** dB of cut per dB of rise: the HF Limiter's 0.5 at the bottom of the knob, 1 at the top. */
export const SOFTEN_SLOPE_MIN = 0.5
export const SOFTEN_SLOPE_MAX = 1
/** Soften's corner, pinned: a one-pole split, so it reaches the voice's snap and body as well as the top. */
export const SOFTEN_FREQ_HZ = 500
/** Onsets in Soften's band this far under the voice level are left alone. */
export const SOFTEN_GATE_BELOW_DB = 32
/** The voice level a zero level offset stands for (the softener's nominal). */
export const SOFTEN_NOMINAL_DBFS = -20

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Soften's depth from its knob (0–SOFTEN_MAX): 0 is no cut at all; the
 * ceiling is SOFTEN_DB_PER_STEP per step and the slope runs SOFTEN_SLOPE_MIN →
 * MAX across the travel.
 *
 * @returns {{ depthDb: number, slope: number }}
 */
export function softenLaw(amount) {
  const t = clamp(Number(amount) || 0, 0, SOFTEN_MAX)
  return {
    depthDb: SOFTEN_DB_PER_STEP * t,
    slope: SOFTEN_SLOPE_MIN + (SOFTEN_SLOPE_MAX - SOFTEN_SLOPE_MIN) * (t / SOFTEN_MAX),
  }
}

/**
 * The HF Limiter kernel params that make it the Soften stage: shelf out, the
 * Transient on its own 500 Hz band at Soften's depth and slope, gated under
 * the file's voice level (`levelOffsetDb` is the softener's: gated RMS − −20).
 */
export function softenKernelParams(amount, levelOffsetDb = 0) {
  const soft = softenLaw(amount)
  const voice = SOFTEN_NOMINAL_DBFS + (Number(levelOffsetDb) || 0)
  return {
    cornerHz: 2000, // the shelf's — out, so it does not matter
    thresholdDb: voice,
    rangeDb: 0, // the shelf out: g = 1 throughout
    releaseMs: 35,
    shape: 'warm',
    tailMs: 0,
    transientDb: soft.depthDb,
    transientCornerHz: SOFTEN_FREQ_HZ,
    transientSlope: soft.slope,
    transientGateDb: voice - SOFTEN_GATE_BELOW_DB,
    outputGainDb: 0,
  }
}

/** The stage's latency, samples: the HF Limiter's, constant per sample rate. */
export function softenLatencySamples(sampleRate) {
  return shelfLatencySamples(sampleRate)
}
