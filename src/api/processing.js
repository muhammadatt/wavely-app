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

import { renderRegionToBuffer, floatChannelsToWavBlob } from '../audio/processing.js'
import { uploadAudio, postWithUpload } from './uploadAudio.js'
import { pollJob } from './pollJob.js'


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
 * @param {Function} [options.onUploadProgress] - (fraction 0–1) while the audio uploads
 * @param {Function} [options.onUploaded]    - Called once the upload has finished
 * @returns {Promise<{ report: object, audioBlob: Blob, peaks: object[] }>}
 */
export async function processAudioOnServer({
  segments, sampleRate, channels, fileName, presetId, outputProfileId,
  separationModel, resembleMode, voiceFixerMode,
  onProgress, onUploadProgress, onUploaded,
}) {
  // ── 1. Render timeline to WAV blob ─────────────────────────────────────────
  const wavBlob = await renderTimelineToWavBlob(segments, sampleRate, channels)

  // ── 2. Upload, then submit the job ─────────────────────────────────────────
  // A chapter is hundreds of MB of float WAV: it goes up in resumable chunks
  // (uploadAudio), and the job request names the upload. The token makes both
  // count against the account rather than the IP, and lifts the signed-out
  // preview limit (a 402 otherwise — see `mastering`).
  const uploadId = await uploadAudio(wavBlob, {
    filename: fileName || 'audio.wav',
    onProgress: (sent, total) => onUploadProgress?.(total ? sent / total : 1),
  })
  onUploaded?.()

  const submitRes = await postWithUpload('/api/process', {
    uploadId,
    preset: presetId,
    output_profile: outputProfileId,
    ...(separationModel ? { separation_model: separationModel } : {}),
    ...(resembleMode ? { resemble_mode: resembleMode } : {}),
    ...(voiceFixerMode != null ? { voicefixer_mode: String(voiceFixerMode) } : {}),
  }, 'Submit failed')
  const { jobId } = await submitRes.json()

  // ── 3. Poll for completion ─────────────────────────────────────────────────
  const job = await pollJob({
    fetchStatus: async () => {
      const pollRes = await fetch(`${API_BASE}/api/jobs/${jobId}`)
      if (!pollRes.ok) {
        const body = await pollRes.json().catch(() => ({}))
        throw new Error(body.error || `Status check failed: ${pollRes.status}`)
      }
      return pollRes.json()
    },
    onProgress,
  })

  // ── 4. Download audio ──────────────────────────────────────────────────────
  const dlRes = await fetch(`${API_BASE}/api/jobs/${jobId}/download`)
  if (!dlRes.ok) {
    const body = await dlRes.json().catch(() => ({}))
    throw new Error(body.error || `Audio download failed: ${dlRes.status}`)
  }
  const audioBlob = await dlRes.blob()

  return { report: job.report, peaks: job.peaks, audioBlob }
}

/**
 * Render the timeline segments to a WAV Blob.
 */
async function renderTimelineToWavBlob(segments, sampleRate, channels) {
  const duration = segments.reduce((sum, seg) => {
    return sum + (seg.sourceBuffer === null ? seg.duration : seg.sourceEnd - seg.sourceStart)
  }, 0)

  const channelData = await renderRegionToBuffer(segments, 0, duration, sampleRate, channels)
  return floatChannelsToWavBlob(channelData, sampleRate, channels)
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
