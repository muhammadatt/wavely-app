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
  // 0–100 — from pure Odd (tanh) toward Even (quartic), over the useful part
  // of the crossfade only (ODD_EVEN_SPAN). The bench voicing is 36 (at Warmth 5).
  oddEven: 50,
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
  // The Warmth peak guard's ceiling: the selection's own peak, dBFS. The guard
  // is PINNED ON whenever Warmth is up — Warmth may add density but never the
  // peak (dsp/warmthGuard.js). Measured, never a user setting; null until
  // measured, and the guard then has no ceiling.
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
/**
 * How much of the full Odd→Even crossfade the knob covers. The whole crossfade
 * (pure tanh to pure quartic) was the knob's range at first; by ear only its
 * first quarter is useful on narration — past it the quartic mostly adds sub
 * (full Even at Warmth 10: +9.7 dB at 20–60 Hz on Southern Sunrise). So the
 * knob's travel spans that quarter: 100 is where the old scale read 25, and
 * the bench voicing (old 9) sits at 36.
 */
export const ODD_EVEN_SPAN = 0.25

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
 * Warmth's level law: LINEAR IN AMPLITUDE. What the layers add scales in
 * proportion to the knob — Warmth 5 adds half of Warmth 10 — topping out at
 * +6 dB on the layers' Amount at 10.
 *
 * ⚠ IT WAS 3 dB A STEP, AND THAT SOUNDED BACKWARDS. Even dB steps on the
 * ADDED signal are uneven steps in what you hear: at the bottom the added
 * signal sits 20+ dB under the voice and moves the sum by almost nothing, so
 * the effect crept in and then took off near the top (Southern Sunrise, body
 * 120–250 Hz: +0.5 / +1.0 / +1.9 / +3.6 / +6.3 / +8.1 dB at Warmth 1/3/5/7/9/10;
 * each step ~1.35× the last). Linear amplitude spreads the change out evenly.
 * The top (+6 at 10) is unchanged; Warmth 5 is now Amount 0, the bench voicing.
 */
export const WARMTH_TOP_DB = 6

/** The Amount (dB) a Warmth setting gives before the Odd/Even split; −∞ at 0. */
export function warmthLevelDb(warmth) {
  const w = clamp(Number(warmth) || 0, 0, WARMTH_MAX)
  return w > 0 ? WARMTH_TOP_DB + 20 * Math.log10(w / WARMTH_MAX) : -Infinity
}

/**
 * How far the quartic sits under the tanh at the voicing above, on the
 * narration it was voiced on (Southern Sunrise: −42.58 vs −25.19 dBFS added
 * rms). Added to the quartic so the full crossfade's midpoint is equal
 * loudness (a point the knob no longer reaches: see ODD_EVEN_SPAN). ⚠ It is a
 * property of that recording's low band; on other material the balance point
 * moves a few dB.
 */
export const WARMTH_EVEN_MATCH_DB = 17.4

/** Below this the crossfade has taken a layer out; switch it off instead. */
const WARMTH_LAYER_OFF_DB = SAT_AMOUNT_FLOOR_DB

/**
 * The two warmth layers' kernel params for a Warmth / Odd/Even setting.
 * Odd/Even is an equal-power crossfade, so turning it keeps the combined
 * added level, over the first ODD_EVEN_SPAN of the full Odd→Even travel; the
 * bench voicing is Warmth 8 / Odd/Even 36.
 */
export function warmthLayers(warmth, oddEven, refPeaksDb) {
  const w = clamp(Number(warmth) || 0, 0, WARMTH_MAX)
  const b = ODD_EVEN_SPAN * clamp(Number.isFinite(oddEven) ? oddEven : 50, 0, ODD_EVEN_MAX) / ODD_EVEN_MAX
  const levelDb = warmthLevelDb(w)
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
    // Pinned on with Warmth: there is no switch.
    warmthGuard: { on: warmthActive(p), ceilingDb: Number.isFinite(p.warmthCeilingDb) ? p.warmthCeilingDb : null },
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
