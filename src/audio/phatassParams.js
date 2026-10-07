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
import {
  SAT_BENCH_LAYER_LATENCY, SAT_BENCH_MAX_LAYERS, SAT_AMOUNT_FLOOR_DB, SAT_BAND_MIN_HZ, SAT_BAND_MAX_HZ, SAT_DRIVE_MIN_DB, SAT_DRIVE_MAX_DB,
} from './dsp/saturationLayers.js'
import { unitDriveU } from './dsp/shaperCurves.js'
import { warmthGuardLatencySamples } from './dsp/warmthGuard.js'

export const PHATASS_DEFAULTS = {
  // 0–10 — low-end harmonic warmth: how much of what the two fixed
  // WARMTH_LAYERS add is mixed in. 0 is off (a pure delay).
  warmth: 5,
  // 0–100 — from pure Odd toward Even, over the useful part of the crossfade
  // only (ODD_EVEN_SPAN). The bench voicing is 36 (at Warmth 5).
  oddEven: 50,
  // 0–SOFTEN_MAX — SOFTEN: the HF Limiter's Transient detector on its own band
  // above SOFTEN_FREQ_HZ — it turns that band down for a few ms when it rises
  // suddenly, not when it is loud. Its own knob since October 2026 (it rode
  // TAME before); 0 is off. `softenLaw` maps it exactly as it mapped Tame, so
  // Soften 5 is what Soften ON at Tame 5 was. A gain on a band, never
  // distortion, no latency of its own.
  soften: 0,
  // 0–TAPE_MAX_DB — TAPE: how many dB a full-band soft clipper takes off
  // the selection's own peak (`tapeLayer`). 0 is off (a pure delay).
  tape: 0,
  // TAPE's curve (`TAPE_CURVES`): 'cubic' (the Studer fit; a hard clip past
  // 3.52 dB), 'tanh' or 'algebraic' (both never flat; algebraic bends earliest).
  tapeCurve: 'cubic',
  // Where TAPE sits: 'first' (default — TAPE → makeup → Warmth, so Warmth
  // shapes the rounded signal) or 'last' (Warmth → guard → TAPE → makeup, the
  // order before October 2026, kept to audition). See `TAPE_ORDERS`.
  tapeOrder: 'first',
  // TAPE's makeup, dB: what it MEASURED off the selection's peak, given back
  // so the peak returns to where it started (`measureTapeMakeup`). Measured,
  // never a user setting; applied only while TAPE is up.
  tapeMakeupDb: 0,
  // 0–10 — how hard the tape HF shelf holds the top end: Threshold and Range
  // together, on the chosen `curve` (`tapeShelf`). 0 takes the shelf out. On
  // the default 'voice' curve 5 is −4 dB re the voice, Range 12; 10 is −14,
  // Range 27.
  tame: 5,
  // Tame's law (`tapeShelf`). 'voice' and 'fatso' both pin the corner at 2 kHz:
  // 'fatso' is fitted to the EL7 Fatso's Warmth knob on music, 'voice' is the
  // same shape 6 dB lower with the Range opening sooner, voiced on narration.
  // 'original' is the DEPRECATED Tame/Tone law — off the panel, kept so a
  // render can still reach it.
  curve: 'voice',
  // 0–10 — the 'original' curve's corner only: 2 kHz (0) to 12 kHz (10).
  // Not on the panel; the 2 kHz curves ignore it.
  tone: 10,
  // Where the shelf LISTENS: '2k' is the band it cuts; '4k' gives the detector
  // its own split at 4 kHz (threshold DETECT_4K_COMP_DB lower), so sibilance
  // triggers it before vowel brightness. The cut stays at 2 kHz either way.
  // Defaults to the VOICE curve's pair (CURVE_DETECT).
  detect: '4k',
  output: 0, // dB trim
  // The whole file's gated RMS, dBFS. Measured, never a user setting — it is
  // what makes the shelf's threshold mean the same on a quiet take and a hot one.
  voiceLevelDb: ALIGN_TARGET_DBFS,
  // Each warmth layer's reference peak, dBFS (saturationBenchAnalysis
  // .bandRefPeakDb). Measured, never a user setting; null until measured.
  warmthRefPeaksDb: null,
  // The selection's own peak, dBFS: the Warmth peak guard's ceiling (pinned on
  // whenever Warmth is up, dsp/warmthGuard.js) and the peak TAPE is calibrated
  // on. Measured; null until measured — the guard then has no ceiling and TAPE
  // assumes one (`TAPE_FALLBACK_CREST_DB`).
  warmthCeilingDb: null,
}

