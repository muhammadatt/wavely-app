import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NOISE_REDUCTION_DEFAULTS,
  NR_DF3_LIMIT_MAX_DB,
  toServerParams,
  parseServerParams,
  serverParamsKey,
  blendDryWet,
  previewWindow,
  NR_PREVIEW_SECONDS,
} from '../../src/audio/noiseReductionParams.js'
import { decodeWav } from '../../src/audio/wavDecode.js'
import { FEATURES, FREE_PREVIEW_SECONDS } from '../../src/auth/plans.js'

test('the defaults send DF3 at the chain’s heavy tier and keep Mix in the browser', () => {
  assert.deepEqual(toServerParams(NOISE_REDUCTION_DEFAULTS), {
    engine: 'df3', df3AttenLimDb: 18, protectConsonants: false,
  })
  assert.equal('mix' in toServerParams({ mix: 0.5 }), false)
})

test('the top of the Max reduction knob is uncapped', () => {
  assert.equal(toServerParams({ df3LimitDb: NR_DF3_LIMIT_MAX_DB }).df3AttenLimDb, null)
  assert.equal(toServerParams({ df3LimitDb: NR_DF3_LIMIT_MAX_DB - 1 }).df3AttenLimDb, NR_DF3_LIMIT_MAX_DB - 1)
})

test('a setting the chosen engine does not read is not sent', () => {
  assert.deepEqual(toServerParams({ engine: 'rnnoise', df3LimitDb: 6, protectConsonants: true }), {
    engine: 'rnnoise', df3AttenLimDb: null, protectConsonants: true,
  })
  assert.deepEqual(toServerParams({ engine: 'both', df3LimitDb: 6, protectConsonants: false }), {
    engine: 'both', df3AttenLimDb: 6, protectConsonants: false,
  })
})

test('the result key moves with what the server reads and nothing else', () => {
  const base = { ...NOISE_REDUCTION_DEFAULTS, engine: 'rnnoise' }
  // Mix and an unused DF3 cap share a result.
  assert.equal(serverParamsKey(base), serverParamsKey({ ...base, mix: 0.3, df3LimitDb: 9 }))
  assert.notEqual(serverParamsKey(base), serverParamsKey({ ...base, protectConsonants: false }))
  assert.notEqual(serverParamsKey(base), serverParamsKey({ ...base, engine: 'both' }))
})

test('the server validates what the browser sends and refuses the rest', () => {
  assert.deepEqual(parseServerParams(toServerParams({ engine: 'both', df3LimitDb: 12 })), {
    engine: 'both', df3AttenLimDb: 12, protectConsonants: true,
  })
  assert.deepEqual(parseServerParams({}), { engine: 'df3', df3AttenLimDb: null, protectConsonants: false })
  assert.throws(() => parseServerParams({ engine: 'dtln' }), /engine/)
  assert.throws(() => parseServerParams({ df3AttenLimDb: 1 }), /df3AttenLimDb/)
  assert.throws(() => parseServerParams({ df3AttenLimDb: '--flag' }), /df3AttenLimDb/)
})

test('Mix is a linear dry/wet blend, bit-exact at its ends', () => {
  const dry = [new Float32Array([1, 0.5, -0.25])]
  const wet = [new Float32Array([0, 0.25, 0.5])]
  assert.deepEqual(Array.from(blendDryWet(dry, wet, 1)[0]), [0, 0.25, 0.5])
  assert.deepEqual(Array.from(blendDryWet(dry, wet, 0)[0]), [1, 0.5, -0.25])
  assert.deepEqual(Array.from(blendDryWet(dry, wet, 0.5)[0]), [0.5, 0.375, 0.125])
  // A short wet side reads as silence past its end rather than throwing.
  assert.deepEqual(Array.from(blendDryWet(dry, [new Float32Array([0])], 0.5)[0]), [0.5, 0.25, -0.125])
})

test('noise reduction is a server feature with a free preview', () => {
  assert.deepEqual(FEATURES.noiseReduction, {
    requires: 'pro', label: 'Noise Reduction', server: true, preview: true,
  })
})

test('the preview is the free limit, so every plan gets the same one', () => {
  assert.equal(NR_PREVIEW_SECONDS, FREE_PREVIEW_SECONDS)
})

