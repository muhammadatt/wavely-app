/**
 * PHAT*SS — Psycho Harmonic Analog Tape * Saturation Simulator. UI params,
 * their mapping to the kernel, and the latency.
 *
 * Chain: WARMTH (two fixed Saturation Bench layers on the low band) → its PEAK
 * GUARD (pinned on) → a tape-style HF shelf, whose Transient detector (SOFTEN)
 * cuts its own band (the HF Limiter's dynamic shelf
 * with its timing pinned and its Freq / Threshold / Range driven by two macro
 * knobs) → Output.
 *
 * Lives apart from the worklet and the effect wrapper so the apply path, the
 * composable and the tests can all read it without pulling either in.
 */

import { ALIGN_TARGET_DBFS } from './dsp/inputAlign.js'
import { shelfLatencySamples } from './dsp/hfLimit.js'
import { SAT_BENCH_LAYER_LATENCY, SAT_AMOUNT_FLOOR_DB } from './dsp/saturationLayers.js'
import { warmthGuardLatencySamples } from './dsp/warmthGuard.js'

export const PHATASS_DEFAULTS = {
  // 0–10 — low-end harmonic warmth: how much of what the two fixed
  // WARMTH_LAYERS add is mixed in. 0 is off (a pure delay).
  warmth: 5,
  // 0–100 — from pure Odd toward Even, over the useful part of the crossfade
  // only (ODD_EVEN_SPAN). The bench voicing is 36 (at Warmth 5).
  oddEven: 50,
  // SOFTEN (on/off): the HF Limiter's Transient detector on its own band
  // above SOFTEN_FREQ_HZ — it turns that band down for a few ms when it rises
  // suddenly, not when it is loud. It has no knob of its own: its depth rides
  // TAME, so the top-end shelf and the onset softening turn down together
  // (`softenLaw`). A gain on a band, never distortion, no latency of its own.
  soften: false,
  // 0–10 — how hard the tape HF shelf holds the top end: Threshold and Range
  // together (`tapeShelf`). 0 takes the shelf out. 5 is −8 dB re the voice,
  // Range 18; 10 reaches Range 36.
  tame: 5,
  // 0–10 — where the top end starts: the shelf's corner, 2 kHz (0, dark) to
  // 12 kHz (10, only the very top).
  tone: 10,
  output: 0, // dB trim
  // The whole file's gated RMS, dBFS. Measured, never a user setting — it is
  // what makes the shelf's threshold mean the same on a quiet take and a hot one.
  voiceLevelDb: ALIGN_TARGET_DBFS,
  // Each warmth layer's reference peak, dBFS (saturationBenchAnalysis
  // .bandRefPeakDb). Measured, never a user setting; null until measured.
  warmthRefPeaksDb: null,
  // The Warmth peak guard's ceiling: the selection's own peak, dBFS. The guard
  // is PINNED ON whenever Warmth is up (dsp/warmthGuard.js). Measured; null
  // until measured, and the guard then has no ceiling.
  warmthCeilingDb: null,
}

export const WARMTH_MAX = 10
export const ODD_EVEN_MAX = 100
export const TAME_MAX = 10
/** Soften's ceiling on one cut, dB per TAME step (36 at Tame 10; the HF Limiter's Transient stops at 12). */
export const SOFTEN_DB_PER_STEP = 3.6
/** dB of cut per dB of rise: the HF Limiter's 0.5 at Tame 0, 1 at Tame 10. */
export const SOFTEN_SLOPE_MIN = 0.5
export const SOFTEN_SLOPE_MAX = 1
/** Soften's corner, pinned: a one-pole split, so it reaches the voice's snap and body as well as the top. */
export const SOFTEN_FREQ_HZ = 500
/** Onsets in Soften's band this far under the voice level are left alone (the HF Limiter's default works out to 32). */
export const SOFTEN_GATE_BELOW_DB = 32
export const TONE_MAX = 10
export const OUTPUT_MIN_DB = -12
export const OUTPUT_MAX_DB = 12

