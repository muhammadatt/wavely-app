/**
 * Naming and delivering a rendered file to the user.
 *
 * Split out of export.js so the two callers that only need a filename or a
 * download — the export dialog and the save path — don't drag in the whole
 * offline render chain (processing.js reaches every AudioWorklet in the app,
 * which is browser-only and unloadable under `node --test`).
 */

/** Swap a filename's extension for .wav. */
export function toWavFileName(fileName) {
  return fileName.replace(/\.[^.]+$/, '') + '.wav'
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
