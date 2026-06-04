/**
 * Tests for the Python worker pool.
 *
 * Validates that:
 *   1. PYTHON_WORKER_POOL_SIZE>1 spawns the configured number of distinct
 *      Python processes (distinct pids).
 *   2. Tasks dispatched concurrently distribute across workers — i.e. each
 *      worker handles roughly its share of in-flight work, rather than
 *      everything funnelling into one process FIFO-style.
 *   3. Pool size 1 preserves the prior singleton behaviour.
 *
 * Uses the worker's built-in __ping__ control request so we don't take a
 * dependency on any real pipeline script in this test (no torch, no models).
 *
 * Each test isolates its pool via PYTHON_WORKER_POOL_SIZE + dynamic import
 * after a worker shutdown — the module reads the env var at load time, so
 * a fresh import is required to swap pool sizes between tests.
 *
 * Run with:  cd server && npm test
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'

let loadedModule = null
let loadedPoolSize = null

/**
 * Load (or reload) pythonWorker.js with the given pool size. The module
 * captures the env var at top-level evaluation, so we shut down any prior
 * pool, change the env var, and import via a cache-busting query string.
 */
async function loadWithPoolSize(size) {
  if (loadedModule && loadedPoolSize !== size) {
    await loadedModule.stopWorker()
    loadedModule = null
  }
  if (!loadedModule) {
    process.env.PYTHON_WORKER_POOL_SIZE = String(size)
    // Cache-bust the import so the new env var takes effect
    loadedModule = await import(`../pipeline/pythonWorker.js?poolSize=${size}-${Date.now()}`)
    loadedPoolSize = size
  }
  return loadedModule
}

after(async () => {
  if (loadedModule) {
    await loadedModule.stopWorker()
    loadedModule = null
  }
})

test('pool size > 1 spawns distinct worker processes', async () => {
  const { pingAllWorkers, getPoolSize } = await loadWithPoolSize(3)
  assert.equal(getPoolSize(), 3)

  const pids = await pingAllWorkers()
  assert.equal(pids.length, 3)
  for (const p of pids) {
    assert.ok(typeof p.pid === 'number' && p.pid > 0,
      `expected positive integer pid, got ${JSON.stringify(p)}`)
  }
  const uniquePids = new Set(pids.map(p => p.pid))
  assert.equal(uniquePids.size, 3,
    `expected 3 distinct worker pids, got ${[...uniquePids].join(',')}`)
})

test('concurrent dispatch distributes across workers', async () => {
  const { runPython, getPoolSize } = await loadWithPoolSize(3)
  assert.equal(getPoolSize(), 3)

  // Issue 6 pings concurrently — 2× pool size. If dispatch round-robins or
  // load-balances onto idle workers, each worker should handle ≥1 ping.
  // (A naïve FIFO singleton would send all 6 to the same pid.)
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => runPython('__ping__', [], `ping-${i}`)),
  )

  const pidCounts = new Map()
  for (const r of results) {
    pidCounts.set(r.pid, (pidCounts.get(r.pid) ?? 0) + 1)
  }
  assert.ok(pidCounts.size >= 2,
    `expected dispatch to use ≥2 worker pids; results landed entirely on pid ${[...pidCounts.keys()][0]}`)
  // No single worker should hog the dispatch (>=4 of 6 in one would suggest
  // a serialization bug). Loose check — leaves room for OS-scheduling jitter.
  for (const count of pidCounts.values()) {
    assert.ok(count <= 4,
      `single worker handled ${count}/6 pings — distribution heavily skewed`)
  }
})

