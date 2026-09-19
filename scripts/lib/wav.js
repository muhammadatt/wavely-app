/**
 * 32-bit float mono WAV writer for the capture tooling.
 *
 * Shared by every stimulus generator. It was written twice — byte-identical
 * copies in `la2a-ballistics.mjs` and `la2a-tube-capture-tones.mjs` — and the
 * FET suite would have made it three. The read side lives in
 * `test/voicerx/wav.js` and is re-exported here so a script needs one import
 * for both directions.
 *
 * ⚠ 32-BIT FLOAT AND NEVER INTEGER. The stimulus is the reference half of
 * every measurement in this directory: a gain trace is recovered by dividing
 * the capture by it, and a THD figure is quoted against its fundamental.
 * Quantising it would put the quantiser's own error into both. The CAPTURE
 * side has the same requirement for the same reason, which is why every
 * protocol doc asks for a 32-bit float bounce.
 */

import { writeFileSync } from 'node:fs'

export { readWav } from '../../test/voicerx/wav.js'

/**
 * @param {string} path
 * @param {Float32Array|Float64Array|number[]} samples - mono
 * @param {number} sampleRate
 */
export function writeFloatWav(path, samples, sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`writeFloatWav: bad sample rate ${sampleRate}`)
  }
  const n = samples.length
  const fmtSize = 18
  const factSize = 4
  const dataSize = n * 4
  const buf = Buffer.alloc(12 + (8 + fmtSize) + (8 + factSize) + (8 + dataSize))
  let o = 0
  buf.write('RIFF', o); o += 4
  buf.writeUInt32LE(buf.length - 8, o); o += 4
  buf.write('WAVE', o); o += 4

  buf.write('fmt ', o); o += 4
  buf.writeUInt32LE(fmtSize, o); o += 4
  buf.writeUInt16LE(3, o); o += 2 // WAVE_FORMAT_IEEE_FLOAT
  buf.writeUInt16LE(1, o); o += 2 // mono
  buf.writeUInt32LE(sampleRate, o); o += 4
  buf.writeUInt32LE(sampleRate * 4, o); o += 4 // byte rate
  buf.writeUInt16LE(4, o); o += 2 // block align
  buf.writeUInt16LE(32, o); o += 2 // bits per sample
  buf.writeUInt16LE(0, o); o += 2 // cbSize

  buf.write('fact', o); o += 4
  buf.writeUInt32LE(factSize, o); o += 4
  buf.writeUInt32LE(n, o); o += 4

  buf.write('data', o); o += 4
  buf.writeUInt32LE(dataSize, o); o += 4
  for (let i = 0; i < n; i++) { buf.writeFloatLE(samples[i], o); o += 4 }

  writeFileSync(path, buf)
}
