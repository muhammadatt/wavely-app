/**
 * API client for server-side audio processing.
 *
 * Handles communication with the Wavely processing server,
 * including multipart response parsing.
 */

import { renderRegionToBuffer } from '../audio/processing.js'

/**
 * Send audio to the server for preset processing.
 *
 * @param {object} options
 * @param {Array} options.segments - Timeline segments to process
 * @param {number} options.sampleRate - Sample rate
 * @param {number} options.channels - Number of channels
 * @param {string} options.fileName - Original file name
 * @param {string} options.presetId - Preset ID
 * @param {string} options.complianceId - Compliance target ID
 * @returns {{ report: object, audioBlob: Blob, peaks: object[] }}
 */
export async function processAudioOnServer({
  segments, sampleRate, channels, fileName, presetId, complianceId,
}) {
  // Render the full timeline to a WAV blob for upload
  const wavBlob = await renderTimelineToWavBlob(segments, sampleRate, channels)

  // Build form data
  const formData = new FormData()
  formData.append('file', wavBlob, fileName || 'audio.wav')
  formData.append('preset', presetId)
  formData.append('compliance', complianceId)

  // Send to server
  const response = await fetch('/api/process', {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(errorBody.error || `Server error: ${response.status}`)
  }

  // Parse multipart response
  return parseMultipartResponse(response)
}

/**
 * Render the timeline segments to a WAV Blob.
 */
async function renderTimelineToWavBlob(segments, sampleRate, channels) {
  const duration = segments.reduce((sum, seg) => {
    return sum + (seg.sourceBuffer === null ? seg.duration : seg.sourceEnd - seg.sourceStart)
  }, 0)

  const channelData = await renderRegionToBuffer(segments, 0, duration, sampleRate, channels)

  // Encode as 32-bit float WAV to preserve full precision for server processing
  const numSamples = channelData[0].length
  const bytesPerSample = 4 // 32-bit float
  const dataSize = numSamples * channels * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')

  // fmt chunk
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)         // chunk size
  view.setUint16(20, 3, true)          // IEEE float format
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)

  // data chunk
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // Interleave and write 32-bit float samples
  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < channels; ch++) {
      view.setFloat32(offset, channelData[ch][i], true)
      offset += 4
    }
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i))
  }
}

/**
 * Parse a multipart/mixed response into { report, peaks, audioBlob }.
 */
async function parseMultipartResponse(response) {
  const contentType = response.headers.get('Content-Type') || ''
  const boundaryMatch = contentType.match(/boundary=(.+)/)

  if (!boundaryMatch) {
    // Fallback: treat as JSON error
    const body = await response.json()
    throw new Error(body.error || 'Invalid response format')
  }

  const boundary = boundaryMatch[1]
  const arrayBuffer = await response.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)

  // Find boundary positions
  const boundaryBytes = new TextEncoder().encode(`--${boundary}`)
  const positions = []
  for (let i = 0; i < bytes.length - boundaryBytes.length; i++) {
    let match = true
    for (let j = 0; j < boundaryBytes.length; j++) {
      if (bytes[i + j] !== boundaryBytes[j]) { match = false; break }
    }
    if (match) positions.push(i)
  }

  if (positions.length < 2) {
    throw new Error('Invalid multipart response: not enough parts')
  }

  // Extract JSON part (first part after first boundary)
  const jsonPart = extractPart(bytes, positions[0] + boundaryBytes.length, positions[1])
  const jsonText = new TextDecoder().decode(jsonPart.body)
  const { report, peaks } = JSON.parse(jsonText)

  // Extract audio part (second part after second boundary)
  const endBoundary = positions.length > 2 ? positions[2] : bytes.length
  const audioPart = extractPart(bytes, positions[1] + boundaryBytes.length, endBoundary)
  const audioBlob = new Blob([audioPart.body], { type: 'audio/wav' })

  return { report, peaks, audioBlob }
}

/**
 * Extract headers and body from a multipart part.
 */
function extractPart(bytes, start, end) {
  // Skip \r\n after boundary
  let i = start
  while (i < end && (bytes[i] === 13 || bytes[i] === 10)) i++

  // Find end of headers (double \r\n)
  let headerEnd = i
  for (; headerEnd < end - 3; headerEnd++) {
    if (bytes[headerEnd] === 13 && bytes[headerEnd + 1] === 10 &&
        bytes[headerEnd + 2] === 13 && bytes[headerEnd + 3] === 10) {
      break
    }
  }

  const bodyStart = headerEnd + 4
  // Trim trailing \r\n before next boundary
  let bodyEnd = end
  while (bodyEnd > bodyStart && (bytes[bodyEnd - 1] === 13 || bytes[bodyEnd - 1] === 10)) {
    bodyEnd--
  }

  return { body: bytes.slice(bodyStart, bodyEnd) }
}
