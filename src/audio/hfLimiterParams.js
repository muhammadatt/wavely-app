/**
 * HF Limiter — UI params, their mapping to the kernel, and the latency.
 *
 * Lives apart from the worklet and the effect wrapper so the apply path, the
 * composable and the tests can all read it without pulling either in.
 */

import { ALIGN_TARGET_DBFS } from './dsp/inputAlign.js'
import { shelfLatencySamples } from './dsp/hfLimit.js'

export const HF_LIMITER_DEFAULTS = {
  freq: 12000, // Hz — where "bright" starts, for both the detector and the cut
  threshold: -8, // dB relative to the file's voice level (gated RMS)
  range: 12, // dB — the deepest the shelf may cut; 0 takes the shelf out
  release: 60, // ms — the fast (or only) release stage
  // 'tight': a zero-phase one-octave split, a ceiling on the band above Freq.
  // 'warm': a one-pole split, the EL7 Fatso's Warmth — a 6 dB/oct tilt.
  shape: 'warm',
  tail: 0, // ms — the slow second release stage; 0 is a single-stage release
  // dB — the most the onset softener may add on top of the shelf; 0 is off.
  // It stacks: Range caps only the shelf.
  transient: 0,
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
export const TAIL_MIN_MS = 40
export const TAIL_MAX_MS = 600

export const TRANSIENT_MAX_DB = 12
/** Voice levels outside this are clamped: a near-silent file is not a voice. */
const VOICE_LEVEL_MIN_DB = -60
const VOICE_LEVEL_MAX_DB = 0

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  const p = { ...HF_LIMITER_DEFAULTS, ...params }
  const voice = Number.isFinite(p.voiceLevelDb)
    ? clamp(p.voiceLevelDb, VOICE_LEVEL_MIN_DB, VOICE_LEVEL_MAX_DB)
    : ALIGN_TARGET_DBFS
  const thresholdDb = voice + clamp(p.threshold, THRESHOLD_MIN_DB, THRESHOLD_MAX_DB)
  return {
    cornerHz: clamp(p.freq, FREQ_MIN_HZ, FREQ_MAX_HZ),
    thresholdDb,
    rangeDb: clamp(p.range, 0, RANGE_MAX_DB),
    releaseMs: clamp(p.release, RELEASE_MIN_MS, RELEASE_MAX_MS),
    shape: p.shape === 'warm' ? 'warm' : 'tight',
    // Below its minimum the Tail knob reads OFF, so it is off rather than clamped up.
    tailMs: p.tail >= TAIL_MIN_MS ? Math.min(p.tail, TAIL_MAX_MS) : 0,
    transientDb: clamp(p.transient > 0 ? p.transient : 0, 0, TRANSIENT_MAX_DB),
    outputGainDb: p.output,
  }
}

/**
 * Plugin latency, samples: the shelf's split centre and lookahead. CONSTANT,
 * so no setting moves the audio. (The Warmth stage that once sat ahead of the
 * shelf moved to PHAT*SS, phatssParams.js.)
 */
export function hfLimiterLatencySamples(sampleRate) {
  return shelfLatencySamples(sampleRate)
}

/**
 * Pre-roll for apply, seconds: several of the longest release (the Tail's
 * 600 ms included), so an applied region starts on the gain a playing preview
 * would have had.
 */
export const HF_LIMITER_PREROLL_S = 3.0
