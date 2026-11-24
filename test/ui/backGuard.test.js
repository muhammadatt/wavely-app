import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackGuard, GUARD_STATE_KEY, EXIT_WINDOW_MS } from '../../src/platform/backGuard.js'

/** A window with a history stack: back() pops and fires popstate, as a browser does. */
function fakeWindow() {
  const listeners = new Map()
  const stack = [{ state: null, url: 'https://x/' }]
  let at = 0
  const win = {
    location: { get href() { return stack[at].url } },
    history: {
      get state() { return stack[at].state },
      get length() { return stack.length },
      pushState(state, _t, url) { stack.length = at + 1; stack.push({ state, url }); at++ },
      replaceState(state, _t, url) { stack[at] = { state, url } },
      back() {
        if (at === 0) { win.exited = true; return }
        at--
        for (const fn of listeners.get('popstate') ?? []) fn({ state: stack[at].state })
      },
      forward() {
        if (at >= stack.length - 1) return
        at++
        for (const fn of listeners.get('popstate') ?? []) fn({ state: stack[at].state })
      },
    },
    addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn) },
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn) },
    fire(t) { for (const fn of listeners.get(t) ?? []) fn({}) },
    exited: false,
    get depth() { return at },
  }
  return win
}

test('nothing is pushed until the user touches the page', () => {
  const win = fakeWindow()
  createBackGuard({ win, closeTop: () => false }).install()
  assert.equal(win.history.length, 1)
  win.fire('pointerdown')
  assert.equal(win.history.length, 2)
  assert.equal(win.history.state[GUARD_STATE_KEY], true)
  win.fire('pointerdown')
  assert.equal(win.history.length, 2, 'one guard, not one per touch')
})

test('Back closes the top sheet and the guard goes back on top', () => {
  const win = fakeWindow()
  let open = 2
  createBackGuard({ win, closeTop: () => (open > 0 ? (open--, true) : false) }).install()
  win.fire('pointerdown')
  win.history.back()
  assert.equal(open, 1)
  assert.equal(win.depth, 1)
  win.history.back()
  assert.equal(open, 0)
  assert.equal(win.depth, 1)
  assert.equal(win.exited, false)
})

test('with nothing open, Back warns once and a second Back leaves', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = fakeWindow()
  let armed = 0
  createBackGuard({ win, closeTop: () => false, onArmed: () => armed++ }).install()
  win.fire('pointerdown')
  win.history.back()
  assert.equal(armed, 1)
  assert.equal(win.depth, 0)
  win.fire('pointerdown')
  assert.equal(win.depth, 0, 'a touch inside the exit window does not re-arm')
  win.history.back()
  assert.equal(win.exited, true)
})

test('the guard comes back after the exit window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = fakeWindow()
  createBackGuard({ win, closeTop: () => false, onArmed() {} }).install()
  win.fire('pointerdown')
  win.history.back()
  t.mock.timers.tick(EXIT_WINDOW_MS)
  assert.equal(win.depth, 1)
  win.history.back()
  assert.equal(win.exited, false)
})

test('an entry pushed above the guard (the account hash) is left to its own handler', () => {
  const win = fakeWindow()
  let closed = 0
  createBackGuard({ win, closeTop: () => (closed++, true) }).install()
  win.fire('pointerdown')
  win.history.pushState(win.history.state, '', 'https://x/#/account/plan')
  win.history.back()
  assert.equal(closed, 0)
  assert.equal(win.depth, 1)
})

test('disabled (desktop): never pushes, Back behaves as before', () => {
  const win = fakeWindow()
  createBackGuard({ win, closeTop: () => true, enabled: () => false }).install()
  win.fire('pointerdown')
  assert.equal(win.history.length, 1)
})

test('a reload on top of the guard keeps using it', () => {
  const win = fakeWindow()
  win.history.pushState({ [GUARD_STATE_KEY]: true }, '', 'https://x/')
  let closed = 0
  createBackGuard({ win, closeTop: () => (closed++, true) }).install()
  win.fire('pointerdown')
  assert.equal(win.history.length, 2, 'no second guard')
  win.history.back()
  assert.equal(closed, 1)
})

test('Back then Forward in the exit window: the guard is in charge again, no second guard', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = fakeWindow()
  let open = 0
  let armed = 0
  createBackGuard({ win, closeTop: () => (open > 0 ? (open--, true) : false), onArmed: () => armed++ }).install()
  win.fire('pointerdown')
  win.history.back()
  assert.equal(armed, 1)
  win.history.forward()
  t.mock.timers.tick(EXIT_WINDOW_MS)
  assert.equal(win.history.length, 2, 'the timer pushed no second guard')
  open = 1
  win.history.back()
  assert.equal(open, 0, 'the next Back closes the sheet')
  assert.equal(win.depth, 1)
})
