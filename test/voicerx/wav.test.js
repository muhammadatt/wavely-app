/**
 * Run with:  npm test
 *
 * The WAV reader decodes four sample formats, and every branch of it can fail
 * SILENTLY. A 24-bit sign-extension that drops the sign gives audio that is
 * merely wrong rather than absent, and the first symptom would be a detector
 * reporting nonsense about a corpus file with no error anywhere. These write a
 * known ramp through each format and check it comes back.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWav } from './wav.js'

/** Minimal WAV writer, test-only — the reader is the thing under test. */
function writeWav(path, channels, sampleRate, { bitDepth = 16, float = false } = {}) {
  const bytes = float ? 4 : bitDepth / 8
  const frames = channels[0].length
  const chCount = channels.length
  const dataLen = frames * chCount * bytes
  const buf = Buffer.alloc(44 + dataLen)

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(float ? 3 : 1, 20)
  buf.writeUInt16LE(chCount, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * chCount * bytes, 28)
  buf.writeUInt16LE(chCount * bytes, 32)
  buf.writeUInt16LE(float ? 32 : bitDepth, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataLen, 40)

  let o = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < chCount; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]))
      if (float) {
        buf.writeFloatLE(v, o)
        o += 4
      } else if (bytes === 2) {
        buf.writeInt16LE(Math.round(v * 32767), o)
        o += 2
      } else if (bytes === 3) {
        const x = Math.round(v * 8388607)
        buf[o] = x & 255
        buf[o + 1] = (x >> 8) & 255
        buf[o + 2] = (x >> 16) & 255
        o += 3
      } else {
        buf.writeInt32LE(Math.round(v * 2147483647), o)
        o += 4
      }
    }
  }
  writeFileSync(path, buf)
}

/** A ramp through the full range, so a sign error cannot hide in the positives. */
function ramp(n) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (i / (n - 1)) * 2 - 1
  return out
}

test('every sample format round-trips, negatives included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wav-'))
  try {
    const signal = ramp(512)

    for (const format of [
      { name: '16', bitDepth: 16, tolerance: 1 / 32768 },
      { name: '24', bitDepth: 24, tolerance: 1 / 8388608 },
      { name: '32', bitDepth: 32, tolerance: 1 / 2147483648 },
      { name: 'f32', float: true, tolerance: 1e-7 },
    ]) {
      const path = join(dir, `${format.name}.wav`)
      writeWav(path, [signal], 44100, format)
      const { mono, sampleRate, channels, seconds } = readWav(path)

      assert.equal(sampleRate, 44100, format.name)
      assert.equal(channels, 1, format.name)
      assert.equal(mono.length, signal.length, format.name)
      assert.ok(Math.abs(seconds - 512 / 44100) < 1e-9, format.name)

      for (let i = 0; i < signal.length; i++) {
        assert.ok(
          Math.abs(mono[i] - signal[i]) <= format.tolerance * 2,
          `${format.name}-bit sample ${i}: wrote ${signal[i]}, read ${mono[i]}`,
        )
      }
      // The half that a dropped sign extension would destroy.
      assert.ok(mono[0] < -0.99, `${format.name}: negative range lost`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stereo is mixed to mono, not truncated to one channel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wav-'))
  try {
    const left = new Float32Array([1, 1, 1, 1])
    const right = new Float32Array([-1, -1, 0, 0])
    const path = join(dir, 'stereo.wav')
    writeWav(path, [left, right], 48000, { bitDepth: 24 })

    const { mono, channels, sampleRate } = readWav(path)
    assert.equal(channels, 2)
    assert.equal(sampleRate, 48000)
    assert.equal(mono.length, 4)
    // Taking channel 0 alone would give 1 here; the mean is what is wanted.
    assert.ok(Math.abs(mono[0] - 0) < 1e-5, `expected the mean, got ${mono[0]}`)
    assert.ok(Math.abs(mono[2] - 0.5) < 1e-5, `expected the mean, got ${mono[2]}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file that is not a WAV is refused rather than misread', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wav-'))
  try {
    const path = join(dir, 'bogus.wav')
    writeFileSync(path, Buffer.from('this is not audio at all, not even close'))
    assert.throws(() => readWav(path), /RIFF\/WAVE/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
