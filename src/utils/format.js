/**
 * Shared display formatters.
 *
 * These were copy-pasted across four components; a duration rendered in the tab
 * strip and the same duration rendered in the export dialog must agree, so the
 * rounding rule lives in exactly one place.
 */

/** Seconds → `m:ss`. Used wherever a whole-file length is shown. */
export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
