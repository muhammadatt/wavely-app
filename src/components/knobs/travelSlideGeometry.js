/**
 * Where a pointer on the travel slide's track lands.
 *
 * Extracted from the component for the reason `selectionDrag.js` and
 * `resonanceZoneEdit.js` are: an axis mapping that is off by one still looks
 * exactly like a working slider, and the failure is at the ends — the last stop
 * unreachable, or the first one claiming a sliver of the track that belongs to
 * nothing. Those are cheap to assert here and invisible in a screenshot.
 */

/**
 * The stop under a pointer, from its position along the track as a 0..1 ratio.
 *
 * The track is divided into `count` equal slots and stop `i` owns slot `i` —
 * the same division the thumb is drawn in (`left: i * 100/n %`) and the labels
 * are laid out in (one flex child each), so the number under the pointer is the
 * one under the label the pointer is over.
 *
 * ⚠ FLOORING IS ALREADY NEAREST-CENTRE, so it should not be "improved" into a
 * round(). The thumb's centre for stop i sits at `(i + 0.5) / n`, and
 * `round(r*n - 0.5)` is `floor(r*n)` everywhere except exact ties. Rounding the
 * raw `r*n` instead would bias every stop half a slot to the left.
 *
 * Out-of-range ratios clamp rather than wrapping: a drag continues past both
 * ends of the track once the pointer is captured, and running off the right
 * edge means "the last one", not "back to the first".
 */
export function stopIndexFromRatio(ratio, count) {
  if (!Number.isFinite(ratio) || !Number.isFinite(count) || count < 1) return 0
  return Math.min(count - 1, Math.max(0, Math.floor(ratio * count)))
}
