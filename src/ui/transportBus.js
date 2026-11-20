/**
 * The one way to ask the transport to play or stop.
 *
 * The transport (TransportBar.vue) owns playback; anything else that wants
 * Play / Stop — a plugin window's Preview, the Space key, the try-out flow —
 * REQUESTS it here rather than reaching for playback directly, so a different
 * shell (a phone layout) only has to listen in one place.
 *
 * It is a window event because the listener is a component and the callers are
 * not; `onTogglePlaybackRequest` returns its own unsubscribe.
 */

export const TOGGLE_PLAY_EVENT = 'wavely:toggle-play'

/** Ask the transport to start if stopped, or stop if playing. */
export function requestTogglePlayback() {
  window.dispatchEvent(new CustomEvent(TOGGLE_PLAY_EVENT))
}

/** Listen for Play / Stop requests. Returns the unsubscribe. */
export function onTogglePlaybackRequest(fn) {
  window.addEventListener(TOGGLE_PLAY_EVENT, fn)
  return () => window.removeEventListener(TOGGLE_PLAY_EVENT, fn)
}
