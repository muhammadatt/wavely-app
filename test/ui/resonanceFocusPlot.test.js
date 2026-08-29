import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * THE FOCUS NODES LIVE IN THE PLOT, and these pin the wiring that puts them
 * there.
 *
 * The arithmetic is covered in test/ui/resonanceFocusNodes.test.js and
 * test/dsp/resonanceFocus.test.js. What is pinned HERE is what a unit test
 * cannot see, and what has already broken once on this feature: a correct
 * function that nobody calls. A component test would need a canvas and a live
 * kernel frame, so the source is read instead — the arrangement
 * resonanceZoneDelta.test.js already uses for a guarantee unreachable in node.
 */

const PLOT = readFileSync(
  new URL('../../src/components/meters/ResonanceSpectrum.vue', import.meta.url), 'utf8')
const PANEL = readFileSync(
  new URL('../../src/components/panels/ResonanceModal.vue', import.meta.url), 'utf8')

test('the plot takes the nodes and the selection, and reports both back', () => {
  assert.match(PLOT, /focusNodes:\s*\{\s*type:\s*Array,\s*default:\s*null\s*\}/)
  assert.match(PLOT, /selectedFocusNode:\s*\{\s*type:\s*Number/)
  assert.match(PLOT, /'update:focusNodes'/)
  assert.match(PLOT, /'update:selectedFocusNode'/)
})

/**
 * ⚠ NULL, NOT AN EMPTY ARRAY, is what says "this panel is not running the focus
 * model" — where `[]` says "it is, and nothing has been placed yet", a state
 * with its own drawing and its own gestures. Collapsing the two would put every
 * focus branch on the zone path.
 */
test('focus mode is the null check, so the zone path keeps its own behaviour', () => {
  assert.match(PLOT, /const focusMode = computed\(\(\) => props\.focusNodes !== null\)/)
  assert.match(PLOT, /if \(focusMode\.value\) drawFocus\(ctx, w\)/)
  assert.match(PANEL, /:focus-nodes="focusMode \? resFocus\.nodes : null"/)
  assert.match(PANEL, /@update:focus-nodes=/)
  assert.match(PANEL, /@update:selected-focus-node=/)
})

/**
 * ⚠ ONE SCOPE FOR DRAWING AND HIT TESTING. This panel's own notes call this out
 * as the failure that fails silently — "the hit test especially: it is the one
 * that fails silently, as dots that cannot be clicked where they are drawn". A
 * second copy of the geometry is exactly how that happens.
 */
test('the curve and its hit test share one vertical mapping', () => {
  assert.match(PLOT, /const focusScopeNow = \(\) =>/)
  // Both readers go through it rather than computing a scope of their own.
  assert.match(PLOT, /nodeAt\(props\.focusNodes, x, y, axis, focusScopeNow\(\)\)/)
  assert.match(PLOT, /biasRuns\(nodes, axisNow, scope\)/)
  assert.match(PLOT, /moveNode\(props\.focusNodes, focusDrag, x, y, axis, focusScopeNow\(\)\)/)
})

/**
 * ⚠ THE WHEEL BINDING HAD `.prevent` AND NO HANDLER, since before focus
 * existed. Measured in a browser rather than reasoned about, and two guesses
 * were wrong before the right answer: it does not throw, and Vue does not drop
 * the binding. It applies the modifier and calls nothing — so the plot
 * SILENTLY SWALLOWED THE PAGE SCROLL and did nothing with it, in a window that
 * can run past the fold.
 *
 * The modifier therefore had to go as well as the missing handler: `.prevent`
 * is applied by the template before the handler runs, so no early return inside
 * the handler can give the scroll back.
 */
test('the wheel is bound without .prevent, so an unconsumed wheel still scrolls', () => {
  // ⚠ THE TEMPLATE ONLY. The comment above the handler quotes the old binding
  // verbatim, so a whole-file check for `.prevent` matches the very note
  // explaining why it is gone.
  const template = PLOT.slice(PLOT.indexOf('<template>'))
  assert.match(template, /@wheel="onWheel"/)
  assert.doesNotMatch(template, /@wheel\.prevent/)
  assert.match(PLOT, /function onWheel\(e\)/)
  // It consumes the event only when it actually acted on a node: the two early
  // returns come BEFORE the only preventDefault in the function.
  const fn = PLOT.slice(PLOT.indexOf('function onWheel'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.ok(body.indexOf('if (!focusMode.value) return') < body.indexOf('e.preventDefault()'))
  assert.ok(body.indexOf('if (i < 0) return') < body.indexOf('e.preventDefault()'))
  assert.equal(body.split('preventDefault').length - 1, 1, 'exactly one preventDefault')
})

/**
 * ⚠ THE ACCESSIBLE NAME HAS TO CARRY THE NODES, and it did not: the separate
 * rail component had its own, and deleting the rail deleted the only
 * description of them there was. With the plate row gone too, a node's
 * frequency, width and amount now exist NOWHERE else on the panel — a canvas is
 * opaque to a screen reader, so this sentence is the whole of it.
 */
test('the accessible name describes the focus nodes and how to work them', () => {
  assert.match(PLOT, /focus node\$\{props\.focusNodes\.length === 1 \? '' : 's'\}/)
  assert.match(PLOT, /No focus nodes: the detector runs at its global setting everywhere/)
  assert.match(PLOT, /decibels \$\{dir\} cut/)
  assert.match(PLOT, /octaves wide/)
  assert.match(PLOT, /const FOCUS_HINT =/)
  assert.match(PLOT, /focusMode\.value \? FOCUS_HINT : ZONE_HINT/)
})

/**
 * Every pointer gesture has a keyboard equivalent — the commitment this panel
 * makes everywhere a canvas owns a parameter.
 */
test('every focus gesture has a keyboard equivalent', () => {
  const fn = PLOT.slice(PLOT.indexOf('function onFocusKeyDown'))
  for (const key of ["'ArrowUp'", "'ArrowDown'", "'ArrowLeft'", "'ArrowRight'",
    "'['", "']'", "'Delete'", "' '", "'Enter'"]) {
    assert.ok(fn.includes(key), `no keyboard route for ${key}`)
  }
  assert.match(PLOT, /if \(focusMode\.value\) return onFocusKeyDown\(e\)/)
})

/**
 * ⚠ A CLICK ON EMPTY PLATE DESELECTS; IT DOES NOT CREATE. Creation is the
 * double-click, matching the vocabulary the zone plot already teaches — and on
 * a plate this size an accidental node is easy, where an accidental
 * deselection costs nothing.
 */
test('a single click never creates a node', () => {
  const down = PLOT.slice(PLOT.indexOf('function onDown'), PLOT.indexOf('function onDrag'))
  assert.doesNotMatch(down, /addNode|makeFocusNode|newFocusNode/)
  assert.match(down, /if \(focusMode\.value\) \{\s*\n\s*selectFocus\(-1\)/)
  const dbl = PLOT.slice(PLOT.indexOf('function onDblClick'), PLOT.indexOf('function onFocusKeyDown'))
  assert.match(dbl, /newFocusNode/)
})

/** The rail and the plate row are gone — the plot owns all of this now. */
test('nothing outside the plot edits a node', () => {
  assert.doesNotMatch(PANEL, /ResonanceFocusRail|ResonanceFocusNode\b/)
  // The controls row may TALK about nodes in its comments; what it must not do
  // is edit one, so this checks for the machinery rather than the word.
  const controls = readFileSync(
    new URL('../../src/components/panels/ResonanceFocusControls.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(controls, /resonanceFocusNodes|setNodeParam|toggleNode|focus\.nodes/)
})
