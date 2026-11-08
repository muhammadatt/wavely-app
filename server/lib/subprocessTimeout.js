/**
 * Wall-clock limits for the processes the pipeline starts.
 *
 * A malformed upload or a model that wedges must not hold a CPU (and a job
 * slot) forever. Every spawn site arms `killAfter` on its child; when the limit
 * passes the child is SIGKILLed — not SIGTERM, since a process stuck in native
 * code may never act on a polite signal — and the caller rejects with
 * `timeoutError` instead of the bare "signal SIGKILL" the close handler sees.
 *
 * These are hang guards, not cost controls: the default is generous enough for
 * Demucs on a long chapter on CPU. Tighten it per deployment.
 *
 * Environment:
 *   SUBPROCESS_TIMEOUT_MS  per-process limit (default 60 min; 0 disables)
 *   PROBE_TIMEOUT_MS       ffprobe limit     (default 2 min;  0 disables)
 */

function readMs(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export const SUBPROCESS_TIMEOUT_MS = readMs('SUBPROCESS_TIMEOUT_MS', 60 * 60 * 1000)
export const PROBE_TIMEOUT_MS = readMs('PROBE_TIMEOUT_MS', 2 * 60 * 1000)

/**
 * Kill `proc` if it is still running after `ms`. Returns a watch whose
 * `timedOut` is true once the limit fired; the timer clears itself when the
 * process exits. `ms` of 0 (or less) arms nothing.
 */
export function killAfter(proc, label, ms = SUBPROCESS_TIMEOUT_MS) {
  const watch = { timedOut: false }
  if (!(ms > 0)) return watch
  const timer = setTimeout(() => {
    watch.timedOut = true
    console.error(`[timeout] ${label} still running after ${formatMs(ms)} — killing pid ${proc.pid}`)
    proc.kill('SIGKILL')
  }, ms)
  timer.unref?.()
  const clear = () => clearTimeout(timer)
  proc.once('exit', clear)
  proc.once('error', clear)
  return watch
}

export function timeoutError(label, ms = SUBPROCESS_TIMEOUT_MS) {
  const err = new Error(`${label} timed out after ${formatMs(ms)} and was stopped`)
  err.code = 'ETIMEDOUT'
  return err
}

export function formatMs(ms) {
  if (ms < 1000) return `${ms} ms`
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
}
