/**
 * Tests for the Noise Reduction plugin's server half (pipeline/spotNoiseReduce.js).
 *
 * The models are stubbed — each halves what it is given and records how it was
 * called — so this exercises the plumbing around them for real (ffmpeg decode,
 * per-channel split, consonant-guard mask, resample back, length match) without
 * Python. What the models do to the audio is theirs, not this module's.
 *
 * Run with:  cd server && node --test test/spotNoiseReduce.test.js
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'fs/promises'
import path from 'path'
import { tempPath, removeTmp } from '../lib/ffmpeg.js'
import { readWavAllChannels } from '../pipeline/wavReader.js'
import { writeWavChannels } from '../pipeline/wavWriter.js'
import { runSpotNoiseReduction, SPOT_RNNOISE_VAD_GATE } from '../pipeline/spotNoiseReduce.js'

const TEMP_FILES = []

before(async () => {
  await mkdir(path.dirname(tempPath()), { recursive: true })
})

after(async () => {
  await Promise.all(TEMP_FILES.map(removeTmp))
})

function sine(n, rate, hz, amp) {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate)
  return x
}

async function writeInput(channels, rate) {
  const p = tempPath('.wav')
  TEMP_FILES.push(p)
  await writeWavChannels(channels, rate, p)
  return p
}

function stubs() {
  const calls = { df3: [], rnnoise: [], vad: 0, order: [] }
  const halve = (name) => async (input, output, opts) => {
    calls[name].push(opts)
    calls.order.push(name)
    const { channels, sampleRate } = await readWavAllChannels(input)
    assert.equal(channels.length, 1, `${name} must be handed mono`)
    assert.equal(sampleRate, 44100, `${name} must be handed 44.1 kHz`)
    await writeWavChannels([channels[0].map(s => s * 0.5)], 44100, output)
  }
  return {
    calls,
    deps: {
      df3: halve('df3'),
      rnnoise: halve('rnnoise'),
      vadFrames: async () => { calls.vad++; return [{ isSilence: false }] },
    },
  }
}

function rms(x, from = 0, to = x.length) {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / (to - from))
}

test('DF3 alone: each channel denoised on its own, the level left as the model returned it', async () => {
  const n = 44100
  const left = sine(n, 44100, 220, 0.5)
  const right = sine(n, 44100, 330, 0.25)
  const input = await writeInput([left, right], 44100)
  const output = tempPath('.wav'); TEMP_FILES.push(output)
  const { calls, deps } = stubs()

  const summary = await runSpotNoiseReduction(input, output, { engine: 'df3', df3AttenLimDb: 12 }, deps)

  assert.deepEqual(calls.order, ['df3', 'df3'])
  assert.deepEqual(calls.df3, [{ attenLimDb: 12 }, { attenLimDb: 12 }])
  assert.equal(calls.vad, 0, 'no Silero pass without RNNoise')
  assert.equal(summary.channels, 2)

  const out = await readWavAllChannels(output)
  assert.equal(out.sampleRate, 44100)
  assert.equal(out.numChannels, 2)
  assert.equal(out.numSamples, n)
  // Halved by the stub and not re-normalised afterwards; L and R not mixed.
  for (let i = 0; i < n; i += 997) {
    assert.ok(Math.abs(out.channels[0][i] - left[i] * 0.5) < 1e-6)
    assert.ok(Math.abs(out.channels[1][i] - right[i] * 0.5) < 1e-6)
  }
})

test('Both: DF3 then RNNoise, one speech mask shared by every channel', async () => {
  const n = 22050
  const input = await writeInput([sine(n, 44100, 200, 0.4), sine(n, 44100, 200, 0.4)], 44100)
  const output = tempPath('.wav'); TEMP_FILES.push(output)
  const { calls, deps } = stubs()

  await runSpotNoiseReduction(input, output, { engine: 'both', df3AttenLimDb: null, protectConsonants: true }, deps)

  assert.deepEqual(calls.order, ['df3', 'rnnoise', 'df3', 'rnnoise'])
  assert.equal(calls.vad, 1)
  for (const c of calls.rnnoise) {
    assert.deepEqual(c.sileroFrames, [{ isSilence: false }])
    assert.deepEqual(c.vadGate, SPOT_RNNOISE_VAD_GATE)
  }
  assert.deepEqual(calls.df3[0], { attenLimDb: null })
  const out = await readWavAllChannels(output)
  assert.ok(Math.abs(rms(out.channels[0]) - 0.4 * 0.25 / Math.SQRT2) < 1e-3)
})

test('RNNoise without the consonant guard runs no Silero pass and passes no gate', async () => {
  const input = await writeInput([sine(8820, 44100, 200, 0.4)], 44100)
  const output = tempPath('.wav'); TEMP_FILES.push(output)
  const { calls, deps } = stubs()

  await runSpotNoiseReduction(input, output, { engine: 'rnnoise', protectConsonants: false }, deps)

  assert.deepEqual(calls.order, ['rnnoise'])
  assert.equal(calls.vad, 0)
  assert.deepEqual(calls.rnnoise[0], { sileroFrames: null, vadGate: null })
})

test('a 48 kHz upload comes back at 48 kHz and its own length', async () => {
  const n = 48000
  const input = await writeInput([sine(n, 48000, 150, 0.5)], 48000)
  const output = tempPath('.wav'); TEMP_FILES.push(output)
  const { deps } = stubs()

  await runSpotNoiseReduction(input, output, { engine: 'df3' }, deps)

  const out = await readWavAllChannels(output)
  assert.equal(out.sampleRate, 48000)
  assert.ok(Math.abs(out.numSamples - n) <= 2, `length ${out.numSamples} vs ${n}`)
  // Away from the edges, the round trip through 44.1 kHz is the stub's halving.
  const mid = Math.floor(n / 2)
  assert.ok(Math.abs(rms(out.channels[0], mid - 4800, mid + 4800) - 0.25 / Math.SQRT2) < 2e-3)
})

test('a model whose output runs long or short is fitted to the input length', async () => {
  const n = 10000
  const input = await writeInput([sine(n, 44100, 200, 0.4)], 44100)
  const output = tempPath('.wav'); TEMP_FILES.push(output)
  const deps = {
    df3: async (inPath, outPath) => {
      const { channels } = await readWavAllChannels(inPath)
      const longer = new Float32Array(channels[0].length + 37)
      longer.set(channels[0])
      await writeWavChannels([longer], 44100, outPath)
    },
  }
  await runSpotNoiseReduction(input, output, { engine: 'df3' }, deps)
  assert.equal((await readWavAllChannels(output)).numSamples, n)
})

test('bad params are refused before any model runs', async () => {
  const input = await writeInput([sine(4410, 44100, 200, 0.4)], 44100)
  const { calls, deps } = stubs()
  await assert.rejects(
    runSpotNoiseReduction(input, tempPath('.wav'), { engine: 'nope' }, deps),
    /engine/,
  )
  assert.deepEqual(calls.order, [])
})
