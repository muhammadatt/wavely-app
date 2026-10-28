/**
 * Saving a document back to a file on disk.
 *
 * Export renders a timeline and hands the bytes to the download folder; saving
 * renders it at the format chosen in the Save dialog and writes it to a file
 * the user named, in place. The render half is shared — `renderRegionToBuffer`
 * is the one path that turns an EDL into samples, and nothing here duplicates it.
 *
 * The write half needs the File System Access API, which is Chromium-only on
 * the desktop today. Everywhere else this degrades to the download the export
 * path already does: same bytes, worse ergonomics, never a dead button.
 *
 * WRITING OVER THE FILE A DOCUMENT WAS OPENED FROM is allowed, but only from
 * the Save dialog and only once the user has seen the name and the format. It
 * was refused outright at first, for two reasons that still shape the rules:
 * the encoder could only write 16-bit, so a silent Ctrl+S would have replaced a
 * 24-bit master with a reduced-depth render of itself; and a document does not
 * survive a reload (buffers are in memory only), so handles are never persisted
 * — a restored write target would have nothing left to write to it. The
 * encoder now writes 16, 24 and 32-bit float, the dialog defaults to the
 * source's own depth and rate and says when a choice is lower, and only a WAV
 * is ever replaced (`savePlan` in saveFormat.js). Handles still live only as
 * long as the tab.
 */
import { downloadBlob } from './download.js'
import { FORMATS, toSaveFileName } from './saveFormat.js'

/** True when this browser can write back to a file the user picked. */
export function canSaveInPlace() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

/** True for the DOMException a picker throws when the user hits Cancel. */
export function isCancellation(err) {
  return err?.name === 'AbortError'
}

/**
 * Ask for a save destination. `suggestedName` is given the chosen format's
 * extension — offering to write FLAC bytes under a .wav name produces a file
 * nothing can open — and the picker filters to that format.
 *
 * `startIn` is a handle the dialog should open beside — the file last saved
 * to, or the one the document was opened from. A FILE handle opens its parent
 * folder, which is exactly "the original file's folder". Without one the
 * browser picks (usually Documents, or wherever it last saved).
 *
 * @returns {Promise<FileSystemFileHandle>} rejects with AbortError if cancelled
 */
export function pickSaveTarget(suggestedName, startIn = null, format = 'wav') {
  const f = FORMATS[format] ?? FORMATS.wav
  const options = {
    suggestedName: toSaveFileName(suggestedName || 'untitled', f.id),
    types: [{ description: `${f.label} audio`, accept: { [f.mime]: [f.ext] } }],
  }
  if (startIn) options.startIn = startIn
  return window.showSaveFilePicker(options)
}

/**
 * Re-check write permission on a handle.
 *
 * A handle carries its grant for as long as the tab lives, so in the common
 * case this is a no-op query. It still has to be asked: the user can revoke
 * the grant from the site controls mid-session, and `createWritable` on a
 * revoked handle throws a NotAllowedError that reads like a bug.
 *
 * The permission methods are the newest part of this API and not every engine
 * that ships the pickers ships them. A browser with no `queryPermission` is not
 * refusing us — it has nothing to ask — so "cannot be queried" resolves to
 * "attempt the write", and a genuine refusal surfaces as the write throwing.
 * Optional-chaining the calls instead returns undefined, which compares unequal
 * to 'granted' and blocks the save behind a permission message nobody sent.
 */
export async function ensureWritePermission(handle) {
  if (typeof handle.queryPermission !== 'function') return true
  const opts = { mode: 'readwrite' }
  if (await handle.queryPermission(opts) === 'granted') return true
  if (typeof handle.requestPermission !== 'function') return true
  return await handle.requestPermission(opts) === 'granted'
}

/**
 * Write bytes to a handle, replacing whatever was there.
 *
 * `createWritable()` truncates by default, so a render shorter than the file
 * already on disk doesn't leave the old tail behind it. The abort on failure
 * matters more than it looks: a writable left open holds the browser's swap
 * copy, and on some platforms the original is not restored until it closes.
 */
export async function writeFileToHandle(handle, bytes, mime) {
  const writable = await handle.createWritable()
  try {
    await writable.write(new Blob([bytes], { type: mime }))
  } catch (err) {
    await writable.abort?.()
    throw err
  }
  await writable.close()
}

/**
 * What a save of this document has to do.
 *
 *   'write'    — a destination is known; overwrite it silently
 *   'pick'     — no destination yet; this Save is a Save As
 *   'download' — no way to write files here; fall back to the download folder
 *
 * Pure, so the rule that decides whether Ctrl+S opens a dialog is testable
 * without a browser — it is the part of this feature users notice.
 */
export function saveTargetKind(handle, supportsInPlace = canSaveInPlace()) {
  if (!supportsInPlace) return 'download'
  return handle ? 'write' : 'pick'
}

/** Save-as-download fallback, for browsers with no write API. */
export function downloadFile(bytes, fileName, mime) {
  downloadBlob(new Blob([bytes], { type: mime }), fileName)
}
