/**
 * Looks again for work a closed tab left, for session autosave.
 *
 * A tab that has just closed can still hold its Web Lock for a moment — an
 * installed phone app relaunched straight after Back closed it is the common
 * case — and its work reads as another OPEN tab's, so it is never offered.
 * So the offer is re-read for a while after start, until no other tab's lock
 * is held, and again whenever the page comes back.
 *
 *   refresh()   re-reads the offer; resolves whether some other tab's work is
 *               still held by a live lock (worth looking again)
 *   busy()      a restore or discard is using the offer: skip, don't refill it
 *
 * One check at a time (`check()` returns the one in flight), and `idle()`
 * lets a restore or discard wait for it before it starts.
 */
export function createPendingRecheck({
  refresh, busy = () => false, onError = () => {},
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  let checking = null

  /** Resolves true (look again), false (nothing held) or null (skipped while busy). */
  function check() {
    if (busy()) return Promise.resolve(null)
    checking ??= Promise.resolve()
      .then(refresh)
      .catch((err) => { onError(err); return false })
      .finally(() => { checking = null })
    return checking
  }

  /** Resolves once no check is in flight. */
  function idle() {
    return checking ? checking.then(() => {}) : Promise.resolve()
  }

  /** Check every `everyMs`, at most `times` times, until nothing is held. */
  function poll(everyMs, times) {
    let tries = 0
    const id = setIntervalFn(async () => {
      tries++
      const held = await check()
      if (tries >= times || held === false) clearIntervalFn(id)
    }, everyMs)
    return () => clearIntervalFn(id)
  }

  return { check, idle, poll }
}
