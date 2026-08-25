import { renderRegionToBuffer } from './processing.js'
import { getTimelineDuration } from './operations.js'
import { toWavFileName, downloadBlob } from './download.js'

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
 * Encode Float32Array channel data as WAV.
 * Manual encoding — 44-byte header + 16-bit PCM data.
 */
function encodeWav(channelData, sampleRate, numChannels) {
  const numSamples = channelData[0].length
  const bytesPerSample = 2 // 16-bit
  const dataSize = numSamples * numChannels * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')

  // fmt chunk
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true) // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true) // block align
  view.setUint16(34, 16, true) // bits per sample

  // data chunk
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // Interleave samples and convert to 16-bit
  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]))
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF
      view.setInt16(offset, intSample, true)
      offset += 2
    }
  }

  return buffer
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
