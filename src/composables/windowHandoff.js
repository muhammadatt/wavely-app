import { reactive } from 'vue'

/**
 * Settings handed to a window that keeps its state in the component rather
 * than in a plugin composable (Loudness Normalize), so the pluginSettings
 * registry — which is the chain's, and covers chainable plugins only — has no
 * entry to write through. The try-out link puts the sample's settings here
 * before it opens the window; the window takes them when it mounts, or at once
 * if it is already open.
 */
const pending = reactive({})

export function handOffWindowSettings(windowId, settings) {
  pending[windowId] = settings
}

/** Watch-friendly read for `windowId`; `take` clears what was read. */
export function pendingWindowSettings(windowId) {
  return pending[windowId] ?? null
}

export function takeWindowSettings(windowId) {
  const s = pending[windowId] ?? null
  delete pending[windowId]
  return s
}
