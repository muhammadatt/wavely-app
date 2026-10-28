/**
 * Decode a PCM WAV into Float32 channels, at the file's own rate.
 *
 * For audio the server hands back. `decodeAudioData` would do it, but it
 * resamples to its context's rate — the editor's AudioContext runs at the
 * device rate, not the file's, so a 44.1 kHz file on a 48 kHz machine would be
 * resampled twice on the way into the timeline. Reading the samples directly
 * keeps them exactly as the server wrote them.
 *
 * Handles 32-bit float, 16/24/32-bit integer PCM, WAVE_FORMAT_EXTENSIBLE and any
 * chunks before `data` (ffmpeg writes a LIST chunk).
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ channels: Float32Array[], sampleRate: number }}
 */
export function decodeWav(arrayBuffer) {
  const view = new DataView(arrayBuffer)
  if (view.byteLength < 12 || tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') {
    throw new Error('Not a WAV file')
  }

  let format = null
  let numChannels = 0
  let sampleRate = 0
  let bits = 0
  let dataOffset = -1
  let dataSize = 0

  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = tag(view, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      numChannels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE: the real format is the SubFormat GUID's first word.
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      dataOffset = body
      // A streaming writer may leave the size at 0 or 0xFFFFFFFF; read to the end.
      dataSize = size === 0 || size === 0xffffffff || body + size > view.byteLength
        ? view.byteLength - body
        : size
      break
    }
    offset = body + size + (size & 1)
  }

  if (format === null || dataOffset < 0) throw new Error('WAV has no fmt or data chunk')
  if (numChannels < 1) throw new Error('WAV has no channels')

  const bytes = bits / 8
  const frames = Math.floor(dataSize / (bytes * numChannels))
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames))

  let read
  if (format === 3 && bits === 32) read = p => view.getFloat32(p, true)
  else if (format === 3 && bits === 64) read = p => view.getFloat64(p, true)
  else if (format === 1 && bits === 16) read = p => view.getInt16(p, true) / 32768
  else if (format === 1 && bits === 24) {
    read = p => {
      const v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)
      return v / 8388608
    }
  } else if (format === 1 && bits === 32) read = p => view.getInt32(p, true) / 2147483648
  else throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit)`)

  const stride = bytes * numChannels
  for (let i = 0; i < frames; i++) {
    const base = dataOffset + i * stride
    for (let ch = 0; ch < numChannels; ch++) channels[ch][i] = read(base + ch * bytes)
  }
  return { channels, sampleRate }
}

function tag(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3),
  )
}