test('per-call threads hint propagates through withThreadLimit to the worker', async () => {
  const { runPython, getChunkedThreadLimit } = await loadWithPoolSize(2)
  // Import threadingContext WITHOUT a cache-busting query string — the
  // pythonWorker module (also without a query string for its own internal
  // import of threadingContext) references the same AsyncLocalStorage
  // instance. Using a query string here would create a separate module
  // with a separate storage, and withThreadLimit values wouldn't reach
  // getThreadLimit in pythonWorker.
  const { withThreadLimit } = await import('../pipeline/threadingContext.js')

  // Outside any withThreadLimit scope, no hint is sent — the worker's
  // last_threads_hint should be null (env-default applies).
  const baseline = await runPython('__ping__', [], 'ping-baseline')
  assert.equal(baseline.last_threads_hint, null,
    `serial call should send no threads hint; got ${baseline.last_threads_hint}`)

  // Inside withThreadLimit(2), the worker should receive threads=2.
  const inChunked = await withThreadLimit(2, () => runPython('__ping__', [], 'ping-chunked'))
  assert.equal(inChunked.last_threads_hint, 2,
    `chunked-scope call should send threads=2; got ${inChunked.last_threads_hint}`)

  // After leaving the scope, subsequent calls should revert to no hint
  // (and the worker's _apply_torch_threads restores the env default).
  const afterChunked = await runPython('__ping__', [], 'ping-after')
  assert.equal(afterChunked.last_threads_hint, null,
    `post-scope call should send no threads hint; got ${afterChunked.last_threads_hint}`)

  // Sanity: getChunkedThreadLimit returns a sensible positive integer that
  // the chunked runner would use. With pool size 2 and the default
  // TORCH_NUM_THREADS=floor(cpus/2), chunked = min(default, floor(cpus/2))
  // = floor(cpus/2).
  assert.ok(getChunkedThreadLimit() >= 1, 'chunked thread limit should be ≥1')
})

test('pool size 1 preserves single-worker behaviour', async () => {
  const { runPython, getPoolSize, pingAllWorkers } = await loadWithPoolSize(1)
  assert.equal(getPoolSize(), 1)

  const pids = await pingAllWorkers()
  assert.equal(pids.length, 1)
  const lonePid = pids[0].pid

  // All concurrent pings must land on the same worker
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) => runPython('__ping__', [], `ping-${i}`)),
  )
  for (const r of results) {
    assert.equal(r.pid, lonePid,
      `pool size 1 should route every call to the same worker; got pid ${r.pid} vs ${lonePid}`)
  }
})

test('SERIAL_TORCH_THREADS raises serial dispatches; chunked scope still wins', async () => {
  // SERIAL_THREADS is captured at module load, so set the env and import a
  // fresh module instance. The cache-busting query is only on pythonWorker —
  // threadingContext is imported plainly so its AsyncLocalStorage instance is
  // shared with the worker module's internal import (so withThreadLimit reaches
  // getThreadLimit). Same reasoning as the withThreadLimit test above.
  // Ensure we don't keep a prior cached pool alive while spinning up a second
  // pythonWorker module instance for this env-dependent test.
  if (loadedModule) {
    await loadedModule.stopWorker()
    loadedModule = null
    loadedPoolSize = null
  }

  const prevSerial = process.env.SERIAL_TORCH_THREADS
  const prevPool   = process.env.PYTHON_WORKER_POOL_SIZE
  try {
    // Serial dispatch (no chunked scope) now carries the SERIAL hint instead
    // of falling back to the worker's spawn env-default.
    const serial = await mod.runPython('__ping__', [], 'ping-serial')
    assert.equal(serial.last_threads_hint, 5,
      `serial call should send SERIAL_TORCH_THREADS=5; got ${serial.last_threads_hint}`)

    // A chunked scope still takes priority over the serial default.
    const chunked = await withThreadLimit(2, () => mod.runPython('__ping__', [], 'ping-chunked'))
    assert.equal(chunked.last_threads_hint, 2,
      `chunked scope should override the serial default; got ${chunked.last_threads_hint}`)
  } finally {
    await mod.stopWorker()
    if (prevSerial === undefined) delete process.env.SERIAL_TORCH_THREADS
    else process.env.SERIAL_TORCH_THREADS = prevSerial
    if (prevPool === undefined) delete process.env.PYTHON_WORKER_POOL_SIZE
    else process.env.PYTHON_WORKER_POOL_SIZE = prevPool
  }
})
