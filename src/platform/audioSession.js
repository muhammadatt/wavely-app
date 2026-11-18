/**
 * Phone-browser audio fixes: the iOS silent switch and interrupted contexts.
 *
 * SILENT SWITCH. iOS gives Web Audio the "ambient" audio session by default,
 * and ambient audio obeys the ringer switch, so an iPhone on silent plays the
 * editor's playback at zero volume with no error anywhere. Declaring the page's
 * session as "playback" (the Audio Session API, Safari 17+) makes it behave like
 * a media player: it plays with the switch on silent, and it pauses other apps'
 * audio while it plays. Browsers without the API (every desktop browser, older
 * iOS) are left alone.
 *
 * It is declared WHEN PLAYBACK STARTS, never when the AudioContext is created:
 * the editor's context also exists to decode files, so it is created on import,
 * and claiming the playback session there would pause the user's music the
 * moment they open a file. Until the first Play the page stays ambient and
 * mixes with whatever else is playing.
 *
 * INTERRUPTIONS. A phone call, Siri or another app taking the audio session
 * moves the context to "interrupted" (Safari) or "suspended" (others). Nothing
 * in the editor suspends its context on purpose, so either state means the audio
 * has stopped under the user. The transport is stopped to match (see
 * `onContextStopped`), and the next Play resumes the context inside its own
 * click, which iOS requires. It is deliberately NOT resumed on any tap: that
 * made an unrelated tap (selecting a region) restart whatever had been playing.
 *
 * The helpers take their globals as arguments so they can be tested without a
 * browser.
 */

/**
 * Declare the page's audio session as playback, where the browser lets us.
 * Call it when audio starts playing. Returns true when the session is (now)
 * playback.
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

/** A realtime AudioContext, with the prefixed constructor older WebKit has. */
export function createAudioContext(win = globalThis) {
  const Ctor = win.AudioContext || win.webkitAudioContext
  return new Ctor()
}

/** Whether a context has stopped without being asked to and should be resumed. */
export function needsResume(ctx) {
  return !!ctx && ctx.state !== 'running' && ctx.state !== 'closed'
}

/**
 * Resume `ctx` if it has stopped. Never throws and never rejects: resolves
 * true when the context is running (or was already), false when the browser
 * refused (no user gesture, a call still in progress) or threw synchronously,
 * as older WebKit can. Call it inside the click that wants sound.
 */
export function resumeIfStopped(ctx) {
  if (!needsResume(ctx)) return Promise.resolve(!!ctx && ctx.state === 'running')
  try {
    return Promise.resolve(ctx.resume()).then(() => true, () => false)
  } catch {
    return Promise.resolve(false)
  }
}

/**
 * Call `onStop` whenever `ctx` stops under the user (interrupted or suspended),
 * so whatever was playing can be stopped to match. Returns a function that
 * removes the listener.
 */
export function onContextStopped(ctx, onStop) {
  if (!ctx?.addEventListener) return () => {}
  const listener = () => {
    if (needsResume(ctx)) onStop()
  }
  ctx.addEventListener('statechange', listener)
  return () => ctx.removeEventListener('statechange', listener)
}
