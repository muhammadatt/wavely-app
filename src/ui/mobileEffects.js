/**
 * The phone's Effects menu (components/mobile/MobileEffectsMenu.vue): which
 * operations it lists, and in what order its groups come.
 *
 * Every released effect is in it (owner, November 2026: the phone ships the
 * desktop panels, scaled, so there is no reason to hold any back — the Plugin
 * Chain already offers them all). The one-tap edit verbs (Cut, Copy, Paste,
 * Select All, registry `surface: 'immediate'`) are left out: the selection
 * bar holds them. Trim, Split and Silence stay, under Edit, for the choices
 * their panels carry (trim before / after, split at the playhead or the
 * selection's edges).
 *
 * Plain data and pure functions, testable without the registry (which imports
 * every panel's .vue file).
 */

/**
 * Categories the phone has no menu group for. Mastering presets are deferred
 * (Master is dev-only on desktop too) and not part of mobile v1, dev builds
 * included.
 */
export const MOBILE_EXCLUDED_CATEGORIES = new Set(['master'])

/** Group order in the menu: the effects first, the edits last. */
export const MOBILE_MENU_CATEGORY_ORDER = ['level', 'dynamics', 'tone', 'clean', 'edit']

/**
 * The operations the menu lists, from the registry's released `OPERATIONS`.
 * @param {object[]} operations
 */
export function mobileMenuOperations(operations) {
  return operations.filter(op =>
    op.category
    && !MOBILE_EXCLUDED_CATEGORIES.has(op.category)
    && op.surface !== 'immediate')
}

/**
 * The tool sheet's target line: what the panel open in it would act on. An
 * Apply runs on the selection, so with none the line says so (and the sheet
 * offers Select all beside it).
 *
 * @param {{ start: number, end: number } | null} selection
 * @param {boolean} hasFile
 */
export function targetLine(selection, hasFile) {
  if (!hasFile) return 'No file open'
  if (selection && selection.end > selection.start) {
    return `Selection · ${formatLength(selection.end - selection.start)}`
  }
  return 'Nothing selected'
}

function formatLength(seconds) {
  const s = Math.max(0, seconds || 0)
  if (s < 60) return `${s.toFixed(2)} s`
  const m = Math.floor(s / 60)
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`
}
