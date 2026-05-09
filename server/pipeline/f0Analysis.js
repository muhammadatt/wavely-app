/**
 * F0 contour analysis — shared pitch estimation for downstream stages.
 *
 * Any pipeline stage that needs per-frame F0 data calls getF0Contour(ctx).
 * The result is computed once and cached on ctx._f0Contour so subsequent
 * callers pay zero marginal cost.
 *
 * Priority order:
 *   1. ctx._f0Contour          — already computed this run.
 *   2. ctx._sibilanceEvents    — sibilance analyzer ran upstream and emitted
 *                                F0 as a side effect; extract for free.
 *   3. estimate_f0_contour.py  — dedicated lightweight analysis pass.
 *
 * Cache is stored outside ctx.results (internal pipeline plumbing, not a
 * report payload — buildReport() should never see it).
 *
 * Contour shape (matches estimate_f0_contour.py output):
 *   { median: number, perFrame: number[], nFft: number, hopLength: number }
 */

import { join }           from 'path'
import { writeFile, rm }  from 'fs/promises'
import { spawn }          from 'child_process'
import { fileURLToPath }  from 'url'
import { dirname }        from 'path'

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

  // 2. Sibilance events already computed — extract F0 for free.
  //    build_events_map() emits f0.{median, perFrame} alongside nFft/hopLength
  //    at the top level of the events map.
  const sibEvents = ctx._sibilanceEvents?.events
  if (sibEvents?.f0?.perFrame?.length > 0 && sibEvents.f0.median != null) {
    ctx._f0Contour = {
      median:    sibEvents.f0.median,
      perFrame:  sibEvents.f0.perFrame,
      nFft:      sibEvents.nFft      ?? 2048,
      hopLength: sibEvents.hopLength ?? 512,
    }
    ctx.log?.('[F0Analysis] Using F0 contour from sibilance event cache')
    return ctx._f0Contour
  }

  // 3. Run dedicated analysis.
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

  try {
    await runF0Script(args)
  } finally {
    if (vadMaskPath) await rm(vadMaskPath, { force: true })
  }

  const { readFile } = await import('fs/promises')
  const contour      = JSON.parse(await readFile(outputPath, 'utf8'))
  ctx._f0Contour     = contour

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
    const proc = spawn('python', [F0_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(
        `estimate_f0_contour.py exited ${code}: ${stderr.slice(-500)}`,
      ))
    })
    proc.on('error', reject)
  })
}
