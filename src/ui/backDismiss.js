/**
 * Overlays that close on the system Back gesture but live in a component of
 * their own (the phone's ⋯ menu, the sign-in and upgrade dialogs), not in the
 * editor state the Escape ladder reads (composables/editorShell.js).
 *
 * A component registers a dismisser while it is open; the back guard asks the
 * most recently registered first. A dismisser returns true when it handled
 * the Back — closed itself, or is busy and refuses to close (the Back is
 * still spent on it, so nothing under it closes and the app does not arm its
 * exit) — and false to let the next one try.
 */
import { onMounted, onUnmounted } from 'vue'

const dismissers = []

export function registerBackDismiss(fn) {
  dismissers.push(fn)
  return () => {
    const i = dismissers.lastIndexOf(fn)
    if (i >= 0) dismissers.splice(i, 1)
  }
}

/** Offer a Back to the open overlays, newest first. True when one took it. */
export function dismissTopOverlay() {
  for (let i = dismissers.length - 1; i >= 0; i--) {
    if (dismissers[i]()) return true
  }
  return false
}

/** Register `fn` for as long as the calling component is mounted. */
export function useBackDismiss(fn) {
  let off = null
  onMounted(() => { off = registerBackDismiss(fn) })
  onUnmounted(() => off?.())
}
