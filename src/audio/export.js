import { renderRegionToBuffer } from './processing.js'
import { getTimelineDuration } from './operations.js'
import { toWavFileName, downloadBlob } from './download.js'
import { encodeWav } from './wavEncode.js'
import { resample } from './dsp/resample.js'

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
 * Render a timeline for Save: at the chosen sample format and rate.
 *
 * The timeline renders at the document's rate (the AudioContext's) and is then
 * converted — `resample` is a windowed sinc, not the browser's linear
 * interpolation. Same rate in and out skips the conversion entirely, so a save
 * at the document's own rate is the same samples Export writes.
 *
 * @param {{ bits: number, float: boolean, sampleRate: number }} format
 * @returns {ArrayBuffer|null} null when the timeline is empty
 */
export function renderTimelineForSave(segments, docRate, channels, { bits, float, sampleRate }) {
  const totalDuration = getTimelineDuration(segments)
  if (totalDuration === 0) return null

  let channelData = renderRegionToBuffer(segments, 0, totalDuration, docRate, channels)
  if (sampleRate !== docRate) channelData = channelData.map(ch => resample(ch, docRate, sampleRate))
  return encodeWav(channelData, sampleRate, channels, { bits, float })
}
