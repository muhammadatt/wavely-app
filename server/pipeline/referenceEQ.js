/**
 * referenceEQ — corpus-reference broad tonal correction.
 *
 * Compares a recording's overall spectral shape against a corpus-derived
 * reference curve and applies a smooth, broad linear-phase FIR correction.
 * Complements Stage 3a Corrective EQ: 3a fixes localised anomalies, referenceEQ
 * fixes broad tonal imbalance. Runs immediately after the final correctiveEQ.
 *
 * The spectrum measurement and FIR application both run in reference_eq.py —
 * a broad smooth match-curve is the one EQ task where a linear-phase FIR is
 * clearly the right tool, so this stage diverges from the FFmpeg-based EQ path.
 *
 * Reference curves are static repository assets at data/reference_curves/.
 * When no curve exists for the active preset the stage skips cleanly, so it is
 * safe to wire into the pipeline before the corpus is sourced.
 *
 * Reference: referenceEQ stage spec v1.0 (docs/instant_polish_reference_eq_spec.md).
 */

import { join, dirname }       from 'path'
import { fileURLToPath }       from 'url'
import { readFile, rm, access } from 'fs/promises'
import { spawnPython }         from './spawnPython.js'

const __dirname        = dirname(fileURLToPath(import.meta.url))
const REFERENCE_SCRIPT = join(__dirname, '../scripts/reference_eq.py')
const CURVES_DIR       = join(__dirname, '../../data/reference_curves')

// Reference curves are static assets — load each file at most once per process.
const curvePathCache = new Map()

/**
 * Resolve the reference curve file path for a preset, or null if absent.
 * The result (including a null miss) is cached for the process lifetime.
 */
export async function getReferenceCurvePath(presetId) {
  if (curvePathCache.has(presetId)) return curvePathCache.get(presetId)

  const path = join(CURVES_DIR, `${presetId}.json`)
  let resolved = null
  try {
    await access(path)
    resolved = path
  } catch {
    resolved = null
  }
  curvePathCache.set(presetId, resolved)
  return resolved
}

/**
 * Run a single referenceEQ pass against ctx.currentPath.
 *
 * @param {object} ctx              Pipeline context
 * @param {string} curvePath        Reference curve JSON path
 * @param {number} lfMaxBoostDb     Sub-500 Hz boost cap (dB) — starting cap for the analytic ACX backoff
 * @param {object} [opts]
 * @param {string} [opts.noisePsdPath]            PSD JSON path enabling the analytic ACX LF cap solve
 * @param {number} [opts.acxTargetNoiseFloorDb]   ACX post-EQ noise-floor ceiling (dBFS)
 * @param {number} [opts.noiseFloorDb]            Override for --noise-floor (locally-measured floor for the ACX path); falls back to ctx.results.metrics.noiseFloorDbfs
 * @returns {Promise<{ result: object, outputPath: string|null }>}
 *          outputPath is the corrected WAV when result.applied is true, else null.
 */
export async function runReferenceEQPass(ctx, curvePath, lfMaxBoostDb, opts = {}) {
  const outputPath = ctx.tmp('.wav')
  const resultPath = ctx.tmp('.json')

  const args = [
    '--input',           ctx.currentPath,
    '--output',          outputPath,
    '--result-json',     resultPath,
    '--curve',           curvePath,
    '--lf-max-boost-db', String(lfMaxBoostDb),
  ]

  const noiseFloor = opts.noiseFloorDb ?? ctx.results.metrics?.noiseFloorDbfs
  if (noiseFloor != null) args.push('--noise-floor', String(noiseFloor))

  if (opts.noisePsdPath) {
    args.push('--noise-psd-json', opts.noisePsdPath)
  }
  if (opts.acxTargetNoiseFloorDb != null) {
    args.push('--acx-target-noise-floor-db', String(opts.acxTargetNoiseFloorDb))
  }

  let result
  try {
    await spawnPython(REFERENCE_SCRIPT, args, 'ReferenceEQ')
    result = JSON.parse(await readFile(resultPath, 'utf8'))
  } finally {
    await rm(resultPath, { force: true })
  }

  return { result, outputPath: result.applied ? outputPath : null }
}
