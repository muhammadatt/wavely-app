/**
 * Baseline override, for listening to the two detectors back to back.
 *
 *   ?voicerxBaseline=chord                              one page load
 *   localStorage.setItem('voicerxBaseline', 'chord')    until cleared
 *
 * The trend ships (see the BASELINE STRATEGY note in analysis.js). The chord is
 * the superseded baseline, kept reachable because the case for switching rests
 * entirely on corpus measurements — and a corpus cannot tell you what something
 * SOUNDS like. That needs a person, one file, and a way to flip between them
 * without a rebuild.
 *
 * Its own module rather than a function inside useVoiceRx.js so it can be
 * tested under node: importing the composable drags in Vite's `?worker&url`
 * specifiers, which only the bundler can resolve.
 */

/** The baseline used unless something explicitly asks for the other one. */
export const DEFAULT_BASELINE = 'trend'

const KNOWN = new Set(['trend', 'chord'])

/**
 * Resolve the baseline for one analysis. Query string beats stored preference
 * beats the default.
 *
 * Read fresh on every analysis rather than cached at module load, so setting it
 * in the console and re-analysing works without a page reload.
 *
 * An unrecognised value falls back to the default instead of passing through.
 * A typo in a query string must not silently produce a third behaviour, and
 * `analyzeVoiceRx` treats any non-'trend' string as the chord — so `chrod`
 * would quietly select the superseded detector while looking like a normal run.
 * That is precisely the confusion this exists to prevent.
 */
export function resolveBaseline() {
  let requested = null
  try {
    requested = new URLSearchParams(window.location.search).get('voicerxBaseline')
      ?? window.localStorage.getItem('voicerxBaseline')
  } catch {
    // No window under test, or a browser that throws on localStorage access
    // in private mode. Neither is a reason to fail an analysis.
    return DEFAULT_BASELINE
  }
  return KNOWN.has(requested) ? requested : DEFAULT_BASELINE
}
