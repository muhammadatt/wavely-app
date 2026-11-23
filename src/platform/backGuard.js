/**
 * Catches the system Back gesture so it cannot close the editor by accident.
 *
 * On Android a swipe in from either screen edge is Back. In the installed app
 * (`display: standalone`) the editor is the only page in its history, so Back
 * closed the app at once — mid-edit, from a drag that only started too near
 * the edge. A phone browser tab has the same problem one step later: Back
 * leaves the site.
 *
 * How: once the user has touched the page, a GUARD entry (same URL, state
 * `{ wavelyBackGuard: true }`) is pushed on top of the page's own entry. Back
 * then only pops the guard, and `popstate` lands on the entry beneath it:
 *   - something is open (a sheet, a menu, a plugin window): `closeTop()`
 *     closes it, as Escape would, and the guard goes back on top;
 *   - nothing is open: a toast says to go back again to leave (`onArmed`),
 *     and the guard is NOT put back for EXIT_WINDOW_MS, so a second Back
 *     leaves as it always did. Any touch or key after that re-arms it.
 *
 * Why only after a touch: Chrome's history-manipulation intervention skips
 * Back over entries a page pushed before the user interacted with it, so a
 * guard pushed on load would do nothing.
 *
 * Entries pushed ON TOP of the guard (the account dashboard's `#/account`
 * hash) copy its state, so popping them lands on a guard-marked entry and is
 * left to their own handler.
 *
 * Built with its window passed in so it is testable under `node --test`.
 */

export const GUARD_STATE_KEY = 'wavelyBackGuard'
/** How long after a "go back again" toast a second Back leaves the app. */
export const EXIT_WINDOW_MS = 2500

const isGuard = state => !!state && typeof state === 'object' && state[GUARD_STATE_KEY] === true

export function createBackGuard({ win = globalThis.window, closeTop, onArmed, enabled = () => true }) {
  let installed = false
  /** The guard entry is in history, on top of (or under) the current entry. */
  let guarded = false
  let exitTimer = null

  function push() {
    if (guarded || !enabled()) return
    const state = { ...(win.history.state && typeof win.history.state === 'object' ? win.history.state : {}), [GUARD_STATE_KEY]: true }
    win.history.pushState(state, '', win.location.href)
    guarded = true
  }

  // A touch or key: the user is here, so the guard can go (back) on top —
  // unless a "go back again" window is open, which only time closes.
  function onActivity() {
    if (exitTimer !== null) return
    push()
  }

  function onPopState(e) {
    // Landed on the guard itself (an entry above it was popped): not ours.
    if (isGuard(e?.state ?? win.history.state)) return
    if (!guarded) return
    guarded = false
    if (!enabled()) return
    if (closeTop?.()) {
      push()
      return
    }
    onArmed?.()
    clearTimeout(exitTimer)
    exitTimer = setTimeout(() => {
      exitTimer = null
      push()
    }, EXIT_WINDOW_MS)
  }

  function install() {
    if (installed || !win?.history?.pushState || !win.addEventListener) return
    installed = true
    // Reloaded on top of a guard left by the last load: it is still there.
    if (isGuard(win.history.state)) guarded = true
    win.addEventListener('popstate', onPopState)
    win.addEventListener('pointerdown', onActivity, true)
    win.addEventListener('keydown', onActivity, true)
  }

  function uninstall() {
    if (!installed) return
    installed = false
    clearTimeout(exitTimer)
    exitTimer = null
    win.removeEventListener('popstate', onPopState)
    win.removeEventListener('pointerdown', onActivity, true)
    win.removeEventListener('keydown', onActivity, true)
  }

  return { install, uninstall, onPopState, onActivity, get guarded() { return guarded } }
}
