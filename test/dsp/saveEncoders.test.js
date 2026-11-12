/**
 * Save's encoders: FLAC must decode to exactly the samples that went in, and
 * MP3 must carry the LAME Info tag that lets a decoder trim LAME's start-up
 * delay. FLAC is checked against an independent decoder written here from the
 * spec (RFC 9639), for the subset the encoder writes; MP3 runs the real WASM
 * build from node_modules.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { encodeFlac, FLAC_BLOCK_SIZE } from '../../src/audio/flacEncode.js'
import { encodeMp3, withInfoTag, mp3FrameLength } from '../../src/audio/mp3Encode.js'
import { encodeAudio } from '../../src/audio/encodeAudio.js'
import { toIntSamples } from '../../src/audio/wavEncode.js'
import { parseSourceFormat } from '../../src/audio/sourceFormat.js'

const require = createRequire(import.meta.url)
const MP3_WASM = readFileSync(require.resolve('wasm-media-encoders/wasm/mp3'))

// ── A FLAC decoder for the subset the encoder writes ────────────────────────

class BitReader {
  constructor(bytes) { this.b = bytes; this.pos = 0 } // pos in bits
  bit() { const v = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1; this.pos++; return v }
  bits(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v }
  signed(n) { const v = this.bits(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v }
  unary() { let q = 0; while (this.bit() === 0) q++; return q }
  align() { this.pos = (this.pos + 7) & ~7 }
}

function crc16(buf, start, end) {
  let c = 0
  for (let i = start; i < end; i++) {
    c ^= buf[i] << 8
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff
  }
  return c
}

function decodeSubframe(r, n, bps) {
  assert.equal(r.bit(), 0, 'subframe padding bit')
  const type = r.bits(6)
  assert.equal(r.bit(), 0, 'no wasted bits')
  const x = new Array(n)
  if (type === 0) { x.fill(r.signed(bps)); return x }
  if (type === 1) { for (let i = 0; i < n; i++) x[i] = r.signed(bps); return x }
  assert.ok(type >= 8 && type <= 12, `FIXED subframe, got type ${type}`)
  const order = type - 8
  for (let i = 0; i < order; i++) x[i] = r.signed(bps)
  const method = r.bits(2)
  assert.ok(method <= 1)
  const porder = r.bits(4)
  const paramBits = method ? 5 : 4
  let i = order
  for (let p = 0; p < 1 << porder; p++) {
    const k = r.bits(paramBits)
    assert.notEqual(k, method ? 31 : 15, 'no escape partitions')
    const count = (n >> porder) - (p === 0 ? order : 0)
    for (let j = 0; j < count; j++) {
      const u = r.unary() * 2 ** k + r.bits(k)
      x[i++] = u % 2 ? -(u + 1) / 2 : u / 2
    }
  }
  const c = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]][order]
  for (let t = order; t < n; t++) {
    let pred = 0
    for (let j = 0; j < order; j++) pred += c[j] * x[t - 1 - j]
    x[t] += pred
  }
  return x
}

function decodeFlac(bytes) {
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'fLaC')
  const r = new BitReader(bytes)
  r.pos = 32
  assert.equal(r.bit(), 1, 'STREAMINFO is the last metadata block')
  assert.equal(r.bits(7), 0)
  assert.equal(r.bits(24), 34)
  r.bits(16); r.bits(16); r.bits(24); r.bits(24)
  const sampleRate = r.bits(20)
  const channels = r.bits(3) + 1
  const bps = r.bits(5) + 1
  const total = r.bits(36)
  r.pos += 128
  const out = Array.from({ length: channels }, () => [])
  while (r.pos / 8 < bytes.length) {
    const start = r.pos / 8
    assert.equal(r.bits(16), 0xfff8, 'frame sync')
    const sizeCode = r.bits(4)
    r.bits(4)
    const assignment = r.bits(4)
    r.bits(3); r.bit()
    // UTF-8 frame number
    let lead = r.bits(8), extra = 0
    while (lead & 0x80) { lead = (lead << 1) & 0xff; extra++ }
    for (let i = 1; i < extra; i++) r.bits(8)
    const n = sizeCode === 0b1100 ? 4096 : r.bits(16) + 1
    r.bits(8) // CRC-8
    const sbps = ch => bps + ((assignment === 8 && ch === 1) || (assignment === 9 && ch === 0) || (assignment === 10 && ch === 1) ? 1 : 0)
    const subs = []
    for (let ch = 0; ch < channels; ch++) subs.push(decodeSubframe(r, n, sbps(ch)))
    r.align()
    const end = r.pos / 8
    assert.equal(r.bits(16), crc16(bytes, start, end), 'frame CRC-16')
    for (let i = 0; i < n; i++) {
      let s = subs.map(sf => sf[i])
      if (assignment === 8) s = [s[0], s[0] - s[1]]
      else if (assignment === 9) s = [s[1] + s[0], s[1]]
      else if (assignment === 10) { const side = s[1], mid = s[0] * 2 + (side & 1); s = [(mid + side) / 2, (mid - side) / 2] }
      for (let ch = 0; ch < channels; ch++) out[ch].push(s[ch])
    }
  }
  return { sampleRate, channels, bps, total, samples: out }
}

// ── Material ─────────────────────────────────────────────────────────────────

function narrationLike(n, sr, seed = 1) {
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const env = (0.5 + 0.5 * Math.sin(2 * Math.PI * 2.3 * t)) ** 2
    x[i] = env * (0.3 * Math.sin(2 * Math.PI * 180 * t) + 0.1 * Math.sin(2 * Math.PI * 2500 * t)) + 0.01 * rand()
  }
  return x
}

// ── FLAC ─────────────────────────────────────────────────────────────────────

test('FLAC round-trips bit-exact: 16 and 24-bit, mono and stereo, partial last block', () => {
  const sr = 44100, n = FLAC_BLOCK_SIZE * 3 + 777
  const L = narrationLike(n, sr, 1)
  const R = narrationLike(n, sr, 2).map((v, i) => (i < n / 2 ? 0.7 * L[i] + v * 0.05 : L[i]))
  L.fill(0.25, 100, 5000)          // a constant run (CONSTANT subframes)
  L[9000] = 1.7; L[9001] = -3       // clipped samples
  for (const bits of [16, 24]) {
    for (const chs of [[L], [L, R]]) {
      const dec = decodeFlac(encodeFlac(chs, sr, { bits }))
      assert.equal(dec.sampleRate, sr)
      assert.equal(dec.channels, chs.length)
      assert.equal(dec.bps, bits)
      assert.equal(dec.total, n)
      chs.forEach((ch, c) => assert.deepEqual(dec.samples[c], Array.from(toIntSamples(ch, bits)), `${bits}-bit ch${c}`))
    }
  }
})

test('FLAC: white noise at 24-bit (falls back to VERBATIM) and silence (CONSTANT) still round-trip', () => {
  const n = 5000
  const noise = new Float32Array(n).map((_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1)
  const silence = new Float32Array(n)
  const dec = decodeFlac(encodeFlac([noise, silence], 48000, { bits: 24 }))
  assert.deepEqual(dec.samples[0], Array.from(toIntSamples(noise, 24)))
  assert.ok(dec.samples[1].every(v => v === 0))
})

test('FLAC compresses speech-like material well below PCM', () => {
  const x = narrationLike(44100 * 5, 44100)
  const flac = encodeFlac([x], 44100, { bits: 16 })
  assert.ok(flac.length < x.length * 2 * 0.75, `${flac.length} bytes vs ${x.length * 2} PCM`)
})

// ── MP3 ──────────────────────────────────────────────────────────────────────

test('MP3: CBR frames at the chosen bitrate behind a LAME Info tag with delay and padding', async () => {
  const sr = 44100, n = sr * 3 + 321
  const x = narrationLike(n, sr)
  const mp3 = await encodeMp3([x, x], sr, { bitrate: 192, wasm: MP3_WASM })

  // Frame 0 is the tag; every later frame parses and they tile the file.
  const first = mp3FrameLength(mp3, 0)
  assert.ok(first > 0)
  let at = first, frames = 0
  while (at < mp3.length) {
    const len = mp3FrameLength(mp3, at)
    assert.ok(len > 0, `frame at ${at}`)
    assert.equal(mp3[at + 2] >> 4, 11, '192 kbps bitrate index')
    at += len
    frames++
  }
  assert.equal(at, mp3.length)

  const text = Buffer.from(mp3.subarray(0, first)).toString('latin1')
  const info = text.indexOf('Info')
  assert.equal(info, 36, 'Info header after 32 bytes of stereo side info')
  const dv = new DataView(mp3.buffer, mp3.byteOffset)
  assert.equal(dv.getUint32(info + 8), frames, 'frame count excludes the tag')
  assert.equal(dv.getUint32(info + 12), mp3.length, 'byte count includes the tag')
  const lame = text.indexOf('LAME3.100')
  assert.equal(lame, info + 120)
  const delay = (mp3[lame + 21] << 4) | (mp3[lame + 22] >> 4)
  const padding = ((mp3[lame + 22] & 0x0f) << 8) | mp3[lame + 23]
  assert.equal(delay, 576)
  assert.equal(frames * 1152, delay + n + padding, 'delay + samples + padding fill the frames')

  // Our own header parser reads it back.
  const src = parseSourceFormat(mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.length), 'x.mp3')
  assert.deepEqual(src, { container: 'mp3', lossy: true, bitDepth: null, float: false, sampleRate: 44100, channels: 2, bitrate: 192 })
})

test('MP3: mono uses the 17-byte side info; rates outside MPEG-1 and odd bitrates are refused', async () => {
  const x = narrationLike(48000, 48000)
  const mp3 = await encodeMp3([x], 48000, { bitrate: 128, wasm: MP3_WASM })
  assert.equal(Buffer.from(mp3.subarray(0, 200)).toString('latin1').indexOf('Info'), 21)
  await assert.rejects(encodeMp3([x], 22050, { bitrate: 128, wasm: MP3_WASM }), /22050/)
  await assert.rejects(encodeMp3([x], 44100, { bitrate: 100, wasm: MP3_WASM }), /bitrate/)
  // Not a stream: left untouched rather than tagged.
  const junk = new Uint8Array([1, 2, 3, 4, 5])
  assert.equal(withInfoTag(junk, 10), junk)
})

// ── Dispatch ─────────────────────────────────────────────────────────────────

test('encodeAudio resamples, then writes the chosen format with its MIME type', async () => {
  const x = narrationLike(48000, 48000)
  const wav = await encodeAudio([x], 48000, { format: 'wav', bitDepth: '24', sampleRate: 44100 })
  assert.equal(wav.mime, 'audio/wav')
  assert.equal(parseSourceFormat(wav.bytes.buffer).sampleRate, 44100)
  assert.equal(wav.bytes.length, 44 + 44100 * 3)

  const flac = await encodeAudio([x], 48000, { format: 'flac', bitDepth: '16', sampleRate: 48000 })
  assert.equal(flac.mime, 'audio/flac')
  assert.deepEqual(decodeFlac(flac.bytes).samples[0], Array.from(toIntSamples(x, 16)))

  const stages = new Set()
  const mp3 = await encodeAudio([x], 48000, { format: 'mp3', bitDepth: '16', sampleRate: 44100, bitrate: 128 },
    { wasm: MP3_WASM, onProgress: stage => stages.add(stage) })
  assert.equal(mp3.mime, 'audio/mpeg')
  assert.ok(stages.has('resample') && stages.has('encode'))
})
