/**
 * API client for synchronous spot-effect operations.
 *
 * Spot effects run on a short user selection, bypass the preset chain on the
 * server, and return the processed WAV directly. No job polling — the request
 * resolves with the processed audio.
 */

import { renderRegionToBuffer, floatChannelsToWavBlob } from '../audio/processing.js'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

/**
 * Run a spot effect on a region of the timeline.
 *
 * @param {object} options
 * @param {string} options.operation   - Server operation id (e.g. 'vocal_saturation')
 * @param {Array}  options.segments    - Timeline segments
 * @param {number} options.start       - Region start (seconds)
 * @param {number} options.end         - Region end (seconds)
 * @param {number} options.sampleRate  - Sample rate
 * @param {number} options.channels    - Channel count
 * @param {object} [options.params]    - Operation-specific parameters
 * @returns {Promise<Blob>}            - Processed WAV blob
 */
export async function runSpotEffect({
  operation, segments, start, end, sampleRate, channels, params = {},
}) {
  const channelData = renderRegionToBuffer(segments, start, end, sampleRate, channels)
  const wavBlob = floatChannelsToWavBlob(channelData, sampleRate, channels)

  const formData = new FormData()
  formData.append('file', wavBlob, 'selection.wav')
  formData.append('params', JSON.stringify(params))

  const res = await fetch(`${API_BASE}/api/spot/${operation}`, {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `Spot effect failed: ${res.status}` }))
    throw new Error(body.error || `Spot effect failed: ${res.status}`)
  }

  return await res.blob()
}

/**
 * Apply Vocal Saturation to a region of the timeline.
 *
 * @param {object} options
 * @param {Array}  options.segments
 * @param {number} options.start
 * @param {number} options.end
 * @param {number} options.sampleRate
 * @param {number} options.channels
 * @param {object} options.params
 * @param {number} options.params.drive
 * @param {number} options.params.wetDry
 * @param {number} options.params.bias            - absolute operating-point offset on the curve (drive-independent)
 * @param {number} options.params.lowCrossover
 * @param {number} options.params.midCrossover
 * @param {number} options.params.softness
 * @param {number} options.params.lowDriveMult    - low-band drive multiplier (× drive)
 * @param {number} options.params.midDriveMult    - mid-band drive multiplier (× drive)
 * @param {number} options.params.highDriveMult   - high-band drive multiplier (× drive)
 * @returns {Promise<Blob>}
 */
export function applyVocalSaturation(options) {
  return runSpotEffect({ ...options, operation: 'vocal_saturation' })
}
