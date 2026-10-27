/**
 * One entry point from rendered samples to file bytes, for every Save format.
 *
 * Pure (no DOM, no Vite specifiers) so it runs the same inside the encode
 * worker and under `node --test`; the worker supplies the MP3 encoder's WASM
 * as a URL, a test supplies it as bytes.
 */
import { resample } from './dsp/resample.js'
import { encodeWav } from './wavEncode.js'
import { encodeFlac } from './flacEncode.js'
import { encodeMp3 } from './mp3Encode.js'
import { bitDepthById, FORMATS } from './saveFormat.js'

/**
 * @param {Float32Array[]} channelData rendered at `fromRate`
 * @param {number} fromRate
 * @param {{ format: 'wav'|'flac'|'mp3', bitDepth: string, sampleRate: number, bitrate: number }} settings
 * @param {{ wasm?: string|URL|ArrayBuffer|Uint8Array, onProgress?: (stage: string, fraction: number) => void }} [env]
 * @returns {Promise<{ bytes: Uint8Array, mime: string }>}
 */
export async function encodeAudio(channelData, fromRate, settings, { wasm, onProgress } = {}) {
  const { format, sampleRate } = settings
  let data = channelData
  if (sampleRate !== fromRate) {
    onProgress?.('resample', 0)
    data = data.map((ch, i) => {
      const out = resample(ch, fromRate, sampleRate)
      onProgress?.('resample', (i + 1) / data.length)
      return out
    })
  }

  const progress = f => onProgress?.('encode', f)
  let bytes
  if (format === 'mp3') {
    bytes = await encodeMp3(data, sampleRate, { bitrate: settings.bitrate, wasm, onProgress: progress })
  } else if (format === 'flac') {
    bytes = encodeFlac(data, sampleRate, { bits: bitDepthById(settings.bitDepth).bits, onProgress: progress })
  } else {
    const depth = bitDepthById(settings.bitDepth)
    bytes = new Uint8Array(encodeWav(data, sampleRate, data.length, { bits: depth.bits, float: depth.float }))
    progress(1)
  }
  return { bytes, mime: FORMATS[format].mime }
}
