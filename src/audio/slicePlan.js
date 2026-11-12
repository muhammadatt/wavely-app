import { cloneSegments, trimToSelection } from './operations.js'
import { markerSpans } from './markers.js'

/**
 * Turning a marked-up timeline into one exportable file per slice.
 *
 * ── A SLICE IS A TIMELINE, SO IT IS A DOCUMENT ─────────────────────────────
 * Everything export already knows — disambiguating colliding names, zipping
 * more than one file, refusing an archive the zip writer cannot address,
 * skipping a file that fails to render rather than aborting its siblings —
 * works on `{ name, segments, currentFile }` and nothing else. So a slice is
 * built as exactly that shape and handed to the same `exportDocuments`, rather
 * than growing a second export path beside it. `exportPlan.js` says it plainly:
 * two copies of those rules would drift, and the second copy is how a surface
 * ends up quietly worse than the other.
 *
 * This module is therefore only the part that is actually new: which spans
 * become files, and what each one is called. It imports no worklet chain, so
 * unlike the export path itself it can be tested under node.
 */

/**
 * Hard ceiling on slices per export.
 *
 * Not a technical limit — it is a guard against a marker set that is obviously
 * not a chapter list (a stray import, a click-happy session) turning into a
 * thousand-entry zip the browser renders synchronously. Well past any real
 * audiobook: the longest trade books run to a few hundred chapters.
 */
export const MAX_SLICES = 500

/** Characters a file name cannot carry, plus leading/trailing junk. */
function sanitize(name) {
  return String(name ?? '')
    // Path separators first: a marker named "Act 1/Scene 2" must not become a
    // directory inside the zip.
    .replace(/[/\\]+/g, '-')
    // The rest of what Windows refuses, plus control characters. Replaced with
    // a space rather than deleted: "bad:name" should read "bad name", not
    // "badname" — the character was a word boundary. A name that is nothing
    // but punctuation collapses to empty here and the slice stays numbered.
    .replace(/[<>:"|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A name that is only dots is a directory reference, not a file.
    .replace(/^\.+$/, '')
}

/**
 * What one slice is called, before the `.wav` the export path appends.
 *
 * The index leads and is zero-padded to the width of the count, so the files
 * sort in playing order in every file manager — which is the whole job for a
 * narrator handing over chapters. The marker's name follows when it has one;
 * `uniqueNames` in exportPlan.js settles any collision between two slices the
 * user named the same thing.
 */
export function sliceName(baseName, index, count, spanName) {
  const base = sanitize(baseName).replace(/\.[^.]+$/, '') || 'untitled'
  const width = String(count).length
  const n = String(index + 1).padStart(width, '0')
  const label = sanitize(spanName)
  return label ? `${base} ${n} ${label}` : `${base} ${n}`
}

/**
 * The spans that become files.
 *
 * ⚠ GAP SPANS ARE EXCLUDED, and that is the point of flagging one. A gap is
 * the user saying "this stretch is dead air" — writing it out as a file would
 * contradict the flag, and silently exporting room tone as "chapter 4" is
 * worse than any error message. It is also what makes a gap marker earn its
 * place: before this it only fed "Delete gaps".
 */
export function exportableSpans(markers, totalDuration) {
  return markerSpans(markers, totalDuration).filter(s => s.kind !== 'gap')
}

/**
 * Build one export-shaped document per slice.
 *
 * ⚠ EACH SLICE GETS ITS OWN CLONE. `trimToSelection` runs `recalcOutputStarts`,
 * which rewrites `outputStart` ON THE SEGMENT OBJECTS IT WAS GIVEN — handing it
 * the live array would renumber the open document's timeline, once per slice.
 * The clone is shallow, so the audio buffers are shared and nothing is copied
 * but the pointers.
 *
 * @param {{ segments: Array, markers: Array, totalDuration: number,
 *           currentFile: Object, name: string }} doc
 * @returns {{ name: string, segments: Array, currentFile: Object }[]}
 */
export function sliceDocuments({ segments, markers, totalDuration, currentFile, name }) {
  if (!segments?.length || !currentFile || !(totalDuration > 0)) return []

  const sr = currentFile.sampleRate
  // ⚠ BOUNDARIES GO ON THE SAMPLE GRID, OR THE SLICES DO NOT TILE THE FILE.
  // renderRegionToBuffer sizes its buffer with Math.ceil and copies
  // Math.floor samples, so a boundary falling between two samples leaves
  // trailing silence in the slice and the pieces no longer add up: measured on
  // a 4-slice export, 352801 samples written against the source's 352800, with
  // up to three zero samples at a slice's end. Inaudible — 68 µs at a
  // zero-crossing — but a file boundary belongs ON a sample, and a narrator who
  // re-joins the chapters should get the recording back, not the recording plus
  // a sample per cut.
  const onGrid = t => Math.round(t * sr) / sr

  const spans = exportableSpans(markers, totalDuration)
  return spans.map((span, i) => ({
    name: sliceName(name, i, spans.length, span.name),
    // Adjacent spans share a boundary, so quantising both ends keeps them
    // flush: slice k's end is slice k+1's start, before and after rounding.
    segments: trimToSelection(cloneSegments(segments), onGrid(span.start), onGrid(span.end)),
    currentFile,
  }))
}
