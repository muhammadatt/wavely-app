/**
 * Which targeting model the resonance panel offers: zones, or focus nodes.
 *
 *   ?resoTargeting=focus                              one page load
 *   localStorage.setItem('resoTargeting', 'focus')    until cleared
 *
 * ZONES SHIP. Focus is the prototype — see resonanceFocus.js for what it is and
 * why. This flag exists for the same reason `voicerxBaseline` does: the two
 * models make different bargains, no corpus can say which one a person can
 * think in, and the decision needs a listener, one file, and a way to flip
 * between them without a rebuild.
 *
 * ⚠ IT IS A TARGETING MODEL, NOT A TUNING. Both start from the same detector
 * numbers (RESONANCE_FOCUS_GLOBAL is ZONE_STOCK), and a focus patch with no
 * nodes produces the same per-bin curves as the stock zone set — asserted in
 * test/dsp/resonanceFocus.test.js. So an A/B on an untouched panel is silence,
 * which is the correct answer: what is being compared is how you get to a
 * setting, not where the setting starts.
 *
 * Its own module rather than a function inside useResonance.js so it can be
 * tested under node — importing the composable drags in Vite's `?worker&url`
 * specifiers, which only the bundler can resolve.
 */

/** The model used unless something explicitly asks for the other one. */
export const DEFAULT_TARGETING = 'zones'

const KNOWN = new Set(['zones', 'focus'])

/**
 * Resolve the targeting model.
 *
 * An unrecognised value falls back to the default rather than passing through.
 * A typo must not quietly produce a third behaviour, or a panel running zones
 * while the person at the keyboard believes they are listening to focus — which
 * is precisely the confusion that makes an A/B worthless.
 */
export function resolveTargeting() {
  const requested = read('resoTargeting')
  return KNOWN.has(requested) ? requested : DEFAULT_TARGETING
}

/** Query string, then stored preference. Null when neither has an opinion. */
function read(key) {
  try {
    return new URLSearchParams(window.location.search).get(key)
      ?? window.localStorage.getItem(key)
  } catch {
    // No window under test, or a browser that throws on localStorage in
    // private mode. Neither is a reason to fail.
    return null
  }
}
