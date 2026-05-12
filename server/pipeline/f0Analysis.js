/**
 * F0 contour analysis — shared pitch estimation for downstream stages.
 *
 * Any pipeline stage that needs per-frame F0 data calls getF0Contour(ctx).
 * The result is computed once and cached on ctx._f0Contour so subsequent
 * callers pay zero marginal cost.
 *
 * Resolution order:
 *   1. ctx._f0Contour         — already computed this run; return immediately.
 *   2. estimate_f0_contour.py — dedicated per-frame autocorrelation pass on
 *                               ctx.currentPath. Always used; see note inside
 *                               getF0Contour() for why ctx._sibilanceEvents F0
 *                               is intentionally NOT reused here.
 *
 * Cache is stored outside ctx.results (internal pipeline plumbing, not a
 * report payload — buildReport() should never see it).
 *
 * Contour shape (matches estimate_f0_contour.py output):
 *   { median: number, perFrame: number[], nFft: number, hopLength: number }
 */

import { join, dirname }           from 'path'
import { writeFile, readFile, rm } from 'fs/promises'
import { spawn }                   from 'child_process'
import { fileURLToPath }           from 'url'
import { PYTHON }                  from './spawnPython.js'

const __dirname   = dirname(fileURLToPath(import.meta.url))
const F0_SCRIPT   = join(__dirname, '../scripts/estimate_f0_contour.py')

/**
 * Return the F0 contour for the current ctx audio, computing it once and
 * caching on ctx._f0Contour. Subsequent calls return the cached object.
 *
 * @param {object} ctx  Pipeline context (see createContext in index.js)
 * @returns {Promise<{ median: number, perFrame: number[], nFft: number, hopLength: number }>}
 */
export async function getF0Contour(ctx) {
  // 1. Already computed this run.
  if (ctx._f0Contour) return ctx._f0Contour

  // Note: the sibilance event map also carries a per-frame F0 field
  // (ctx._sibilanceEvents?.events?.f0), but that is the sibilance detector's
  // rolling-median estimate — designed for sibilance band placement (~3×F0
  // accuracy) rather than harmonic protection (~1 bin ≈ 21.5 Hz accuracy).
  // Reusing it here caused the resonance suppressor's harmonic mask to misfire
  // on harmonic bins, producing visible gain reduction in the voiced harmonic
  // region. Always run the dedicated autocorrelation estimator.

  // 2. Run dedicated analysis.
  ctx.log?.('[F0Analysis] Computing F0 contour via estimate_f0_contour.py')
  const startTime  = Date.now()
  const outputPath = ctx.tmp('.json')
  const args       = ['--input', ctx.currentPath, '--output', outputPath]

  const frames = ctx.results.metrics?.frames ?? null
  let vadMaskPath = null
  if (frames?.length > 0) {
    vadMaskPath = ctx.tmp('.json')
    await writeFile(vadMaskPath, JSON.stringify(frames))
    args.push('--vad-mask-json', vadMaskPath)
  }

  let contour
  try {
    await runF0Script(args)
    contour = JSON.parse(await readFile(outputPath, 'utf8'))
  } finally {
    if (vadMaskPath) await rm(vadMaskPath, { force: true })
    await rm(outputPath, { force: true })
  }

  ctx._f0Contour = contour

  const durationMs = Date.now() - startTime
  ctx.log?.(
    `[F0Analysis] Done in ${durationMs}ms: ` +
    `median=${contour.median}Hz frames=${contour.perFrame.length}`,
  )
  return ctx._f0Contour
}

// ---------------------------------------------------------------------------

function runF0Script(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [F0_SCRIPT, ...args], {
      // stdout: 'pipe' so we can drain it; stderr: 'pipe' for error capture.
      // Both must be consumed to prevent the child process blocking on a full
      // pipe buffer once its output exceeds the OS pipe buffer (~64 KB).
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    // Drain stdout — the script prints a one-line summary; capture it for
    // debug visibility without blocking the process.
    let stdout = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (stdout.trim()) process.stdout.write(`[F0Script] ${stdout.trim()}\n`)
      if (code === 0) resolve()
      else reject(new Error(
        `estimate_f0_contour.py exited ${code}: ${stderr.slice(-500)}`,
      ))
    })
    proc.on('error', reject)
  })
}
