/**
 * Sibilance event map — shared detection results for downstream stages.
 *
 * Any pipeline stage that needs per-frame sibilance data calls
 * analyzeSibilanceEvents(ctx). By default a fresh analysis is always run
 * against ctx.currentPath so that the event map reflects the actual audio
 * at the point of the call — important when multiple stages in the pipeline
 * need sibilance data but the signal has changed significantly between them
 * (e.g. airBoost mutates the spectrum; the resonance suppressor should see
 * the post-mask audio, not the pre-mask boosted signal).
 *
 * Pass { useCache: true } to opt into returning a previously computed map
 * without re-running the Python script. This is appropriate when a caller
 * knows the sibilant frame timing has not changed relative to the most
 * recent analyzeSibilanceEvents() call (e.g. stages that read the map for
 * gating purposes but run after the audio has only been loudness-shifted).
 *
 * Resolution order (default — useCache: false):
 *   1. analyze_sibilance_events.py — dedicated detection pass on
 *                                    ctx.currentPath. Result stored to
 *                                    ctx._sibilanceEvents.
 *
 * Resolution order (useCache: true):
 *   1. ctx._sibilanceEvents — already computed; return immediately.
 *   2. analyze_sibilance_events.py — as above when cache is empty.
 *
 * Cache is stored outside ctx.results (internal pipeline plumbing, not a
 * report payload — buildReport() should never see it).
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
 * Return the sibilance event map for ctx.currentPath.
 *
 * @param {object}  ctx                  Pipeline context (see createContext in index.js)
 * @param {object}  [options]
 * @param {boolean} [options.useCache]   When true, return ctx._sibilanceEvents if already
 *                                       computed rather than re-running the analysis.
 *                                       Defaults to false — fresh analysis on every call.
 * @returns {Promise<{events: object, path: string}>}
 *   - events: parsed event map (see analyze_sibilance_events.py for shape)
 *   - path:   on-disk JSON file (registered with ctx.tmp) — pass to the
 *     suppressor via --events-json. Stable for the lifetime of ctx.
 */
export async function analyzeSibilanceEvents(ctx, { useCache = false } = {}) {
  // Return cached map only when the caller explicitly opts in.
  if (useCache && ctx._sibilanceEvents) return ctx._sibilanceEvents

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
