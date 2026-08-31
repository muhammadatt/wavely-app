import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * THE PLOT'S THRESHOLD MUST FOLLOW WHICHEVER TARGETING MODEL IS RUNNING.
 *
 * ⚠ THIS SHIPPED BROKEN, AND IT WAS ONE LINE WITH TWO SYMPTOMS. The plot adds
 * the detection threshold to the kernel's reference ITSELF, so the dotted line
 * tracks the knob on the frame it is turned rather than a frame later — and it
 * read that offset out of `props.zones`. Under the focus model the plot is
 * given no zones, so `zoneSettingsAt` fell through to the stock constant and
 * `threshold[]` froze at 20.
 *
 * Reported as two unrelated faults, from that one frozen array:
 *
 *   1. the dotted threshold line stopped moving for the Threshold knob, and
 *      for the nodes;
 *   2. the same `threshold[]` feeds `findExceedanceRuns` and the FOUND trace,
 *      so crossings were still measured against 20 with the knob wound fully
 *      off — the display kept reporting resonances the kernel had stopped
 *      touching.
 *
 * The arithmetic is pinned in test/dsp/resonanceFocus.test.js. What is pinned
 * HERE is the wiring, because that is what actually broke: every arithmetic
 * test passed throughout, since the function they exercise was never the
 * problem — the panel simply was not handing it to the plot. A component test
 * needs a canvas and a live kernel frame, so the source is read instead, which
 * is the arrangement resonanceZoneDelta.test.js already uses for a guarantee
 * that cannot be reached under node.
 */

const PLOT = readFileSync(
  new URL('../../src/components/meters/ResonanceSpectrum.vue', import.meta.url), 'utf8')
const PANEL = readFileSync(
  new URL('../../src/components/panels/ResonanceModal.vue', import.meta.url), 'utf8')

test('the plot accepts a threshold offset instead of only reading zones', () => {
  assert.match(PLOT, /selectivityFn:\s*\{\s*type:\s*Function/,
    'ResonanceSpectrum must take a selectivityFn prop')
  // The offset is resolved ONCE per frame and read per bin. Both halves matter:
  // resolving per bin costs an allocation per node per bin per frame.
  assert.match(PLOT, /const offsetAt = props\.selectivityFn/)
  assert.match(PLOT, /threshold\[d\] = reference\[d\] \+ offsetAt\(/)
})

/**
 * ⚠ THE FALLBACK IS WHAT KEEPS THE SHIPPING PATH UNTOUCHED BY CONSTRUCTION.
 * With no function given the plot must still do its own zone lookup, or fixing
 * focus would have silently changed the model that actually ships.
 */
test('with no function given the plot falls back to the zone lookup', () => {
  assert.match(PLOT, /\?\?\s*\(hz => zoneSettingsAt\(props\.zones, hz\)\.selectivity\)/)
  assert.match(PLOT, /selectivityFn:\s*\{\s*type:\s*Function,\s*default:\s*null\s*\}/)
})

test('the panel hands the plot a threshold under focus and nothing under zones', () => {
  // ⚠ NO REGEX ON THE IMPORT, DELIBERATELY. This pinned the whole clause —
  // `import { focusThresholdFn }` — so adding a second name to it broke a test
  // that has no opinion about how many things are imported. The obvious
  // loosening was a word boundary, and the escape for one reached the file as a
  // literal backspace through the layers between the source and disk; the
  // replacement after that put a real newline inside a string literal. Two
  // failures in a row from escaping, on an assertion that is a substring search.
  const at = PANEL.indexOf("from '../../audio/resonanceFocus.js'")
  assert.ok(at > 0, 'the panel must import from resonanceFocus.js')
  assert.ok(
    PANEL.slice(Math.max(0, at - 200), at).includes('focusThresholdFn'),
    'the panel must import focusThresholdFn',
  )
  // Built from the live patch, so it is rebuilt when a knob moves...
  assert.match(PANEL, /focusMode \? focusThresholdFn\(resFocus\.value\) : null/)
  // ...in a computed, so it is NOT rebuilt per display bin per animation frame.
  assert.match(PANEL, /const selectivityFn = computed\(/)
  // And actually reaches the plot. This is the assertion that would have caught
  // the reported bug; every other test in this suite passed while it was live.
  assert.match(PANEL, /:selectivity-fn="selectivityFn"/)
})
