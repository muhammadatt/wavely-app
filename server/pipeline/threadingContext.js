/**
 * Per-call threading context for the Python worker pool.
 *
 * Worker processes are long-lived and spawned with a single
 * TORCH_NUM_THREADS env value — so historically every call dispatched to a
 * worker used the same thread count. That's the wrong shape for our
 * workload: serial stages benefit from many threads (only one worker is
 * busy → idle cores left on the table), while chunked stages need few
 * threads (multiple workers in parallel → oversubscription crushes PyTorch).
 * A single static value can't be optimal for both.
 *
 * AsyncLocalStorage solves this without invasive API changes. The chunked
 * runner sets a thread-limit hint on the async context before dispatching
 * inner stages; runPython reads the hint at dispatch time and forwards it
 * to the worker, which calls torch.set_num_threads() before running the
 * script. Stages running outside any chunked block see no hint and the
 * worker uses its env default — the high serial value.
 *
 * Async propagation is automatic via async_hooks: every await/then chain
 * inside withThreadLimit's callback inherits the context. No threading the
 * value through every intermediate stage function.
 */

import { AsyncLocalStorage } from 'async_hooks'

const threadCtx = new AsyncLocalStorage()

/**
 * Run `fn` inside a threading context that requests `threads` PyTorch
 * threads for any runPython call dispatched from within. Nested calls
 * inherit the innermost value.
 *
 * @param {number}  threads — per-worker thread count to request
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withThreadLimit(threads, fn) {
  return threadCtx.run({ threads }, fn)
}

/**
 * Read the current thread-limit hint, or undefined if none is set.
 * runPython calls this just before sending its payload to the worker.
 */
export function getThreadLimit() {
  return threadCtx.getStore()?.threads
}
