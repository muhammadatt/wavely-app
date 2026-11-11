/**
 * How a file's name is shown on its tab, and how wide the tabs are.
 *
 * Design 1a (`Header Tabs v2`, owner, November 2026):
 *  - The extension is dropped: the row's Format readout already says it.
 *  - A long name is cut in the MIDDLE: the last TAIL characters are pinned and
 *    the head ellipsises, so "Chapter_07_take_v3" keeps its version suffix
 *    instead of every take reading "Chapter_07_ta…". The full name stays in
 *    the tab's tooltip.
 *  - Every tab shares ONE width: the widest name's natural width, between
 *    MIN and MAX, shrinking evenly when the strip is crowded — so switching
 *    files never moves a tab.
 */

export const TAB_NAME_TAIL = 6
export const TAB_MIN_WIDTH = 110
export const TAB_MAX_WIDTH = 280
// Left padding, gap, the 24 px close / dirty slot and right padding.
export const TAB_CHROME_WIDTH = 11 + 6 + 24 + 4
// Must match the tab label's CSS (12 px, owner, November 2026) or the shared
// width is measured for the wrong text.
export const TAB_FONT = '600 12px Inter, system-ui, sans-serif'

/** The name without its extension (a leading dot is part of the name). */
export function baseName(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

// The longest name kept in one piece: what fits the text room of a tab at
// TAB_MIN_WIDTH (110 − 45 = 65 px, ~9 characters at 12 px). Anything longer
// splits, so a crowded tab still shows its last characters; when there is
// room the two pieces render as the whole name anyway.
export const TAB_NAME_WHOLE_MAX = TAB_NAME_TAIL + 3

/**
 * Split a name for a middle cut: `head` ellipsises, `tail` is pinned. Names
 * short enough to fit the narrowest tab keep one piece.
 * @returns {{ head: string, tail: string }}
 */
export function splitTabName(name, tail = TAB_NAME_TAIL) {
  const base = baseName(name)
  if (base.length <= TAB_NAME_WHOLE_MAX) return { head: base, tail: '' }
  return { head: base.slice(0, -tail), tail: base.slice(-tail) }
}

/**
 * The shared tab width for a set of names.
 * @param {string[]} names
 * @param {(text: string) => number} textWidth  measures one label in TAB_FONT
 */
export function sharedTabWidth(names, textWidth) {
  let need = 0
  for (const name of names) {
    const { head, tail } = splitTabName(name)
    need = Math.max(need, TAB_CHROME_WIDTH + textWidth(head + tail))
  }
  return Math.round(Math.min(TAB_MAX_WIDTH, Math.max(TAB_MIN_WIDTH, Math.ceil(need))))
}
