/**
 * HF Limiter — UI params, their mapping to the kernel, and the latency.
 *
 * Lives apart from the worklet and the effect wrapper so the apply path, the
 * composable and the tests can all read it without pulling either in.
 */

import { ALIGN_TARGET_DBFS } from './dsp/inputAlign.js'
import { shelfLatencySamples } from './dsp/hfLimit.js'
import { SAT_BENCH_LAYER_LATENCY, SAT_AMOUNT_FLOOR_DB } from './dsp/saturationLayers.js'
import { warmthGuardLatencySamples } from './dsp/warmthGuard.js'

export const HF_LIMITER_DEFAULTS = {
  freq: 5000, // Hz — where "bright" starts, for both the detector and the cut
  threshold: -8, // dB relative to the file's voice level (gated RMS)
  range: 12, // dB — the deepest the shelf may cut; 0 takes the shelf out
  release: 60, // ms — the fast (or only) release stage
  // 'tight': a zero-phase one-octave split, a ceiling on the band above Freq.
  // 'warm': a one-pole split, the EL7 Fatso's Warmth — a 6 dB/oct tilt.
  shape: 'tight',
  tail: 0, // ms — the slow second release stage; 0 is a single-stage release
  // dB — the most the onset softener may add on top of the shelf; 0 is off.
  // It stacks: Range caps only the shelf.
  transient: 0,
  // 0–10 — low-end harmonic warmth AHEAD of the shelf: how much of what the two
  // fixed WARMTH_LAYERS add is mixed in. 0 is off (a pure delay).
  warmth: 0,
  // 0–100 — Odd (tanh) to Even (quartic). 50 is equal loudness.
  oddEven: 50,
  // Makeup for the Warmth stage: 'off' or 'loud' — take back the integrated
  // loudness Warmth adds, so the A/B is character, not level. (A 'peak'
  // mode existed until the GUARD made it redundant; a saved 'peak' reads as off.)
  warmthMakeup: 'off',
  // PEAK GUARD: turn down only what Warmth ADDS, only where the sum would
  // pass the selection's own peak (dsp/warmthGuard.js).
  warmthGuard: false,
  output: 0, // dB trim
  // The whole file's gated RMS, dBFS. Measured by the composable, never a
  // user setting — it is what makes a Threshold mean the same thing on a
  // quiet narration and a hot one (the HF Softener's `levelOffset` contract).
  voiceLevelDb: ALIGN_TARGET_DBFS,
  // Each warmth layer's reference peak, dBFS: the file's gated level in that
  // layer's band + crest (saturationBenchAnalysis.bandRefPeakDb). Measured,
  // never a user setting; null until measured, and the layers fall back to
  // the nominal point.
  warmthRefPeaksDb: null,
  // The gain LOUD applies after the Warmth stage, dB: minus the loudness
  // change the readout measured. Measured, never a user setting; ignored when OFF.
  warmthMakeupDb: 0,
  // The guard's ceiling: the selection's own peak, dBFS. Measured, never a
  // user setting; null until measured, and the guard then has no ceiling.
  warmthCeilingDb: null,
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
export const WARMTH_MAX = 10
export const ODD_EVEN_MAX = 100
export const WARMTH_MAKEUP_MODES = ['off', 'loud']
/** Makeup never moves the level further than this either way. */
export const WARMTH_MAKEUP_MAX_DB = 24

/**
 * WARMTH — the low-end warmth/fatness combination voiced on the Saturation
 * Bench, as two fixed layers in series: an even curve (quartic) and an odd one
 * (tanh), each on the low band with a +24 dB bell pushing the body into the
 * curve. CHARACTER IS FIXED; the knobs only set how much of each is mixed in.
 * Both drives are already past the point where more drive changes anything
 * (the quartic caps at ~5.7 % THD past ~+15 dB, the tanh flattens past ~+36),
 * so a level knob is the honest control — Drive would mostly have been a
 * level knob in disguise.
 *
 * Order: quartic, then tanh — as voiced. `amountDb` is set per layer by
 * `warmthLayers`, not here.
 */
export const WARMTH_LAYERS = [
  { curve: 'quartic', driveDb: 60, loHz: 1, hiHz: 400, emphType: 'bell', emphHz: 350, emphQ: 0.5, emphDb: 24, mode: 'full' },
  { curve: 'tanh', driveDb: 50, loHz: 1, hiHz: 300, emphType: 'bell', emphHz: 250, emphQ: 0.7, emphDb: 24, mode: 'full' },
]

/**
 * Warmth's level law: dB on what the layers add, 3 dB per step, +6 at 10. So
 * Warmth 8 with Odd/Even 0 is the tanh layer exactly as voiced (Amount 0).
 */
export const WARMTH_TOP_DB = 6
export const WARMTH_DB_PER_STEP = 3

/**
 * How far the quartic sits under the tanh at the voicing above, on the
 * narration it was voiced on (Southern Sunrise: −42.58 vs −25.19 dBFS added
 * rms). Added to the quartic so Odd/Even 50 is equal loudness. ⚠ It is a
 * property of that recording's low band; on other material the balance point
 * moves a few dB, which the knob absorbs.
 */
export const WARMTH_EVEN_MATCH_DB = 17.4

/** Below this the crossfade has taken a layer out; switch it off instead. */
const WARMTH_LAYER_OFF_DB = SAT_AMOUNT_FLOOR_DB

/**
 * The two warmth layers' kernel params for a Warmth / Odd/Even setting.
 * Odd/Even is an equal-power crossfade, so turning it keeps the combined
 * added level; the bench voicing is Warmth 8 / Odd/Even 9.
 */
export function warmthLayers(warmth, oddEven, refPeaksDb) {
  const w = clamp(Number(warmth) || 0, 0, WARMTH_MAX)
  const b = clamp(Number.isFinite(oddEven) ? oddEven : 50, 0, ODD_EVEN_MAX) / ODD_EVEN_MAX
  const levelDb = WARMTH_TOP_DB - WARMTH_DB_PER_STEP * (WARMTH_MAX - w)
  const gains = [Math.sin((b * Math.PI) / 2), Math.cos((b * Math.PI) / 2)] // even (quartic), odd (tanh)
  const offsets = [WARMTH_EVEN_MATCH_DB, 0]
  return WARMTH_LAYERS.map((l, k) => {
    const amountDb = levelDb + offsets[k] + 20 * Math.log10(Math.max(gains[k], 1e-12))
    const on = w > 0 && amountDb > WARMTH_LAYER_OFF_DB
    const ref = Array.isArray(refPeaksDb) && Number.isFinite(refPeaksDb[k]) ? refPeaksDb[k] : undefined
    return { ...l, on, amountDb: on ? amountDb : 0, ...(ref === undefined ? {} : { refPeakDb: ref }) }
  })
}

/** True when the Warmth stage is on. */
export function warmthActive(p) {
  return Number(p?.warmth) > 0
}
/** True when LOUD makeup is selected. */
export function warmthMakeupOn(p) {
  return p?.warmthMakeup === 'loud'
}

/** The makeup gain the kernel applies after the Warmth stage, dB: 0 unless a mode is on and a layer is up. */
export function warmthMakeupDb(p) {
  if (!warmthMakeupOn(p) || !warmthActive(p) || !Number.isFinite(p.warmthMakeupDb)) return 0
  return clamp(p.warmthMakeupDb, -WARMTH_MAKEUP_MAX_DB, WARMTH_MAKEUP_MAX_DB)
}

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
    warmthLayers: warmthLayers(p.warmth, p.oddEven, p.warmthRefPeaksDb),
    warmthMakeupDb: warmthMakeupDb(p),
    warmthGuard: { on: !!p.warmthGuard && warmthActive(p), ceilingDb: Number.isFinite(p.warmthCeilingDb) ? p.warmthCeilingDb : null },
    outputGainDb: p.output,
  }
}

/** The Warmth stage's latency: one oversampler round trip per layer. */
export const WARMTH_LATENCY_SAMPLES = WARMTH_LAYERS.length * SAT_BENCH_LAYER_LATENCY

/**
 * Plugin latency, samples: the Warmth stage's oversamplers, the peak guard's
 * lookahead, and the shelf's split centre and lookahead. CONSTANT: Warmth and
 * the guard stay delays of their own length when off, so no setting moves the
 * audio.
 */
export function hfLimiterLatencySamples(sampleRate) {
  return WARMTH_LATENCY_SAMPLES + warmthGuardLatencySamples(sampleRate) + shelfLatencySamples(sampleRate)
}

/**
 * Pre-roll for apply, seconds: several of the longest release (the Tail's
 * 600 ms included), so an applied region starts on the gain a playing preview
 * would have had.
 */
export const HF_LIMITER_PREROLL_S = 3.0