export const WARMTH_MAX = 10
export const ODD_EVEN_MAX = 100
export const TAME_MAX = 10
/** Top of the Soften knob. */
export const SOFTEN_MAX = 10
/** Soften's ceiling on one cut, dB per Soften step (36 at 10; the HF Limiter's Transient stops at 12). */
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
 *
 * UP TO `WARMTH_MAX_LAYERS` (4, the bench kernel's slots), in series. Each is a
 * Saturation Bench layer — `curve`, `driveDb`, `loHz` / `hiHz`, `emph*` mean
 * exactly what they do on the bench, and Drive is calibrated the same way, on
 * this file's own band level — plus a `blend` ROLE:
 *   'even' / 'odd' — the Odd/Even crossfade's two sides (the quartic sits
 *                    `WARMTH_EVEN_MATCH_DB` up, as voiced);
 *   'fixed'        — follows Warmth's level only; Odd/Even does not touch it.
 * and an optional `amountOffsetDb` (default 0) added to the Amount the law
 * gives. For a FIXED layer the Amount is `warmthLevelDb(Warmth) + amountOffsetDb`,
 * and `warmthLevelDb(5)` is −0.02 dB (6 + 20·log10 ½; the top is 6, not 6.02) —
 * so a layer voiced on the bench at Amount A goes in as `amountOffsetDb: A` and
 * lands within 0.02 dB of it at Warmth 5. (Named apart from the
 * bench kernel's own `levelOffsetDb`, which is its voicing detector's level.)
 *
 * ⚠ ALWAYS FULL: PHAT*SS has no VOICED mode. `warmthLayers` forces `mode: 'full'`
 * (the bench's default is VOICED) and `checkWarmthLayers` rejects a layer that
 * asks for 'voiced', so a layer copied from the bench cannot bring it along.
 *
 * Every layer gets its own measured reference peak and, by default, its own 4x
 * oversampler and 50 samples of latency (`WARMTH_LATENCY_SAMPLES` follows the
 * list). `oversample: false` runs a layer at the base rate instead — no
 * oversampler, no latency. ⚠ LOW BANDS ONLY: what a layer adds is band-passed
 * again, so a curve's aliases only matter where they land inside its own band.
 * Measured (1x against 4x, re what the layer adds): the 1–250 Hz quartic and
 * 1–220 Hz cubic at drive +50 −84.5 to −90.6 dB on two narrations, −109.5 /
 * −121.8 on music — the same render; the full-band quartic −34.0 and the
 * 3–20 kHz tanh −17.5 on bright narration, which keep theirs. Each oversampled
 * layer is ~1 % of a core for live preview (6 s per 10 min of audio offline).
 */
//export const WARMTH_LAYERS = [
//  { curve: 'quartic', driveDb: 60, loHz: 1, hiHz: 400, emphType: 'bell', emphHz: 350, emphQ: 0.5, emphDb: 24, mode: 'full' },
//  { curve: 'tanh', driveDb: 50, loHz: 1, hiHz: 300, emphType: 'bell', emphHz: 250, emphQ: 0.7, emphDb: 24, mode: 'full' },
//]

export const WARMTH_LAYERS = [
  { blend: 'even', curve: 'quartic', driveDb: 50, loHz: 1, hiHz: 250, emphType: 'bell', emphHz: 280, emphQ: 0.5, emphDb: 14, oversample: false },
  { blend: 'odd', curve: 'cubic', driveDb: 50, loHz: 1, hiHz: 220, emphType: 'bell', emphHz: 240, emphQ: 0.5, emphDb: 10, oversample: false },
  // Fixed layers (bench Amount A → amountOffsetDb A). Full band / high band: oversampled.
  { blend: 'fixed', amountOffsetDb: 0, curve: 'quartic', driveDb: 0, loHz: 1, hiHz: 20000, emphType: 'hishelf', emphHz: 2400, emphQ: 0.7, emphDb: -10 },
  { blend: 'fixed', amountOffsetDb: -6, curve: 'tanh', driveDb: 27, loHz: 3000, hiHz: 20000, emphType: 'hishelf', emphHz: 2400, emphQ: 0.7, emphDb: -20 },
]

/** Per-slot oversampling for a layer list, as `SaturationBenchKernel` takes it. */
export function slotOversample(layers = WARMTH_LAYERS) {
  return layers.map(l => l.oversample !== false)
}

export const WARMTH_MAX_LAYERS = SAT_BENCH_MAX_LAYERS
export const WARMTH_BLENDS = ['even', 'odd', 'fixed']
/**
 * Highest band top a layer may run at the base rate (`oversample: false`).
 * Measured clean at 220–250 Hz (−84 dB); 500 is a reasoned margin, not a
 * measurement — above it, measure 1x against 4x before allowing it.
 */
export const WARMTH_BASE_RATE_MAX_HZ = 500

/** Throws unless `layers` is 1–WARMTH_MAX_LAYERS layers with known roles. */
export function checkWarmthLayers(layers) {
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > WARMTH_MAX_LAYERS) {
    throw new Error(`PHAT*SS Warmth takes 1–${WARMTH_MAX_LAYERS} layers, got ${layers?.length}`)
  }
  layers.forEach((l, k) => {
    const blend = l.blend ?? 'fixed'
    if (!WARMTH_BLENDS.includes(blend)) throw new Error(`Warmth layer ${k}: unknown blend '${l.blend}'`)
    if (l.mode !== undefined && l.mode !== 'full') throw new Error(`Warmth layer ${k}: PHAT*SS runs every layer FULL, not '${l.mode}'`)
    if (l.oversample === false && !(l.hiHz <= WARMTH_BASE_RATE_MAX_HZ)) {
      throw new Error(`Warmth layer ${k}: oversample: false needs a low band (hiHz ≤ ${WARMTH_BASE_RATE_MAX_HZ}), got ${l.hiHz}`)
    }
  })
  return layers
}
checkWarmthLayers(WARMTH_LAYERS)


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
 * The warmth layers' kernel params for a Warmth / Odd/Even setting (roles in
 * WARMTH_LAYERS: the even and odd layers crossfade, fixed layers follow the level).
 * Odd/Even is an equal-power crossfade, so turning it keeps the combined
 * added level, over the first ODD_EVEN_SPAN of the full Odd→Even travel; the
 * bench voicing is Warmth 5 / Odd/Even 36.
 */
