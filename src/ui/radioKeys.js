/**
 * Keyboard behaviour for a hand-built role="radiogroup" of buttons — the same
 * contract ModulaSegmented keeps: one tab stop (the checked option, or the
 * first when none is, so a value off the group — a dragged Max reduction of
 * 14 dB — never leaves it unreachable), and arrow keys that move, wrap and
 * select.
 */

/** Index of the option holding the tab stop. */
export function radioTabStop(options, isChecked) {
  const i = options.findIndex(isChecked)
  return i < 0 ? 0 : i
}

/**
 * Handle an arrow key on option `i` of `options`: pick the next one (wrapping)
 * and move focus to it. Other keys pass through.
 */
export function radioArrowKey(e, i, options, pick) {
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
    : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!d) return
  e.preventDefault()
  const n = options.length
  const j = (i + d + n) % n
  pick(options[j])
  e.currentTarget?.parentElement?.children[j]?.focus()
}
