/**
 * Persistent Python worker pool — pipes JSON requests to one or more
 * long-lived Python processes and resolves their JSON responses.
 *
 * Each worker process (server/scripts/_worker.py) dispatches each request
 * to the named script's module-level `run(argv)` function. Modules are
 * lazy-imported and stay loaded for the lifetime of the worker, so torch /
 * numpy imports and (where the script caches them) ML model weights are
 * amortized across every pipeline stage.
 *
 * Pool sizing: PYTHON_WORKER_POOL_SIZE (default 1). With size 1 the pool
 * behaves exactly like the prior singleton — one process, FIFO queue. With
 * size N the dispatcher routes each request to whichever worker is idle;
 * tasks beyond N in-flight wait in a JS-side queue (no double-queueing on
 * a single Python process). The pool is lazy: workers spawn on demand.
 *
 * Stage-level parallelism gated on this: chunked block runs `noiseReduce`
 * (DF3 → RNNoise) per chunk; before the pool every Python call serialized
 * through a single worker, so chunking gave no wall-clock win for the slow
 * stages. With the pool, N chunks worth of inner Python stages run on N
 * cores simultaneously (workers are CPU-bound — RNNoise et al. don't use
 * GPU — so each worker pinned to its own core scales near-linearly until
 * physical core count).
 *
 * If a worker dies unexpectedly, only that worker's pending requests reject;
 * the pool respawns its slot on next dispatch. Other workers keep serving.
 *
 * ⚠ Per-call threading is BEST-EFFORT, not guaranteed. Workers also accept a
 * `threads` hint per request (see threadingContext.js); _worker.py applies
 * it via torch.set_num_threads() + threadpoolctl. This works for libraries
 * that respect runtime thread-pool changes (most NumPy/scipy work, RNNoise,
 * click_remover, etc.) but does NOT work for DeepFilterNet3 — its torch /
 * MKL / OpenMP thread pools are pinned at first inference using whatever
 * env value was set at worker spawn, and subsequent runtime calls don't
 * shrink the already-spawned worker threads. Empirical result on 8 vCPU:
 * TORCH_NUM_THREADS=6 + per-call=2 → DF3 oversubscribes anyway (1300+ s/chunk);
 * TORCH_NUM_THREADS=3 env-consistent → DF3 healthy (~85 s/chunk).
 * For stages where this matters (currently only DF3), set TORCH_NUM_THREADS
 * to the value that's safe at full chunked concurrency rather than relying
 * on the per-call path to clamp it. See GitHub issue for revisit.
 *
 * Environment:
 *   SEPARATION_PYTHON         — Python executable (default: python3)
 *   PYTHON_WORKER_POOL_SIZE   — number of worker processes (default: 1)
 *   TORCH_NUM_THREADS         — per-worker torch thread count, applied at
 *                                worker spawn via env. ⚠ This is what DF3
 *                                actually uses (see note above); set it
 *                                conservatively for chunked workloads.
 *                                (default: floor(CPU count / pool size))
 *   CHUNKED_TORCH_THREADS     — per-call torch thread hint for chunked-block
 *                                dispatches. Best-effort runtime override —
 *                                see note above on the DF3 limitation.
 *                                Defaults to min(TORCH_NUM_THREADS,
 *                                floor(cpus/pool_size)).
 *   WAVELY_DISABLE_PY_WORKER  — set to '1' to force the legacy spawn path
 *                                in spawnPython.js (escape hatch)
 */

import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

import { getThreadLimit } from './threadingContext.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

export const PYTHON = process.env.SEPARATION_PYTHON ?? 'python3'
const SCRIPTS_DIR   = path.resolve(__dirname, '..', 'scripts')
const WORKER_SCRIPT = path.join(SCRIPTS_DIR, '_worker.py')

const POOL_SIZE = Math.max(1, parseInt(process.env.PYTHON_WORKER_POOL_SIZE ?? '1', 10) || 1)

// Per-worker thread caps default to a fair share of physical cores —
// floor(cpus / pool size) — so the combined OMP/MKL/torch thread budget
// across all workers stays at or below os.cpus().length. Rounding down
// (rather than up) prevents oversubscription when CPU count isn't evenly
// divisible: a host with 8 cores and pool size 3 gives 2 threads per
// worker × 3 = 6 threads (2 cores headroom) instead of 3 × 3 = 9 threads
// (1 thread oversubscribed). Callers who know their workload can pin via
// TORCH_NUM_THREADS.
const NUM_THREADS = process.env.TORCH_NUM_THREADS
  ?? String(Math.max(1, Math.floor(os.cpus().length / POOL_SIZE)))

