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
/**
 * ⚠ `margin` IS GONE AND `found` REPLACES IT. The margin lane plotted
 * `input - threshold` against a flat rail in a band of its own; the FOUND strip
 * carries the same quantity in a fraction of the height, so the lane was a
 * second answer to a question already answered. A stored `margin` is ignored
 * like any unknown key, which puts FOUND at its default rather than inheriting a
 * preference for a different picture.
 */
export const OVERLAY_KEYS = ['history', 'spectrum', 'found', 'removed']

/**
 * What each is when nothing has been stored.
 *
 * ⚠ `removed` DEFAULTS ON AND IS THE ONLY ONE THAT DOES, because it is not
 * really an overlay: the reduction trace IS the plot, and the other four are
 * context folded in around it. It is a switch at all so the hero can be put down
 * while reading the spectrum underneath it.
 *
 * Per-key defaults are also why `loadOverlays` cannot go on testing `=== true`
 * alone: that cannot tell a stored `false` from a key nobody has written yet,
 * and for `removed` those are opposite answers.
 */
/**
 * ⚠ `grid` IS GONE. It drew frequency and reduction rules across the whole plot
 * AND gated the reduction numerals down the right-hand edge — so reading a depth
 * off the trace meant switching on a grid over everything else to get the scale
 * that measures it. The numerals now follow REMOVED, which is the reading they
 * belong to, and the rules are not missed: the frequency labels along the axis
 * never depended on the switch, and the reduction figures are printed in the
 * band itself. A stored `grid` is ignored like any unknown key.
 */
const DEFAULTS = {
  history: false,
  spectrum: false,
  found: false,
  removed: true,
}

/** The default view, and the fallback whenever storage says nothing. */
export function noOverlays() {
  return { ...DEFAULTS }
}

/**
 * The stored preference, falling back per key.
 *
 * A key that is PRESENT is compared against `true` rather than coerced, so a
 * half-written or hand-edited entry degrades to off rather than to whatever
 * `Boolean` makes of it. A key that is ABSENT takes its default — which is how
 * a preference file written before an overlay existed still gets that overlay's
 * intended starting state rather than silently off.
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
    for (const k of OVERLAY_KEYS) out[k] = k in v ? v[k] === true : DEFAULTS[k]
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