test('Preview takes a short selection whole', () => {
  assert.deepEqual(previewWindow({ start: 10, end: 25 }, 12), { start: 10, end: 25 })
  assert.deepEqual(previewWindow({ start: 10, end: 40 }, 35), { start: 10, end: 40 })
})

test('on a long selection Preview starts at the playhead and stays inside', () => {
  const sel = { start: 0, end: 600 }
  assert.deepEqual(previewWindow(sel, 120, 30), { start: 120, end: 150 })
  // Near the end it slides back so the window stays full length.
  assert.deepEqual(previewWindow(sel, 590, 30), { start: 570, end: 600 })
  // A playhead outside the selection (or none) falls back to its start.
  assert.deepEqual(previewWindow({ start: 100, end: 700 }, 50, 30), { start: 100, end: 130 })
  assert.deepEqual(previewWindow({ start: 100, end: 700 }, 700, 30), { start: 100, end: 130 })
  assert.deepEqual(previewWindow({ start: 100, end: 700 }, null, 30), { start: 100, end: 130 })
})

// ── WAV decode ────────────────────────────────────────────────────────────────

function wav({ format, bits, channels, sampleRate, frames, extraChunk = false, extensible = false }) {
  const bytes = bits / 8
  const dataSize = frames.length * channels * bytes
  const fmtSize = extensible ? 40 : 16
  const extra = extraChunk ? 8 + 4 : 0
  const buf = new ArrayBuffer(12 + 8 + fmtSize + extra + 8 + dataSize)
  const v = new DataView(buf)
  const put = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  put(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); put(8, 'WAVE')
  let o = 12
  put(o, 'fmt '); v.setUint32(o + 4, fmtSize, true)
  v.setUint16(o + 8, extensible ? 0xfffe : format, true)
  v.setUint16(o + 10, channels, true)
  v.setUint32(o + 12, sampleRate, true)
  v.setUint32(o + 16, sampleRate * channels * bytes, true)
  v.setUint16(o + 20, channels * bytes, true)
  v.setUint16(o + 22, bits, true)
  if (extensible) { v.setUint16(o + 24, 22, true); v.setUint16(o + 32, format, true) }
  o += 8 + fmtSize
  if (extraChunk) { put(o, 'LIST'); v.setUint32(o + 4, 4, true); put(o + 8, 'INFO'); o += 12 }
  put(o, 'data'); v.setUint32(o + 4, dataSize, true); o += 8
  for (const frame of frames) {
    for (const s of frame) {
      if (format === 3) v.setFloat32(o, s, true)
      else if (bits === 16) v.setInt16(o, Math.round(s * 32768), true)
      else if (bits === 24) {
        const x = Math.round(s * 8388608)
        v.setUint8(o, x & 0xff); v.setUint8(o + 1, (x >> 8) & 0xff); v.setUint8(o + 2, (x >> 16) & 0xff)
      }
      o += bytes
    }
  }
  return buf
}

test('decodeWav reads float stereo at its own rate, past a LIST chunk', () => {
  const { channels, sampleRate } = decodeWav(wav({
    format: 3, bits: 32, channels: 2, sampleRate: 48000, extraChunk: true,
    frames: [[0.5, -0.5], [0.25, 0.125]],
  }))
  assert.equal(sampleRate, 48000)
  assert.deepEqual(channels.map(c => Array.from(c)), [[0.5, 0.25], [-0.5, 0.125]])
})

test('decodeWav reads 16- and 24-bit integer PCM and WAVE_FORMAT_EXTENSIBLE', () => {
  const i16 = decodeWav(wav({ format: 1, bits: 16, channels: 1, sampleRate: 44100, frames: [[0.5], [-0.5]] }))
  assert.deepEqual(Array.from(i16.channels[0]), [0.5, -0.5])
  const i24 = decodeWav(wav({ format: 1, bits: 24, channels: 1, sampleRate: 44100, frames: [[0.25], [-0.75]] }))
  assert.deepEqual(Array.from(i24.channels[0]), [0.25, -0.75])
  const ext = decodeWav(wav({ format: 3, bits: 32, channels: 1, sampleRate: 22050, extensible: true, frames: [[0.75]] }))
  assert.equal(ext.sampleRate, 22050)
  assert.deepEqual(Array.from(ext.channels[0]), [0.75])
})

test('decodeWav refuses what is not a WAV', () => {
  assert.throws(() => decodeWav(new ArrayBuffer(8)), /Not a WAV/)
})
