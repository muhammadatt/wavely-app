/**
 * Memo for the pure signal generators the DSP tests build their material from.
 *
 * These generators are the dominant cost of the slowest files, and a large
 * share of every call is redundant: `resonancePitch.test.js` alone builds 17
 * signals of which only 9 are distinct, because each test re-derives the same
 * carrier from the same constants. The work is not small — a 3 s harmonic stack
 * at F0 90 runs a partial for every harmonic below Nyquist on every sample,
 * which is ~32 M `Math.sin` calls for one buffer.
 *
 * ⚠ THE KEY MUST CAPTURE EVERYTHING THE OUTPUT DEPENDS ON, INCLUDING CLOSURE
 * STATE. The generators take a contour *function*, so keying on source text is
 * wrong: the three pitches in the pitch-coupling probe all arrive as `() => f0`
 * and stringify identically while producing different signals. Callers key on
 * the contour's sampled VALUES instead (see `hashNumbers`), which is exact —
 * the sampled contour plus the scalar options fully determine the buffer.
 *
 * Entries are returned as copies. Callers treat generated buffers as their own
 * and some of them filter in place, so handing out the cached instance would
 * make one test's mutation another test's input.
 */
import { createHash } from 'node:crypto'

const cache = new Map()

/** Stable digest of a numeric sequence, for use as part of a cache key. */
export function hashNumbers(values) {
  const buf = Float64Array.from(values)
  return createHash('sha1')
    .update(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
    .digest('hex')
}

/**
 * Return `make()`'s result for `key`, computing it at most once per process.
 * The returned buffer is always a fresh copy, so callers may mutate freely.
 */
export function memoSignal(key, make) {
  let hit = cache.get(key)
  if (hit === undefined) {
    hit = make()
    cache.set(key, hit)
  }
  return hit.slice()
}

/** Test-support: how many distinct signals have been built this process. */
export function memoSize() {
  return cache.size
}
