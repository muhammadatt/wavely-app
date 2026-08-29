/**
 * Where the selected focus node's fields sit.
 *
 *   ?focusDock=row                              one page load
 *   localStorage.setItem('focusDock', 'row')    until cleared
 *
 * Two placements, and the question between them is not answerable from the
 * source — it is what the eye does, which needs both on screen:
 *
 *   bottom  along the foot of the display, inside the plate. The change happens
 *           where the user is already looking, which is the objection to `row`;
 *           the cost is that it covers the bottom of the plot, including the
 *           FOUND strip, whenever a node is selected.
 *   row     in the control row under the display, swapping with the global focus
 *           knobs. Costs no occlusion at all and puts a node's settings exactly
 *           where a ZONE's settings already live — but it is outside the plate,
 *           and a swap there is easy to miss while the pointer is on a node.
 *
 * ⚠ NEITHER IS THE ONE THIS REPLACED. Both are better than the card that
 * floated beside its own node: `placePanel` put it at the node's y ± 14, which
 * is the one position guaranteed to cover the curve being edited, and it moved
 * every time the node did.
 *
 * Its own module rather than a constant in either component so both can read it
 * without importing each other, and so it can be read under node — importing a
 * component drags in Vue's SFC compiler output, which the test suite has no way
 * to resolve. Same shape as `ui/harnessChrome.js`.
 */

/** The placement used unless something explicitly asks for the other one. */
export const DEFAULT_FOCUS_DOCK = 'bottom'

const KNOWN = new Set(['bottom', 'row'])

/** Query string beats stored preference beats the default. */
export function resolveFocusDock() {
  try {
    const q = new URLSearchParams(window.location.search).get('focusDock')
    if (KNOWN.has(q)) return q
    const stored = window.localStorage.getItem('focusDock')
    if (KNOWN.has(stored)) return stored
  } catch {
    // A browser set to block site data throws on the accessor itself; a panel
    // that will not open because a preference could not be read is a worse
    // failure than a lost preference.
  }
  return DEFAULT_FOCUS_DOCK
}
