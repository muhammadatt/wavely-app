/**
 * Which way the harness chassis is lit.
 *
 *   ?harnessChrome=light                              one page load
 *   localStorage.setItem('harnessChrome', 'light')    until cleared
 *
 * Two designs, one hue recipe. Both mix the plugin's own accent into the
 * chrome at 5–9%, which is what stops the chassis clashing with any faceplate.
 * They differ only in which side of the face the chrome sits on:
 *
 *   light (5a)  chrome lifted ABOVE the face, so the face reads as the
 *               recessed part and the shell as the thing it is set into
 *   dark  (5b)  chrome dropped BELOW the face, so the face is the only lit
 *               surface in the window and the chassis is the room around it
 *
 * ⚠ 5b SHIPS. That was decided by looking at both in the real app across the
 * hue circle, which is the only way it could be decided: they are the same
 * window at two exposures, and no measurement distinguishes them — the
 * question is what the eye goes to first, and the answer is that it should be
 * the faceplate rather than the frame around it.
 *
 * 5a stays reachable because the comparison is worth being able to re-run
 * whenever a faceplate is redesigned — a panel tuned against one exposure can
 * read quite differently against the other, which is exactly how FET Punch's
 * inherited faceplate was caught. Same reasoning and same shape as
 * `voicerx/baselineOverride.js`.
 *
 * Its own module rather than a constant inside FloatingWindow.vue so it can be
 * read under node: importing the component drags in Vue's SFC compiler output,
 * which the test suite has no way to resolve.
 */

/** The variant used unless something explicitly asks for the other one. */
export const DEFAULT_CHROME = 'dark'

const KNOWN = new Set(['light', 'dark'])

/**
 * Resolve the variant for one window. Query string beats stored preference
 * beats the default.
 *
 * Read fresh per window rather than cached at module load, so setting it in
 * the console and reopening a plugin works without a page reload — which is
 * the whole point of having the switch.
 *
 * An unrecognised value falls back to the default rather than passing through:
 * a typo must not silently render a third thing while the person looking at it
 * believes they are seeing the other design.
 */
export function resolveHarnessChrome() {
  const requested = read('harnessChrome')
  return KNOWN.has(requested) ? requested : DEFAULT_CHROME
}

/** Query string, then stored preference. Null when neither has an opinion. */
function read(key) {
  try {
    return new URLSearchParams(window.location.search).get(key)
      ?? window.localStorage.getItem(key)
  } catch {
    // No window under test, or a browser that throws on localStorage access in
    // private mode. Neither is a reason to fail to open a window.
    return null
  }
}
