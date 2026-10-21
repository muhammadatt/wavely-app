import { nextTick, onBeforeUnmount, onMounted } from 'vue'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Focus handling for an `aria-modal` dialog: on open, focus moves inside —
 * to the element marked `data-autofocus`, else the first focusable one —
 * unless the dialog already focused something itself; Tab and Shift+Tab
 * wrap within it; on close, focus returns to whatever opened it.
 *
 * ⚠ The dialog must ALSO stop keydown propagation (the editor's shortcuts
 * listen on window). Keeping focus inside is what makes that sufficient: a
 * keydown can only start inside the dialog, so it never reaches the editor.
 *
 * Returns `trapTab(event)` for the dialog's own keydown handler.
 */
export function useModalFocus(rootRef) {
  let opener = null

  function focusables() {
    return [...(rootRef.value?.querySelectorAll(FOCUSABLE) ?? [])].filter(el => el.offsetParent !== null || el === document.activeElement)
  }

  onMounted(async () => {
    opener = document.activeElement
    await nextTick()
    if (rootRef.value && !rootRef.value.contains(document.activeElement)) {
      ;(rootRef.value.querySelector('[data-autofocus]') ?? focusables()[0] ?? rootRef.value).focus()
    }
  })

  onBeforeUnmount(() => {
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
  })

  function trapTab(e) {
    if (e.key !== 'Tab') return
    const items = focusables()
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !rootRef.value.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !rootRef.value.contains(active))) {
      e.preventDefault()
      first.focus()
    }
  }

  return { trapTab }
}