// Chunked-block thread cap. When the chunked runner dispatches inner stages
// concurrently, multiple workers share the CPU at once — so each call needs
// fewer threads than a serial call would. Defaults to
// min(TORCH_NUM_THREADS, floor(cpus/pool_size)) so bumping TORCH_NUM_THREADS
// for serial throughput automatically clamps chunked calls back to a safe
// budget. Override explicitly via CHUNKED_TORCH_THREADS to tune (e.g. 2 if
// you've observed contention even at the auto value).
const CHUNKED_THREADS = (() => {
  const explicit = process.env.CHUNKED_TORCH_THREADS
  if (explicit) {
    const n = parseInt(explicit, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  const torchDefault = parseInt(NUM_THREADS, 10) || 1
  const safeDefault  = Math.max(1, Math.floor(os.cpus().length / POOL_SIZE))
  return Math.min(torchDefault, safeDefault)
})()

// ─── WorkerHandle ────────────────────────────────────────────────────────────

/**
 * A single Python worker process. Owns its child_process handle, its own
 * pending-request map, and a tiny stdout line buffer. The pool flips its
 * `busy` flag while a request is in flight so dispatch never sends a second
 * request to the same worker.
 */
class WorkerHandle {
  constructor(index) {
    this.index        = index
    this.proc         = null
    this.pending      = new Map()      // id -> { resolve, reject, label }
    this.stdoutBuffer = ''
    this.busy         = false
  }

  ensureStarted() {
    if (this.proc) return this.proc

    const proc = spawn(PYTHON, [WORKER_SCRIPT], {
      cwd:   SCRIPTS_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS:   NUM_THREADS,
        MKL_NUM_THREADS:   NUM_THREADS,
        TORCH_NUM_THREADS: NUM_THREADS,
        PYTHONUNBUFFERED:  '1',
        PYTHONPATH: SCRIPTS_DIR + path.delimiter + (process.env.PYTHONPATH ?? ''),
      },
    })

    proc.stdout.on('data', chunk => {
      this.stdoutBuffer += chunk.toString()
      let nl
      while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
        const line        = this.stdoutBuffer.slice(0, nl).trim()
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1)
        if (line) this._handleResponseLine(line)
      }
    })

    proc.stderr.on('data', chunk => {
      const tag = POOL_SIZE > 1 ? `[python#${this.index}]` : '[python]'
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) console.log(`${tag} ${line}`)
      }
    })

    proc.on('exit', (code, signal) => {
      const err = new Error(`Python worker ${this.index} exited (code=${code}, signal=${signal})`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.stdoutBuffer = ''
      this.proc         = null
      this.busy         = false
      // Pool will respawn this slot lazily on next dispatch.
    })

    proc.on('error', err => {
      const wrapped = new Error(`Python worker ${this.index} spawn failed: ${err.message}`)
      for (const p of this.pending.values()) p.reject(wrapped)
      this.pending.clear()
      this.proc = null
      this.busy = false
    })

    this.proc = proc
    return proc
  }

  _handleResponseLine(line) {
    let res
    try {
      res = JSON.parse(line)
    } catch {
      console.warn(`[python#${this.index}] non-JSON stdout: ${line.slice(0, 500)}`)
      return
    }

    const p = this.pending.get(res.id)
    if (!p) {
      console.warn(`[python#${this.index}] response with unknown id=${res.id}`)
      return
    }
    this.pending.delete(res.id)

    if (res.ok) {
      p.resolve(res.result ?? {})
    } else {
      const details = res.traceback ? `\n${res.traceback}` : ''
      p.reject(new Error(`${p.label} failed: ${res.error}${details}`))
    }
  }

  /**
   * Send a request and resolve with the worker's response. Caller must
   * ensure `busy` is set before calling and clear it on settlement.
   *
   * `threads`, when set, is forwarded to the worker which calls
   * torch.set_num_threads() before dispatching the script. The worker
   * doesn't restore afterwards — every dispatch that omits `threads` falls
   * back to the worker's env-default thread count by re-applying it.
   */
  send(script, argv, label, threads) {
    this.ensureStarted()
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, label })
      const req = { id, script, args: argv }
      if (threads != null) req.threads = threads
      const payload = JSON.stringify(req) + '\n'
      this.proc.stdin.write(payload, err => {
        if (err) {
          this.pending.delete(id)
          reject(new Error(`${label} failed to send to worker ${this.index}: ${err.message}`))
        }
      })
    })
  }

  async shutdown() {
    if (!this.proc) return
    return new Promise(resolve => {
      this.proc.once('exit', () => resolve())
      try {
        this.proc.stdin.write(JSON.stringify({ script: '__shutdown__' }) + '\n')
        this.proc.stdin.end()
      } catch {
        this.proc.kill()
      }
    })
  }
}

