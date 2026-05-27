/**
 * Persistent Python worker — singleton that pipes JSON requests to a
 * long-lived Python process and resolves their JSON responses.
 *
 * The worker process (server/scripts/_worker.py) dispatches each request
 * to the named script's module-level `run(argv)` function. Modules are
 * lazy-imported and stay loaded for the lifetime of the worker, so torch /
 * numpy imports and (where the script caches them) ML model weights are
 * amortized across every pipeline stage.
 *
 * The singleton is lazy: the worker is spawned on the first `runPython`
 * call. Subsequent calls reuse it. If the worker dies unexpectedly all
 * in-flight requests reject; the next call respawns a fresh worker.
 *
 * Concurrency: requests are queued and processed in FIFO order on the
 * Python side. Single worker = serial Python work, which matches today's
 * `spawn()`-per-stage behavior (the pipeline itself is serial). Pooling
 * can be added later if intra-file chunked parallelism is introduced.
 *
 * Environment:
 *   SEPARATION_PYTHON         — Python executable (default: python3)
 *   TORCH_NUM_THREADS         — torch thread count (default: CPU count)
 *   WAVELY_DISABLE_PY_WORKER  — set to '1' to force the legacy spawn path
 *                                in spawnPython.js (escape hatch)
 */

import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

export const PYTHON       = process.env.SEPARATION_PYTHON ?? 'python3'
const SCRIPTS_DIR         = path.resolve(__dirname, '..', 'scripts')
const WORKER_SCRIPT       = path.join(SCRIPTS_DIR, '_worker.py')
const NUM_THREADS         = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)

let workerProc    = null
let stdoutBuffer  = ''
const pending     = new Map()      // id -> { resolve, reject, label }

function buildWorkerEnv(extraEnv = {}) {
  return {
    ...process.env,
    OMP_NUM_THREADS:   NUM_THREADS,
    MKL_NUM_THREADS:   NUM_THREADS,
    TORCH_NUM_THREADS: NUM_THREADS,
    // PYTHONUNBUFFERED so script print() to stderr surfaces immediately
    // in our log stream, not after the script returns.
    PYTHONUNBUFFERED:  '1',
    // _worker.py imports peer scripts by name (e.g. `import deepfilter_enhance`).
    // Prepend the scripts dir so those imports resolve regardless of cwd.
    PYTHONPATH: SCRIPTS_DIR + path.delimiter + (process.env.PYTHONPATH ?? ''),
    ...extraEnv,
  }
}

function startWorker() {
  if (workerProc) return workerProc

  const proc = spawn(PYTHON, [WORKER_SCRIPT], {
    cwd:   SCRIPTS_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env:   buildWorkerEnv(),
  })

  proc.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString()
    // The protocol is one JSON object per newline. Drain complete lines;
    // partial trailing bytes stay in the buffer for the next chunk.
    let nl
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const line   = stdoutBuffer.slice(0, nl).trim()
      stdoutBuffer = stdoutBuffer.slice(nl + 1)
      if (line) handleResponseLine(line)
    }
  })

  proc.stderr.on('data', chunk => {
    // Script-level print() and our own readiness banner come through here.
    // We don't know which pending request emitted each line (Python is
    // single-threaded within the worker, so it's "the currently-running one"),
    // so we tag with a generic prefix.
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) console.log(`[python] ${line}`)
    }
  })

  proc.on('exit', (code, signal) => {
    const reason = `Python worker exited (code=${code}, signal=${signal})`
    const err = new Error(reason)
    for (const p of pending.values()) p.reject(err)
    pending.clear()
    stdoutBuffer = ''
    workerProc   = null
  })

  proc.on('error', err => {
    const wrapped = new Error(`Python worker spawn failed: ${err.message}`)
    for (const p of pending.values()) p.reject(wrapped)
    pending.clear()
    workerProc = null
  })

  workerProc = proc
  return proc
}

function handleResponseLine(line) {
  let res
  try {
    res = JSON.parse(line)
  } catch (err) {
    // The worker is supposed to keep stdout protocol-clean, but if a
    // stray write slips through we don't want to lose track of pending
    // requests. Log and move on.
    console.warn(`[python] non-JSON stdout: ${line.slice(0, 500)}`)
    return
  }

  const p = pending.get(res.id)
  if (!p) {
    console.warn(`[python] response with unknown id=${res.id}`)
    return
  }
  pending.delete(res.id)

  if (res.ok) {
    p.resolve(res.result ?? {})
  } else {
    const details = res.traceback ? `\n${res.traceback}` : ''
    p.reject(new Error(`${p.label} failed: ${res.error}${details}`))
  }
}

/**
 * Dispatch a script to the persistent worker.
 *
 * @param {string} script — module name (no .py), matches a file in server/scripts/
 * @param {string[]} argv — argv-style args (e.g. ['--input', '/tmp/x.wav'])
 * @param {string} label  — label for log messages and errors
 * @returns {Promise<object>} — the dict returned by the script's run(argv)
 */
export function runPython(script, argv = [], label = script) {
  const proc = startWorker()
  const id   = randomUUID()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, label })
    const payload = JSON.stringify({ id, script, args: argv }) + '\n'
    proc.stdin.write(payload, err => {
      if (err) {
        pending.delete(id)
        reject(new Error(`${label} failed to send to worker: ${err.message}`))
      }
    })
  })
}

/**
 * Health check — returns the worker's pid (spawns it if not running).
 */
export async function pingWorker() {
  return runPython('__ping__', [], 'worker-ping')
}

/**
 * Stop the worker if running. Intended for tests and graceful shutdown.
 */
export function stopWorker() {
  if (!workerProc) return Promise.resolve()
  return new Promise(resolve => {
    workerProc.once('exit', () => resolve())
    try {
      workerProc.stdin.write(JSON.stringify({ script: '__shutdown__' }) + '\n')
      workerProc.stdin.end()
    } catch {
      workerProc.kill()
    }
  })
}
