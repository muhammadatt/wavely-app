/**
 * Open / closed state of the full-screen account dashboard, kept in step with
 * the address bar's hash (see accountRoute.js for why a hash).
 *
 *   open(section)   from a click: pushes `#/account/<section>` so Back closes
 *                   it; switching sections while open REPLACES the entry, so
 *                   Back leaves the dashboard rather than walking its tabs.
 *   close()         pops the entry it pushed (history.back()), or strips a
 *                   hash it did not push (a deep link) in place.
 *   popstate        Back / Forward / a typed hash open or close it.
 *   start()         a deep link on load: waits for the session, then opens —
 *                   or asks the user to log in first and opens once they have.
 *
 * Signed in only. A sign-out closes it; a sign-in it was waiting for opens
 * it; a sign-in dialog dismissed without signing in drops the link.
 *
 * Built with its auth store and window passed in so the history handling is
 * testable under `node --test`; `useAccountScreen` wires the real ones.
 */

import { reactive, watch } from 'vue'
import { parseAccountHash, accountHash, withHash, DEFAULT_SECTION } from './accountRoute.js'

export function createAccountScreen({ auth, win = globalThis.window }) {
  const state = reactive({ open: false, section: DEFAULT_SECTION })

  // Did WE push the entry the dashboard sits on? Then closing goes back.
  let pushed = false
  // A section asked for while signed out, opened once the user signs in.
  let pending = null
  let started = false

  const signedIn = () => auth.state.status === 'signedIn'

  function setHash(section, mode) {
    if (!win?.history) return
    const href = withHash(win.location.href, section ? accountHash(section) : '')
    if (href === win.location.href) return
    if (mode === 'push') win.history.pushState(win.history.state, '', href)
    else win.history.replaceState(win.history.state, '', href)
  }

  function open(section = DEFAULT_SECTION) {
    if (auth.state.status === 'disabled') return
    if (!signedIn()) {
      pending = section
      if (auth.state.status === 'signedOut') auth.openDialog('signIn')
      return
    }
    pending = null
    if (state.open) {
      state.section = section
      setHash(section, 'replace')
      return
    }
    state.section = section
    state.open = true
    // Already on this hash (a deep link): nothing to push.
    if (parseAccountHash(win?.location?.hash) !== null) setHash(section, 'replace')
    else {
      setHash(section, 'push')
      pushed = true
    }
  }

  function close() {
    if (!state.open) return
    state.open = false
    if (pushed) {
      pushed = false
      win?.history?.back()
    } else {
      setHash(null, 'replace')
    }
  }

  /** Back / Forward / a typed hash. */
  function onPopState() {
    const section = parseAccountHash(win?.location?.hash)
    if (section === null) {
      state.open = false
      pushed = false
      // Left the link before the session settled: don't reopen it (or ask
      // for a log-in) when it does.
      pending = null
      return
    }
    if (!signedIn()) {
      open(section)
      return
    }
    state.section = section
    state.open = true
    // Forward onto an entry we pushed earlier is still ours, but close()
    // can't know that history; stripping in place is the safe close.
    pushed = false
  }

  function start() {
    if (started || !win?.addEventListener) return
    started = true
    win.addEventListener('popstate', onPopState)

    watch(() => auth.state.status, (status) => {
      if (status === 'signedIn' && pending) open(pending)
      // A deep link that waited out the session check, to find no session.
      else if (status === 'signedOut' && pending && !auth.state.dialog) auth.openDialog('signIn')
      else if (status === 'signedOut' && state.open) {
        state.open = false
        pushed = false
        setHash(null, 'replace')
      }
    }, { flush: 'sync' })

    // The log-in prompt for a deep link closed without a sign-in: drop the
    // link, or it would spring open at some later, unrelated sign-in.
    watch(() => auth.state.dialog, (dialog, before) => {
      if (!dialog && before && pending && !signedIn()) {
        pending = null
        if (parseAccountHash(win?.location?.hash) !== null) setHash(null, 'replace')
      }
    }, { flush: 'sync' })

    const section = parseAccountHash(win.location?.hash)
    if (section === null) return
    if (auth.state.status === 'disabled') setHash(null, 'replace')
    else open(section) // signed in: now; loading: when it settles; signed out: after log-in
  }

  return { state, open, close, start, onPopState }
}
