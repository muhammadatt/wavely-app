/**
 * VoxPressor panel params, defaults and latency — with NO worklet loader
 * behind them, so `node --test` can reach the mapping (the same split as
 * schepsParams.js, for the same reason: `voxPressor.js` imports the
 * `?worker&url` loader, which only Vite resolves).
 */
import { OVERSAMPLE_LATENCY_SAMPLES } from '../dsp/oversample.js'
import { PEAKS_MAX_DB, BODY_MAX_DB } from '../voxPressorSolve.js'

/** Two oversampled kernels in series, constant whether a stage is on or off. */
export const VOX_LATENCY_SAMPLES = 2 * OVERSAMPLE_LATENCY_SAMPLES

export const VOX_OUTPUT_MIN_DB = -12
export const VOX_OUTPUT_MAX_DB = 12
export { PEAKS_MAX_DB, BODY_MAX_DB }

/**
 * The panel's state. `peaks`, `body` and `output` are the user's; everything
 * under MEASURED comes from `solveVoxPressor` and never enters a preset.
 */
export const VOX_DEFAULTS = {
  /** dB off the loudest voice peaks (0 = Peaks stage out). */
  peaks: 3,
  /** dB of average leveling on voiced material (0 = Body stage out). */
  body: 4,
  /** Manual trim after the ceiling, dB. */
  output: 0,
  /** 'off' | 'peaks' | 'body' — monitor a detector. Never saved. */
  listen: 'off',
  // ── MEASURED ──
  cornerHz: null,
  peaksAlignDb: null,
  bodyAlignDb: null,
  makeupDb: 0,
  ceilingDb: null,
  ceilingKneeDb: null,
}

/** Map panel params to kernel params. */
export function toKernelParams(p) {
  return {
    peaksOn: p.peaks > 0,
    bodyOn: p.body > 0,
    outputDb: Number.isFinite(p.output) ? p.output : 0,
    listen: p.listen ?? 'off',
    makeupDb: Number.isFinite(p.makeupDb) ? p.makeupDb : 0,
    // Measured values cross only when real, so an unmeasured panel leaves the
    // kernel on its own defaults rather than on a NaN.
    ...(Number.isFinite(p.cornerHz) ? { cornerHz: p.cornerHz } : {}),
    ...(Number.isFinite(p.peaksAlignDb) ? { peaksAlignDb: p.peaksAlignDb } : {}),
    ...(Number.isFinite(p.bodyAlignDb) ? { bodyAlignDb: p.bodyAlignDb } : {}),
    // The ceiling and its knee travel together, and null clears them.
    ceilingDb: Number.isFinite(p.ceilingDb) ? p.ceilingDb : null,
    ceilingKneeDb: Number.isFinite(p.ceilingKneeDb) ? p.ceilingKneeDb : null,
  }
}
