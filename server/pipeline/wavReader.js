/**
 * WAV PCM sample reader.
 *
 * Reads a 32-bit float or 16-bit PCM WAV file and returns:
 *   - samples: Float32Array of mono samples (first channel)
 *   - sampleRate: number
 *   - numChannels: number
 *   - numSamples: number (per channel)
 *
 * Internal processing files are always 32-bit float PCM at 44.1 kHz,
 * produced by the decode stage. This reader handles both formats for
 * robustness.
 */

import { readFile } from 'fs/promises'

/**
 * Read a WAV file and extract mono samples as Float32Array.
 * Only the first channel is returned (sufficient for analysis).
 *
 * @param {string} wavPath
 * @returns {{ samples: Float32Array, sampleRate: number, numChannels: number, numSamples: number }}
 */
export async function readWavSamples(wavPath) {
  const buffer = await readFile(wavPath)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  let offset = 12 // skip RIFF header (4 RIFF + 4 size + 4 WAVE)
  let sampleRate = 44100
  let numChannels = 1
  let bitsPerSample = 32
  let audioFormat = 3 // 1=PCM int, 3=IEEE float
  let dataOffset = 0
  let dataSize = 0

  while (offset < buffer.length - 8) {
    const chunkId = String.fromCharCode(
      buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]
    )
    const chunkSize = view.getUint32(offset + 4, true)

    if (chunkId === 'fmt ') {
      audioFormat  = view.getUint16(offset + 8, true)
      numChannels  = view.getUint16(offset + 10, true)
      sampleRate   = view.getUint32(offset + 12, true)
      bitsPerSample = view.getUint16(offset + 22, true)
      // WAVE_FORMAT_EXTENSIBLE (0xFFFE): actual format is in SubFormat GUID
      // WAVEFORMATEXTENSIBLE layout (relative to fmt chunk data start at offset+8):
      //   +0  wFormatTag (2)  +2  nChannels (2)  +4  nSamplesPerSec (4)
      //   +8  nAvgBytesPerSec (4)  +12 nBlockAlign (2)  +14 wBitsPerSample (2)
      //   +16 cbSize (2)  +18 wValidBitsPerSample (2)  +20 dwChannelMask (4)
      //   +24 SubFormat GUID (16 bytes; first 2 bytes = actual format code)
      if (audioFormat === 0xFFFE && chunkSize >= 40) {
        audioFormat = view.getUint16(offset + 32, true) // offset+8+24
      }
    }

    if (chunkId === 'data') {
      dataOffset = offset + 8
      dataSize   = chunkSize
      break
    }

    offset += 8 + chunkSize
    if (chunkSize % 2 !== 0) offset++ // align to even boundary
  }

  if (dataOffset === 0) throw new Error('wavReader: no data chunk found')

  const bytesPerSample = bitsPerSample / 8
  const numSamples = Math.floor(dataSize / (bytesPerSample * numChannels))
  const samples = new Float32Array(numSamples)

  for (let i = 0; i < numSamples; i++) {
    const bytePos = dataOffset + i * bytesPerSample * numChannels
    if (bitsPerSample === 32 && audioFormat === 3) {
      samples[i] = view.getFloat32(bytePos, true)
    } else if (bitsPerSample === 16) {
      samples[i] = view.getInt16(bytePos, true) / 32768
    } else if (bitsPerSample === 24) {
      // 24-bit: read 3 bytes little-endian, sign-extend
      const lo = buffer[bytePos]
      const mi = buffer[bytePos + 1]
      const hi = buffer[bytePos + 2]
      const raw = (hi << 16) | (mi << 8) | lo
      samples[i] = (raw > 0x7FFFFF ? raw - 0x1000000 : raw) / 0x800000
    } else {
      samples[i] = 0
    }
  }

  return { samples, sampleRate, numChannels, numSamples }
}

/**
 * Read a WAV file and return all channels as separate Float32Arrays.
 *
 * @param {string} wavPath
 * @returns {{ channels: Float32Array[], sampleRate: number, numChannels: number, numSamples: number }}
 */
export async function readWavAllChannels(wavPath) {
  const buffer = await readFile(wavPath)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  let offset = 12
  let sampleRate = 44100
  let numChannels = 1
  let bitsPerSample = 32
  let audioFormat = 3
  let dataOffset = 0
  let dataSize = 0

  while (offset < buffer.length - 8) {
    const chunkId = String.fromCharCode(
      buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]
    )
    const chunkSize = view.getUint32(offset + 4, true)

    if (chunkId === 'fmt ') {
      audioFormat   = view.getUint16(offset + 8, true)
      numChannels   = view.getUint16(offset + 10, true)
      sampleRate    = view.getUint32(offset + 12, true)
      bitsPerSample = view.getUint16(offset + 22, true)
      // WAVE_FORMAT_EXTENSIBLE (0xFFFE): actual format is in SubFormat GUID
      // SubFormat starts at fmt-data-offset + 24 → absolute: offset + 32
      if (audioFormat === 0xFFFE && chunkSize >= 40) {
        audioFormat = view.getUint16(offset + 32, true)
      }
    }

    if (chunkId === 'data') {
      dataOffset = offset + 8
      dataSize   = chunkSize
      break
    }

    offset += 8 + chunkSize
    if (chunkSize % 2 !== 0) offset++
  }

  if (dataOffset === 0) throw new Error('wavReader: no data chunk found')

  const bytesPerSample = bitsPerSample / 8
  const numSamples = Math.floor(dataSize / (bytesPerSample * numChannels))

  const channels = Array.from({ length: numChannels }, () => new Float32Array(numSamples))

  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const bytePos = dataOffset + (i * numChannels + ch) * bytesPerSample
      let sample = 0
      if (bitsPerSample === 32 && audioFormat === 3) {
        sample = view.getFloat32(bytePos, true)
      } else if (bitsPerSample === 16) {
        sample = view.getInt16(bytePos, true) / 32768
      } else if (bitsPerSample === 24) {
        const lo = buffer[bytePos]
        const mi = buffer[bytePos + 1]
        const hi = buffer[bytePos + 2]
        const raw = (hi << 16) | (mi << 8) | lo
        sample = (raw > 0x7FFFFF ? raw - 0x1000000 : raw) / 0x800000
      }
      channels[ch][i] = sample
    }
  }

  return { channels, sampleRate, numChannels, numSamples }
}
