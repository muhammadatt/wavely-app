/**
 * Plugin windows on a phone: a full-screen sheet, scaled to fit.
 *
 * Plugin faceplates are laid out by hand at one width (560–868 px) and a
 * floating window that size on a 390–430 px tall phone is cut off and cannot
 * be dragged back. Redesigning twenty panels for a narrow screen is not on the
 * table, so on a small viewport the window instead becomes a SHEET: pinned to
 * the whole screen, not draggable or resizable, and — when the screen is
 * narrower than the faceplate — the whole frame scaled down with CSS `zoom`
 * until the faceplate fits the width. Zoom (unlike a transform) scales layout,
 * so the body still scrolls the right distance and hit-testing still lands.
 *
 * The rules are here rather than in FloatingWindow so they can be tested
 * without a DOM.
 */

/**
 * The viewport that turns windows into sheets. Mirrors the `compact:` variant
 * in main.css: a phone either way up, or any window too short for a floating
 * panel plus the editor behind it.
 */
export const SHEET_MAX_HEIGHT = 520
export const SHEET_MAX_WIDTH = 640

/**
 * A window this much narrower than the viewport still floats. Below it there
 * is no room to move the window aside, which is what floating is for.
 */
export const SHEET_SIDE_ROOM = 32

/**
 * Below this the faceplate is unreadable even pinched; the sheet stops
 * shrinking and the page's own pinch-zoom has to take over.
 */
export const SHEET_MIN_ZOOM = 0.45

/**
 * Whether a window `designW` wide should be a sheet in this viewport.
 *
 * @param {{ viewportW: number, viewportH: number, designW: number }} opts
 */
export function isSheetViewport({ viewportW, viewportH, designW }) {
  return viewportH <= SHEET_MAX_HEIGHT
    || viewportW <= SHEET_MAX_WIDTH
    || viewportW < designW + SHEET_SIDE_ROOM
}

/**
 * The sheet's zoom and its size in the frame's own (unzoomed) pixels.
 *
 * The frame is laid out at `width` × `height` and then zoomed, so it covers the
 * viewport exactly: `width · zoom = viewportW`. A faceplate that fits is not
 * enlarged (zoom 1) — it just gets the spare width.
 *
 * @param {{ viewportW: number, viewportH: number, designW: number }} opts
 * @returns {{ zoom: number, width: number, height: number }}
 */
export function sheetGeometry({ viewportW, viewportH, designW }) {
  const zoom = Math.max(SHEET_MIN_ZOOM, Math.min(1, viewportW / designW))
  return { zoom, width: viewportW / zoom, height: viewportH / zoom }
}