// ─── Pool ────────────────────────────────────────────────────────────────────

const workers     = Array.from({ length: POOL_SIZE }, (_, i) => new WorkerHandle(i))
const waitingTasks = []  // { script, argv, label, resolve, reject }

/**
 * Find the first idle worker, or null if all are busy.
 */
function findIdleWorker() {
  for (const w of workers) {
    if (!w.busy) return w
  }
  return null
}

/**
 * Dispatch a task to a worker, marking it busy for the duration. On
 * settlement, free the worker and drain the next queued task (if any) into
 * the freshly-idle slot.
 */
function dispatchOnWorker(worker, task) {
  worker.busy = true
  worker.send(task.script, task.argv, task.label, task.threads).then(
    result => {
      worker.busy = false
      task.resolve(result)
      drainQueue()
    },
    err => {
      worker.busy = false
      task.reject(err)
      drainQueue()
    },
  )
}

function drainQueue() {
  while (waitingTasks.length > 0) {
    const worker = findIdleWorker()
    if (!worker) return
    const task = waitingTasks.shift()
    dispatchOnWorker(worker, task)
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Dispatch a script to an idle worker, or queue if all workers are busy.
 *
 * The per-call PyTorch thread count is read from the AsyncLocalStorage hint
 * set by the chunked runner; serial calls (no hint) fall back to the
 * worker's env-default. See threadingContext.js.
 *
 * @param {string}   script — module name (no .py), matches a file in server/scripts/
 * @param {string[]} argv   — argv-style args (e.g. ['--input', '/tmp/x.wav'])
 * @param {string}   label  — label for log messages and errors
 * @returns {Promise<object>} — the dict returned by the script's run(argv)
 */
export function runPython(script, argv = [], label = script) {
  return new Promise((resolve, reject) => {
    const threads = getThreadLimit()
    const task = { script, argv, label, threads, resolve, reject }
    const worker = findIdleWorker()
    if (worker) {
      dispatchOnWorker(worker, task)
    } else {
      waitingTasks.push(task)
    }
  })
}

/**
 * Health check — returns the worker[0]'s pid (spawns it if not running).
 * Preserves the prior singleton API; tests / health probes typically only
 * care that *a* worker is alive.
 */
export async function pingWorker() {
  return runPython('__ping__', [], 'worker-ping')
}

/**
 * Ping every worker in the pool (spawning any that haven't started yet).
 * Resolves to an array of `{ index, pid }`, useful in pool tests to confirm
 * each worker is a distinct process.
 */
export async function pingAllWorkers() {
  // Issue pingS concurrently, but force each onto a distinct worker by
  // saturating the pool first — each ping blocks its worker until the
  // response arrives. Sequential await would round-robin onto the same idle
  // worker every time.
  const inflight = workers.map((_, i) => runPython('__ping__', [], `worker-ping-${i}`))
  const results  = await Promise.all(inflight)
  return results.map((r, i) => ({ index: i, pid: r.pid }))
}

/**
 * Stop all workers if running. Intended for tests and graceful shutdown.
 */
export async function stopWorker() {
  await Promise.all(workers.map(w => w.shutdown()))
}

/**
 * Pool size (read-only). Useful for callers that want to size their own
 * concurrency to match — e.g. the chunked runner's CHUNKED_CONCURRENCY cap
 * should typically not exceed this.
 */
export function getPoolSize() {
  return POOL_SIZE
}

/**
 * Resolved per-call PyTorch thread count for chunked-block dispatches.
 * The chunked runner wraps its inner-stage calls in withThreadLimit using
 * this value so concurrent workers stay below physical core count.
 */
export function getChunkedThreadLimit() {
  return CHUNKED_THREADS
}
