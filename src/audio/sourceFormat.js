/**
 * What the file a document was opened from actually was.
 *
 * `decodeAudioData` hands back float samples at the AudioContext's rate and
 * forgets everything else: a 24-bit 44.1 kHz WAV and a 16-bit 48 kHz one arrive
 * looking identical. The Save dialog needs the original to default to it — so
 * that accepting the defaults never quietly lowers a file's quality — and to
 * warn when the chosen settings would. So the header is read here, once, at
 * import, from the first bytes of the file.
 *
 * Lossless containers (WAV, AIFF, FLAC) report depth and rate. Lossy ones have
 * no bit depth to report and their rate is not worth a frame parser, so they
 * come back as `{ lossy: true }` with the rest null — the dialog then falls
 * back to the document's own rate and a 16-bit default.
 */

/** How many bytes of the file to read. Headers sit well inside this. */
export const SOURCE_HEADER_BYTES = 65536

const LOSSY = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'webm'])

/**
 * @typedef {object} SourceFormat
 * @property {string} container  'wav' | 'aiff' | 'flac' | 'mp3' | … (from the bytes, else the extension)
 * @property {boolean} lossy
 * @property {number|null} bitDepth
 * @property {boolean} float
 * @property {number|null} sampleRate
 * @property {number|null} channels
 */

/**
 * @param {ArrayBuffer} bytes the start of the file (SOURCE_HEADER_BYTES is plenty)
 * @param {string} [fileName] used for the container when the bytes say nothing
 * @returns {SourceFormat}
 */
export function parseSourceFormat(bytes, fileName = '') {
  const view = new DataView(bytes)
  const tag = fourCC(view, 0)
  try {
    if ((tag === 'RIFF' || tag === 'RF64') && fourCC(view, 8) === 'WAVE') return parseWav(view)
    if (tag === 'FORM') {
      const kind = fourCC(view, 8)
      if (kind === 'AIFF' || kind === 'AIFC') return parseAiff(view, kind === 'AIFC')
    }
    if (tag === 'fLaC') return parseFlac(view)
  } catch {
    // A truncated or malformed header is not a reason to refuse the file —
    // decodeAudioData already accepted it. Fall through to "unknown".
  }
  const ext = String(fileName).split('.').pop().toLowerCase()
  return unknown(ext, LOSSY.has(ext))
}

function unknown(container, lossy) {
  return { container: container || 'unknown', lossy, bitDepth: null, float: false, sampleRate: null, channels: null }
}

function fourCC(view, offset) {
  if (offset + 4 > view.byteLength) return ''
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3)
  )
}

function parseWav(view) {
  // Walk chunks from after "RIFF<size>WAVE" until "fmt ". Chunks are word
  // aligned: an odd-sized chunk is followed by one pad byte.
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = fourCC(view, offset)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      const body = offset + 8
      let formatTag = view.getUint16(body, true)
      const channels = view.getUint16(body + 2, true)
      const sampleRate = view.getUint32(body + 4, true)
      const bitDepth = view.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE: the real tag is the first two bytes of the
      // SubFormat GUID, 24 bytes into the extension.
      if (formatTag === 0xfffe && size >= 40) formatTag = view.getUint16(body + 24, true)
      return {
        container: 'wav', lossy: false,
        bitDepth, float: formatTag === 3, sampleRate, channels,
      }
    }
    offset += 8 + size + (size & 1)
  }
  return unknown('wav', false)
}

function parseAiff(view, isAifc) {
  // Big-endian throughout. COMM: channels(2) frames(4) bits(2) rate(80-bit
  // extended) [AIFC: compressionType(4) …].
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = fourCC(view, offset)
    const size = view.getUint32(offset + 4, false)
    if (id === 'COMM') {
      const body = offset + 8
      const channels = view.getUint16(body, false)
      const bitDepth = view.getUint16(body + 6, false)
      const sampleRate = Math.round(readExtended(view, body + 8))
      const compression = isAifc && size >= 22 ? fourCC(view, body + 18) : 'NONE'
      const float = compression === 'fl32' || compression === 'FL32'
      return {
        container: 'aiff', lossy: false,
        bitDepth: float ? 32 : bitDepth, float, sampleRate, channels,
      }
    }
    offset += 8 + size + (size & 1)
  }
  return unknown('aiff', false)
}

/** IEEE 754 80-bit extended, big-endian — AIFF's sample-rate field. */
function readExtended(view, offset) {
  const expSign = view.getUint16(offset, false)
  const hi = view.getUint32(offset + 2, false)
  const lo = view.getUint32(offset + 6, false)
  const sign = expSign & 0x8000 ? -1 : 1
  const exp = (expSign & 0x7fff) - 16383
  const mantissa = hi * 2 ** -31 + lo * 2 ** -63
  return sign * mantissa * 2 ** exp
}

function parseFlac(view) {
  // "fLaC", then metadata blocks; STREAMINFO is required to be first.
  // Its body: min/max block (2+2), min/max frame (3+3), then 20 bits of
  // sample rate, 3 of channels − 1, 5 of bits per sample − 1.
  const body = 8
  const b0 = view.getUint8(body + 10)
  const b1 = view.getUint8(body + 11)
  const b2 = view.getUint8(body + 12)
  const b3 = view.getUint8(body + 13)
  const sampleRate = (b0 << 12) | (b1 << 4) | (b2 >> 4)
  const channels = ((b2 >> 1) & 0x7) + 1
  const bitDepth = (((b2 & 1) << 4) | (b3 >> 4)) + 1
  return { container: 'flac', lossy: false, bitDepth, float: false, sampleRate, channels }
}
