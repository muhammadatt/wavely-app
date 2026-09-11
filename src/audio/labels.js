import { createMarker, markerSpans, MARKER_EPSILON } from './markers.js'

/**
 * Audacity label files — the interchange format for markers.
 *
 * ── WHY THIS FORMAT ────────────────────────────────────────────────────────
 * `start<TAB>end<TAB>name`, one row per line. It is the de-facto exchange
 * format for exactly this data: Audacity reads and writes it, so do most
 * transcription tools, forced aligners and batch splitters, and it is three
 * fields of plain text — a narrator can open it in a spreadsheet, fix a
 * chapter name, and load it back. A bespoke JSON format would be easier to
 * write and useful to nobody but this app.
 *
 * ── EXPORT WRITES SPANS, IMPORT READS BOUNDARIES ───────────────────────────
 * The two are deliberately not symmetric in shape, only in effect. Markers
 * are points, but a label file whose rows are all zero-length points loses
 * the thing the receiving tool wants — the extent of each slice — and shows up
 * in Audacity as a row of pins rather than labelled regions. So export writes
 * one row per span from `markerSpans`, and import turns each row back into its
 * boundaries. Round-tripping a file through both is stable.
 */

/** Audacity writes six decimal places; matching it keeps diffs quiet. */
const TIME_DP = 6

/**
 * Markers → label file text.
 *
 * @param {Array} markers
 * @param {number} totalDuration
 * @returns {string} one `start\tend\tname\n` row per span
 */
export function formatAudacityLabels(markers, totalDuration) {
  return markerSpans(markers, totalDuration)
    .map(span => {
      // Tabs and newlines would break the row apart on the way back in, and a
      // name is free text the user typed. Spaces are the least surprising
      // substitution — nothing downstream treats them specially.
      const name = span.name.replace(/[\t\r\n]+/g, ' ')
      return `${span.start.toFixed(TIME_DP)}\t${span.end.toFixed(TIME_DP)}\t${name}`
    })
    .join('\n') + '\n'
}

/**
 * Label file text → markers.
 *
 * Each row contributes its start as a marker, named after the row, and its end
 * as an unnamed one — the end of one region is the start of the next, so in a
 * contiguous file those ends land on the following row's start and collapse.
 * In a file of sparse regions they are real boundaries and have to be kept, or
 * the gaps between regions would silently merge into them.
 *
 * Rows that are not three tab-separated fields, or whose times are not finite
 * numbers, are skipped rather than failing the import: these files are hand-
 * edited, and one bad line should not lose the other three hundred.
 *
 * @returns {{ markers: Array, skipped: number }}
 */
export function parseAudacityLabels(text) {
  const markers = []
  let skipped = 0

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    const fields = line.split('\t')
    if (fields.length < 2) { skipped++; continue }

    const start = Number(fields[0])
    const end = Number(fields[1])
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) { skipped++; continue }

    // A third field is the name; a name containing tabs would have been
    // flattened on the way out, but a hand-edited file may still carry one, so
    // anything past the second field rejoins rather than being dropped.
    const name = fields.slice(2).join(' ').trim()

    markers.push(createMarker(start, { name }))
    if (end > start + MARKER_EPSILON) markers.push(createMarker(end))
  }

  return { markers: mergeBoundaries(markers), skipped }
}

/**
 * Collapse coincident boundaries, keeping the one that carries a name.
 *
 * ⚠ NOT `normalizeMarkers`, AND THIS IS THE WHOLE OF WHY. In a contiguous
 * label file the end of one region and the start of the next are the same
 * instant, and only the start carries the name. normalizeMarkers keeps the
 * first of a colliding group, which here is always the unnamed end — so every
 * name in the file was silently dropped on import. Named wins; between two
 * named boundaries the earlier one does, as everywhere else.
 */
function mergeBoundaries(markers) {
  const sorted = [...markers].sort((a, b) => a.time - b.time)
  const out = []
  for (const m of sorted) {
    const prev = out[out.length - 1]
    if (prev && Math.abs(m.time - prev.time) < MARKER_EPSILON) {
      if (!prev.name && m.name) out[out.length - 1] = m
      continue
    }
    out.push(m)
  }
  return out
}

/** `chapter-03.wav` → `chapter-03.labels.txt`. */
export function toLabelFileName(fileName) {
  const trimmed = String(fileName ?? '').replace(/[.\s]+$/, '')
  const base = trimmed.replace(/\.[^.]+$/, '')
  return (base || trimmed || 'untitled') + '.labels.txt'
}
