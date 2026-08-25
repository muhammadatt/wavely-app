/**
 * Saving a document back to a file on disk.
 *
 * Export renders a timeline and hands the bytes to the download folder; saving
 * renders the same bytes and writes them to a file the user already named, in
 * place, with no dialog. The render half is shared — `renderTimelineToWav` is
 * the one path that turns an EDL into bytes, and nothing here duplicates it.
 *
 * The write half needs the File System Access API, which is Chromium-only on
 * the desktop today. Everywhere else this degrades to the download the export
 * path already does: same bytes, worse ergonomics, never a dead button.
 *
 * WHAT IS DELIBERATELY NOT HERE: a handle for the file the document was opened
 * from. Two reasons, and neither is effort. A handle from an *open* picker
 * points at the user's source recording, and this app can only encode 16-bit
 * WAV — so a silent Ctrl+S would overwrite a 24-bit master with a reduced-depth
 * render of itself, which is data loss dressed as a convenience. And a document
 * does not survive a reload (buffers are in memory only), so persisting handles
 * in IndexedDB would restore a write target with nothing left to write to it.
 * Every handle in this app therefore comes from a *save* picker: the user has
 * seen the filename and agreed to it before anything is written.
 */
import { toWavFileName, downloadBlob } from './download.js'

/** True when this browser can write back to a file the user picked. */
export function canSaveInPlace() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

/** True for the DOMException a picker throws when the user hits Cancel. */
export function isCancellation(err) {
  return err?.name === 'AbortError'
}

/**
 * Ask for a save destination. `suggestedName` is normalised to .wav — the file
 * we write is a WAV whatever the source format was, and offering to write WAV
 * bytes under an .mp3 name produces a file nothing can open.
 *
 * @returns {Promise<FileSystemFileHandle>} rejects with AbortError if cancelled
 */
export function pickSaveTarget(suggestedName) {
  return window.showSaveFilePicker({
    suggestedName: toWavFileName(suggestedName || 'untitled.wav'),
    types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }],
  })
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
export async function writeWavToHandle(handle, arrayBuffer) {
  const writable = await handle.createWritable()
  try {
    await writable.write(new Blob([arrayBuffer], { type: 'audio/wav' }))
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
export function downloadWav(arrayBuffer, fileName) {
  downloadBlob(new Blob([arrayBuffer], { type: 'audio/wav' }), toWavFileName(fileName))
}
