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

/**
 * Seconds → `m:ss.mmm`. Used where a *position* is shown rather than a length.
 *
 * Whole seconds are enough for "this file is 4:12 long" and nowhere near
 * enough for "this marker is at 4:12" — two boundaries a third of a second
 * apart would render identically, which is exactly the case a marker list has
 * to distinguish. Milliseconds rather than frames because the editor has no
 * frame rate to be wrong about.
 */
export function formatTimecode(seconds) {
  const safe = Math.max(0, seconds)
  const m = Math.floor(safe / 60)
  const s = Math.floor(safe % 60)
  const ms = Math.floor((safe % 1) * 1000)
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`
}
