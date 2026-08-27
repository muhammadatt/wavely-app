/**
 * ResoTame's three display overlays, and where the preference lives.
 *
 * The default view (design 1c) is removal only: nothing on the plot but what
 * is being taken out. GRID (the rules), HISTORY (the last few seconds of carve
 * as a waterfall) and SPECTRUM (the input curve and the detection threshold
 * this frame was decided from) fold context back in. Each is independent
 * rather than the source design's single DETAIL button, because they answer
 * different questions and someone who wants the grid rarely wants a waterfall
 * behind it.
 *
 * KEPT OUT OF `params`, like DELTA and the per-zone deltas. `applyResonanceRegion`
 * spreads the param object straight into the kernel, so anything living there
 * is one careless key away from being rendered into the timeline. These are
 * purely about what is drawn — the kernel neither sends nor receives them — so
 * the safest place for them is panel state with no route to the worklet at all.
 *
 * PERSISTED, unlike the monitoring modes, and the difference is intent. A
 * monitoring mode is something you switch on to check one thing and switch off
 * again, so carrying it across sessions would be a trap. A preference for
 * seeing the grid is a preference; making someone re-set it every time they
 * open the panel is the trap.
 *
 * ⚠ IT LIVES HERE RATHER THAN INSIDE THE PLOT because the buttons and the
 * drawing code are no longer in the same component: the switches went up into
 * the panel header with the rest of the readouts, and the plot now takes the
 * flags as a prop. Its own module rather than either end of that pair so
 * neither owns the storage key, and so the load/save can be read under node —
 * importing a component drags in Vue's SFC compiler output, which the test
 * suite has no way to resolve. Same reasoning and same shape as
 * `ui/harnessChrome.js`.
 */

const STORE_KEY = 'wavely.resotame.overlays'

/** The keys, in the order the buttons appear. */
export const OVERLAY_KEYS = ['grid', 'history', 'spectrum']

/** All off — the default view, and the fallback whenever storage says nothing. */
export function noOverlays() {
  return { grid: false, history: false, spectrum: false }
}

/**
 * The stored preference, or all-off.
 *
 * Every stored value is compared against `true` rather than coerced, so a
 * half-written or hand-edited entry degrades to the default view rather than
 * to whatever `Boolean` makes of it.
 */
export function loadOverlays() {
  // Wrapped because a browser set to block site data throws on the accessor
  // itself rather than returning null, and a panel that will not open because
  // a preference could not be read is a worse failure than a lost preference.
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return noOverlays()
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object') return noOverlays()
    const out = noOverlays()
    for (const k of OVERLAY_KEYS) out[k] = v[k] === true
    return out
  } catch {
    return noOverlays()
  }
}

/** Persist. A viewer who cannot store it still gets it for this session. */
export function saveOverlays(overlays) {
  try {
    const out = {}
    for (const k of OVERLAY_KEYS) out[k] = overlays[k] === true
    window.localStorage.setItem(STORE_KEY, JSON.stringify(out))
  } catch {
    // Ignored deliberately — see above.
  }
}

/**
 * One flipped, as a new object.
 *
 * Returns rather than mutates so the caller's ref sees a change: the plot
 * takes these as a prop, and an in-place flip of an object it already holds
 * would redraw with the new flags only on whatever frame happened to follow.
 */
export function toggleOverlay(overlays, key) {
  if (!OVERLAY_KEYS.includes(key)) return overlays
  return { ...overlays, [key]: !(overlays[key] === true) }
}
