/**
 * API client for synchronous spot-effect operations.
 *
 * Spot effects run on a short user selection, bypass the preset chain on the
 * server, and return the processed WAV directly. No job polling — the request
 * resolves with the processed audio.
 *
 * Currently unused by the client: vocal saturation was the only caller and now
 * runs in an AudioWorklet (src/audio/vocalSatProcessor.js), which removed the
 * upload round-trip. Kept because it is still the right shape for the spot
 * operations that genuinely have to run server-side — noise reduction being
 * the obvious one, since DeepFilterNet3 has no browser implementation here.
 * The server's /api/spot/vocal_saturation route also remains, and the preset
 * chain's own Python vocalSaturation stage is untouched.
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

