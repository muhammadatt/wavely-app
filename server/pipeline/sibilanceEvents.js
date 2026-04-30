/**
 * Sibilance event map — shared detection results for downstream stages.
 *
 * The standard sibilance suppressor and a future sibilant-aware airBoost
 * both need to know which STFT frames contain sibilant energy. Running
 * detection twice would double the STFT cost and risk inconsistency
 * (different thresholds, different rolling F0 windows). This module wraps
 * `analyze_sibilance_events.py`, caches the result on the pipeline ctx,
 * and returns the map on subsequent calls.
 *
 * The cached fields are pipeline-stable: sample-rate-tied frame indices,
 * timestamps, and per-frame F0. Frequency centroids and energy values are
 * intentionally NOT cached — those become stale after stages like NR,
 * compression, or air boost mutate the spectrum.
 */

import { spawn }         from 'child_process'
import { fileURLToPath } from 'url'
import { readFile, writeFile, rm } from 'fs/promises'
import os                from 'os'
import path              from 'path'
import { PYTHON as SHARED_PYTHON } from './spawnPython.js'
import { writeSibilanceParamsFile } from './enhancement.js'

const RESONANCE_PYTHON = process.env.RESONANCE_PYTHON ?? SHARED_PYTHON
const NUM_THREADS      = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)

const SCRIPTS_DIR     = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const ANALYZER_SCRIPT = path.join(SCRIPTS_DIR, 'analyze_sibilance_events.py')

/**
 * Return the sibilance event map for the current ctx audio, computing it
 * once and caching on `ctx._sibilanceEvents`. Subsequent calls return the
 * cached object without re-spawning the analyzer.
 *
 * The cache is stored outside `ctx.results` because it is internal pipeline
 * plumbing, not a report payload. `buildReport()` should never see it.
 *
 * @param {object} ctx - Pipeline context (see createContext in index.js)
 * @returns {Promise<{events: object, path: string}>}
 *   - events: parsed event map (see analyze_sibilance_events.py for shape)
 *   - path:   on-disk JSON file (registered with ctx.tmp) — pass to the
 *     suppressor via --events-json. Stable for the lifetime of ctx.
 */
export async function analyzeSibilanceEvents(ctx) {
  if (ctx._sibilanceEvents) return ctx._sibilanceEvents

  const eventsPath = ctx.tmp('.json')
  const frames     = ctx.results.metrics?.frames ?? null
  const f0         = ctx.results.deEss?.f0Hz ?? null

  const args = [
    ANALYZER_SCRIPT,
    '--input',  ctx.currentPath,
    '--output', eventsPath,
  ]

  // Must match the params the suppressor will see, otherwise the cached
  // sibilantFrameIndices won't align with the suppressor's reduction step.
  const paramsPath = await writeSibilanceParamsFile(ctx.presetId)
  if (paramsPath) args.push('--params-json', paramsPath)

  if (f0 != null) args.push('--f0', String(f0))

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
  }

  const events = JSON.parse(await readFile(eventsPath, 'utf8'))
  ctx._sibilanceEvents = { events, path: eventsPath }

  const durationMs = Date.now() - startTime
  console.log(
    `[SibilanceAnalyzer] Done in ${durationMs}ms: frames=${events.frameCount} ` +
    `sibilant=${events.sibilantFrameIndices.length} events=${events.events.length} ` +
    `f0_median=${events.f0?.median ?? 'n/a'}Hz`,
  )

  return ctx._sibilanceEvents
}

// The analyzer uses the same JSON_RESULT: line-prefix protocol as the
// suppressor (summary line on stdout, heavy data written to --output).
// We don't parse the summary here — the cached file is the source of
// truth — but we filter it from the streamed log for cleanliness.
function runAnalyzerScript(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(RESONANCE_PYTHON, args, {
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
