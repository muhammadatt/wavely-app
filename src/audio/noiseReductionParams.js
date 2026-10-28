/**
 * Noise Reduction — the plugin's params and the one wire format the browser
 * and the API server share (the server imports this file, as it does
 * src/audio/presets.js).
 *
 * The plugin is a spot front end on the mastering chain's own denoisers:
 * DeepFilterNet3 and RNNoise run on the server (`/api/spot/noise_reduction`,
 * server/pipeline/spotNoiseReduce.js), there is no browser implementation of
 * either, and so there is no live preview — the selection is processed once,
 * auditioned inside the window, and committed from that result.
 *
 * WHAT IS A SERVER SETTING AND WHAT IS NOT. Engine, DF3's attenuation cap and
 * RNNoise's consonant guard change what the server computes, so changing any of
 * them invalidates a processed result. Mix does not: it is a dry/wet blend done
 * in the browser on the result already held, so it can be turned while
 * listening and costs no round trip.
 */

import { FREE_PREVIEW_SECONDS } from '../auth/plans.js'

/**
 * The engines. `both` is the ACX Audiobook preset's order — DF3 first for the
 * broadband floor, then RNNoise for what DF3 leaves — not the reverse: RNNoise
 * is the lighter model, and a lighter pass ahead of a heavier one does work the
 * second pass would have done anyway.
 */
export const NR_ENGINES = ['df3', 'rnnoise', 'both']

/**
 * How much Preview processes, in seconds — the free preview limit, so the
 * preview is the same on every plan and the server's gate admits it for anyone.
 * Short on purpose for Pro too: a setting is judged on a passage, and waiting
 * on a whole chapter to hear one is the slow loop this replaces.
 */
export const NR_PREVIEW_SECONDS = FREE_PREVIEW_SECONDS

export const NR_ENGINE_LABELS = {
  df3: 'DeepFilterNet3',
  rnnoise: 'RNNoise',
  both: 'DF3 + RNNoise',
}

/**
 * DF3's `atten_lim_db` range. 6 / 12 / 18 dB are the mastering chain's light /
 * standard / heavy tiers (NR_TIERS in server/pipeline/stages.js); the top of the
 * knob, NR_DF3_LIMIT_MAX_DB, means UNCAPPED and goes over the wire as null.
 */
export const NR_DF3_LIMIT_MIN_DB = 3
export const NR_DF3_LIMIT_MAX_DB = 48

export const NOISE_REDUCTION_DEFAULTS = {
  engine: 'df3',
  // The chain's heavy tier: what a user reaching for this plugin on a noisy
  // selection expects to hear, without DF3's uncapped extreme.
  df3LimitDb: 18,
  // RNNoise's VAD guard: restore the dry signal where Silero hears speech and
  // RNNoise does not — its causal VAD misreads fricative onsets as noise. On in
  // the ACX preset, and on here.
  protectConsonants: true,
  mix: 1, // 0–1, wet share, applied in the browser
}

/**
 * The stretch Preview processes: the whole selection when it fits, else
 * `length` seconds starting at the playhead — where the user is listening —
 * or at the selection's start when the playhead is outside it. A window that
 * would run past the end is slid back so it stays full length.
 *
 * @param {{ start: number, end: number }} selection
 * @param {number|null} playhead  seconds
 * @param {number} [length]
 * @returns {{ start: number, end: number }}
 */
export function previewWindow(selection, playhead, length = NR_PREVIEW_SECONDS) {
  const { start, end } = selection
  if (end - start <= length) return { start, end }
  const inside = Number.isFinite(playhead) && playhead >= start && playhead < end
  const from = Math.min(inside ? playhead : start, end - length)
  return { start: from, end: from + length }
}

/** True when `engine` runs that model. */
export function usesDf3(engine) {
  return engine === 'df3' || engine === 'both'
}

export function usesRnnoise(engine) {
  return engine === 'rnnoise' || engine === 'both'
}

/** DF3's cap for a knob value: null (uncapped) at the top of the travel. */
export function df3AttenLimFor(limitDb) {
  return limitDb >= NR_DF3_LIMIT_MAX_DB ? null : limitDb
}

/**
 * The request body for `/api/spot/noise_reduction`. Mix is absent on purpose —
 * the server never sees it.
 */
export function toServerParams(params) {
  const p = { ...NOISE_REDUCTION_DEFAULTS, ...params }
  return {
    engine: p.engine,
    df3AttenLimDb: usesDf3(p.engine) ? df3AttenLimFor(p.df3LimitDb) : null,
    protectConsonants: usesRnnoise(p.engine) ? !!p.protectConsonants : false,
  }
}

/**
 * Validate a request body on the server. Throws with a message fit for a 400
 * rather than letting a bad value reach a Python argv.
 */
export function parseServerParams(raw = {}) {
  const engine = raw.engine ?? NOISE_REDUCTION_DEFAULTS.engine
  if (!NR_ENGINES.includes(engine)) {
    throw new Error(`Unknown noise reduction engine: ${engine}`)
  }
  let df3AttenLimDb = raw.df3AttenLimDb ?? null
  if (df3AttenLimDb !== null) {
    df3AttenLimDb = Number(df3AttenLimDb)
    if (!Number.isFinite(df3AttenLimDb) || df3AttenLimDb < NR_DF3_LIMIT_MIN_DB || df3AttenLimDb > NR_DF3_LIMIT_MAX_DB) {
      throw new Error(`df3AttenLimDb must be null or between ${NR_DF3_LIMIT_MIN_DB} and ${NR_DF3_LIMIT_MAX_DB} dB`)
    }
  }
  return {
    engine,
    df3AttenLimDb: usesDf3(engine) ? df3AttenLimDb : null,
    protectConsonants: usesRnnoise(engine) && raw.protectConsonants !== false,
  }
}

/**
 * The key a processed result is stored under: everything the server read.
 * Two settings that send the same request share a result (Mix, or DF3's cap
 * while the engine is RNNoise alone, never re-process).
 */
export function serverParamsKey(params) {
  const s = toServerParams(params)
  return `${s.engine}|${s.df3AttenLimDb ?? 'uncapped'}|${s.protectConsonants ? 1 : 0}`
}

/**
 * Dry/wet blend into a new set of channels: `dry·(1 − mix) + wet·mix`. Both
 * inputs are the same length by construction (the server length-matches every
 * channel to what it was sent); a shorter one reads as silence past its end
 * rather than throwing, so a malformed response degrades to audible rather than
 * to a crash mid-commit.
 */
export function blendDryWet(dry, wet, mix) {
  const m = Math.min(1, Math.max(0, mix))
  return dry.map((d, ch) => {
    const w = wet[ch] ?? wet[0]
    const out = new Float32Array(d.length)
    if (m === 1) {
      out.set(w.length >= d.length ? w.subarray(0, d.length) : w)
      return out
    }
    const dm = 1 - m
    const n = Math.min(d.length, w.length)
    for (let i = 0; i < n; i++) out[i] = d[i] * dm + w[i] * m
    for (let i = n; i < d.length; i++) out[i] = d[i] * dm
    return out
  })
}
