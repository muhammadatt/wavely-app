/**
 * Where the focus node's fields sit, and the switch between the two placements.
 *
 * The choice itself cannot be tested — it is what the eye does with both on
 * screen. What can be is that the switch resolves, that a typo falls back
 * rather than producing a third state, and that both components agree about the
 * two names: a mismatch there is a placement that silently renders nowhere,
 * which looks exactly like a node with no fields.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DEFAULT_FOCUS_DOCK, resolveFocusDock } from '../../src/ui/focusNodeDock.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODAL = readFileSync(join(HERE, '../../src/components/panels/ResonanceModal.vue'), 'utf8')
const PLOT = readFileSync(join(HERE, '../../src/components/meters/ResonanceSpectrum.vue'), 'utf8')

function withEnv({ search = '', stored = null, throws = false }, fn) {
  const had = 'window' in globalThis
  const previous = globalThis.window
  globalThis.window = {
    location: { search },
    localStorage: {
      getItem() {
        if (throws) throw new Error('blocked')
        return stored
      },
    },
  }
  try {
    return fn()
  } finally {
    if (had) globalThis.window = previous
    else delete globalThis.window
  }
}

test('the default is the bottom of the display', () => {
  withEnv({}, () => assert.equal(resolveFocusDock(), DEFAULT_FOCUS_DOCK))
  assert.equal(DEFAULT_FOCUS_DOCK, 'bottom')
})

test('the query string wins, then storage, then the default', () => {
  withEnv({ search: '?focusDock=row' }, () => assert.equal(resolveFocusDock(), 'row'))
  withEnv({ stored: 'row' }, () => assert.equal(resolveFocusDock(), 'row'))
  withEnv({ search: '?focusDock=bottom', stored: 'row' },
    () => assert.equal(resolveFocusDock(), 'bottom'))
})

test('an unknown value falls back rather than becoming a third state', () => {
  // A placement nothing renders looks exactly like a node with no fields, so an
  // unrecognised name must resolve to one of the two rather than pass through.
  withEnv({ search: '?focusDock=floating' }, () => assert.equal(resolveFocusDock(), 'bottom'))
  withEnv({ stored: 'nowhere' }, () => assert.equal(resolveFocusDock(), 'bottom'))
})

test('unreadable storage gives the default rather than throwing', () => {
  withEnv({ throws: true }, () => assert.equal(resolveFocusDock(), 'bottom'))
})

test('both placements are actually mounted, and by the same names', () => {
  // ⚠ THE TWO GUARDS ARE IN DIFFERENT COMPONENTS AND MUST AGREE. The row one is
  // a v-if in the control row; the bottom one is a named slot filled into the
  // plot. A rename on one side alone leaves that placement resolving to a
  // string nothing tests for, and the fields simply never appear.
  assert.match(MODAL, /focusDock === 'row'/)
  assert.match(MODAL, /focusDock === 'bottom'/)
  assert.match(MODAL, /#dock/)
  assert.match(PLOT, /<slot name="dock"/)
  assert.match(PLOT, /v-if="\$slots\.dock"/)
})

test('the plot no longer places the card itself', () => {
  // The whole point of the move: the card was positioned from the node's own
  // pixel coordinates, at the one place guaranteed to cover the curve.
  assert.doesNotMatch(PLOT, /function placePanel/)
  assert.doesNotMatch(PLOT, /const panelOpen/)
})
