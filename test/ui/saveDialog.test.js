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
  defaultSaveSettings, estimateSaveBytes, formatAvailable, normalizeSettings,
  qualityLossWarning, savePlan, sampleRateOptions, toSaveFileName, wavBytesFor, formatFolderPath,
  splitAudioName, formatForExtension, extensionFor,
} from '../../src/audio/saveFormat.js'
import { directoryPathIn } from '../../src/composables/useWorkingFolder.js'

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

test('defaults keep the source’s format, depth and rate, so accepting them loses nothing', () => {
  assert.deepEqual(defaultSaveSettings(wav24, 48000, 1), { format: 'wav', bitDepth: '24', sampleRate: 44100, bitrate: 192 })
  assert.equal(qualityLossWarning(defaultSaveSettings(wav24, 48000, 1), wav24), null)
  assert.equal(defaultSaveSettings({ ...wav24, bitDepth: 32, float: true }, 48000).bitDepth, '32f')
  assert.equal(defaultSaveSettings({ ...wav24, bitDepth: 16 }, 48000).bitDepth, '16')
  // Nothing known: 16-bit WAV at the document's rate, as Save always wrote.
  assert.deepEqual(defaultSaveSettings(null, 48000), { format: 'wav', bitDepth: '16', sampleRate: 48000, bitrate: 192 })
  // An AIFF or an M4A has no format of its own on offer: WAV.
  assert.equal(defaultSaveSettings({ ...wav24, container: 'aiff' }, 48000).format, 'wav')
  assert.equal(defaultSaveSettings({ container: 'm4a', lossy: true, sampleRate: null }, 48000).format, 'wav')
})

test('a FLAC original defaults to FLAC; an MP3 to MP3 at its own bitrate, rounded up', () => {
  const flac = { container: 'flac', lossy: false, bitDepth: 24, float: false, sampleRate: 96000, channels: 2 }
  assert.deepEqual(defaultSaveSettings(flac, 48000), { format: 'flac', bitDepth: '24', sampleRate: 96000, bitrate: 192 })
  const mp3 = { container: 'mp3', lossy: true, bitDepth: null, float: false, sampleRate: 44100, channels: 2, bitrate: 128 }
  assert.deepEqual(defaultSaveSettings(mp3, 48000), { format: 'mp3', bitDepth: '16', sampleRate: 44100, bitrate: 128 })
  assert.equal(defaultSaveSettings({ ...mp3, bitrate: 112 }, 48000).bitrate, 128)
  assert.equal(defaultSaveSettings({ ...mp3, bitrate: null }, 48000).bitrate, 192) // VBR: ACX's rate
  // A 22.05 kHz MP3 has no MPEG-1 rate of its own: the next one up.
  assert.equal(defaultSaveSettings({ ...mp3, sampleRate: 22050 }, 48000).sampleRate, 32000)
})

test('switching format fixes what the new one cannot write', () => {
  assert.deepEqual(normalizeSettings({ format: 'flac', bitDepth: '32f', sampleRate: 96000, bitrate: 192 }),
    { format: 'flac', bitDepth: '24', sampleRate: 96000, bitrate: 192 })
  assert.equal(normalizeSettings({ format: 'mp3', bitDepth: '24', sampleRate: 96000, bitrate: 192 }).sampleRate, 48000)
  assert.equal(normalizeSettings({ format: 'mp3', bitDepth: '24', sampleRate: 44100, bitrate: 192 }, 6).format, 'wav')
  assert.equal(formatAvailable('mp3', 2), true)
  assert.equal(formatAvailable('mp3', 6), false)
  assert.equal(formatAvailable('flac', 6), true)
})

test('a lower depth or rate than a lossless original is called out; a lossy one never is', () => {
  const w = x => ({ format: 'wav', ...x })
  assert.match(qualityLossWarning(w({ bitDepth: '16', sampleRate: 44100 }), wav24), /24-bit → 16-bit/)
  assert.match(qualityLossWarning(w({ bitDepth: '24', sampleRate: 22050 }), wav24), /44\.1 kHz → 22\.05 kHz/)
  assert.equal(qualityLossWarning(w({ bitDepth: '32f', sampleRate: 96000 }), wav24), null)
  assert.match(qualityLossWarning(w({ bitDepth: '24', sampleRate: 44100 }), { ...wav24, bitDepth: 32, float: true }), /float/)
  assert.equal(qualityLossWarning(w({ bitDepth: '16', sampleRate: 22050 }), { container: 'mp3', lossy: true }), null)
})

