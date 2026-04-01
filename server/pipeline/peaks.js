/**
 * Waveform peak data extraction.
 *
 * Reads a WAV file and computes ~1000 min/max peak points for
 * canvas waveform rendering in the browser.
 */

import { readFile } from 'fs/promises'

const TARGET_POINTS = 1000

/**
 * Extract waveform peak data from a 32-bit float or 16-bit PCM WAV file.
 * Returns an array of { min, max } objects (~1000 points).
 */
export async function extractPeaks(wavPath) {
  const buffer = await readFile(wavPath)

  // Parse WAV header
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  // Find 'data' chunk
  let offset = 12 // Skip RIFF header
  let dataOffset = 0
  let dataSize = 0
  let bitsPerSample = 16
  let numChannels = 1

  while (offset < buffer.length - 8) {
    const chunkId = String.fromCharCode(
      buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]
    )
    const chunkSize = view.getUint32(offset + 4, true)

    if (chunkId === 'fmt ') {
      numChannels = view.getUint16(offset + 10, true)
      bitsPerSample = view.getUint16(offset + 22, true)
    }

    if (chunkId === 'data') {
      dataOffset = offset + 8
      dataSize = chunkSize
      break
    }

    offset += 8 + chunkSize
    // Align to even boundary
    if (chunkSize % 2 !== 0) offset++
  }

  if (dataOffset === 0) {
    throw new Error('Could not find data chunk in WAV file')
  }

  const bytesPerSample = bitsPerSample / 8
  const totalSamples = Math.floor(dataSize / (bytesPerSample * numChannels))
  const samplesPerPoint = Math.max(1, Math.floor(totalSamples / TARGET_POINTS))
  const numPoints = Math.ceil(totalSamples / samplesPerPoint)

  const peaks = []

  for (let i = 0; i < numPoints; i++) {
    let min = 1
    let max = -1
    const startSample = i * samplesPerPoint
    const endSample = Math.min(startSample + samplesPerPoint, totalSamples)

    for (let s = startSample; s < endSample; s++) {
      // Read first channel only
      const bytePos = dataOffset + s * bytesPerSample * numChannels
      let sample

      if (bitsPerSample === 32) {
        sample = view.getFloat32(bytePos, true)
      } else if (bitsPerSample === 16) {
        sample = view.getInt16(bytePos, true) / 32768
      } else {
        sample = 0
      }

      if (sample < min) min = sample
      if (sample > max) max = sample
    }

    peaks.push({ min: round4(min), max: round4(max) })
  }

  return peaks
}

function round4(n) {
  return Math.round(n * 10000) / 10000
}
