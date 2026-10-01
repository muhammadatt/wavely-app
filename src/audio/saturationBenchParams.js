/**
 * Saturation Bench's UI params: factory layers, defaults and the mapping to
 * kernel params. Split out of effects/saturationBench.js so node can import it
 * — the wrapper pulls a Vite `?worker&url` specifier.
 */

import {
  SAT_BENCH_MAX_LAYERS, SAT_LAYER_DEFAULTS, SAT_DEFAULT_REF_PEAK_DB,
} from './saturationBenchProcessor.js'

/**
 * Factory layers: the two combinations that earned their keep in the HF
 * Softener, where this was built, plus two spare slots.
 *   1 WARMTH  — Quartic, OPTO, full band, FULL: density without edge.
 *   2 EXCITER — Tanh (odd), REV, 3 kHz up, VOICED: harmonic brightness on
 *               the vowels, none added to sibilants or room tone.
 */
export const SAT_BENCH_LAYER_PRESETS = [
  { on: true, curve: 'quartic', driveDb: 0, emph: 'opto', loHz: 20, hiHz: 20000, mode: 'full' },
  // +22: REV pulls the highs out before the curve, so on a high band it needs
  // ~8–10 dB more drive than OFF for the same brightening (vowels +1.8 dB above
  // 5 kHz here, synthetic voice; OFF gets there by ~+16, OPTO by ~+6).
  { on: true, curve: 'tanh', driveDb: 22, emph: 'reverse', loHz: 3000, hiHz: 20000, mode: 'voiced' },
  { on: false, curve: 'algebraic', driveDb: 0, emph: 'off', loHz: 20, hiHz: 20000, mode: 'voiced' },
  { on: false, curve: 'atan', driveDb: 0, emph: 'off', loHz: 20, hiHz: 20000, mode: 'voiced' },
]

export const SATURATION_BENCH_DEFAULTS = {
  layers: SAT_BENCH_LAYER_PRESETS.map(l => ({ ...l })),
  // Measured from the whole file, never a user setting — see useSaturationBench.
  refPeaks: Array(SAT_BENCH_MAX_LAYERS).fill(SAT_DEFAULT_REF_PEAK_DB),
  levelOffset: 0,
}

/**
 * Map UI params to kernel params. Copied field by field, not spread: layers
 * arrive as Vue reactive proxies and this object crosses a structured clone
 * (postMessage, processorOptions), which throws DataCloneError on a proxy.
 */
export function toKernelParams(params) {
  const layers = []
  for (let k = 0; k < SAT_BENCH_MAX_LAYERS; k++) {
    const l = params.layers?.[k] ?? SAT_LAYER_DEFAULTS
    layers.push({
      on: !!l.on,
      curve: String(l.curve),
      driveDb: Number(l.driveDb),
      emph: String(l.emph),
      loHz: Number(l.loHz),
      hiHz: Number(l.hiHz),
      mode: String(l.mode),
      refPeakDb: Number(params.refPeaks?.[k] ?? SAT_DEFAULT_REF_PEAK_DB),
    })
  }
  return { levelOffsetDb: Number(params.levelOffset) || 0, layers }
}

