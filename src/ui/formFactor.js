/**
 * Which editor shell to show: the desktop layout or the mobile one
 * (docs: the mobile design page, "Desktop vs mobile UI").
 *
 * Picked ONCE, at startup, from the screen and the pointer — a touch screen
 * whose SHORT side is under MOBILE_SHORT_SIDE_PX is a phone, held either way
 * up — unless the user chose a layout ("Use desktop layout" / "Use phone
 * layout"), which wins and is kept per browser. Rotating a phone never swaps
 * the shell mid-session; it only reflows it. A tablet (short side 768+) keeps
 * the desktop layout with its touch fixes.
 *
 * Pure: the caller passes what it read from the browser.
 */

export const LAYOUTS = ['desktop', 'mobile']
export const MOBILE_SHORT_SIDE_PX = 640
export const LAYOUT_STORAGE_KEY = 'wavely:layout'

/**
 * @param {{ width: number, height: number, coarsePointer: boolean, override?: string|null }} p
 * @returns {'desktop'|'mobile'}
 */
export function pickLayout({ width, height, coarsePointer, override = null }) {
  if (LAYOUTS.includes(override)) return override
  return coarsePointer && Math.min(width, height) < MOBILE_SHORT_SIDE_PX ? 'mobile' : 'desktop'
}
