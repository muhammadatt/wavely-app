/**
 * Phone-browser audio fixes: the iOS silent switch and interrupted contexts.
 *
 * SILENT SWITCH. iOS gives Web Audio the "ambient" audio session by default,
 * and ambient audio obeys the ringer switch, so an iPhone on silent plays the
 * editor's playback at zero volume with no error anywhere. Declaring the page's
 * session as "playback" (the Audio Session API, Safari 17+) makes it behave like
 * a media player: it plays with the switch on silent, and it pauses other apps'
 * audio while it plays, which is what an audio editor should do. It has to be
 * set before the context starts making sound. Browsers without the API (every
 * desktop browser, older iOS) are left alone.
 *
 * INTERRUPTIONS. A phone call, Siri, another app taking the audio session or the
 * tab going to the background moves the AudioContext to "interrupted" (Safari)
 * or "suspended" (others). Nothing in the editor suspends its context on
 * purpose, so any state other than "running" or "closed" is one to undo — but
 * iOS refuses resume() outside a user gesture. So the editor resumes on the
 * user's next tap, click or key, and tries once more when the page becomes
 * visible again (enough on desktop and Android, harmless where it is refused).
 *
 * The helpers take their globals as arguments so they can be tested without a
 * browser.
 */

/**
 * Declare the page's audio session as playback, where the browser lets us.
 * Returns true when the session is (now) playback.
 */
export function setPlaybackAudioSession(nav = globalThis.navigator) {
  const session = nav?.audioSession
  if (!session || !('type' in session)) return false
  try {
    if (session.type !== 'playback') session.type = 'playback'
    return session.type === 'playback'
  } catch {
    return false
  }
}

/** Whether a context has stopped without being asked to and should be resumed. */
export function needsResume(ctx) {
  return !!ctx && ctx.state !== 'running' && ctx.state !== 'closed'
}

/**
 * The events iOS counts as a user gesture for starting audio. `pointerdown`
 * alone is not enough on older iOS; `touchend` and `click` are.
 */
export const RESUME_GESTURES = ['touchend', 'click', 'keydown']

/**
 * Keep `ctx` running: resume it on the next user gesture whenever it has
 * stopped, and try again when the page becomes visible. Returns a function that
 * removes the listeners.
 */
export function keepContextRunning(ctx, doc = globalThis.document) {
  if (!ctx || !doc?.addEventListener) return () => {}

  const resume = () => {
    if (!needsResume(ctx)) return
    // A refused resume (no gesture yet) rejects; the next gesture tries again.
    try {
      const p = ctx.resume()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      // Older WebKit can throw synchronously; same outcome.
    }
  }
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') resume()
  }

  // Capture, so a handler that stops propagation cannot keep audio stopped.
  for (const type of RESUME_GESTURES) doc.addEventListener(type, resume, true)
  doc.addEventListener('visibilitychange', onVisibility)

  return () => {
    for (const type of RESUME_GESTURES) doc.removeEventListener(type, resume, true)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}
