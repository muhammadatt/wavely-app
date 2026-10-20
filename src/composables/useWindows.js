import { reactive, computed } from 'vue'
import { isChainCopyId } from './pluginCopies.js'

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

/**
 * Windows that may stay open beside anything: the analyzer reads whatever is
 * playing, and the Modula kit is a dev gallery. Every other window is a
 * PLUGIN window, and plugin windows open in one of two groups:
 *
 *   the CHAIN group — the Plugin Chain window and the windows of the plugin
 *                     copies in it (`<id>@chain`, see pluginCopies.js). Any
 *                     number of these may be open at once: they are one rack,
 *                     edited together.
 *   a SOLO plugin   — a plugin's own copy, opened on its own — whether or not
 *                     the same plugin also has a slot in the chain.
 *
 * The two never share the screen. Opening a chain-group window closes a solo
 * plugin's; opening a solo plugin closes every other plugin window, the chain
 * group included (its slots keep playing — only their windows close). Having
 * plugins that are in the chain and plugins that are not open side by side
 * made it impossible to tell which Apply did what.
 */
export const ALONGSIDE_WINDOW_IDS = new Set(['spectrum-analyzer', 'modula-kit'])

export const CHAIN_WINDOW_ID = 'plugin-chain'

const isPluginWindow = id => !ALONGSIDE_WINDOW_IDS.has(id)

const inChainGroup = id => id === CHAIN_WINDOW_ID || isChainCopyId(id)

/** A plugin window that is not the chain's: while one is open the chain is suspended. */
export const isSoloPluginWindow = id => isPluginWindow(id) && !inChainGroup(id)

// Last known position per window id. Deliberately outside the reactive list and
// never cleared: closing a window and reopening it should put it back where the
// user dragged it, not fling it to the default corner again.
const positions = new Map()

// Last known size per window id, for the subset of windows that opt into
// resizing (see FloatingWindow's `resizable` prop). Same lifetime rule as
// positions: outside the reactive list, never cleared, so a resized window
// reopens at the size it was left rather than back at its default.
const sizes = new Map()

export function useWindows() {
  function isOpen(id) {
    return openIds.includes(id)
  }

  /**
   * Open a window, or raise it if it is already open. A plugin window closes
   * the plugin windows it may not share the screen with — see the groups above.
   */
  function openWindow(id) {
    if (isOpen(id)) {
      focusWindow(id)
      return
    }
    if (isPluginWindow(id)) {
      const chainSide = inChainGroup(id)
      for (let i = openIds.length - 1; i >= 0; i--) {
        const other = openIds[i]
        if (!isPluginWindow(other)) continue
        if (chainSide && inChainGroup(other)) continue
        openIds.splice(i, 1)
      }
      // A chain copy opens WITH the chain: its Apply lives there.
      if (chainSide && id !== CHAIN_WINDOW_ID && !openIds.includes(CHAIN_WINDOW_ID)) {
        openIds.push(CHAIN_WINDOW_ID)
      }
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

  function saveSize(id, size) {
    sizes.set(id, { ...size })
  }

  function getSize(id) {
    return sizes.get(id) ?? null
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
    saveSize,
    getSize,
  }
}
