import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'

/**
 * The mobile shell's file switcher is a sheet of its own, not a rail
 * category, so its open state lives here. One sheet at a time: opening the
 * switcher closes a category's effect list, and the shell closes the switcher
 * when a category opens (MobileEditorScreen).
 */
const fileSheetOpen = ref(false)

export function useMobileSheets() {
  const { closeRail } = useEditorState()

  function openFileSheet() {
    closeRail()
    fileSheetOpen.value = true
  }

  function closeFileSheet() {
    fileSheetOpen.value = false
  }

  function toggleFileSheet() {
    if (fileSheetOpen.value) closeFileSheet()
    else openFileSheet()
  }

  return { fileSheetOpen, openFileSheet, closeFileSheet, toggleFileSheet }
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
