/**
 * WAV PCM writer helpers for the processing pipeline.
 *
 * Writes multi-channel 32-bit float PCM WAV files.
 * Internal processing always uses 44.1 kHz float32.
 */

import { writeFile, open } from 'fs/promises'

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

/**
 * Streaming WAV writer for incremental output.
 *
 * Opens a WAV file, writes the 44-byte header up front (sized for the known
 * total sample count), and exposes `write(channels)` to append blocks of
 * interleaved float32 samples. Callers stream chunks in order without ever
 * materialising the full output buffer in memory — critical for the chunked
 * stitcher, where the alternative is allocating a Float32Array spanning the
 * entire (potentially multi-hour) output.
 *
 * Total sample count is fixed at construction time; `close()` is a no-op
 * apart from releasing the file descriptor (header is already correct).
 *
 * @param {string} outputPath
 * @param {number} numChannels
 * @param {number} sampleRate
 * @param {number} totalSamples  Final per-channel sample count
 * @returns {{ write: (channels: Float32Array[]) => Promise<void>, close: () => Promise<void> }}
 */
export async function openWavStreamWriter(outputPath, numChannels, sampleRate, totalSamples) {
  const bitsPerSample = 32
  const blockAlign    = numChannels * bitsPerSample / 8
  const byteRate      = sampleRate * blockAlign
  const dataSize      = totalSamples * blockAlign

  const header = Buffer.alloc(44)
  let off = 0
  header.write('RIFF', off); off += 4
  header.writeUInt32LE(36 + dataSize, off); off += 4
  header.write('WAVE', off); off += 4
  header.write('fmt ', off); off += 4
  header.writeUInt32LE(16, off); off += 4
  header.writeUInt16LE(3, off); off += 2              // IEEE float
  header.writeUInt16LE(numChannels, off); off += 2
  header.writeUInt32LE(sampleRate, off); off += 4
  header.writeUInt32LE(byteRate, off); off += 4
  header.writeUInt16LE(blockAlign, off); off += 2
  header.writeUInt16LE(bitsPerSample, off); off += 2
  header.write('data', off); off += 4
  header.writeUInt32LE(dataSize, off); off += 4

  const fh = await open(outputPath, 'w')
  await fh.write(header)

  let written = 0  // per-channel samples written so far

  return {
    /**
     * Append a block of channel-aligned samples. All channel arrays must be
     * the same length; that length is taken as the block's per-channel
     * sample count.
     */
    async write(channels) {
      if (channels.length !== numChannels) {
        throw new Error(
          `wavStreamWriter.write: expected ${numChannels} channels, got ${channels.length}`
        )
      }
      const blockSamples = channels[0].length
      if (blockSamples === 0) return
      if (written + blockSamples > totalSamples) {
        throw new Error(
          `wavStreamWriter.write: exceeded declared totalSamples ` +
          `(${written + blockSamples} > ${totalSamples})`
        )
      }

      const buf = Buffer.alloc(blockSamples * blockAlign)
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      for (let i = 0; i < blockSamples; i++) {
        for (let c = 0; c < numChannels; c++) {
          view.setFloat32((i * numChannels + c) * 4, channels[c][i], true)
        }
      }
      await fh.write(buf)
      written += blockSamples
    },

    async close() {
      if (written !== totalSamples) {
        // Header declared totalSamples but caller wrote fewer — file is
        // structurally valid but truncated. Surface this loudly rather than
        // silently producing a short file.
        await fh.close()
        throw new Error(
          `wavStreamWriter.close: wrote ${written} samples, expected ${totalSamples}`
        )
      }
      await fh.close()
    },
  }
}
