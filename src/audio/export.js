import { renderRegionToBuffer } from './processing.js'
import { getTimelineDuration } from './operations.js'
import { toWavFileName, downloadBlob } from './download.js'
import { encodeWav } from './wavEncode.js'

/**
 * Render a timeline to a WAV ArrayBuffer.
 *
 * Kept separate from downloading so the same render feeds a single-file
 * download, a zip entry, or anything else that needs bytes.
 *
 * @returns {ArrayBuffer|null} null when the timeline is empty
 */
export function renderTimelineToWav(segments, sampleRate, channels) {
  const totalDuration = getTimelineDuration(segments)
  if (totalDuration === 0) return null

  const channelData = renderRegionToBuffer(segments, 0, totalDuration, sampleRate, channels)
  return encodeWav(channelData, sampleRate, channels)
}

/**
 * Render the entire timeline and download it as WAV.
 */
export function exportAsWav(segments, sampleRate, channels, fileName) {
  const wavBuffer = renderTimelineToWav(segments, sampleRate, channels)
  if (!wavBuffer) return
  downloadBlob(new Blob([wavBuffer], { type: 'audio/wav' }), toWavFileName(fileName))
}

/**
 * Render a timeline for Save, in the chosen format, depth and rate.
 *
 * The timeline renders here at the document's rate (the AudioContext's); the
 * resample and the encode run in a worker (`encodeWorker.js`) — MP3 and FLAC
 * encodes of a long chapter take long enough to freeze the page otherwise.
 * `resample` is a windowed sinc, not the browser's linear interpolation, and
 * equal rates skip it, so a WAV at the document's rate is the same samples
 * Export writes.
 *
 * @param {{ format: string, bitDepth: string, sampleRate: number, bitrate: number }} settings
 * @param {{ onProgress?: (stage: 'resample'|'encode', fraction: number) => void }} [options]
 * @returns {Promise<{ bytes: Uint8Array, mime: string }|null>} null when the timeline is empty
 */
export async function renderTimelineForSave(segments, docRate, channels, settings, { onProgress } = {}) {
  const totalDuration = getTimelineDuration(segments)
  if (totalDuration === 0) return null

  const channelData = renderRegionToBuffer(segments, 0, totalDuration, docRate, channels)
  // Transferred, not copied: the render's arrays are fresh and unused after
  // this. A view onto a larger buffer would hand the worker more than it
  // should own, so those are copied.
  const owned = channelData.map(ch => (ch.byteOffset === 0 && ch.byteLength === ch.buffer.byteLength ? ch : ch.slice()))

  const worker = new Worker(new URL('../workers/encodeWorker.js', import.meta.url), { type: 'module' })
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') onProgress?.(data.stage, data.fraction)
        else if (data.type === 'done') resolve({ bytes: data.bytes, mime: data.mime })
        else reject(Object.assign(new Error(data.message ?? 'encode failed'), { name: data.name ?? 'Error' }))
      }
      worker.onerror = e => reject(new Error(e.message || 'encode worker failed'))
      worker.postMessage({ channelData: owned, fromRate: docRate, settings }, owned.map(ch => ch.buffer))
    })
  } finally {
    worker.terminate()
  }
}
