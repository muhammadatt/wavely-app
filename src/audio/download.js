/**
 * Naming and delivering a rendered file to the user.
 *
 * Split out of export.js so the two callers that only need a filename or a
 * download — the export dialog and the save path — don't drag in the whole
 * offline render chain (processing.js reaches every AudioWorklet in the app,
 * which is browser-only and unloadable under `node --test`).
 */

/**
 * Swap a filename's extension for .wav.
 *
 * Idempotent, so it can be applied wherever the .wav name is needed rather
 * than threaded through. Two edge cases are worth the extra lines now that
 * this string is shown in a save dialog and not only handed to a download:
 * a name ending in a dot or space is legal on POSIX and would otherwise come
 * out as "take2..wav", and a dotfile has no extension to strip — taking the
 * one it looks like it has would leave a file called ".wav".
 */
export function toWavFileName(fileName) {
  const trimmed = String(fileName ?? '').replace(/[.\s]+$/, '')
  const base = trimmed.replace(/\.[^.]+$/, '')
  return (base || trimmed || 'untitled') + '.wav'
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
