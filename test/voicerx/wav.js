/**
 * Minimal WAV reader for the real-audio corpus tooling.
 *
 * The app decodes through Web Audio, which does not exist in Node, and the
 * server decodes through FFmpeg, which is a subprocess this tooling has no
 * reason to depend on. Everything in `data/corpus/` is WAV by convention (see
 * build_reference_curves.py), so a reader is cheaper than either.
 *
 * Returns mono at the file's native sample rate. Mono because every VoiceRx
 * analysis is a single-channel measurement; native rate because the analysis
 * runs at the file's own rate in the app too, and resampling here would measure
 * something the product never sees.
 */

import { readFileSync } from 'node:fs'

const FORMAT_PCM = 0x0001
const FORMAT_FLOAT = 0x0003
const FORMAT_EXTENSIBLE = 0xfffe

/**
 * @param {string} path
 * @returns {{ mono: Float32Array, sampleRate: number, channels: number,
 *             bitDepth: number, seconds: number }}
 */
export function readWav(path) {
  const buf = readFileSync(path)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF'
    || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a RIFF/WAVE file: ${path}`)
  }

  let fmt = null
  let data = null

  // Walk the chunk list rather than assuming fmt-then-data. Files from real
  // mastering chains carry LIST/INFO, bext, iXML and cue chunks in whatever
  // order the tool that wrote them felt like.
  let pos = 12
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size))

    if (id === 'fmt ') {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitDepth: body.readUInt16LE(14),
      }
      // WAVE_FORMAT_EXTENSIBLE hides the real format code in its GUID prefix.
      if (fmt.format === FORMAT_EXTENSIBLE && body.length >= 26) {
        fmt.format = body.readUInt16LE(24)
      }
    } else if (id === 'data') {
      data = body
    }
    // Chunks are word-aligned; an odd size is followed by a pad byte.
    pos += 8 + size + (size % 2)
  }

  if (!fmt) throw new Error(`no fmt chunk: ${path}`)
  if (!data) throw new Error(`no data chunk: ${path}`)

  const bytes = fmt.bitDepth / 8
  const frames = Math.floor(data.length / (bytes * fmt.channels))
  const mono = new Float32Array(frames)
  const read = sampleReader(fmt, bytes, path)

  for (let i = 0; i < frames; i++) {
    let acc = 0
    for (let c = 0; c < fmt.channels; c++) acc += read(data, (i * fmt.channels + c) * bytes)
    mono[i] = acc / fmt.channels
  }

  return {
    mono,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitDepth: fmt.bitDepth,
    seconds: frames / fmt.sampleRate,
  }
}

function sampleReader(fmt, bytes, path) {
  if (fmt.format === FORMAT_FLOAT) {
    if (bytes === 4) return (d, o) => d.readFloatLE(o)
    if (bytes === 8) return (d, o) => d.readDoubleLE(o)
  }
  if (fmt.format === FORMAT_PCM) {
    if (bytes === 2) return (d, o) => d.readInt16LE(o) / 32768
    // 24-bit has no Buffer accessor. Assemble the three little-endian bytes into
    // the TOP 24 bits of a 32-bit word, then arithmetic-shift down — that is
    // what sign-extends bit 23 into the sign position. Every byte has to be
    // shifted up, not just the most significant one: an earlier version left
    // the low byte unshifted, which read a full-scale negative sample as
    // -0.99998 instead of -0.99609 and mixed stereo to the wrong value.
    if (bytes === 3) {
      return (d, o) => (((d[o] << 8) | (d[o + 1] << 16) | (d[o + 2] << 24)) >> 8) / 8388608
    }
    if (bytes === 4) return (d, o) => d.readInt32LE(o) / 2147483648
    if (bytes === 1) return (d, o) => (d[o] - 128) / 128 // 8-bit PCM is unsigned
  }
  throw new Error(`unsupported WAV format ${fmt.format} at ${fmt.bitDepth}-bit: ${path}`)
}