/**
 * How much of the full Odd→Even crossfade the knob covers. The whole crossfade
 * (pure odd layer to pure quartic) was the knob's range at first; by ear only its
 * first quarter is useful on narration — past it the quartic mostly adds sub
 * (full Even at Warmth 10: +9.7 dB at 20–60 Hz on Southern Sunrise). So the
 * knob's travel spans that quarter: 100 is where the old scale read 25, and
 * the bench voicing (old 9) sits at 36.
 */
export const ODD_EVEN_SPAN = 0.25

/**
 * WARMTH — the low-end warmth/fatness combination voiced on the Saturation
 * Bench, as two fixed layers in series: an even curve (quartic, low band to
 * 250 Hz, +14 dB bell at 280 Hz) and an odd one (cubic, low band to 220 Hz,
 * +10 dB bell at 240 Hz), each bell pushing the body into the curve.
 * CHARACTER IS FIXED; the knobs only set how much of each is mixed in. Both
 * drives sit past the point where more drive changes much (the quartic caps at
 * ~5.7 % THD past ~+15 dB), so a level knob is the honest control — Drive
 * would mostly have been a level knob in disguise.
 *
 * Order: quartic, then cubic — as voiced. `amountDb` is set per layer by
 * `warmthLayers`, not here. ⚠ The first voicing was quartic 60 / 1–400 Hz /
 * bell 350 +24 then tanh 50 / 1–300 Hz / bell 250 +24 (kept below for
 * reference); the Southern Sunrise figures in this file were measured on it.
 */
//export const WARMTH_LAYERS = [
//  { curve: 'quartic', driveDb: 60, loHz: 1, hiHz: 400, emphType: 'bell', emphHz: 350, emphQ: 0.5, emphDb: 24, mode: 'full' },
//  { curve: 'tanh', driveDb: 50, loHz: 1, hiHz: 300, emphType: 'bell', emphHz: 250, emphQ: 0.7, emphDb: 24, mode: 'full' },
//]

export const WARMTH_LAYERS = [
  { curve: 'quartic', driveDb: 50, loHz: 1, hiHz: 250, emphType: 'bell', emphHz: 280, emphQ: 0.5, emphDb: 14, mode: 'full' },
  { curve: 'cubic', driveDb: 50, loHz: 1, hiHz: 220, emphType: 'bell', emphHz: 240, emphQ: 0.5, emphDb: 10, mode: 'full' },
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
 * How far the quartic sits under the odd layer, measured on the FIRST voicing
 * (quartic + tanh, see above) on the narration it was voiced on (Southern
 * Sunrise: −42.58 vs −25.19 dBFS added rms). Added to the quartic so the full
 * crossfade's midpoint is equal loudness (a point the knob no longer reaches:
 * see ODD_EVEN_SPAN). ⚠ The shipping quartic + cubic pair measures a 20.8 dB
 * gap on the same file, so the even side comes in ~3.4 dB later than this
 * assumes. It is also a property of that recording's low band; on other
 * material the balance point moves a few dB.
 */
export const WARMTH_EVEN_MATCH_DB = 17.4

/** Below this the crossfade has taken a layer out; switch it off instead. */
const WARMTH_LAYER_OFF_DB = SAT_AMOUNT_FLOOR_DB

/**
 * The two warmth layers' kernel params for a Warmth / Odd/Even setting.
 * Odd/Even is an equal-power crossfade, so turning it keeps the combined
 * added level, over the first ODD_EVEN_SPAN of the full Odd→Even travel; the
 * bench voicing is Warmth 5 / Odd/Even 36.
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

/**
 * The tape HF shelf's pinned timing and shape. WARM (the one-pole split, the
 * EL7 Fatso's Warmth) at 35 ms with no Tail and no Transient is the setting the
 * HF Limiter matched to a Fatso Warmth 7 bounce (0.69–0.75 dB rms of band-gain
 * error) — the tape-ish gentle tilt rather than a ceiling.
 */
export const TAPE_SHELF = { shape: 'warm', releaseMs: 35, tailMs: 0 }

/** The two macro knobs' ends. */
export const TONE_MIN_HZ = 2000
export const TONE_MAX_HZ = 12000
export const TAME_THRESHOLD_TOP_DB = 2 // Tame 0: threshold, dB re voice level
export const TAME_THRESHOLD_PER_STEP_DB = 2 // each Tame step lowers it this much
export const TAME_RANGE_PER_STEP_DB = 3.6 // and deepens the Range this much (36 at 10, Soften's top too)

