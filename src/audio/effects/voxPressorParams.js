/**
 * VoxPressor panel params, defaults and latency — with NO worklet loader
 * behind them, so `node --test` can reach the mapping (the same split as
 * schepsParams.js, for the same reason: `voxPressor.js` imports the
 * `?worker&url` loader, which only Vite resolves).
 */
import { PEAKS_BODY_WARN_DB } from '../voxPressorSolve.js'
import { voxLatencySamples, PEAKS_INPUT_KNOB } from '../voxPressorProcessor.js'
import { LOOKAHEAD_MAX_MS } from '../la2aProcessor.js'

/**
 * Two oversampled kernels and two limiters in series, constant whether a stage
 * is on or off — at 44.1 kHz with the Body lookahead off, for the effect's
 * nominal figure. The apply path asks `voxLatencySamples` for the real one: the
 * limiters' lookahead is in ms, and so is the bench's Body lookahead.
 */
export const VOX_LATENCY_SAMPLES = voxLatencySamples({}, 44100)
export { voxLatencySamples }

/**
 * THE PEAKS SCALE: 0–10, linear in the 1176's detector drive, calibrated so
 * Peaks N takes about N dB off the loudest peaks of typical narration.
 *
 * Measured with the Input pinned at 26 and the drive stepped (owner's two
 * clips, 30 s each): once peaks are caught, each dB of drive takes 0.88–0.90 dB
 * off them, linearly to 10 dB and beyond, on both clips and on synthetic
 * narration — at 12:1 the stage is a limiter. Both clips start being caught
 * ~3.9 dB under Input 26's drive (−3.5 / −4.3), so that is Peaks 0, and a
 * step is 1 / 0.885 = 1.13 dB of drive. Predicted at Peaks 3: 2.6 / 3.5 dB;
 * at 10: 9.6 / 10.8.
 *
 * ⚠ A CALIBRATED SCALE, NOT A TARGET. A peakier voice reads more: synthetic
 * narration (crest 20 dB) takes ~6.4 dB at Peaks 3. The panel's readout is
 * the measured figure for the file. (Solving every voice onto the scale was
 * the retired target solve — see voxPressorSolve.js.)
 *
 * Why not the 1176's own Input: over this range it moves drive almost evenly
 * (~0.5 dB a point, 15–40), but that is a quarter of its travel, the numbers
 * mean nothing on their own, and the knee would move with it.
 */
export const PEAKS_MAX = 10
export const PEAKS_ZERO_DRIVE_DB = -3.9
export const PEAKS_DRIVE_PER_STEP_DB = 1.13

/** The detector drive Peaks `x` adds over the file's alignment, dB. */
export function peaksDriveDb(x) {
  return PEAKS_ZERO_DRIVE_DB + PEAKS_DRIVE_PER_STEP_DB * x
}

/** The bench's Body lookahead steps, ms (LA Vintage 2A's own control). */
export const BODY_LOOKAHEAD_STEPS_MS = Object.freeze([0, 5, 10, LOOKAHEAD_MAX_MS])

export const VOX_OUTPUT_MIN_DB = -12
export const VOX_OUTPUT_MAX_DB = 12
export { PEAKS_BODY_WARN_DB }

/**
 * The panel's state. `peaks`, `body` and `output` are the user's; everything
 * under MEASURED is measured (`alignDb` from the whole file's gated RMS, the
 * rest by `measureVoxPressor`) and never enters a preset.
 */
