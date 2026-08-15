/**
 * Baseline override, for listening to the two detectors back to back.
 *
 *   ?voicerxBaseline=trend                              one page load
 *   localStorage.setItem('voicerxBaseline', 'trend')    until cleared
 *
 * The chord ships (see the BASELINE STRATEGY note in analysis.js). The trend is
 * the alternative, and it is better than the chord on every countable measure
 * taken against finished masters — which is exactly why this override has to
 * exist: a corpus cannot tell you what something SOUNDS like, and the decision
 * between these two rested on listening. That needs a person, one file, and a
 * way to flip between them without a rebuild.
 *
 * Its own module rather than a function inside useVoiceRx.js so it can be
 * tested under node: importing the composable drags in Vite's `?worker&url`
 * specifiers, which only the bundler can resolve.
 */

/** The baseline used unless something explicitly asks for the other one. */
export const DEFAULT_BASELINE = 'chord'

const KNOWN = new Set(['trend', 'chord'])

/**
 * Resolve the baseline for one analysis. Query string beats stored preference
 * beats the default.
 *
 * Read fresh on every analysis rather than cached at module load, so setting it
 * in the console and re-analysing works without a page reload.
 *
 * An unrecognised value falls back to the default instead of passing through.
 * A typo in a query string must not silently produce a third behaviour: since
 * `analyzeVoiceRx` treats any unrecognised string as the chord, `trned` would
 * quietly run the shipping detector while the person at the keyboard believed
 * they were listening to the other one. That is the confusion this prevents.
 */
export function resolveBaseline() {
  const requested = read('voicerxBaseline')
  return KNOWN.has(requested) ? requested : DEFAULT_BASELINE
}

/**
 * Detection-threshold multiplier — see the THRESHOLD CALIBRATION note in
 * analysis.js.
 *
 *   ?voicerxThreshold=0.8
 *   localStorage.setItem('voicerxThreshold', '0.8')
 *
 * 1 is the shipping calibration. 0.8 is the value the synthetic corpus prefers
 * and the one worth listening to; it is deliberately not the default until a
 * real corpus has been checked, because lowering a detection threshold can only
 * increase what the tool offers on audio that needs nothing.
 *
 * Clamped to [0.4, 2]. Outside that the tool either offers nothing at all or
 * offers something on every region of every file, and in both cases the person
 * doing the listening learns nothing about the detector.
 */
export const DEFAULT_THRESHOLD_SCALE = 1
const MIN_SCALE = 0.4
const MAX_SCALE = 2

export function resolveThresholdScale() {
  const raw = read('voicerxThreshold')
  if (raw === null || raw === '') return DEFAULT_THRESHOLD_SCALE
  const value = Number(raw)
  if (!Number.isFinite(value) || value < MIN_SCALE || value > MAX_SCALE) {
    return DEFAULT_THRESHOLD_SCALE
  }
  return value
}

/** Query string, then stored preference. Null when neither has an opinion. */
function read(key) {
  try {
    return new URLSearchParams(window.location.search).get(key)
      ?? window.localStorage.getItem(key)
  } catch {
    // No window under test, or a browser that throws on localStorage access in
    // private mode. Neither is a reason to fail an analysis.
    return null
  }
}
