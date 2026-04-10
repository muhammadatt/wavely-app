/**
 * API client for server-side audio processing.
 *
 * Uses an async job pattern to avoid proxy timeouts (Cloudflare 524):
 *   1. POST /api/process        → 202 { jobId }  (returns in <5 s)
 *   2. GET  /api/jobs/:jobId    → poll until status === 'done' or 'error'
 *   3. GET  /api/jobs/:jobId/download → stream processed audio blob
 *
 * API base URL:
 *   Dev:        empty — Vite proxy forwards /api to localhost:3001
 *   Production: set VITE_API_BASE_URL=https://your-vps-domain.com
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

import { renderRegionToBuffer } from '../audio/processing.js'

const POLL_INTERVAL_MS = 3000       // 3 s between status checks
const MAX_POLL_ATTEMPTS = 400       // 400 × 3 s = 20 min max wait

/**
 * Send audio to the server for preset processing.
 *
 * @param {object}   options
 * @param {Array}    options.segments        - Timeline segments to process
 * @param {number}   options.sampleRate      - Sample rate
 * @param {number}   options.channels        - Number of channels
 * @param {string}   options.fileName        - Original file name
 * @param {string}   options.presetId        - Preset ID
 * @param {string}   options.outputProfileId - Output profile ID
 * @param {Function} [options.onProgress]    - Called with progress string on each poll
 * @returns {Promise<{ report: object, audioBlob: Blob, peaks: object[] }>}
 */
export async function processAudioOnServer({
  segments, sampleRate, channels, fileName, presetId, outputProfileId,
  separationModel, resembleMode, voiceFixerMode, clearervoiceModel,
  onProgress,
}) {
  // ── 1. Render timeline to WAV blob ─────────────────────────────────────────
  const wavBlob = await renderTimelineToWavBlob(segments, sampleRate, channels)

  // ── 2. Submit job ──────────────────────────────────────────────────────────
  const formData = new FormData()
  formData.append('file', wavBlob, fileName || 'audio.wav')
  formData.append('preset', presetId)
  formData.append('output_profile', outputProfileId)
  if (separationModel)        formData.append('separation_model',  separationModel)
  if (resembleMode)           formData.append('resemble_mode',      resembleMode)
  if (voiceFixerMode != null) formData.append('voicefixer_mode',    String(voiceFixerMode))
  if (clearervoiceModel)      formData.append('clearervoice_model', clearervoiceModel)

  const submitRes = await fetch(`${API_BASE}/api/process`, { method: 'POST', body: formData })
  if (!submitRes.ok) {
    const body = await submitRes.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(body.error || `Submit failed: ${submitRes.status}`)
  }
  const { jobId } = await submitRes.json()

  // ── 3. Poll for completion ─────────────────────────────────────────────────
  let job = null
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS)

    const pollRes = await fetch(`${API_BASE}/api/jobs/${jobId}`)
    if (!pollRes.ok) {
      const body = await pollRes.json().catch(() => ({}))
      throw new Error(body.error || `Status check failed: ${pollRes.status}`)
    }

    job = await pollRes.json()

    if (job.status === 'done')  break
    if (job.status === 'error') throw new Error(job.error || 'Processing failed on server')
    if (onProgress && job.progress) onProgress(job.progress)
  }

  if (!job || job.status !== 'done') {
    throw new Error('Processing timed out — please try again with a shorter file')
  }

  // ── 4. Download audio ──────────────────────────────────────────────────────
  const dlRes = await fetch(`${API_BASE}/api/jobs/${jobId}/download`)
  if (!dlRes.ok) {
    const body = await dlRes.json().catch(() => ({}))
    throw new Error(body.error || `Audio download failed: ${dlRes.status}`)
  }
  const audioBlob = await dlRes.blob()

  return { report: job.report, peaks: job.peaks, audioBlob }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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
