/**
 * Sibilance event map — detection-only Python pass for downstream stages.
 *
 * Any pipeline stage that needs per-frame sibilance data calls
 * analyzeSibilanceEvents(ctx, { params, f0Contour }) and gets a freshly
 * computed map back. Two design properties:
 *
 *   1. Each caller supplies its own detection params (sparse overrides
 *      over server/scripts/sibilance_detector.DEFAULT_PARAMS). airBoost
 *      uses `preset.airBoost.sibilanceDetection`; a `sibilant_only`
 *      resonanceSuppressor pass uses
 *      `preset.resonanceSuppressor[i].sibilanceDetection`. There is no
 *      shared "preset-level" sibilance config any more.
 *
 *   2. The F0 contour comes from getF0Contour() in f0Analysis.js. The
 *      detector consumes it directly instead of running a second
 *      autocorrelation pass. Callers should pass the cached contour
 *      (e.g. `await getF0Contour(ctx, { useCache: true })`) when the
 *      audio has not changed since the last contour pass.
 *
 * No shared event-map cache: each caller's params may differ, so caching
 * across stages would silently return the wrong map. If the same stage
 * needs the result twice it should hold the return value itself.
 */

import { spawn }                  from 'child_process'
import { fileURLToPath }          from 'url'
import { readFile, writeFile, rm } from 'fs/promises'
import os                         from 'os'
import path                       from 'path'
import { PYTHON as SHARED_PYTHON } from './spawnPython.js'

const SIBILANCE_PYTHON = process.env.RESONANCE_PYTHON ?? SHARED_PYTHON
const NUM_THREADS      = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)

const SCRIPTS_DIR     = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const ANALYZER_SCRIPT = path.join(SCRIPTS_DIR, 'analyze_sibilance_events.py')

/**
 * Run a sibilance event analysis pass against ctx.currentPath.
 *
 * @param {object}  ctx                  Pipeline context (see createContext in index.js).
 * @param {object}  [options]
 * @param {object}  [options.params]     Sparse override dict overlaid on
 *                                       sibilance_detector.DEFAULT_PARAMS.
 *                                       Caller-specific (airBoost vs.
 *                                       resonanceSuppressor pass, etc.).
 * @param {object}  options.f0Contour    Per-frame F0 contour from
 *                                       getF0Contour() in f0Analysis.js.
 *                                       Required — the detector no longer
 *                                       runs its own pitch estimation.
 * @returns {Promise<{events: object, path: string}>}
 *   - events: parsed event map (see sibilance_detector.build_events_map)
 *   - path:   on-disk JSON file (registered with ctx.tmp); pass to
 *             resonance_suppressor.py via --events-json or to
 *             air_boost_masked.py via --events. Stable for the lifetime
 *             of ctx.
 */
export async function analyzeSibilanceEvents(ctx, { params, f0Contour } = {}) {
  if (!f0Contour) {
    throw new Error(
      'analyzeSibilanceEvents requires an f0Contour. ' +
      'Call getF0Contour(ctx) first and pass the result in.',
    )
  }

  const eventsPath  = ctx.tmp('.json')
  const contourPath = ctx.tmp('.json')
  await writeFile(contourPath, JSON.stringify(f0Contour))

  const args = [
    ANALYZER_SCRIPT,
    '--input',            ctx.currentPath,
    '--output',           eventsPath,
    '--f0-contour-json',  contourPath,
  ]

  let paramsPath = null
  if (params && Object.keys(params).length > 0) {
    paramsPath = ctx.tmp('.json')
    await writeFile(paramsPath, JSON.stringify(params))
    args.push('--params-json', paramsPath)
  }

  const frames = ctx.results.metrics?.frames ?? null
  let vadMaskPath = null
  if (frames && frames.length > 0) {
    vadMaskPath = ctx.tmp('.json')
    await writeFile(vadMaskPath, JSON.stringify(frames))
    args.push('--vad-mask-json', vadMaskPath)
  }

  console.log(`[SibilanceAnalyzer] Starting: preset=${ctx.presetId} | input=${ctx.currentPath}`)
  const startTime = Date.now()

  try {
    await runAnalyzerScript(args)
  } finally {
    if (vadMaskPath) await rm(vadMaskPath, { force: true })
    if (paramsPath)  await rm(paramsPath,  { force: true })
    await rm(contourPath, { force: true })
  }

  const events = JSON.parse(await readFile(eventsPath, 'utf8'))

  const durationMs = Date.now() - startTime
  console.log(
    `[SibilanceAnalyzer] Done in ${durationMs}ms: frames=${events.frameCount} ` +
    `sibilant=${events.sibilantFrameIndices.length} events=${events.events.length} ` +
    `f0_median=${events.f0?.median ?? 'n/a'}Hz`,
  )

  return { events, path: eventsPath }
}

// The analyzer uses the same JSON_RESULT: line-prefix protocol as the
// suppressor (summary line on stdout, heavy data written to --output).
function runAnalyzerScript(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(SIBILANCE_PYTHON, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS:   NUM_THREADS,
        MKL_NUM_THREADS:   NUM_THREADS,
        TORCH_NUM_THREADS: NUM_THREADS,
      },
    })

    let stderr = ''
    let stdoutBuffer = ''

    proc.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString()
      const lines  = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop()
      for (const line of lines) {
        if (line.trim() && !line.startsWith('JSON_RESULT:')) {
          console.log(`[SibilanceAnalyzer] ${line}`)
        }
      }
    })

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    proc.on('close', (code, signal) => {
      if (stdoutBuffer.trim() && !stdoutBuffer.startsWith('JSON_RESULT:')) {
        console.log(`[SibilanceAnalyzer] ${stdoutBuffer.trim()}`)
      }
      if (stderr.trim() && code === 0) console.log(`[SibilanceAnalyzer] ${stderr.trim()}`)

      if (code === 0 && signal === null) {
        resolve()
      } else {
        const parts = []
        if (code   !== null) parts.push(`code ${code}`)
        if (signal !== null) parts.push(`signal ${signal}`)
        reject(new Error(`SibilanceAnalyzer exited with ${parts.join(', ')}.\n${stderr.slice(-2000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn SibilanceAnalyzer: ${err.message}`))
    })
  })
}
