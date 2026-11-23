import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'

/**
 * The mobile shell's file switcher and Effects menu are its own, not rail
 * categories, so their open state lives here. One at a time: opening either
 * closes the other and any tool sheet (a rail view such as Fade), and the
 * shell closes both when a tool sheet opens (MobileEditorScreen).
 */
const fileSheetOpen = ref(false)
const effectsMenuOpen = ref(false)

export function useMobileSheets() {
  const { closeRail } = useEditorState()

  function openFileSheet() {
    closeRail()
    effectsMenuOpen.value = false
    fileSheetOpen.value = true
  }

  function openEffectsMenu() {
    closeRail()
    fileSheetOpen.value = false
    effectsMenuOpen.value = true
  }

  function closeEffectsMenu() {
    effectsMenuOpen.value = false
  }

  function closeFileSheet() {
    fileSheetOpen.value = false
  }

  function toggleFileSheet() {
    if (fileSheetOpen.value) closeFileSheet()
    else openFileSheet()
  }

  return {
    fileSheetOpen, openFileSheet, closeFileSheet, toggleFileSheet,
    effectsMenuOpen, openEffectsMenu, closeEffectsMenu,
  }
}

/** How far the handle must be dragged down before a sheet closes, px. */
export const SHEET_DISMISS_PX = 72

/**
 * A bottom sheet's grab handle: drag it down past SHEET_DISMISS_PX and the
 * sheet closes (`dismiss`); let go short of it and it springs back. `dragY`
 * is the sheet's offset while a finger holds it; bind `handle` to the handle.
 */
export function useSheetDrag(dismiss) {
  const dragY = ref(0)
  let from = null

  function end() {
    if (from === null) return
    const far = dragY.value >= SHEET_DISMISS_PX
    from = null
    dragY.value = 0
    if (far) dismiss()
  }

  const handle = {
    pointerdown(e) {
      from = e.clientY
      e.currentTarget.setPointerCapture?.(e.pointerId)
    },
    pointermove(e) {
      if (from !== null) dragY.value = Math.max(0, e.clientY - from)
    },
    pointerup: end,
    pointercancel: end,
  }

  return { dragY, handle }
}
