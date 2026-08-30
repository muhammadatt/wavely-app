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

test('the default view is the trace alone', () => {
  // `removed` is the only one that defaults on: it is the plot, not an overlay
  // of it. The other four are context folded in around it.
  withStorage({}, () => {
    assert.deepEqual(loadOverlays(), {
      history: false, spectrum: false, found: false, removed: true,
    })
  })
})

test('an ABSENT key takes its default, a stored false does not', () => {
  // ⚠ The distinction only matters for a key whose default is on, and getting
  // it wrong is silent: `=== true` alone cannot tell "nobody has written this
  // yet" from "the user switched it off", and for `removed` those are opposite
  // answers. A preference file written before an overlay existed would have
  // started it off rather than at its intended state.
  withStorage({ stored: '{"history":true}' }, () => {
    assert.equal(loadOverlays().removed, true, 'absent means default')
  })
  withStorage({ stored: '{"removed":false}' }, () => {
    assert.equal(loadOverlays().removed, false, 'stored false must survive')
  })
})

test('a preference stored under `spectrum` still means the spectrum', () => {
  // ⚠ `margin` was briefly a RENAME of `spectrum`, and that was wrong — they
  // answered different questions. Anyone who had the spectrum on gets it back.
  withStorage({ stored: '{"spectrum":true}' }, () => {
    assert.equal(loadOverlays().spectrum, true)
    assert.equal(loadOverlays().found, false)
  })
})

test('a stored `margin` is ignored rather than inherited by FOUND', () => {
  // ⚠ The margin lane is deleted and FOUND took its slot, but it is not the same
  // picture — the lane was a full band with a below-threshold half. Carrying the
  // preference across would switch on something the user never chose.
  withStorage({ stored: '{"margin":true}' }, () => {
    const v = loadOverlays()
    assert.equal(v.found, false)
    assert.equal('margin' in v, false)
  })
})

test('a stored preference round-trips', () => {
  withStorage({}, () => {
    saveOverlays({ history: false, spectrum: false, found: true, removed: false })
    assert.deepEqual(loadOverlays(), {
      history: false, spectrum: false, found: true, removed: false,
    })
  })
})

test('only exactly true counts, so a half-written entry degrades to off', () => {
  // Coercing instead would make `{"grid":"false"}` — a plausible thing to find
  // in a hand-edited entry — read as ON, which is the wrong direction for a
  // preference whose default is "show nothing but the removal".
  withStorage({ stored: '{"spectrum":"false","history":1,"found":true,"removed":"yes"}' }, () => {
    const v = loadOverlays()
    assert.deepEqual(
      [v.spectrum, v.history, v.found, v.removed], [false, false, true, false])
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
    saveOverlays({ history: true, waterfall: true })
    assert.deepEqual(Object.keys(JSON.parse(read())), OVERLAY_KEYS)
  })
})
