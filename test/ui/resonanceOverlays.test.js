/**
 * ResoTame's overlay preference, which now crosses a component boundary.
 *
 * The switches are in the panel header and the flags are read inside the plot's
 * drawing loop, so the state lives in neither — which makes the store the one
 * place a mistake is invisible from both ends. A dropped save reads as a
 * preference that will not stick; a toggle that mutates in place reads as a
 * button that does nothing until the next unrelated redraw.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OVERLAY_KEYS,
  loadOverlays,
  noOverlays,
  saveOverlays,
  toggleOverlay,
} from '../../src/ui/resonanceOverlays.js'

/** A window whose localStorage can be made to throw, as a locked-down one does. */
function withStorage({ stored = null, throws = false }, fn) {
  const had = 'window' in globalThis
  const previous = globalThis.window
  let value = stored
  globalThis.window = {
    localStorage: {
      getItem() {
        if (throws) throw new Error('blocked')
        return value
      },
      setItem(_k, v) {
        if (throws) throw new Error('blocked')
        value = v
      },
    },
  }
  try {
    return fn(() => value)
  } finally {
    if (had) globalThis.window = previous
    else delete globalThis.window
  }
}

test('the default view is all overlays off', () => {
  withStorage({}, () => {
    assert.deepEqual(loadOverlays(), { grid: false, history: false, spectrum: false })
  })
})

test('a stored preference round-trips', () => {
  withStorage({}, () => {
    saveOverlays({ grid: true, history: false, spectrum: true })
    assert.deepEqual(loadOverlays(), { grid: true, history: false, spectrum: true })
  })
})

test('only exactly true counts, so a half-written entry degrades to off', () => {
  // Coercing instead would make `{"grid":"false"}` — a plausible thing to find
  // in a hand-edited entry — read as ON, which is the wrong direction for a
  // preference whose default is "show nothing but the removal".
  withStorage({ stored: '{"grid":"false","history":1,"spectrum":true}' }, () => {
    assert.deepEqual(loadOverlays(), { grid: false, history: false, spectrum: true })
  })
})

test('unreadable storage gives the default rather than throwing', () => {
  // A browser set to block site data throws on the accessor itself. A panel
  // that will not open because a preference could not be read is a worse
  // failure than a lost preference.
  withStorage({ throws: true }, () => {
    assert.deepEqual(loadOverlays(), noOverlays())
    assert.doesNotThrow(() => saveOverlays({ grid: true }))
  })
})

test('malformed JSON gives the default', () => {
  withStorage({ stored: '{not json' }, () => {
    assert.deepEqual(loadOverlays(), noOverlays())
  })
  withStorage({ stored: '"a string"' }, () => {
    assert.deepEqual(loadOverlays(), noOverlays())
  })
})

test('toggle returns a NEW object rather than mutating', () => {
  // The plot takes these as a prop. An in-place flip of an object the panel
  // already holds does not change the prop's identity, so the redraw would
  // happen on whatever frame followed for some other reason — a button that
  // works late and intermittently, which is worse than one that never works.
  const before = noOverlays()
  const after = toggleOverlay(before, 'history')
  assert.notEqual(after, before)
  assert.equal(before.history, false)
  assert.equal(after.history, true)
  assert.equal(toggleOverlay(after, 'history').history, false)
})

test('an unknown key is refused rather than stored', () => {
  const before = noOverlays()
  assert.equal(toggleOverlay(before, 'waterfall'), before)
})

test('saving keeps only the known keys', () => {
  // The store is written from panel state; a stray key reaching it would be
  // persisted for good and read back by every future session.
  withStorage({}, read => {
    saveOverlays({ grid: true, waterfall: true })
    assert.deepEqual(Object.keys(JSON.parse(read())), OVERLAY_KEYS)
  })
})
