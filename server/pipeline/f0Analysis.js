/**
 * F0 contour analysis — shared pitch estimation for downstream stages.
 *
 * Any pipeline stage that needs per-frame F0 data calls getF0Contour(ctx).
 * By default a fresh analysis is always run against ctx.currentPath so that
 * the contour reflects the actual audio at the point of the call — important
 * when the same stage (e.g. resonanceSuppressor) appears at multiple points
 * in the pipeline and the signal has changed significantly between them.
 *
 * Pass { useCache: true } to opt into returning a previously computed contour
 * without re-running the Python script.  This is appropriate for mid-pipeline
 * stages that need pitch data but know the audio is pitch-stable relative to
 * the most recent getF0Contour() call.
 *
 * Resolution order (default — useCache: false):
 *   1. estimate_f0_contour.py — dedicated per-frame autocorrelation pass on
 *                               ctx.currentPath. Result stored to ctx._f0Contour.
 *
 * Resolution order (useCache: true):
 *   1. ctx._f0Contour         — already computed; return immediately.
 *   2. estimate_f0_contour.py — as above when cache is empty.
 *
 * Note: this is the canonical F0 source for the pipeline. The sibilance
 * detector consumes this same contour rather than running its own pitch
 * estimation — see analyzeSibilanceEvents() in sibilanceEvents.js.
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
 * Return the F0 contour for ctx.currentPath.
 *
 * @param {object}  ctx                  Pipeline context (see createContext in index.js)
 * @param {object}  [options]
 * @param {boolean} [options.useCache]   When true, return ctx._f0Contour if already
 *                                       computed rather than re-running the analysis.
 *                                       Defaults to false — fresh analysis on every call.
 * @returns {Promise<{ median: number, perFrame: number[], nFft: number, hopLength: number }>}
 */
export async function getF0Contour(ctx, { useCache = false } = {}) {
  // Return cached contour only when the caller explicitly opts in.
  if (useCache && ctx._f0Contour) return ctx._f0Contour

  // Run dedicated analysis against the current audio file.
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
