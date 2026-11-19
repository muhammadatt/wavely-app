/**
 * VoxPressor's voice-profile cache: the speaker's rumble corner and median F0,
 * measured ONCE PER FILE VERSION and shared by every measurement on it.
 *
 * Pure (the measurement is passed in), so the panel's rules are testable on
 * their own:
 * - a key already measured or in flight returns the SAME promise;
 * - an uncacheable request (a chain's running segments, which change every
 *   apply under one key) always measures and never replaces the cached entry;
 * - a failed measurement is forgotten, so the next request measures again.
 */
export function createVoiceProfileCache() {
  let key = null
  let promise = null
  return {
    /**
     * @param {string} k            what the profile belongs to (document + revision)
     * @param {() => Promise<{cornerHz: number|null, voiceF0Hz: number|null}>} measure
     * @param {boolean} [cacheable]
     */
    get(k, measure, cacheable = true) {
      if (cacheable && key === k && promise) return promise
      const p = Promise.resolve().then(measure)
      if (!cacheable) return p
      key = k
      promise = p
      p.catch(() => {
        if (promise === p) { key = null; promise = null }
      })
      return p
    },
    /** True while `p` is the entry the cache holds (no newer request replaced it). */
    holds(p) {
      return promise === p
    },
  }
}
