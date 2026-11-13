import { getTimelineDuration } from './operations.js'
import { ZIP_SIZE_LIMIT } from './zip.js'
import { defaultSaveSettings, estimateSaveBytes, toSaveFileName, FORMATS } from './saveFormat.js'

/**
 * The rules an export follows before any audio is rendered: what it will be
 * called, roughly how big it will be, and whether it can be delivered at all.
 *
 * Separate from `useExport` because that module reaches `renderTimelineToWav`,
 * which reaches every AudioWorklet in the app through `?worker&url` specifiers
 * only Vite resolves — importing it under `node --test` fails at load. These
 * are the parts worth testing and they are pure, so they live where a test can
 * reach them. Same reason `download.js` was split out of `export.js`.
 */

/**
 * Largest WAV the encoder can describe: `RIFF` and `data` are both 32-bit
 * size fields, and nothing in the format signals an overflow — a larger file
 * is written happily and read back as garbage.
 */
export const WAV_SIZE_LIMIT = 0xffffffff

/**
 * What a document exports as: the format, depth, rate and (for MP3) bitrate of
 * the file it was opened from — the same defaults the Save dialog opens on.
 *
 * ⚠ EXPORT USED TO WRITE 16-BIT WAV WHATEVER CAME IN, so an MP3 chapter came
 * back as a WAV five times its size and a 24-bit or FLAC source lost its
 * format. Nothing about exporting several files at once is a reason to change
 * their type; a file whose source is unknown (or a container we cannot write,
 * AIFF, M4A) still falls back to WAV, as Save does.
 */
export function exportSettingsFor(doc) {
  const f = doc.currentFile ?? {}
  return defaultSaveSettings(f.sourceFormat ?? null, f.sampleRate, f.channels ?? 1)
}

/** Expected bytes at the document's export settings (FLAC is an estimate). */
export function estimatedBytes(doc) {
  const dur = getTimelineDuration(doc.segments)
  const f = doc.currentFile
  if (!f || !dur) return 0
  return estimateSaveBytes(dur, f.channels, exportSettingsFor(doc)).bytes
}

export function totalBytes(docs) {
  return docs.reduce((sum, d) => sum + estimatedBytes(d), 0)
}

export function formatSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

/**
 * Bytes a zip entry costs on top of its payload: a 30-byte local header and a
 * 46-byte central-directory record, each followed by the filename. The archive
 * then ends with a 22-byte end-of-central-directory record.
 */
const ZIP_LOCAL_HEADER = 30
const ZIP_CENTRAL_RECORD = 46
const ZIP_END_RECORD = 22

const encoder = new TextEncoder()

/** What the archive will actually weigh, headers and directory included. */
export function archiveBytes(docs) {
  const names = uniqueNames(docs)
  const entries = docs.reduce((sum, doc, i) => (
    sum + estimatedBytes(doc)
      + ZIP_LOCAL_HEADER + ZIP_CENTRAL_RECORD + 2 * encoder.encode(names[i]).length
  ), 0)
  return entries + ZIP_END_RECORD
}

/**
 * Whether this selection can be delivered at all, and what to say if not.
 *
 * ⚠ THE CEILING IS NOT A ZIP PROBLEM, AND CALLING IT ONE UNDERSHOT IT TWICE.
 * This started as "a single file is downloaded as-is, so only a zip can run out
 * of address space", which is wrong in both directions:
 *
 *   - A WAV has 32-bit size fields of its own (`RIFF` at offset 4, `data` at
 *     40). One 5 GB file is not saved by skipping the archive — it wraps, and
 *     the user gets a file that every player reads as a few hundred MB of
 *     garbage. A lone file needs the same refusal.
 *   - An archive weighs more than its payloads. Every entry costs a local
 *     header, a central-directory record and two copies of its name, so a
 *     selection measured at just under the limit crosses it once written, and
 *     the writer wraps the offsets instead of refusing.
 *
 * Both produce a corrupt file rather than an error, which is why this is a
 * refusal up front rather than a check after the render.
 *
 * @returns {null | { bytes: number, message: string }} null when it will fit
 */
export function exportSizeLimit(docs) {
  if (docs.length === 0) return null

  if (docs.length === 1) {
    // Only a WAV has the 32-bit size fields; FLAC and MP3 go out as they are.
    // The estimate already carries the header; the RIFF field counts 36 + data,
    // so measuring the whole file is 8 bytes conservative.
    if (exportSettingsFor(docs[0]).format !== 'wav') return null
    const bytes = estimatedBytes(docs[0])
    if (bytes <= WAV_SIZE_LIMIT) return null
    return {
      bytes,
      message: `This file is ${formatSize(bytes)} — over the 4 GB ceiling a WAV's `
        + 'own size fields can address. Split it before exporting.',
    }
  }

  const bytes = archiveBytes(docs)
  if (bytes <= ZIP_SIZE_LIMIT) return null
  return {
    bytes,
    message: `This selection packs to ${formatSize(bytes)} — over the 4 GB zip limit. `
      + 'Export in smaller batches.',
  }
}

/**
 * Each document's export filename — its name with its export format's
 * extension — disambiguated where two would collide.
 *
 * Two documents can legitimately carry the same name — the same chapter opened
 * from two folders, or "take.wav" and "take.m4a" (which has no writer, so exports as WAV) — and inside a zip the second
 * would silently replace the first.
 */
export function uniqueNames(docs) {
  // ⚠ THE GENERATED NAMES GO IN THE SET TOO. Counting occurrences of the
  // ORIGINAL name is not enough: "chapter.wav", "chapter.wav", and a file the
  // user already called "chapter (2).wav" produced the suffix twice, and the
  // zip ended up with the duplicate entry this function exists to prevent.
  //
  // A name that is already taken suffixes ITSELF — "chapter (2) (2).wav" — it
  // is not renumbered into the generated run. Uglier, but "chapter (2).wav" is
  // the name the user gave that file, and calling it "chapter (3).wav" claims
  // it is the third copy of something it may have nothing to do with.
  const taken = new Set()
  return docs.map(doc => {
    const format = exportSettingsFor(doc).format
    const base = toSaveFileName(doc.name, format)
    const ext = base.slice(-FORMATS[format].ext.length)
    const stem = base.slice(0, -ext.length)
    let candidate = base
    let n = 1
    while (taken.has(candidate)) {
      n += 1
      candidate = `${stem} (${n})${ext}`
    }
    taken.add(candidate)
    return candidate
  })
}
