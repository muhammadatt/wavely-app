/**
 * WAV encoding — Float32 channel data to RIFF bytes.
 *
 * Pure and dependency-free so `node --test` can reach it: `export.js` imports
 * the offline render chain, which reaches every AudioWorklet in the app and
 * cannot load under node.
 *
 * Three sample formats, the ones the Save dialog offers:
 *
 *   { bits: 16 }               — PCM, the delivery format (ACX, most podcasts)
 *   { bits: 24 }               — PCM, what most narrators record at
 *   { bits: 32, float: true }  — IEEE float, bit-exact with the editor's buffers
 *
 * ⚠ FLOAT IS NOT CLIPPED, AND THAT IS THE POINT OF OFFERING IT. Every buffer in
 * the editor is float and may legitimately sit above 0 dBFS between stages; a
 * 32-bit float file keeps those samples, so re-opening it loses nothing. The
 * integer formats clip at full scale because they have to.
 */

/** Bytes in front of the sample data for a given format. */
export function wavHeaderBytes({ float = false } = {}) {
  // Float carries an 18-byte fmt chunk (cbSize = 0) and the `fact` chunk the
  // spec requires for every non-PCM format: 12 + 26 + 12 + 8.
  return float ? 58 : 44
}

/**
 * @param {Float32Array[]} channelData one array per channel, equal lengths
 * @param {number} sampleRate
 * @param {number} numChannels
 * @param {{ bits?: 16|24|32, float?: boolean }} [format]
 * @returns {ArrayBuffer}
 */
export function encodeWav(channelData, sampleRate, numChannels, { bits = 16, float = false } = {}) {
  if (float && bits !== 32) throw new Error('float WAV is 32-bit only')
  if (!float && bits !== 16 && bits !== 24) throw new Error(`unsupported PCM depth: ${bits}`)

  const numSamples = channelData[0].length
  const bytesPerSample = bits / 8
  const blockAlign = numChannels * bytesPerSample
  const dataSize = numSamples * blockAlign
  const headerSize = wavHeaderBytes({ float })
  const buffer = new ArrayBuffer(headerSize + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, headerSize - 8 + dataSize, true)
  writeString(view, 8, 'WAVE')

  writeString(view, 12, 'fmt ')
  view.setUint32(16, float ? 18 : 16, true)
  view.setUint16(20, float ? 3 : 1, true) // 3 = IEEE float, 1 = PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bits, true)

  let offset = 36
  if (float) {
    view.setUint16(36, 0, true) // cbSize
    writeString(view, 38, 'fact')
    view.setUint32(42, 4, true)
    view.setUint32(46, numSamples, true) // frames per channel
    offset = 50
  }

  writeString(view, offset, 'data')
  view.setUint32(offset + 4, dataSize, true)
  offset += 8

  if (float) {
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        view.setFloat32(offset, channelData[ch][i], true)
        offset += 4
      }
    }
  } else if (bits === 16) {
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        view.setInt16(offset, quantize(channelData[ch][i], 0x8000, 0x7fff), true)
        offset += 2
      }
    }
  } else {
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const v = quantize(channelData[ch][i], 0x800000, 0x7fffff)
        // Little-endian 24-bit two's complement; `& 0xff` of a negative int
        // gives its low byte, so the sign rides along in the top byte.
        view.setUint8(offset, v & 0xff)
        view.setUint8(offset + 1, (v >> 8) & 0xff)
        view.setUint8(offset + 2, (v >> 16) & 0xff)
        offset += 3
      }
    }
  }

  return buffer
}

/**
 * Clip to [-1, 1] and scale asymmetrically — negative full scale reaches the
 * format's minimum, positive stops one code short — then round to the nearest
 * code. NaN (a render fault) comes out as silence rather than an arbitrary code.
 */
function quantize(sample, negScale, posScale) {
  if (!(sample === sample)) return 0
  const s = sample > 1 ? 1 : sample < -1 ? -1 : sample
  return Math.round(s < 0 ? s * negScale : s * posScale)
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