export const VOX_DEFAULTS = {
  /**
   * Peaks, 0–10 (0 = stage out): about N dB off the loudest peaks of
   * typical narration (`peaksDriveDb`).
   */
  peaks: 3,
  /**
   * The LA-2A's Peak Reduction, 0–100 (0 = Body stage out). 57 is 3.4–3.8 dB
   * of average leveling on both clips (≈ 2.3 dB per 10 points from 40 up;
   * the two clips agree to 0.4 dB at every setting).
   */
  body: 57,
  /** Manual trim after the ceiling, dB. */
  output: 0,
  /** 'off' | 'peaks' | 'body' — monitor a detector. Never saved. */
  listen: 'off',
  /**
   * BENCH: the LA-2A's lookahead, ms (LA Vintage 2A's Lookahead control,
   * `LOOKAHEAD_MAX_MS`). 0 ships — an LA-2A has none. It moves the latency.
   */
  bodyLookaheadMs: 0,
  // ── MEASURED ──
  /**
   * The file's alignment, dB (`alignDbForRms` on the WHOLE file's gated RMS,
   * LA Vintage 2A's and LA Classic 76's): both detectors' offset.
   */
  alignDb: null,
  cornerHz: null,
  // Per-stage makeup, limiter ceilings and restores (see `measureVoxPressor`).
  peaksMakeupDb: 0,
  peaksCeilingDb: null,
  peaksRestoreDb: 0,
  bodyMakeupDb: 0,
  bodyCeilingDb: null,
  /** The LA-2A stage's restore, before its limiter. */
  makeupDb: 0,
}

/** The keys `measureVoxPressor` measures: never a user setting, never in a preset. */
export const VOX_MEASURED_KEYS = Object.freeze([
  // Ceilings first: they reach the live node as separate messages, and a
  // raised makeup must never run against an old ceiling (see useLA2A).
  'peaksCeilingDb', 'bodyCeilingDb',
  'cornerHz',
  'peaksMakeupDb', 'peaksRestoreDb', 'bodyMakeupDb', 'makeupDb',
])

/** Map panel params to kernel params. */
export function toKernelParams(p) {
  return {
    /**
     * ⚠ A STAGE RUNS ONLY ONCE THE FILE'S ALIGNMENT IS MEASURED. Unaligned,
     * the offset is 0, which puts both thresholds wherever the file's level
     * happens to sit: the first build read ~5 dB of 1176 reduction with
     * excursions to 18 on a −22 dBFS voice at every knob position. Bypassed (a
     * delay line, so the latency does not move) until it lands — which is one
     * synchronous pass over the file, so in practice at once.
     */
    peaksOn: p.peaks > 0 && Number.isFinite(p.alignDb),
    bodyOn: p.body > 0 && Number.isFinite(p.alignDb),
    peaksInput: PEAKS_INPUT_KNOB,
    bodyPeakReduction: knob(p.body),
    outputDb: Number.isFinite(p.output) ? p.output : 0,
    listen: p.listen ?? 'off',
    makeupDb: Number.isFinite(p.makeupDb) ? p.makeupDb : 0,
    bodyBench: { lookaheadMs: bodyLookaheadOf(p) },
    // Measured values cross only when real, so an unmeasured panel leaves the
    // kernel on its own defaults rather than on a NaN.
    ...(Number.isFinite(p.cornerHz) ? { cornerHz: p.cornerHz } : {}),
    ...(Number.isFinite(p.alignDb) ? {
      peaksAlignDb: p.alignDb + peaksDriveDb(Math.max(0, Math.min(PEAKS_MAX, Number(p.peaks) || 0))),
      bodyAlignDb: p.alignDb,
    } : {}),
    peaksMakeupDb: Number.isFinite(p.peaksMakeupDb) ? p.peaksMakeupDb : 0,
    peaksRestoreDb: Number.isFinite(p.peaksRestoreDb) ? p.peaksRestoreDb : 0,
    bodyMakeupDb: Number.isFinite(p.bodyMakeupDb) ? p.bodyMakeupDb : 0,
    // null clears a limiter's ceiling (a pure delay).
    peaksCeilingDb: Number.isFinite(p.peaksCeilingDb) ? p.peaksCeilingDb : null,
    bodyCeilingDb: Number.isFinite(p.bodyCeilingDb) ? p.bodyCeilingDb : null,
  }
}

function knob(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0
}

/** The Body lookahead in effect, ms (0 when unset or out of range). */
export function bodyLookaheadOf(p) {
  const v = Number(p?.bodyLookaheadMs)
  return Number.isFinite(v) ? Math.max(0, Math.min(LOOKAHEAD_MAX_MS, v)) : 0
}
