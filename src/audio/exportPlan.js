import { getTimelineDuration } from './operations.js'
import { toWavFileName } from './download.js'
import { ZIP_SIZE_LIMIT } from './zip.js'

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

/** 16-bit PCM: bytes = samples × channels × 2, plus a 44-byte header. */
export function estimatedBytes(doc) {
  const dur = getTimelineDuration(doc.segments)
  const f = doc.currentFile
  if (!f || !dur) return 0
  return Math.round(dur * f.sampleRate) * f.channels * 2 + 44
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
 * A single file is downloaded as-is, so only a zip can run out of address
 * space — the writer is not zip64, and an archive over 4 GB would come out
 * corrupt rather than refused.
 */
export function overZipLimit(docs) {
  return docs.length > 1 && totalBytes(docs) > ZIP_SIZE_LIMIT
}

/**
 * Disambiguate names that collide once extensions are normalised to .wav.
 *
 * Two documents can legitimately carry the same name — the same chapter opened
 * from two folders, or "take.wav" and "take.flac" — and inside a zip the second
 * would silently replace the first.
 */
export function uniqueNames(docs) {
  const seen = new Map()
  return docs.map(doc => {
    const base = toWavFileName(doc.name)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    if (count === 0) return base
    return base.replace(/\.wav$/, ` (${count + 1}).wav`)
  })
}