/**
 * The macro: Tame sets how hard (Threshold and Range together, so the shelf
 * starts acting earlier AND may go deeper), Tone sets where (the corner, on a
 * log scale). Tame 5 / Tone 10 is −8 dB, Range 18, 12 kHz — the HF Limiter's
 * default threshold and corner, half again its Range (the HF Limiter stops at
 * 24; Tame reaches 36). Tame 0 takes the shelf out (Range 0).
 *
 * @returns {{ cornerHz: number, thresholdRelDb: number, rangeDb: number }}
 */
export function tapeShelf(tame, tone) {
  const t = clamp(Number(tame) || 0, 0, TAME_MAX)
  const s = clamp(Number.isFinite(tone) ? tone : TONE_MAX, 0, TONE_MAX)
  return {
    cornerHz: TONE_MIN_HZ * (TONE_MAX_HZ / TONE_MIN_HZ) ** (s / TONE_MAX),
    thresholdRelDb: TAME_THRESHOLD_TOP_DB - TAME_THRESHOLD_PER_STEP_DB * t,
    rangeDb: TAME_RANGE_PER_STEP_DB * t,
  }
}

/**
 * Soften's depth, from the toggle and Tame: off (or Tame 0) is no cut at all;
 * on, the ceiling is SOFTEN_DB_PER_STEP per Tame step and the slope runs
 * SOFTEN_SLOPE_MIN → MAX across Tame's travel.
 *
 * @returns {{ depthDb: number, slope: number }}
 */
export function softenLaw(on, tame) {
  const t = clamp(Number(tame) || 0, 0, TAME_MAX)
  return {
    depthDb: on ? SOFTEN_DB_PER_STEP * t : 0,
    slope: SOFTEN_SLOPE_MIN + (SOFTEN_SLOPE_MAX - SOFTEN_SLOPE_MIN) * (t / TAME_MAX),
  }
}

/** Map UI params to kernel params. */
export function toKernelParams(params) {
  const p = { ...PHATASS_DEFAULTS, ...params }
  const voice = Number.isFinite(p.voiceLevelDb)
    ? clamp(p.voiceLevelDb, VOICE_LEVEL_MIN_DB, VOICE_LEVEL_MAX_DB)
    : ALIGN_TARGET_DBFS
  const shelf = tapeShelf(p.tame, p.tone)
  const soft = softenLaw(p.soften, p.tame)
  return {
    warmthLayers: warmthLayers(p.warmth, p.oddEven, p.warmthRefPeaksDb),
    // Pinned on with Warmth: there is no switch.
    warmthGuard: { on: warmthActive(p), ceilingDb: Number.isFinite(p.warmthCeilingDb) ? p.warmthCeilingDb : null },
    cornerHz: shelf.cornerHz,
    thresholdDb: voice + shelf.thresholdRelDb,
    rangeDb: shelf.rangeDb,
    ...TAPE_SHELF,
    // Soften rides the shelf's Transient, on its own band, at Tame's depth.
    transientDb: soft.depthDb,
    transientCornerHz: SOFTEN_FREQ_HZ,
    transientSlope: soft.slope,
    transientGateDb: voice - SOFTEN_GATE_BELOW_DB,
    voiceLevelDb: voice,
    outputGainDb: clamp(Number(p.output) || 0, OUTPUT_MIN_DB, OUTPUT_MAX_DB),
  }
}

/** The Warmth stage's latency: one oversampler round trip per layer. */
export const WARMTH_LATENCY_SAMPLES = WARMTH_LAYERS.length * SAT_BENCH_LAYER_LATENCY

/**
 * Plugin latency, samples: the Warmth oversamplers, the peak guard's lookahead
 * and the shelf's split centre and lookahead (Soften shares the shelf's).
 * CONSTANT: every stage stays a delay of its own length when idle, so no
 * setting moves the audio.
 */
export function phatassLatencySamples(sampleRate) {
  return WARMTH_LATENCY_SAMPLES + warmthGuardLatencySamples(sampleRate) + shelfLatencySamples(sampleRate)
}

/** Pre-roll for apply, seconds: several of the shelf's release. */
export const PHATASS_PREROLL_S = 1.0
