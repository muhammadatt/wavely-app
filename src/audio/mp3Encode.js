/**
 * MP3 encoding — LAME compiled to WebAssembly (`wasm-media-encoders`).
 *
 * Every MP3 encoder worth shipping is LAME; this is its WASM build, which runs
 * ~150x realtime on mono narration where the pure-JS port (lamejs) managed
 * ~44x — a 30-minute chapter in ~12 s rather than ~40. Only the MP3 binary is
 * loaded (`wasm`, a URL in the browser or bytes under node); the package's
 * default entry inlines its Ogg encoder too and is three times the size.
 *
 * ⚠ LAME IS LGPL. The wrapper is MIT, but the WASM it loads is LAME, so it is
 * kept as a separate, separately fetched file rather than inlined into a
 * bundle — the arrangement LGPL is comfortable with.
 *
 * CBR only (`bitrate`), the delivery norm: ACX requires constant bit rate.
 *
 * ⚠ THE WASM BUILD WRITES NO LAME/INFO TAG, so on its own a player cannot
 * trim the encoder's start-up delay: every file came out ~25 ms late with
 * padding at the end (measured 1083 samples of leading silence at 44.1 kHz),
 * and an MP3 re-saved as MP3 drifted another 25 ms per generation. `withInfoTag`
 * prepends the frame LAME's own CLI writes — an "Info" (CBR Xing) header with
 * the LAME extension carrying encoder delay and padding — which ffmpeg,
 * browsers and Apple's decoders read to return exactly the samples encoded.
 *
 * Sample rates are MPEG-1's only (32 / 44.1 / 48 kHz): one frame layout
 * (1152 samples) for the tag arithmetic, and below 32 kHz is not a delivery
 * format anyone asks narration for.
 */
import { createEncoder } from 'wasm-media-encoders'
import { MP3_BITRATES, MP3_SAMPLE_RATES } from './saveFormat.js'

/** LAME's encoder delay in samples (ENCDELAY); decoders add their own 529 on top. */
const ENCODER_DELAY = 576
const SAMPLES_PER_FRAME = 1152

/** Samples handed to the encoder per call. */
const CHUNK = 1152 * 16

/**
 * @param {Float32Array[]} channelData one or two channels
 * @param {number} sampleRate one of MP3_SAMPLE_RATES
 * @param {{ bitrate: number, wasm: string|URL|ArrayBuffer|Uint8Array,
 *           onProgress?: (fraction: number) => void }} options
 * @returns {Promise<Uint8Array>}
 */
export async function encodeMp3(channelData, sampleRate, { bitrate, wasm, onProgress }) {
  if (!MP3_SAMPLE_RATES.includes(sampleRate)) throw new Error(`MP3 cannot carry ${sampleRate} Hz`)
  if (!MP3_BITRATES.includes(bitrate)) throw new Error(`unsupported MP3 bitrate: ${bitrate}`)
  const channels = channelData.length
  if (channels !== 1 && channels !== 2) throw new Error('MP3 carries one or two channels')

  const encoder = await createEncoder('audio/mpeg', wasm instanceof URL ? wasm.href : wasm)
  encoder.configure({ sampleRate, channels, bitrate })

  const total = channelData[0].length
  const parts = []
  let size = 0
  const push = chunk => {
    // The encoder reuses its output buffer between calls: copy before the next.
    if (chunk.length) { parts.push(chunk.slice()); size += chunk.length }
  }
  for (let i = 0, n = 0; i < total; i += CHUNK, n++) {
    push(encoder.encode(channelData.map(ch => ch.subarray(i, i + CHUNK))))
    if (onProgress && (n & 15) === 15) onProgress(Math.min(1, (i + CHUNK) / total))
  }
  push(encoder.finalize())

  const stream = new Uint8Array(size)
  let at = 0
  for (const p of parts) { stream.set(p, at); at += p.length }
  onProgress?.(1)
  return withInfoTag(stream, total)
}

// ── LAME Info tag ───────────────────────────────────────────────────────────

const BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const RATES_MPEG1 = [44100, 48000, 32000]

/** MPEG-1 Layer III frame length in bytes from its 4-byte header, or 0. */
export function mp3FrameLength(b, i) {
  if (b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xfa) return 0 // MPEG-1, Layer III
  const kbps = BITRATES_MPEG1_L3[b[i + 2] >> 4]
  const rate = RATES_MPEG1[(b[i + 2] >> 2) & 3]
  if (!kbps || !rate) return 0
  return Math.floor(144000 * kbps / rate) + ((b[i + 2] >> 1) & 1)
}

/** CRC-16/ARC (reflected 0x8005, init 0) — what the LAME tag uses. */
function crc16Arc(buf, start, end, crc = 0) {
  for (let i = start; i < end; i++) {
    crc ^= buf[i]
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
  }
  return crc
}

/**
 * Prepend a LAME "Info" frame to a CBR MPEG-1 Layer III stream.
 * @param {Uint8Array} stream frames exactly as the encoder produced them
 * @param {number} samples samples per channel that went in
 */
export function withInfoTag(stream, samples) {
  let frames = 0
  for (let i = 0; i + 4 <= stream.length;) {
    const len = mp3FrameLength(stream, i)
    if (!len) break
    frames++
    i += len
  }
  if (frames === 0) return stream

  // The tag frame copies the stream's header with the padding bit cleared.
  const header = stream.subarray(0, 4)
  const kbps = BITRATES_MPEG1_L3[header[2] >> 4]
  const rate = RATES_MPEG1[(header[2] >> 2) & 3]
  const frameLen = Math.floor(144000 * kbps / rate)
  const mono = (header[3] >> 6) === 3
  const xingAt = 4 + (mono ? 17 : 32)

  const tag = new Uint8Array(frameLen)
  tag.set(header)
  tag[2] &= ~0x02
  const v = new DataView(tag.buffer)
  const total = frameLen + stream.length

  let o = xingAt
  for (const c of 'Info') tag[o++] = c.charCodeAt(0)
  v.setUint32(o, 0x0f, false); o += 4 // frames | bytes | TOC | quality
  v.setUint32(o, frames, false); o += 4
  v.setUint32(o, total, false); o += 4
  for (let i = 0; i < 100; i++) tag[o++] = Math.floor(i * 256 / 100) // CBR: linear TOC
  v.setUint32(o, 0, false); o += 4 // quality

  const lame = o
  for (const c of 'LAME3.100') tag[o++] = c.charCodeAt(0)
  tag[lame + 9] = 0x01 // tag revision 0, VBR method 1 = CBR
  tag[lame + 20] = Math.min(255, kbps)
  const padding = Math.max(0, frames * SAMPLES_PER_FRAME - ENCODER_DELAY - samples)
  tag[lame + 21] = ENCODER_DELAY >> 4
  tag[lame + 22] = ((ENCODER_DELAY & 0x0f) << 4) | (padding >> 8)
  tag[lame + 23] = padding & 0xff
  v.setUint32(lame + 28, total, false) // music length, tag frame included
  v.setUint16(lame + 32, crc16Arc(stream, 0, stream.length), false)
  v.setUint16(lame + 34, crc16Arc(tag, 0, lame + 34), false)

  const out = new Uint8Array(total)
  out.set(tag)
  out.set(stream, frameLen)
  return out
}
