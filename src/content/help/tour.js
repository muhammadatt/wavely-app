import { withWindowControls } from './window.js'

/**
 * The interactive faceplate ("tour") shared by the help and marketing pages:
 * where each documented control's hotspot sits on the faceplate screenshot.
 *
 * Lives with the help content because both pages read it and the help entry
 * imports nothing outside `src/content/help/`.
 */

/**
 * Fewest numbered controls worth a tour. Every help page shows the tour in place
 * of the static window picture (November 2026: trialled on LA Vintage 2A, then
 * rolled out) — except a page whose faceplate carries fewer than this many
 * documented controls (Peak Normalize and the Effect Chain have one each),
 * where a single outlined box tells the reader nothing the picture does not.
 */
export const MIN_TOUR_SPOTS = 3

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
 * The help tour's image: the WHOLE window (`panel`, offset 0), header and
 * footer included — ON / BYPASS, DELTA, presets, Preview and Apply are part of
 * using an effect (owner, November 2026). The marketing pages keep the
 * faceplate alone (`face`, see MarketingApp), where the focus is the controls
 * that shape the sound. Falls back to the face when there is no window shot.
 */
export function tourImage(shots) {
  if (!shots) return null
  if (shots.panel) return { ...shots.panel, x: 0, y: 0 }
  return shots.face ?? null
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

/**
 * A help page's controls and its tour, from ONE merge of the window's controls
 * (`withWindowControls`), so the entries listed on the page and the numbers on
 * the tour come from the same list: `{ controls, tour }`, `tour` being
 * `{ image, spots }` or null when the page has no screenshot or too few
 * numbered controls (`MIN_TOUR_SPOTS`) and keeps the window picture instead.
 */
export function helpPage(controls, shots) {
  const merged = withWindowControls(controls, shots)
  const image = tourImage(shots)
  const spots = image ? helpTourSpots(merged, shots) : []
  return { controls: merged, tour: spots.length >= MIN_TOUR_SPOTS ? { image, spots } : null }
}

/** A help page's tour alone (`helpPage`'s `tour`). */
export function helpTour(controls, shots) {
  return helpPage(controls, shots).tour
}
