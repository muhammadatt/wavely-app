/**
 * Stage 3a — Corrective EQ.
 *
 * Replaces the v3.1 Stage 3 Enhancement EQ. Detects localised spectral
 * anomalies (narrow-to-moderate humps and dips that represent recording
 * environment problems, microphone colorations, or voice characteristic
 * imbalances) in the whole-file average voiced-frame spectral envelope and
 * computes adaptive parametric EQ bands. Measurement-driven — no fixed center
 * frequencies, no fixed gains, no per-preset reference curves.
 *
 * The heavy cepstral analysis runs in corrective_eq.py; this module supplies
 * the F0 estimates and VAD mask it consumes and parses the band output.
 *
 * Reference: Stage 3a Corrective EQ spec v1.0.
 */

import { join, dirname }           from 'path'
import { writeFile, readFile, rm } from 'fs/promises'
import { fileURLToPath }           from 'url'
import { spawnPython }             from './spawnPython.js'
import { getF0Contour }            from './f0Analysis.js'

const __dirname        = dirname(fileURLToPath(import.meta.url))
const CORRECTIVE_SCRIPT = join(__dirname, '../scripts/corrective_eq.py')

/**
 * Run the Stage 3a analysis against ctx.currentPath.
 *
 * @param {object} ctx  Pipeline context (see createContext in index.js)
 * @returns {Promise<object>} Parsed analysis result — see corrective_eq.py.
 */
export async function analyzeCorrectiveEQ(ctx) {
  // F0 is required for voice-type classification and the cepstral lifter
  // cutoff. A fresh contour is computed against the current audio.
  const f0     = await getF0Contour(ctx)
  const f0p5   = percentile(f0.perFrame, 5)

  const outputPath = ctx.tmp('.json')
  const args = [
    '--input',     ctx.currentPath,
    '--output',    outputPath,
    '--f0-median', String(f0.median),
    '--f0-p5',     String(f0p5),
  ]

  const frames = ctx.results.metrics?.frames ?? null
  let vadMaskPath = null
  if (frames?.length > 0) {
    vadMaskPath = ctx.tmp('.json')
    await writeFile(vadMaskPath, JSON.stringify(frames))
    args.push('--vad-mask-json', vadMaskPath)
  }

  let result
  try {
    await spawnPython(CORRECTIVE_SCRIPT, args, 'CorrectiveEQ')
    result = JSON.parse(await readFile(outputPath, 'utf8'))
  } finally {
    if (vadMaskPath) await rm(vadMaskPath, { force: true })
    await rm(outputPath, { force: true })
  }
  return result
}

/**
 * Build FFmpeg `equalizer` filter strings from corrective EQ bands.
 * @param {{ freq_hz: number, q: number, gain_db: number }[]} bands
 * @returns {string[]}
 */
export function bandsToFfmpegFilters(bands) {
  return bands.map(
    b => `equalizer=f=${b.freq_hz}:width_type=q:width=${b.q}:g=${b.gain_db}`,
  )
}

/**
 * Linear-interpolated percentile of a numeric array (NumPy-style).
 */
function percentile(values, p) {
  if (!values || values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = (p / 100) * (sorted.length - 1)
  const lo  = Math.floor(idx)
  const hi  = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}
