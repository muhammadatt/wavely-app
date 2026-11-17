/**
 * The interactive faceplate ("tour") shared by the help and marketing pages:
 * where each documented control's hotspot sits on the faceplate screenshot.
 *
 * Lives with the help content because both pages read it and the help entry
 * imports nothing outside `src/content/help/`.
 */

/**
 * Help pages that show the tour in place of the static window picture. A trial
 * (November 2026): LA Vintage 2A first; add an id here to move another page
 * over, or drop the set once every page has moved.
 */
export const HELP_TOUR_IDS = new Set(['opto-smooth'])

/**
 * A control's box (`at`, measured on the whole window) on the faceplate crop
 * (`face`: its size and offset in the window), clamped to the face — or null
 * when most of it lies off the face (a control in the window's header). A box
 * a few pixels over the edge is kept: LA Vintage 2A's meter bezel starts 2 px
 * into the header.
 */
export function spotOnFace(at, face) {
  const x0 = Math.max(0, at.x - face.x), y0 = Math.max(0, at.y - face.y)
  const x1 = Math.min(face.w, at.x - face.x + at.w), y1 = Math.min(face.h, at.y - face.y + at.h)
  if (x1 <= x0 || y1 <= y0) return null
  return (x1 - x0) * (y1 - y0) >= 0.5 * at.w * at.h ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

/**
 * The tour's image: the faceplate alone (`face`), falling back to the whole
 * window (offset 0) for an effect shot before the face crop existed.
 */
export function tourImage(shots) {
  if (!shots) return null
  return shots.face ?? (shots.panel ? { ...shots.panel, x: 0, y: 0 } : null)
}

/**
 * Hotspots for every help control that has a box on the faceplate, in the
 * entry's (panel) order: `[{ id, label, text, at }]`, `id` being the control's
 * `shot`. Controls with no shot, or off the face, are left out.
 */
export function helpTourSpots(controls, shots) {
  const image = tourImage(shots)
  if (!image) return []
  const seen = new Set()
  return (controls ?? []).flatMap((c) => {
    if (!c.shot || seen.has(c.shot)) return []
    const raw = shots.controls?.[c.shot]?.at
    const at = raw && spotOnFace(raw, image)
    if (!at) return []
    seen.add(c.shot)
    return [{ id: c.shot, label: c.label, text: c.text, at }]
  })
}
