/**
 * Keep the screen on while long work runs in this tab — an upload, a server
 * job, a long render. A phone that locks mid-upload suspends the page: the
 * upload stalls and a backgrounded tab may be discarded.
 *
 * `set(true)` asks for a screen wake lock and `set(false)` lets it go. The
 * browser releases a wake lock whenever the page is hidden, so it is asked for
 * again each time the page comes back while still wanted. Where the Screen
 * Wake Lock API is missing (or refuses), nothing happens.
 */
export function createWakeLock({ nav = globalThis.navigator, doc = globalThis.document } = {}) {
  let wanted = false
  let sentinel = null
  let requesting = false

  async function acquire() {
    if (!wanted || sentinel || requesting || !nav?.wakeLock?.request || doc?.visibilityState !== 'visible') return
    requesting = true
    try {
      const s = await nav.wakeLock.request('screen')
      s.addEventListener?.('release', () => { if (sentinel === s) sentinel = null })
      sentinel = s
      if (!wanted) release()
    } catch {
      // Refused (battery saver, not allowed here): carry on without it.
    } finally {
      requesting = false
    }
  }

  function release() {
    const s = sentinel
    sentinel = null
    s?.release?.().catch?.(() => {})
  }

  doc?.addEventListener?.('visibilitychange', () => {
    if (doc.visibilityState === 'visible') acquire()
  })

  return {
    set(on) {
      wanted = !!on
      if (wanted) return acquire()
      release()
    },
    get held() { return !!sentinel },
  }
}