export function warmthLayers(warmth, oddEven, refPeaksDb, layers = WARMTH_LAYERS) {
  const w = clamp(Number(warmth) || 0, 0, WARMTH_MAX)
  const b = ODD_EVEN_SPAN * clamp(Number.isFinite(oddEven) ? oddEven : 50, 0, ODD_EVEN_MAX) / ODD_EVEN_MAX
  const levelDb = warmthLevelDb(w)
  // Each role's share of the crossfade, and its level offset.
  const gain = { even: Math.sin((b * Math.PI) / 2), odd: Math.cos((b * Math.PI) / 2), fixed: 1 }
  const offset = { even: WARMTH_EVEN_MATCH_DB, odd: 0, fixed: 0 }
  return layers.map((spec, k) => {
    const { blend = 'fixed', amountOffsetDb = 0, ...l } = spec
    const amountDb = levelDb + offset[blend] + amountOffsetDb + 20 * Math.log10(Math.max(gain[blend], 1e-12))
    const on = w > 0 && amountDb > WARMTH_LAYER_OFF_DB
    const ref = Array.isArray(refPeaksDb) && Number.isFinite(refPeaksDb[k]) ? refPeaksDb[k] : undefined
    return { ...l, mode: 'full', on, amountDb: on ? amountDb : 0, ...(ref === undefined ? {} : { refPeakDb: ref }) }
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
 * FATSO mode's law, fitted to four EL7 Fatso bounces (Input 2 with Warmth
 * 2/5/6/7, one music clip at −23.0 dBFS gated RMS; docs/claude-dev-log.md,
 * "PHAT*SS — Tame/Tone against the EL7 Fatso's Warmth"). With the corner at the
 * Fatso's ~2 kHz, its Warmth moves the THRESHOLD (+10 / +4 / 0 dB re the voice
 * at Warmth 5 / 6 / 7; Warmth 2 does nothing) and its Range opens with it, from
 * ~3 dB at Warmth 6 to ≥ 9 at 7 — shallower than Tame's own law at the same
 * threshold. So: threshold `12 − 2·Tame`, Range `max(3, 3·Tame − 9)`, which puts
 * Warmth 5 / 6 / 7 at Tame 1 / 4 / 6 (fitted points; the travel between and
 * past them is not measured).
 *
 * ⚠ THE FATSO'S THRESHOLD IS ABSOLUTE, ours follows the file's level — the
 * mapping holds for a file at the fitted clip's level only. A steeper-than-
 * limiter law and a different release were tried and fit worse.
 */
export const FATSO_CORNER_HZ = 2000
export const FATSO_THRESHOLD_TOP_DB = 12
export const FATSO_THRESHOLD_PER_STEP_DB = 2
export const FATSO_RANGE_MIN_DB = 3
export const FATSO_RANGE_PER_STEP_DB = 3
export const FATSO_RANGE_OFFSET_DB = 9

/**
 * VOICE curve: FATSO's shape moved for narration. On narration the treble's
 * 10 ms peaks sit ~8 dB lower re the gated RMS than on the Fatso's music clip
 * (median −7.4 / −8.5 dB on a bright and a dull narration vs +0.7), so FATSO's
 * thresholds (+10 … +6 at Tame 1–3) are crossed in 0–2 % of windows and the
 * bottom of the knob does nothing. Threshold `6 − 2·Tame`, Range
 * `max(3, 3·Tame − 3)` (27 at 10). Measured on the bright clip (4–16 kHz on
 * sibilant frames / 2–4 kHz on voiced): Tame 1 −1.6 / −0.2, Tame 6 −7.9 / −2.2,
 * Tame 10 −10.6 / −3.9 dB. ⚠ Two clips, chosen by reasoning, not audition.
 */
export const VOICE_THRESHOLD_TOP_DB = 6
export const VOICE_THRESHOLD_PER_STEP_DB = 2
export const VOICE_RANGE_MIN_DB = 3
export const VOICE_RANGE_PER_STEP_DB = 3
export const VOICE_RANGE_OFFSET_DB = 3

export const TAME_CURVES = ['voice', 'fatso', 'original']

/**
 * The detector each curve is paired with, by ear: VOICE with 4K on narration,
 * FATSO with 2K on music. The panel moves DETECT to the pair when CURVE
 * changes; DETECT can still be set against it.
 */
export const CURVE_DETECT = { voice: '4k', fatso: '2k' }

/**
 * DETECT 4K: the detector's own one-pole split, and how much lower its
 * threshold sits. The 4 kHz band reads 2–5 dB under the 2 kHz one at the
 * percentiles the thresholds live at (p90–p99 of 10 ms peaks: bright narration
 * 3.8 / 1.9, dull 4.8 / 5.0, the Fatso music clip 2.5 / 2.5), so 3 dB keeps the
 * two positions doing about as much and makes the switch change WHAT triggers
 * the cut rather than how often. Applies to the 2 kHz curves only.
 */
export const DETECT_4K_HZ = 4000
export const DETECT_4K_COMP_DB = 3

/**
 * The macro: Tame sets how hard (Threshold and Range together, so the shelf
 * starts acting earlier AND may go deeper), Tone sets where (the corner, on a
 * log scale). Tame 5 / Tone 10 is −8 dB, Range 18, 12 kHz — the HF Limiter's
 * default threshold and corner, half again its Range (the HF Limiter stops at
 * 24; Tame reaches 36). Tame 0 takes the shelf out (Range 0). This is the
 * DEPRECATED 'original' curve; `curve` 'fatso' / 'voice' select the laws above,
 * with the corner pinned at 2 kHz and Tone ignored.
 *
 * @returns {{ cornerHz: number, thresholdRelDb: number, rangeDb: number }}
 */
export function tapeShelf(tame, tone, curve = 'original') {
  const t = clamp(Number(tame) || 0, 0, TAME_MAX)
  if (curve === 'fatso') {
    return {
      cornerHz: FATSO_CORNER_HZ,
      thresholdRelDb: FATSO_THRESHOLD_TOP_DB - FATSO_THRESHOLD_PER_STEP_DB * t,
      rangeDb: t > 0 ? Math.max(FATSO_RANGE_MIN_DB, FATSO_RANGE_PER_STEP_DB * t - FATSO_RANGE_OFFSET_DB) : 0,
    }
  }
  if (curve === 'voice') {
    return {
      cornerHz: FATSO_CORNER_HZ,
      thresholdRelDb: VOICE_THRESHOLD_TOP_DB - VOICE_THRESHOLD_PER_STEP_DB * t,
      rangeDb: t > 0 ? Math.max(VOICE_RANGE_MIN_DB, VOICE_RANGE_PER_STEP_DB * t - VOICE_RANGE_OFFSET_DB) : 0,
    }
  }
  const s = clamp(Number.isFinite(tone) ? tone : TONE_MAX, 0, TONE_MAX)
  return {
    cornerHz: TONE_MIN_HZ * (TONE_MAX_HZ / TONE_MIN_HZ) ** (s / TONE_MAX),
    thresholdRelDb: TAME_THRESHOLD_TOP_DB - TAME_THRESHOLD_PER_STEP_DB * t,
    rangeDb: TAME_RANGE_PER_STEP_DB * t,
  }
}

/**
 * Soften's depth from its own knob (0–SOFTEN_MAX): 0 is no cut at all; the
 * ceiling is SOFTEN_DB_PER_STEP per step and the slope runs SOFTEN_SLOPE_MIN →
 * MAX across the travel. ⚠ IT RODE TAME UNTIL OCTOBER 2026 (`softenLaw(on,
 * tame)` with Tame as the amount); the law is unchanged, only its input moved,
 * so Soften s renders what Soften ON did at Tame s. A legacy `true` (the old
 * toggle) is read at the given Tame, `false` as 0 — see `softenAmount`.
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

/** The Soften amount from a param that may still be the old on/off toggle. */
export function softenAmount(soften, tame) {
  if (soften === true) return clamp(Number(tame) || 0, 0, SOFTEN_MAX)
  if (soften === false) return 0
  return clamp(Number(soften) || 0, 0, SOFTEN_MAX)
}

/** Map UI params to kernel params. */
export function toKernelParams(params) {
  const p = { ...PHATASS_DEFAULTS, ...params }
  const voice = Number.isFinite(p.voiceLevelDb)
    ? clamp(p.voiceLevelDb, VOICE_LEVEL_MIN_DB, VOICE_LEVEL_MAX_DB)
    : ALIGN_TARGET_DBFS
  const curve = TAME_CURVES.includes(p.curve) ? p.curve : PHATASS_DEFAULTS.curve
  const shelf = tapeShelf(p.tame, p.tone, curve)
  const det4k = p.detect === '4k' && curve !== 'original'
  const soft = softenLaw(softenAmount(p.soften, p.tame))
  return {
    warmthLayers: warmthLayers(p.warmth, p.oddEven, p.warmthRefPeaksDb),
    // Pinned on with Warmth: there is no switch.
    warmthGuard: { on: warmthActive(p), ceilingDb: Number.isFinite(p.warmthCeilingDb) ? p.warmthCeilingDb : null },
    tapeLayer: tapeLayer(p.tape, Number.isFinite(p.warmthCeilingDb) ? p.warmthCeilingDb : voice + TAPE_FALLBACK_CREST_DB, p.tapeCurve),
    tapeOrder: p.tapeOrder === 'last' ? 'last' : 'first',
    tapeMakeupDb: Number(p.tape) > 0 && Number.isFinite(p.tapeMakeupDb) ? clamp(p.tapeMakeupDb, 0, TAPE_MAX_DB) : 0,
    cornerHz: shelf.cornerHz,
    thresholdDb: voice + shelf.thresholdRelDb - (det4k ? DETECT_4K_COMP_DB : 0),
    detectCornerHz: det4k ? DETECT_4K_HZ : null,
    rangeDb: shelf.rangeDb,
    ...TAPE_SHELF,
    // Soften rides the shelf's Transient, on its own band, at its own depth.
    transientDb: soft.depthDb,
    transientCornerHz: SOFTEN_FREQ_HZ,
    transientSlope: soft.slope,
    transientGateDb: voice - SOFTEN_GATE_BELOW_DB,
    voiceLevelDb: voice,
    outputGainDb: clamp(Number(p.output) || 0, OUTPUT_MIN_DB, OUTPUT_MAX_DB),
  }
}

/**
 * TAPE — a full-band CUBIC soft clipper, FIRST on the main path (ahead of
 * Warmth — owner's call, so Warmth shapes the rounded signal; it sat after the
 * Warmth guard until October 2026): what a tape machine does to peaks. Measured on a
 * Studer A800 emulation (owner-supplied acoustic guitar, dry vs wet, see
 * docs/claude-dev-log.md "PHAT*SS — TAPE"): the peak reduction is a WAVESHAPER,
 * not a compressor — in the loudest 10 ms windows the quiet samples keep their
 * gain and only those near the top bend — nearly symmetric, flat to ~9 dB under
 * the peak, then −1.1 / −2.2 / −5.3 dB at −6 / −3 / 0. The bench's CUBIC
 * (`u − u³/3`, flat past ±1) fits that curve to 0.09 dB rms (tanh 0.17).
 *
 * The knob is PEAK REDUCTION in dB, solved exactly: for f(g·x)/g the gain at
 * the selection's peak P is f(u)/u with u = g·P, and the cubic inverts in
 * closed form (`tapePeakU`). So the knob's number is what happens to the peak
 * sample, on any recording level. ⚠ Past 3.52 dB (u > 1) the top of the wave is
 * on the cubic's FLAT — a hard clip there; the Studer fit sat at u 1.17 (−4.9 dB
 * at its peak). ⚠ Distortion rises fast: on narration ~−33 / −27 / −21 dB of
 * added signal at 1 / 2 / 3.6 dB of peak reduction (≈2 / 4 / 9 %).
 *
 * Run on the shared Saturation Bench kernel as one layer with its band open at
 * both ends and Amount 0, which is exactly a full-band shaper, 4x oversampled,
 * 50 samples of latency on or off.
 *
 * MAKEUP (automatic, owner's choice: peak-restoring): a gain right after TAPE
 * that brings the peak back to the selection's own, turning the peak reduction
 * into loudness. ⚠ IT IS MEASURED, NEVER THE KNOB'S NUMBER: a sibilant peak loses
 * only ~75 % of the knob (its harmonics are filtered above Nyquist), so
 * knob-sized makeup would lift it past the source. `tapeMakeupDb` comes from
 * rendering TAPE on the selection (`measureTapeMakeup`: a fast bounded search
 * for preview, the whole region for apply) — TAPE sees the source, so no other
 * knob moves it. After the makeup the voice peaks at the selection's own peak,
 * which is the Warmth guard's ceiling, and the shelf only lowers peaks, so the
 * output never passes the source. ⚠ The makeup lifts the body Warmth sees
 * (+1.2 to +1.7 dB at TAPE 2), so Warmth runs that much hotter with TAPE up;
 * its calibration is measured on the source and not compensated.
 */
export const TAPE_MAX_DB = 6
/** Peak re the gated RMS assumed when the selection's peak is not measured yet. */
export const TAPE_FALLBACK_CREST_DB = 18
/**
 * TAPE's curves. 'cubic' (default) fits the Studer best (0.09 dB rms) and is
 * pure third harmonic until the peak reaches its flat at 3.52 dB, where it
 * becomes a hard clip. 'tanh' fitted it second (0.17) and never goes flat.
 *
 * ⚠ "TANH IS GENTLER AT THE TOP" WAS THE PREDICTION AND IT DID NOT HOLD.
 * 110 Hz sine at −4.4 dBFS, H7–H41 re the fundamental, cubic / tanh:
 * TAPE 1 −116 / −89, 2 −110 / −71, 3.5 −105 / −56, 5 −45.8 / −46.9,
 * 6 −42.7 / −42.1 dBc — equal where the cubic clips, and tanh carries far MORE
 * high-order content below that (it has every odd order from the start; the
 * cubic has only the third until it reaches its flat). H3+H5 is 0.3–1.5 dB
 * lower on tanh at every setting. On bright narration tanh adds MORE in total
 * (−26.6 vs −28.0 dB re signal at TAPE 2, −16.2 vs −18.9 at 6) because it bends
 * earlier, so more samples are shaped. What tanh does do better: the peak lands
 * nearer the knob (−5.93 vs −5.75 dB at 6; no flat to ring off) and sibilant
 * peaks lose closer to the number (makeup 4.84 vs 4.55 dB at 6). Not auditioned.
 *
 * 'algebraic' (u/√(1 + u²); Studer fit 0.19) is tanh further the same way: it
 * bends earliest, so it has the most high-order content at every setting
 * (H7–H41 −84.8 / −66.9 / −52.8 / −44.0 / −39.7 dBc at TAPE 1 / 2 / 3.5 / 5 / 6),
 * H3+H5 lowest of the three, the most added on narration (−26.3 at 2, −15.5 at
 * 6), and tanh's peak accuracy (−5.94 dB at 6). Its knob solve is closed form.
 * Not auditioned.
 */
export const TAPE_CURVES = ['cubic', 'tanh', 'algebraic']
/**
 * TAPE's place in the chain. 'first' ships; 'last' is the pre-October-2026
 * order, rendered at Warmth 5 / TAPE 3 against 'first' before it was made
 * selectable: within 0.1 LU, the difference −34 / −31 dB re the output on
 * bright / dull narration (spread 500 Hz–16 kHz) and −22 dB on guitar (mostly
 * under 1 kHz — TAPE clipping Warmth's low end). Not auditioned. ⚠ In 'last'
 * TAPE's input depends on Warmth, so its makeup is measured through Warmth
 * (the whole chain, no fast search) and Warmth's knobs re-measure it.
 */
export const TAPE_ORDERS = ['first', 'last']
export const TAPE_CURVE = TAPE_CURVES[0]
const TAPE_LAYER = {
  amountDb: 0, emphDb: 0, loHz: SAT_BAND_MIN_HZ, hiHz: SAT_BAND_MAX_HZ, mode: 'full',
}

/**
 * The curve's input u at the peak that takes `reductionDb` off it: the u with
 * f(u)/u = 10^(−dB/20). The cubic and algebraic (1/√(1 + u²) = r) invert in
 * closed form; tanh(u)/u falls monotonically from 1, so it is bisected (to
 * ~1e-12, well inside a float).
 */
export function tapePeakU(reductionDb, curve = TAPE_CURVE) {
  const r = Math.pow(10, -Math.max(0, reductionDb) / 20)
  if (curve === 'algebraic') return Math.sqrt(1 / (r * r) - 1)
  if (curve === 'tanh') {
    if (r >= 1) return 0
    let lo = 0, hi = 1
    while (Math.tanh(hi) / hi > r) hi *= 2
    for (let k = 0; k < 60; k++) {
      const mid = 0.5 * (lo + hi)
      if (Math.tanh(mid) / mid > r) lo = mid
      else hi = mid
    }
    return 0.5 * (lo + hi)
  }
  return r >= 2 / 3 ? Math.sqrt(3 * (1 - r)) : 2 / (3 * r)
}

/** The TAPE layer's kernel params for a knob position, the selection's peak and the curve. */
export function tapeLayer(tapeDb, peakDb, curve = TAPE_CURVE) {
  const c = TAPE_CURVES.includes(curve) ? curve : TAPE_CURVE
  const t = clamp(Number(tapeDb) || 0, 0, TAPE_MAX_DB)
  if (!(t > 0)) return { ...TAPE_LAYER, curve: c, on: false, driveDb: 0 }
  // layerGain = unitDriveU / refPeak · 10^(drive/20): with refPeak = the peak,
  // u at the peak is unitDriveU · 10^(drive/20).
  const driveDb = clamp(20 * Math.log10(tapePeakU(t, c) / unitDriveU(c)), SAT_DRIVE_MIN_DB, SAT_DRIVE_MAX_DB)
  return { ...TAPE_LAYER, curve: c, on: true, driveDb, refPeakDb: peakDb }
}

/** The TAPE stage's latency: one oversampler round trip, on or off. */
export const TAPE_LATENCY_SAMPLES = SAT_BENCH_LAYER_LATENCY

/** The Warmth stage's latency: one oversampler round trip per oversampled layer. */
export const WARMTH_LATENCY_SAMPLES = slotOversample().filter(Boolean).length * SAT_BENCH_LAYER_LATENCY

/**
 * Plugin latency, samples: TAPE's oversampler, the Warmth oversamplers, the
 * peak guard's lookahead and the shelf's split centre and lookahead (Soften shares
 * the shelf's).
 * CONSTANT: every stage stays a delay of its own length when idle, so no
 * setting moves the audio.
 */
export function phatassLatencySamples(sampleRate) {
  return TAPE_LATENCY_SAMPLES + WARMTH_LATENCY_SAMPLES + warmthGuardLatencySamples(sampleRate) + shelfLatencySamples(sampleRate)
}

/** Pre-roll for apply, seconds: several of the shelf's release. */
export const PHATASS_PREROLL_S = 1.0
