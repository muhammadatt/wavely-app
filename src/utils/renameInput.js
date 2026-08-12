import { nextTick } from 'vue'

/**
 * Focus handler for the inline rename inputs (tab strip, files panel, export
 * dialog).
 *
 * Vue calls a template function ref again on every re-render of the element,
 * and a rename input re-renders on every keystroke because it is bound with
 * v-model. Focusing and selecting unconditionally therefore re-selected the
 * name after each character typed, so the next character replaced everything
 * that came before it: typing "renamed" into a tab left a file called "d".
 *
 * The marker makes the setup run exactly once. It lives on the element rather
 * than in module state because each rename mounts a fresh input, so the flag
 * dies with the input it belongs to.
 */
export function focusRenameInput(el) {
  if (!el || el.dataset.renameFocused) return
  el.dataset.renameFocused = '1'

  // Deferred by a tick: the ref runs before v-model has written the current
  // name into the DOM value, so selecting here selects an empty string and the
  // caret ends up after the name instead of over it.
  nextTick(() => {
    el.focus()
    // Select the stem only. Every rename here ends up as a filename whose
    // extension is either kept as-is or replaced with .wav on export, so
    // putting the extension in the initial selection only makes it easy to
    // wipe by accident.
    const dot = el.value.lastIndexOf('.')
    if (dot > 0) el.setSelectionRange(0, dot)
    else el.select()
  })
}
