/**
 * Python subprocess spawners for ML pipeline stages.
 *
 * Two execution paths:
 *
 *   1. Persistent worker (default) — scripts listed in WORKER_SCRIPTS are
 *      dispatched into a long-lived Python process (server/scripts/_worker.py).
 *      Imports and (where the script caches them) ML models persist across
 *      calls, so the second invocation of any given stage is much faster
 *      than today's cold-start spawn.
 *
 *   2. Legacy spawn — every other script (and everything if the env var
 *      WAVELY_DISABLE_PY_WORKER=1 is set) still goes through a fresh
 *      `spawn(python, [script, ...args])` invocation, identical to the
 *      pre-worker behavior. This is the fallback while individual scripts
 *      are migrated to expose a top-level `run(argv)` function.
 *
 * Call sites do not need to know which path is taken — `spawnPython` and
 * `spawnPythonCapture` keep their existing signatures.
 *
 * Environment:
 *   SEPARATION_PYTHON         — Python executable (default: python3)
 *   SEPARATION_DEVICE         — Compute device for device-aware scripts
 *   TORCH_NUM_THREADS         — torch thread count (default: CPU count)
 *   WAVELY_DISABLE_PY_WORKER  — set to '1' to force the legacy path
 */

import { spawn } from 'child_process'
import os from 'os'
import path from 'path'

import { runPython } from './pythonWorker.js'

export const PYTHON = process.env.SEPARATION_PYTHON ?? 'python3'
export const DEVICE = process.env.SEPARATION_DEVICE ?? 'auto'
const NUM_THREADS = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)

// Scripts that have been refactored to expose a top-level `run(argv)` function
// callable from _worker.py. Anything not in this set falls through to the
// legacy spawn path. Add a script name (no .py) once its main() has been
// updated to accept an `argv` parameter and return its result dict.
const WORKER_SCRIPTS = new Set([
  'deepfilter_enhance',
  'rnnoise_denoise',
  'corrective_eq',
  'reference_eq',
  'vocal_saturation',
  'air_boost_precut',
  'click_remover',
  'room_presence',
])

function workerEnabled() {
  return process.env.WAVELY_DISABLE_PY_WORKER !== '1'
}

function scriptBaseName(scriptPath) {
  // Callers pass an absolute path to the .py file; the worker dispatches by
  // module name (the filename without extension).
  return path.basename(scriptPath, '.py')
}

function shouldUseWorker(scriptPath) {
  if (!workerEnabled()) return false
  return WORKER_SCRIPTS.has(scriptBaseName(scriptPath))
}

/**
 * Fire-and-forget: run a Python script, stream its stdout/stderr to the
 * server log, resolve when it exits 0.
 *
 * Worker path: the script's run(argv) is dispatched into the persistent
 * worker; its return dict is discarded.
 *
 * Legacy path: spawn a fresh `python <script> <args>` process.
 */
export async function spawnPython(script, args, label, extraEnv = {}) {
  if (shouldUseWorker(script)) {
    // The worker doesn't accept per-call env overrides — extraEnv was used
    // by the legacy path to set things like SEPARATION_DEVICE per call. In
    // practice every caller passes the same values, so the worker's process
    // env (set once at startup) is fine. If a future caller needs a true
    // per-call override, gate that script out of WORKER_SCRIPTS.
    await runPython(scriptBaseName(script), args, label)
    return
  }
  return legacySpawn(script, args, label, extraEnv, /* capture */ false)
}

/**
 * Run a Python script and parse its stdout as JSON. Stderr is streamed
 * to the server log.
 *
 * Worker path: the script's run(argv) is dispatched into the persistent
 * worker; its return dict is the resolved value.
 *
 * Legacy path: spawn + capture stdout + JSON.parse.
 */
export async function spawnPythonCapture(script, args, label, extraEnv = {}) {
  if (shouldUseWorker(script)) {
    return runPython(scriptBaseName(script), args, label)
  }
  return legacySpawn(script, args, label, extraEnv, /* capture */ true)
}

// ---------------------------------------------------------------------------
// Legacy spawn path — used for scripts not yet migrated to the worker.
// Behavior matches the pre-worker implementation exactly.
// ---------------------------------------------------------------------------

function legacySpawn(script, args, label, extraEnv, capture) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS:   NUM_THREADS,
        MKL_NUM_THREADS:   NUM_THREADS,
        TORCH_NUM_THREADS: NUM_THREADS,
        ...extraEnv,
      },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', chunk => {
      if (capture) {
        stdout += chunk.toString()
      } else {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) console.log(`[${label}] ${line}`)
        }
      }
    })

    proc.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[${label}] ${line}`)
      }
    })

    proc.on('close', (code, signal) => {
      if (code === 0 && signal === null) {
        if (capture) {
          try {
            resolve(JSON.parse(stdout))
          } catch (err) {
            const details = [
              `${label} produced invalid JSON on stdout: ${err.message}`,
              `stdout (tail):\n${stdout.trim().slice(-3000) || '(empty)'}`,
            ]
            if (stderr.trim()) details.push(`stderr (tail):\n${stderr.trim().slice(-3000)}`)
            reject(new Error(details.join('\n')))
          }
        } else {
          resolve()
        }
      } else {
        const parts = []
        if (code   !== null) parts.push(`code ${code}`)
        if (signal !== null) parts.push(`signal ${signal}`)
        reject(new Error(`${label} exited with ${parts.join(', ') || 'unknown reason'}.\n${stderr.slice(-3000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn ${label}: ${err.message}`))
    })
  })
}