test('the rate list carries an odd source rate and the document rate; MP3 lists only its own', () => {
  const opts = sampleRateOptions('wav', { sampleRate: 47952 }, 48000)
  assert.ok(opts.includes(47952) && opts.includes(44100))
  assert.deepEqual(opts, [...opts].sort((a, b) => a - b))
  assert.deepEqual(sampleRateOptions('mp3', { sampleRate: 47952 }, 48000), [32000, 44100, 48000])
})

test('MP3 warns about lossy output; re-encoding a lossy original says so, with the bitrate drop', () => {
  assert.match(qualityLossWarning({ format: 'mp3', sampleRate: 44100, bitrate: 192 }, wav24), /MP3 is lossy/)
  const mp3 = { container: 'mp3', lossy: true, sampleRate: 44100, bitrate: 192 }
  assert.match(qualityLossWarning({ format: 'mp3', sampleRate: 44100, bitrate: 128 }, mp3), /Lower than the original.*192 → 128 kbps/)
  assert.equal(qualityLossWarning({ format: 'flac', bitDepth: '16', sampleRate: 44100 }, mp3), null)
  assert.match(qualityLossWarning({ format: 'flac', bitDepth: '24', sampleRate: 44100 }, { ...wav24, bitDepth: 32, float: true }), /float → 24-bit/)
})

