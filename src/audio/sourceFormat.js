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
 * Lossless containers (WAV, AIFF, FLAC) report depth and rate. MP3 reports its
 * rate, channels and (for CBR) bitrate from the first frame header, so an MP3
 * re-saved as MP3 defaults to the bitrate it came in at. Other lossy formats
 * come back as `{ lossy: true }` with the rest null — the dialog then falls
 * back to the document's own rate and a 16-bit WAV.
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
 * @property {number|null} [bitrate] MP3 only: kbps of a CBR file, null for VBR
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
    const ext = String(fileName).split('.').pop().toLowerCase()
    if (tag.startsWith('ID3') || ext === 'mp3') {
      const mp3 = parseMp3(view)
      if (mp3) return mp3
    }
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

// MPEG audio Layer III tables, indexed by the header's fields.
const MP3_KBPS = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

/** A Layer III frame header at `i`: its fields, or null if this is not one. */
function mp3Header(view, i) {
  if (i + 4 > view.byteLength) return null
  const b1 = view.getUint8(i + 1), b2 = view.getUint8(i + 2), b3 = view.getUint8(i + 3)
  if (view.getUint8(i) !== 0xff || (b1 & 0xe0) !== 0xe0) return null
  const version = (b1 >> 3) & 3 // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  if (version === 1 || ((b1 >> 1) & 3) !== 1) return null // reserved, or not Layer III
  const kbps = MP3_KBPS[version === 3 ? 1 : 2][b2 >> 4]
  const sampleRate = MP3_RATES[version]?.[(b2 >> 2) & 3]
  if (!kbps || !sampleRate) return null
  const perFrame = version === 3 ? 144000 : 72000
  return {
    version, kbps, sampleRate,
    channels: (b3 >> 6) === 3 ? 1 : 2,
    length: Math.floor(perFrame * kbps / sampleRate) + ((b2 >> 1) & 1),
  }
}

/**
 * Where the audio starts after a leading ID3v2 tag — 10-byte header, a
 * syncsafe size, and a 10-byte footer if flagged — or 0 when there is none.
 */
export function id3v2End(bytes) {
  const view = bytes instanceof DataView ? bytes : new DataView(bytes)
  if (view.byteLength < 10 || !fourCC(view, 0).startsWith('ID3')) return 0
  const size = ((view.getUint8(6) & 0x7f) << 21) | ((view.getUint8(7) & 0x7f) << 14)
    | ((view.getUint8(8) & 0x7f) << 7) | (view.getUint8(9) & 0x7f)
  return 10 + size + (view.getUint8(5) & 0x10 ? 10 : 0)
}

/**
 * Read a file's format from a Blob / File, fetching only what it needs.
 *
 * ⚠ A FIXED PREFIX IS NOT ENOUGH FOR MP3: an ID3v2 tag carrying cover art is
 * routinely larger than SOURCE_HEADER_BYTES, so the first audio frame sat past
 * the bytes read and a 320 kbps original defaulted to 192 with no warning.
 * When the tag runs past (or nearly to) the end of the prefix, the frames are
 * read from just after the tag instead.
 *
 * @param {Blob} file
 * @returns {Promise<SourceFormat>}
 */
export async function readSourceFormat(file) {
  const head = await file.slice(0, SOURCE_HEADER_BYTES).arrayBuffer()
  const tagEnd = id3v2End(head)
  if (tagEnd > 0 && tagEnd + 8192 > head.byteLength && tagEnd < file.size) {
    const frames = await file.slice(tagEnd, tagEnd + SOURCE_HEADER_BYTES).arrayBuffer()
    const viaFrames = parseSourceFormat(frames, file.name)
    if (viaFrames.container === 'mp3' && viaFrames.sampleRate) return viaFrames
  }
  return parseSourceFormat(head, file.name)
}

function parseMp3(view) {
  let i = id3v2End(view)
  // The first header that is followed by another where its length says —
  // a lone 0xFFE pattern inside tag data or garbage is not a frame.
  for (; i + 4 <= view.byteLength; i++) {
    const h = mp3Header(view, i)
    if (!h) continue
    const next = i + h.length
    if (next + 4 <= view.byteLength && !mp3Header(view, next)) continue
    // A Xing header marks VBR (its first frame's bitrate means nothing); Info
    // is the same header on a CBR file. VBRI is Fraunhofer's VBR header.
    const side = h.version === 3 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17)
    const vbr = fourCC(view, i + 4 + side) === 'Xing' || fourCC(view, i + 36) === 'VBRI'
    return {
      container: 'mp3', lossy: true, bitDepth: null, float: false,
      sampleRate: h.sampleRate, channels: h.channels, bitrate: vbr ? null : h.kbps,
    }
  }
  return null
}
