import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'

import { parseAccountHash, accountHash, withHash } from '../../src/auth/accountRoute.js'
import { createAccountScreen } from '../../src/auth/accountScreen.js'

test('parseAccountHash reads the section, falls back to overview, ignores other hashes', () => {
  assert.equal(parseAccountHash('#/account'), 'overview')
  assert.equal(parseAccountHash('#/account/'), 'overview')
  assert.equal(parseAccountHash('#/account/billing'), 'billing')
  assert.equal(parseAccountHash('#/account/SECURITY'), 'security')
  assert.equal(parseAccountHash('#/account/nope'), 'overview')
  assert.equal(parseAccountHash(''), null)
  assert.equal(parseAccountHash('#/accounts'), null)
  assert.equal(parseAccountHash('#section'), null)
})

test('accountHash and withHash round-trip', () => {
  assert.equal(accountHash('overview'), '#/account')
  assert.equal(accountHash('billing'), '#/account/billing')
  assert.equal(withHash('https://a.example/x?q=1', '#/account/billing'), 'https://a.example/x?q=1#/account/billing')
  assert.equal(withHash('https://a.example/x?q=1#/account', ''), 'https://a.example/x?q=1')
})

/** A window with a real-enough history: entries, push/replace, back → popstate. */
function fakeWindow(start = 'https://app.example/') {
  const entries = [start]
  let index = 0
  const listeners = []
  const win = {
    location: {
      get href() { return entries[index] },
      get hash() { return new URL(entries[index]).hash },
    },
    history: {
      state: null,
      pushState(_s, _t, href) { entries.splice(index + 1); entries.push(href); index++ },
      replaceState(_s, _t, href) { entries[index] = href },
      back() { if (index > 0) { index--; listeners.forEach(l => l()) } },
      forward() { if (index < entries.length - 1) { index++; listeners.forEach(l => l()) } },
    },
    addEventListener(type, fn) { if (type === 'popstate') listeners.push(fn) },
    get entries() { return entries.slice() },
    get index() { return index },
    // The user typing a URL / following a link to a hash in this tab.
    navigate(href) { entries.splice(index + 1); entries.push(href); index++; listeners.forEach(l => l()) },
  }
  return win
}

function fakeAuth(status = 'signedIn') {
  const state = reactive({ status, dialog: null })
  return { state, openDialog: (mode) => { state.dialog = mode } }
}

test('open pushes the hash, section switches replace it, close goes back', () => {
  const win = fakeWindow()
  const screen = createAccountScreen({ auth: fakeAuth(), win })
  screen.start()
  screen.open('overview')
  assert.equal(screen.state.open, true)
  assert.equal(win.location.href, 'https://app.example/#/account')
  screen.open('billing')
  assert.equal(screen.state.section, 'billing')
  assert.equal(win.entries.length, 2, 'switching sections does not stack history')
  assert.equal(win.location.hash, '#/account/billing')
  screen.close()
  assert.equal(screen.state.open, false)
  assert.equal(win.location.href, 'https://app.example/')
})

test('Back closes it and Forward reopens it', () => {
  const win = fakeWindow()
  const screen = createAccountScreen({ auth: fakeAuth(), win })
  screen.start()
  screen.open('security')
  win.history.back()
  assert.equal(screen.state.open, false)
  win.history.forward()
  assert.equal(screen.state.open, true)
  assert.equal(screen.state.section, 'security')
  // Not ours to pop any more: close strips the hash in place.
  screen.close()
  assert.equal(win.location.href, 'https://app.example/')
  assert.equal(win.index, 1)
})

test('a deep link opens on load once the session is known', () => {
  const win = fakeWindow('https://app.example/#/account/billing')
  const auth = fakeAuth('loading')
  const screen = createAccountScreen({ auth, win })
  screen.start()
  assert.equal(screen.state.open, false)
  auth.state.status = 'signedIn'
  assert.equal(screen.state.open, true)
  assert.equal(screen.state.section, 'billing')
  screen.close()
  assert.equal(win.location.href, 'https://app.example/', 'a hash we did not push is stripped in place')
  assert.equal(win.entries.length, 1)
})

test('a deep link while signed out asks for a log-in, then opens', () => {
  const win = fakeWindow('https://app.example/#/account/security')
  const auth = fakeAuth('loading')
  const screen = createAccountScreen({ auth, win })
  screen.start()
  auth.state.status = 'signedOut'
  assert.equal(auth.state.dialog, 'signIn')
  assert.equal(screen.state.open, false)
  // The store's order on a sign-in: the session first, then the dialog closes.
  auth.state.status = 'signedIn'
  auth.state.dialog = null
  assert.equal(screen.state.open, true)
  assert.equal(screen.state.section, 'security')
})

test('dismissing that log-in drops the link', () => {
  const win = fakeWindow('https://app.example/#/account')
  const auth = fakeAuth('signedOut')
  const screen = createAccountScreen({ auth, win })
  screen.start()
  assert.equal(auth.state.dialog, 'signIn')
  auth.state.dialog = null
  assert.equal(win.location.href, 'https://app.example/')
  auth.state.status = 'signedIn'
  assert.equal(screen.state.open, false, 'a later, unrelated sign-in does not open it')
})

test('signing out closes it', () => {
  const win = fakeWindow()
  const auth = fakeAuth()
  const screen = createAccountScreen({ auth, win })
  screen.start()
  screen.open('security')
  auth.state.status = 'signedOut'
  assert.equal(screen.state.open, false)
  assert.equal(win.location.hash, '')
})

test('with accounts off it never opens and a stale hash is cleared', () => {
  const win = fakeWindow('https://app.example/#/account')
  const screen = createAccountScreen({ auth: fakeAuth('disabled'), win })
  screen.start()
  screen.open('billing')
  assert.equal(screen.state.open, false)
  assert.equal(win.location.href, 'https://app.example/')
})

test('following a link to a section while the editor is open opens it', () => {
  const win = fakeWindow()
  const screen = createAccountScreen({ auth: fakeAuth(), win })
  screen.start()
  win.navigate('https://app.example/#/account/billing')
  assert.equal(screen.state.open, true)
  assert.equal(screen.state.section, 'billing')
})

test('backing out of a link before the session settles drops it', () => {
  const win = fakeWindow()
  const auth = fakeAuth('loading')
  const screen = createAccountScreen({ auth, win })
  screen.start()
  win.navigate('https://app.example/#/account/billing')
  win.history.back()
  auth.state.status = 'signedIn'
  assert.equal(screen.state.open, false, 'not reopened when the session lands')
  assert.equal(win.location.href, 'https://app.example/')

  // …and resolving signed out asks for nothing.
  const auth2 = fakeAuth('loading')
  const win2 = fakeWindow()
  const screen2 = createAccountScreen({ auth: auth2, win: win2 })
  screen2.start()
  win2.navigate('https://app.example/#/account')
  win2.history.back()
  auth2.state.status = 'signedOut'
  assert.equal(auth2.state.dialog, null)
})