test('size estimate follows format, depth and rate', () => {
  assert.equal(wavBytesFor(1, 2, { bitDepth: '24', sampleRate: 48000 }), 48000 * 2 * 3 + 44)
  assert.equal(wavBytesFor(1, 1, { bitDepth: '32f', sampleRate: 44100 }), 44100 * 4 + 58)
  assert.deepEqual(estimateSaveBytes(60, 2, { format: 'mp3', bitrate: 192, sampleRate: 44100 }), { bytes: 1440000, approx: false })
  const flac = estimateSaveBytes(60, 1, { format: 'flac', bitDepth: '16', sampleRate: 44100 })
  assert.equal(flac.approx, true)
  assert.ok(flac.bytes < wavBytesFor(60, 1, { bitDepth: '16', sampleRate: 44100 }))
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

test('an original is replaced only in its own format — the extension is part of the name', () => {
  const anchor = { name: 'take.mp3' }
  assert.equal(savePlan({ supportsInPlace: true, anchorHandle: anchor, fileName: 'take.mp3', format: 'wav' }), 'pick')
  assert.equal(savePlan({ supportsInPlace: true, anchorHandle: anchor, fileName: 'take.mp3', format: 'mp3' }), 'replace')
  assert.equal(savePlan({ supportsInPlace: true, anchorHandle: { name: 'take.flac' }, fileName: 'take', format: 'flac' }), 'replace')
  assert.equal(savePlan({ supportsInPlace: true, anchorHandle: { name: 'take.flac' }, fileName: 'take.flac', format: 'wav' }), 'pick')
  assert.equal(toSaveFileName('take.mp3'), 'take.wav')
})

test('a destination chosen with Change… wins; no write API always downloads', () => {
  const chosen = { name: 'elsewhere.wav' }
  assert.equal(savePlan({ supportsInPlace: true, chosenHandle: chosen, anchorHandle: { name: 'a.wav' }, fileName: 'a.wav' }), 'chosen')
  assert.equal(savePlan({ supportsInPlace: false, chosenHandle: chosen, fileName: 'a.wav' }), 'download')
})

test('save filenames: a matching extension kept as typed, an audio one swapped, others appended', () => {
  assert.equal(toSaveFileName('Take 2.WAV'), 'Take 2.WAV')
  assert.equal(toSaveFileName('Take 2'), 'Take 2.wav')
  assert.equal(toSaveFileName('mix.flac'), 'mix.wav')
  assert.equal(toSaveFileName('mix.wav', 'flac'), 'mix.flac')
  assert.equal(toSaveFileName('mix.FLAC', 'flac'), 'mix.FLAC')
  assert.equal(toSaveFileName('mix.m4a', 'mp3'), 'mix.mp3')
  assert.equal(toSaveFileName('Chapter 1.2', 'mp3'), 'Chapter 1.2.mp3')
  assert.equal(toSaveFileName('take. ', 'wav'), 'take.wav')
  // A dotfile has no extension to keep: it gets one, it is not taken for one.
  assert.equal(toSaveFileName('.wav'), '.wav.wav')
})

// ── Working folder ──────────────────────────────────────────────────────────

test('a working-folder destination writes straight in; the original\u2019s name still replaces it', () => {
  const inside = { segments: ['Raw'], explicit: false }
  const base = { supportsInPlace: true, anchorHandle: { name: 'ch01.wav' }, folderTarget: inside }
  assert.equal(savePlan({ ...base, fileName: 'ch01 edit.wav' }), 'folder')
  assert.equal(savePlan({ ...base, fileName: 'ch01.wav' }), 'replace')
  // No original at all (a drop with no handle): the folder, not the system dialog.
  assert.equal(savePlan({ supportsInPlace: true, folderTarget: { segments: [] }, fileName: 'x.wav' }), 'folder')
  // Change… still wins, and no write API still downloads.
  assert.equal(savePlan({ ...base, chosenHandle: { name: 'y.wav' }, fileName: 'y.wav' }), 'chosen')
  assert.equal(savePlan({ ...base, supportsInPlace: false, fileName: 'x.wav' }), 'download')
})

test('“Save to the folder instead” outranks replacing an original that lives outside it', () => {
  const p = { supportsInPlace: true, anchorHandle: { name: 'ch01.wav' }, folderTarget: { segments: [], explicit: true }, fileName: 'ch01.wav' }
  assert.equal(savePlan(p), 'folder')
})

test('folder locations read relative to the working folder', () => {
  assert.equal(formatFolderPath('Ch Audiobook', []), 'Ch Audiobook')
  assert.equal(formatFolderPath('Ch Audiobook', ['Raw takes', 'Day 2']), 'Ch Audiobook › Raw takes › Day 2')
})

test('directoryPathIn drops the file’s own name, and is null outside or on error', async () => {
  const root = {
    resolve: async h => (h.name === 'out.wav' ? null : h.name === 'bad.wav' ? Promise.reject(new Error('x')) : ['Raw', h.name]),
  }
  assert.deepEqual(await directoryPathIn(root, { name: 'ch01.wav' }), ['Raw'])
  assert.equal(await directoryPathIn(root, { name: 'out.wav' }), null)
  assert.equal(await directoryPathIn(root, { name: 'bad.wav' }), null)
  assert.equal(await directoryPathIn(null, { name: 'ch01.wav' }), null)
})

// ── Name editing ────────────────────────────────────────────────────────────

test('the name is edited without its audio extension; other dots are part of the name', () => {
  assert.deepEqual(splitAudioName('Chapter01.WAV'), { base: 'Chapter01', ext: '.WAV' })
  assert.deepEqual(splitAudioName(' take.mp3 '), { base: 'take', ext: '.mp3' })
  assert.deepEqual(splitAudioName('Chapter 1.2'), { base: 'Chapter 1.2', ext: '' })
  assert.deepEqual(splitAudioName('.wav'), { base: '.wav', ext: '' })
  assert.equal(formatForExtension('.FLAC'), 'flac')
  assert.equal(formatForExtension('.m4a'), null)
})

test('the extension keeps the case of the file it would replace', () => {
  assert.equal(extensionFor('wav', 'Chapter01.WAV'), '.WAV')
  assert.equal(extensionFor('flac', 'Chapter01.WAV'), '.flac')
  assert.equal(extensionFor('mp3', null, 'x.MP3'), '.MP3')
  assert.equal(extensionFor('wav'), '.wav')
})
