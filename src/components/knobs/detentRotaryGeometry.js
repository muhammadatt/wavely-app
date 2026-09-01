/**
 * Where a turn of the detent rotary lands.
 *
 * Extracted for the reason `travelSlideGeometry.js` and `selectionDrag.js` are:
 * the numbers that decide how a gesture feels are worth testing without a DOM,
 * and a drag mapping that drifts or cannot reach its own end stops still looks
 * exactly like a working knob.
 */

/**
 * Pixels of vertical travel per detent.
 *
 * ⚠ FIXED PER DETENT RATHER THAN PER FULL SWEEP, which is where this parts
 * company with `Knob.vue`'s continuous `DRAG_RANGE_PX = 150`. Spreading one
 * fixed distance across however many positions a caller passes would make the
 * same physical gesture mean two positions on one dial and six on another — the
 * control would feel different on every panel it appears on. 30 px is that 150
 * divided by the five positions the ratio switch has, so a full sweep of the
 * dial this was designed against matches the app's other knobs.
 */
export const DETENT_DRAG_PX = 30

/**
 * ⚠ A PRESS IS NEVER PERFECTLY STILL, so a turn has to out-travel the wobble of
 * an ordinary click or the cap could never be clicked to advance. Same figure
 * and same reason as `SELECTION_DRAG_THRESHOLD_PX` in the waveform.
 */
export const DETENT_DRAG_THRESHOLD_PX = 4

/**
 * The detent a turn has reached.
 *
 * `deltaY` is measured as `startY - currentY`, so UP is positive and turns the
 * dial clockwise — the direction the pointer already sweeps for every other knob
 * in the app.
 *
 * ⚠ MEASURED FROM WHERE THE GESTURE STARTED, NOT ACCUMULATED PER EVENT. Adding
 * up per-move deltas rounds at every step, so a slow drag rounds toward its
 * start on each one and the dial lags the pointer; worse, the error never
 * cancels, so returning the pointer to where it began does not return the dial.
 * Recomputing from the anchor makes the gesture reversible by construction.
 */
export function detentIndexFromDrag(startIndex, deltaY, count, pxPerDetent = DETENT_DRAG_PX) {
  if (!Number.isFinite(count) || count < 1) return 0
  const last = count - 1
  const from = Number.isFinite(startIndex) ? Math.min(last, Math.max(0, startIndex)) : 0
  if (!Number.isFinite(deltaY) || !Number.isFinite(pxPerDetent) || pxPerDetent <= 0) return from
  return Math.min(last, Math.max(0, Math.round(from + deltaY / pxPerDetent)))
}
