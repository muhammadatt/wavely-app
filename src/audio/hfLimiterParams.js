/**
 * HF Limiter — UI params, their mapping to the kernel, and the latency.
 *
 * Lives apart from the worklet and the effect wrapper so the apply path, the
 * composable and the tests can all read it without pulling either in.
 */

import { ALIGN_TARGET_DBFS } from './dsp/inputAlign.js'
import { ACCEL_LATENCY_SAMPLES, shelfLatencySamples } from './dsp/hfLimit.js'

export const HF_LIMITER_DEFAULTS = {
  freq: 5000, // Hz — where "bright" starts, for both the detector and the cut
  threshold: -8, // dB relative to the file's voice level (gated RMS)
  range: 12, // dB — the deepest the shelf may cut; 0 takes the shelf out
  release: 60, // ms
  transient: 0, // 0–100, the acceleration limiter; 0 is out
  output: 0, // dB trim
  // The whole file's gated RMS, dBFS. Measured by the composable, never a
  // user setting — it is what makes a Threshold mean the same thing on a
  // quiet narration and a hot one (the HF Softener's `levelOffset` contract).
  voiceLevelDb: ALIGN_TARGET_DBFS,
}

export const FREQ_MIN_HZ = 2000
export const FREQ_MAX_HZ = 12000
export const THRESHOLD_MIN_DB = -30
export const THRESHOLD_MAX_DB = 12
export const RANGE_MAX_DB = 24
export const RELEASE_MIN_MS = 5
export const RELEASE_MAX_MS = 300

/**
 * How far above the shelf's threshold the acceleration limiter sits, dB, at
 * Transient 1 and at 100. It is a backstop for what the shelf's release lets
 * through and for transients too short for a gain to follow, so at the bottom
 * of its travel it only touches the sharpest edges; at the top it shares the
 * shelf's line.
 */
export const TRANSIENT_OFFSET_AT_MIN_DB = 18
export const TRANSIENT_OFFSET_AT_MAX_DB = 0

/** Voice levels outside this are clamped: a near-silent file is not a voice. */
const VOICE_LEVEL_MIN_DB = -60
const VOICE_LEVEL_MAX_DB = 0

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** Transient knob → accel threshold above the shelf's, dB. Null when out. */
export function transientOffsetDb(transient) {
  if (!(transient > 0)) return null
  const t = clamp(transient, 0, 100) / 100
  return TRANSIENT_OFFSET_AT_MIN_DB + (TRANSIENT_OFFSET_AT_MAX_DB - TRANSIENT_OFFSET_AT_MIN_DB) * t
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  const p = { ...HF_LIMITER_DEFAULTS, ...params }
  const voice = Number.isFinite(p.voiceLevelDb)
    ? clamp(p.voiceLevelDb, VOICE_LEVEL_MIN_DB, VOICE_LEVEL_MAX_DB)
    : ALIGN_TARGET_DBFS
  const thresholdDb = voice + clamp(p.threshold, THRESHOLD_MIN_DB, THRESHOLD_MAX_DB)
  const offset = transientOffsetDb(p.transient)
  return {
    cornerHz: clamp(p.freq, FREQ_MIN_HZ, FREQ_MAX_HZ),
    thresholdDb,
    rangeDb: clamp(p.range, 0, RANGE_MAX_DB),
    releaseMs: clamp(p.release, RELEASE_MIN_MS, RELEASE_MAX_MS),
    accel: offset !== null,
    accelThresholdDb: thresholdDb + (offset ?? 0),
    outputGainDb: p.output,
  }
}

/**
 * Plugin latency, samples. CONSTANT for a sample rate: the accel stage stays
 * a delay of its own length while it is out, so the Transient knob crossing 0
 * never moves the audio.
 */
export function hfLimiterLatencySamples(sampleRate) {
  return shelfLatencySamples(sampleRate) + ACCEL_LATENCY_SAMPLES
}

/**
 * Pre-roll for apply, seconds: several of the longest release, so an applied
 * region starts on the gain a playing preview would have had.
 */
export const HF_LIMITER_PREROLL_S = 1.0
