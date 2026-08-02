import { reactive, computed } from 'vue'

/**
 * Floating window manager.
 *
 * Replaces the one-boolean-per-window model (`la2aModalOpen`,
 * `fet1176ModalOpen`, ...), under which adding a window meant touching five
 * files and every window shared a single hardcoded z-index — so whichever
 * mounted last stayed on top forever, no matter which one you clicked.
 *
 * Module-level singleton: the open set is app state, not component state.
 */

// Ordered list of open window ids. Array order *is* stacking order — the last
// entry is topmost. WindowLayer maps index to z-index.
const openIds = reactive([])

// Last known position per window id. Deliberately outside the reactive list and
// never cleared: closing a window and reopening it should put it back where the
// user dragged it, not fling it to the default corner again.
const positions = new Map()

export function useWindows() {
  function isOpen(id) {
    return openIds.includes(id)
  }

  /** Open a window, or raise it if it is already open. */
  function openWindow(id) {
    if (isOpen(id)) {
      focusWindow(id)
      return
    }
    openIds.push(id)
  }

  function closeWindow(id) {
    const i = openIds.indexOf(id)
    if (i !== -1) openIds.splice(i, 1)
  }

  /** Raise a window to the top of the stack. */
  function focusWindow(id) {
    const i = openIds.indexOf(id)
    // Already topmost — bail before mutating, or every pointerdown on the
    // focused window would churn the array and restart its entry animation.
    if (i === -1 || i === openIds.length - 1) return
    openIds.splice(i, 1)
    openIds.push(id)
  }

  /**
   * Close the topmost window. Returns its id, or null if none were open, so
   * Escape handling can fall through to the next thing when nothing closed.
   */
  function closeTopWindow() {
    if (openIds.length === 0) return null
    return openIds.pop()
  }

  function closeAllWindows() {
    openIds.length = 0
  }

  function savePosition(id, pos) {
    positions.set(id, { ...pos })
  }

  function getPosition(id) {
    return positions.get(id) ?? null
  }

  return {
    windows: openIds,
    anyWindowOpen: computed(() => openIds.length > 0),
    isOpen,
    openWindow,
    closeWindow,
    focusWindow,
    closeTopWindow,
    closeAllWindows,
    savePosition,
    getPosition,
  }
}
