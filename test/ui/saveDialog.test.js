/**
 * The Save dialog's rules and the bytes behind them: WAV encoding at each
 * offered depth, reading the source's format from its header, the defaults
 * that keep the source's resolution, and when a Save replaces the original.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav, wavHeaderBytes } from '../../src/audio/wavEncode.js'
import { parseSourceFormat } from '../../src/audio/sourceFormat.js'
import {
  defaultSaveSettings, qualityLossWarning, savePlan, sampleRateOptions,
  toSaveFileName, wavBytesFor,
} from '../../src/audio/saveFormat.js'

const ch = (...v) => Float32Array.from(v)

// ── Encoding ────────────────────────────────────────────────────────────────

test('16-bit PCM: header fields and rounded, clipped samples', () => {
  const buf = encodeWav([ch(0, 0.5, -1, 2, -0.25)], 48000, 1, { bits: 16 })
  const v = new DataView(buf)
  assert.equal(buf.byteLength, 44 + 5 * 2)
  assert.equal(v.getUint16(20, true), 1)
  assert.equal(v.getUint32(24, true), 48000)
  assert.equal(v.getUint16(34, true), 16)
  assert.equal(v.getUint32(40, true), 10)
  const s = i => v.getInt16(44 + i * 2, true)
  assert.deepEqual([s(0), s(1), s(2), s(3), s(4)], [0, Math.round(0.5 * 32767), -32768, 32767, -8192])
})

test('24-bit PCM: three bytes per sample, sign carried in the top byte', () => {
  const buf = encodeWav([ch(0.5), ch(-0.5)], 44100, 2, { bits: 24 })
  const v = new DataView(buf)
  assert.equal(buf.byteLength, 44 + 2 * 3)
  assert.equal(v.getUint16(32, true), 6) // block align
  assert.equal(v.getUint16(34, true), 24)
  const read24 = o => {
    const u = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16)
    return u & 0x800000 ? u - 0x1000000 : u
  }
  assert.equal(read24(44), Math.round(0.5 * 0x7fffff))
  assert.equal(read24(47), -0x400000)
})

test('32-bit float: format tag 3, fact chunk, samples kept above full scale', () => {
  const buf = encodeWav([ch(0.25, 1.5)], 96000, 1, { bits: 32, float: true })
  const v = new DataView(buf)
  assert.equal(wavHeaderBytes({ float: true }), 58)
  assert.equal(buf.byteLength, 58 + 8)
  assert.equal(v.getUint32(16, true), 18)
  assert.equal(v.getUint16(20, true), 3)
  assert.equal(String.fromCharCode(...new Uint8Array(buf, 38, 4)), 'fact')
  assert.equal(v.getUint32(46, true), 2)
  assert.equal(String.fromCharCode(...new Uint8Array(buf, 50, 4)), 'data')
  assert.equal(v.getUint32(4, true), buf.byteLength - 8)
  assert.equal(v.getFloat32(58, true), 0.25)
  assert.equal(v.getFloat32(62, true), 1.5)
})

// ── Reading the source's header ─────────────────────────────────────────────

test('an encoded WAV reads back as what it was written as', () => {
  for (const [fmt, bits, float] of [[{ bits: 16 }, 16, false], [{ bits: 24 }, 24, false], [{ bits: 32, float: true }, 32, true]]) {
    const f = parseSourceFormat(encodeWav([ch(0), ch(0)], 88200, 2, fmt), 'x.wav')
    assert.deepEqual(f, { container: 'wav', lossy: false, bitDepth: bits, float, sampleRate: 88200, channels: 2 })
  }
})

test('WAVE_FORMAT_EXTENSIBLE reports the sub-format, after skipping a leading chunk', () => {
  const b = new ArrayBuffer(12 + 12 + 8 + 40)
  const v = new DataView(b)
  const put = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  put(0, 'RIFF'); put(8, 'WAVE')
  put(12, 'JUNK'); v.setUint32(16, 3, true) // odd size: one pad byte follows
  const f = 12 + 8 + 4
  put(f, 'fmt '); v.setUint32(f + 4, 40, true)
  v.setUint16(f + 8, 0xfffe, true); v.setUint16(f + 10, 1, true)
  v.setUint32(f + 12, 48000, true); v.setUint16(f + 22, 32, true)
  v.setUint16(f + 8 + 24, 3, true) // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
  assert.deepEqual(parseSourceFormat(b.slice(0, f + 48)), {
    container: 'wav', lossy: false, bitDepth: 32, float: true, sampleRate: 48000, channels: 1,
  })
})

test('FLAC STREAMINFO: rate, channels and depth', () => {
  const b = new Uint8Array(8 + 34)
  b.set([0x66, 0x4c, 0x61, 0x43]) // fLaC
  // 44100 = 0x0AC44 (20 bits) · channels 2 (stored 1) · 24 bits (stored 23)
  b[18] = 0x0a; b[19] = 0xc4; b[20] = (0x4 << 4) | (1 << 1) | (23 >> 4); b[21] = (23 & 0xf) << 4
  assert.deepEqual(parseSourceFormat(b.buffer, 'take.flac'), {
    container: 'flac', lossy: false, bitDepth: 24, float: false, sampleRate: 44100, channels: 2,
  })
})

test('AIFF COMM: 80-bit extended sample rate', () => {
  const b = new ArrayBuffer(12 + 8 + 18)
  const v = new DataView(b)
  const put = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  put(0, 'FORM'); put(8, 'AIFF'); put(12, 'COMM'); v.setUint32(16, 18, false)
  v.setUint16(20, 1, false); v.setUint16(26, 24, false)
  // 44100 Hz as IEEE extended: exponent 16383 + 15, mantissa 44100 << 16
  v.setUint16(28, 16383 + 15, false); v.setUint32(30, 44100 * 2 ** 16, false)
  assert.deepEqual(parseSourceFormat(b), {
    container: 'aiff', lossy: false, bitDepth: 24, float: false, sampleRate: 44100, channels: 1,
  })
})

test('lossy and unreadable files fall back to the extension', () => {
  const mp3 = parseSourceFormat(new Uint8Array([0x49, 0x44, 0x33, 4]).buffer, 'Chapter.MP3')
  assert.equal(mp3.container, 'mp3')
  assert.equal(mp3.lossy, true)
  assert.equal(mp3.bitDepth, null)
  // A RIFF header cut off before fmt is not an error.
  const cut = parseSourceFormat(encodeWav([ch(0)], 44100, 1).slice(0, 14), 'cut.wav')
  assert.equal(cut.container, 'wav')
  assert.equal(cut.bitDepth, null)
})

// ── Defaults and warnings ───────────────────────────────────────────────────

const wav24 = { container: 'wav', lossy: false, bitDepth: 24, float: false, sampleRate: 44100, channels: 1 }

test('defaults keep the source’s depth and rate, so accepting them loses nothing', () => {
  assert.deepEqual(defaultSaveSettings(wav24, 48000), { bitDepth: '24', sampleRate: 44100 })
  assert.equal(qualityLossWarning(defaultSaveSettings(wav24, 48000), wav24), null)
  assert.deepEqual(defaultSaveSettings({ ...wav24, bitDepth: 32, float: true }, 48000).bitDepth, '32f')
  assert.deepEqual(defaultSaveSettings({ ...wav24, bitDepth: 16 }, 48000).bitDepth, '16')
  // Nothing known: 16-bit at the document's rate, as Save always wrote.
  assert.deepEqual(defaultSaveSettings(null, 48000), { bitDepth: '16', sampleRate: 48000 })
  assert.deepEqual(defaultSaveSettings({ container: 'mp3', lossy: true, sampleRate: null }, 48000), { bitDepth: '16', sampleRate: 48000 })
})

test('a lower depth or rate than a lossless original is called out; a lossy one never is', () => {
  assert.match(qualityLossWarning({ bitDepth: '16', sampleRate: 44100 }, wav24), /24-bit → 16-bit/)
  assert.match(qualityLossWarning({ bitDepth: '24', sampleRate: 22050 }, wav24), /44\.1 kHz → 22\.05 kHz/)
  assert.equal(qualityLossWarning({ bitDepth: '32f', sampleRate: 96000 }, wav24), null)
  assert.match(qualityLossWarning({ bitDepth: '24', sampleRate: 44100 }, { ...wav24, bitDepth: 32, float: true }), /float/)
  assert.equal(qualityLossWarning({ bitDepth: '16', sampleRate: 22050 }, { container: 'mp3', lossy: true }), null)
})

test('the rate list carries an odd source rate and the document rate', () => {
  const opts = sampleRateOptions({ sampleRate: 47952 }, 48000)
  assert.ok(opts.includes(47952) && opts.includes(44100))
  assert.deepEqual(opts, [...opts].sort((a, b) => a - b))
})

test('size estimate follows depth and rate, header included', () => {
  assert.equal(wavBytesFor(1, 2, { bitDepth: '24', sampleRate: 48000 }), 48000 * 2 * 3 + 44)
  assert.equal(wavBytesFor(1, 1, { bitDepth: '32f', sampleRate: 44100 }), 44100 * 4 + 58)
})

// ── Where a Save goes ───────────────────────────────────────────────────────

test('keeping a WAV’s name replaces it; any other name confirms in the system dialog', () => {
  const anchor = { name: 'Chapter01.WAV' }
  const base = { supportsInPlace: true, anchorHandle: anchor }
  assert.equal(savePlan({ ...base, fileName: 'Chapter01.WAV' }), 'replace')
  assert.equal(savePlan({ ...base, fileName: ' Chapter01.WAV ' }), 'replace')
  assert.equal(savePlan({ ...base, fileName: 'Chapter01 edit.wav' }), 'pick')
  assert.equal(savePlan({ ...base, fileName: 'Chapter01.wav' }), 'pick') // a different file on a case-sensitive disk
  assert.equal(savePlan({ supportsInPlace: true, anchorHandle: null, fileName: 'x.wav' }), 'pick')
})

test('an MP3 original is never replaced — the output is always WAV', () => {
  const anchor = { name: 'take.mp3' }
  assert.equal(savePlan({ supportsInPlace: true, anchorHandle: anchor, fileName: 'take.mp3' }), 'pick')
  assert.equal(toSaveFileName('take.mp3'), 'take.wav')
})

test('a destination chosen with Change… wins; no write API always downloads', () => {
  const chosen = { name: 'elsewhere.wav' }
  assert.equal(savePlan({ supportsInPlace: true, chosenHandle: chosen, anchorHandle: { name: 'a.wav' }, fileName: 'a.wav' }), 'chosen')
  assert.equal(savePlan({ supportsInPlace: false, chosenHandle: chosen, fileName: 'a.wav' }), 'download')
})

test('save filenames: .wav kept as typed, anything else swapped', () => {
  assert.equal(toSaveFileName('Take 2.WAV'), 'Take 2.WAV')
  assert.equal(toSaveFileName('Take 2'), 'Take 2.wav')
  assert.equal(toSaveFileName('mix.flac'), 'mix.wav')
  // A dotfile has no extension to keep: it gets one, it is not taken for one.
  assert.equal(toSaveFileName('.wav'), '.wav.wav')
})
