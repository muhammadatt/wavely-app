/**
 * WAV PCM writer helpers for the processing pipeline.
 *
 * Writes multi-channel 32-bit float PCM WAV files.
 * Internal processing always uses 44.1 kHz float32.
 */

import { writeFile } from 'fs/promises'

/**
 * Encode interleaved multi-channel Float32 samples as a 32-bit float WAV buffer.
 *
 * @param {Float32Array[]} channels   - One Float32Array per channel (equal length)
 * @param {number}         sampleRate
 * @returns {Buffer}
 */
export function channelsToWavBuffer(channels, sampleRate) {
  if (!channels.length) throw new Error('channelsToWavBuffer: channels array is empty')
  const numChannels   = channels.length
  const numSamples    = channels[0].length
  const bitsPerSample = 32
  const byteRate      = sampleRate * numChannels * bitsPerSample / 8
  const blockAlign    = numChannels * bitsPerSample / 8
  const dataSize      = numSamples * numChannels * (bitsPerSample / 8)
  const buf           = Buffer.alloc(44 + dataSize)
  let off = 0

  buf.write('RIFF', off); off += 4
  buf.writeUInt32LE(36 + dataSize, off); off += 4
  buf.write('WAVE', off); off += 4

  buf.write('fmt ', off); off += 4
  buf.writeUInt32LE(16, off); off += 4
  buf.writeUInt16LE(3, off); off += 2               // IEEE float
  buf.writeUInt16LE(numChannels, off); off += 2
  buf.writeUInt32LE(sampleRate, off); off += 4
  buf.writeUInt32LE(byteRate, off); off += 4
  buf.writeUInt16LE(blockAlign, off); off += 2
  buf.writeUInt16LE(bitsPerSample, off); off += 2

  buf.write('data', off); off += 4
  buf.writeUInt32LE(dataSize, off); off += 4

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      view.setFloat32(off + (i * numChannels + ch) * 4, channels[ch][i], true)
    }
  }

  return buf
}

/**
 * Write multi-channel Float32 audio to a WAV file.
 *
 * @param {Float32Array[]} channels
 * @param {number}         sampleRate
 * @param {string}         outputPath
 */
export async function writeWavChannels(channels, sampleRate, outputPath) {
  const buf = channelsToWavBuffer(channels, sampleRate)
  await writeFile(outputPath, buf)
}
