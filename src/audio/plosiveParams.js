/**
 * Plosive Tamer — UI params, their mapping to the kernel, and the latency.
 *
 * Lives apart from the worklet and the effect wrapper so the apply path, the
 * composable and the tests can all read it without pulling either in.
 *
 * Two stages, each off at Depth 0:
 *   POP    the low-frequency thump of a P or B — air hitting the capsule. A
 *          sudden low band, well above the voice band over it, turned down
 *          with a dynamic high-pass for as long as it lasts.
 *   BURST  the T, K and P RELEASE — a short top-end burst straight out of a
 *          stop's silent closure (ported from the De-Esser, where it rode the
 *          de-ess cut as "Plosives"). Here it drives a cut of its own.
 */

import { ALIGN_TARGET_DBFS } from './dsp/inputAlign.js'

export const PLOSIVE_DEFAULTS = {
  // POP
  popDepth: 12, // dB — the deepest the low band is taken down; 0 takes POP out
  popFreq: 120, // Hz — the corner: the band below it is what is detected and cut
  popSensitivity: 50, // 0–100 — how far the low band must jump, and stand over the voice
  popRelease: 60, // ms — how quickly the low end comes back after a pop
  // BURST
  burstDepth: 6, // dB — how far a caught T/K/P release is turned down; 0 takes BURST out
  burstFreq: 3000, // Hz — the corner: the band above it is cut
  burstSensitivity: 50, // 0–100 — how sharp an onset must be to count
  burstLength: 40, // ms — how long a caught burst is held down
  output: 0, // dB trim
  // The whole file's gated RMS, dBFS. Measured by the composable, never a
  // user setting: it is what keeps POP from waking on room rumble under a
  // quiet file and a hot one alike.
  voiceLevelDb: ALIGN_TARGET_DBFS,
}

export const POP_DEPTH_MAX_DB = 24
export const POP_FREQ_MIN_HZ = 60
export const POP_FREQ_MAX_HZ = 250
export const POP_RELEASE_MIN_MS = 15
export const POP_RELEASE_MAX_MS = 300
export const BURST_DEPTH_MAX_DB = 18
export const BURST_FREQ_MIN_HZ = 1500
export const BURST_FREQ_MAX_HZ = 8000
export const BURST_LENGTH_MIN_MS = 15
export const BURST_LENGTH_MAX_MS = 80
export const OUTPUT_MIN_DB = -12
export const OUTPUT_MAX_DB = 12

/** Voice levels outside this are clamped: a near-silent file is not a voice. */
const VOICE_LEVEL_MIN_DB = -60
const VOICE_LEVEL_MAX_DB = 0

function clamp(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n < lo ? lo : n > hi ? hi : n
}

/**
 * POP Sensitivity → the two detection thresholds, dB.
 *
 *   ratio  how far the low band must stand over the voice band above it.
 *          A vowel's low band sits under its voice band (F1 and the upper
 *          harmonics carry the energy); a pop is air, nearly all of it low.
 *   rise   how far the low band must jump in `popRiseMs` to open a pop. A
 *          deep voice's steady low end never does, however loud it is.
 *
 * Both fall in a straight line across the knob. 50 is 3 dB / 10 dB. ⚠ The
 * line is REASONED, from synthetic pops on synthetic voice; not auditioned.
 */
export function popThresholdsDb(sensitivity) {
  const s = clamp(sensitivity, 0, 100, PLOSIVE_DEFAULTS.popSensitivity)
  return { ratioDb: 12 - 0.18 * s, riseDb: 15 - 0.1 * s }
}

/**
 * BURST Sensitivity → how far the top band must rise in `burstRiseMs` to count
 * as a release. 50 is the De-Esser's 12 dB, the value it shipped and was
 * measured at; 0 is 18, 100 is 6.
 */
export function burstRiseDb(sensitivity) {
  const s = clamp(sensitivity, 0, 100, PLOSIVE_DEFAULTS.burstSensitivity)
  return 18 - 0.12 * s
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  const d = PLOSIVE_DEFAULTS
  const p = { ...d, ...params }
  const { ratioDb, riseDb } = popThresholdsDb(p.popSensitivity)
  return {
    popDepthDb: clamp(p.popDepth, 0, POP_DEPTH_MAX_DB, d.popDepth),
    popFreqHz: clamp(p.popFreq, POP_FREQ_MIN_HZ, POP_FREQ_MAX_HZ, d.popFreq),
    popRatioDb: ratioDb,
    popRiseDb: riseDb,
    popReleaseMs: clamp(p.popRelease, POP_RELEASE_MIN_MS, POP_RELEASE_MAX_MS, d.popRelease),
    burstDepthDb: clamp(p.burstDepth, 0, BURST_DEPTH_MAX_DB, d.burstDepth),
    burstFreqHz: clamp(p.burstFreq, BURST_FREQ_MIN_HZ, BURST_FREQ_MAX_HZ, d.burstFreq),
    burstRiseDb: burstRiseDb(p.burstSensitivity),
    burstLengthMs: clamp(p.burstLength, BURST_LENGTH_MIN_MS, BURST_LENGTH_MAX_MS, d.burstLength),
    voiceLevelDb: clamp(p.voiceLevelDb, VOICE_LEVEL_MIN_DB, VOICE_LEVEL_MAX_DB, ALIGN_TARGET_DBFS),
    outputGainDb: clamp(p.output, OUTPUT_MIN_DB, OUTPUT_MAX_DB, d.output),
  }
}

/** Lookahead half-width, ms. The plugin's latency is twice it. */
export const PLOSIVE_LOOKAHEAD_MS = 4

/**
 * Plugin latency, samples: the gain smoother's lookahead. CONSTANT — no
 * setting moves it, and it is the same with both stages out.
 */
export function plosiveLatencySamples(sampleRate) {
  return 2 * Math.max(1, Math.round((PLOSIVE_LOOKAHEAD_MS / 1000) * sampleRate))
}

/**
 * Pre-roll for apply, seconds. The longest memory is the held voice level the
 * closure test reads (500 ms); two seconds is four of it, so an applied region
 * starts on the state a playing preview would have had.
 */
export const PLOSIVE_PREROLL_S = 2.0
