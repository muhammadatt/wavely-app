/**
 * Run with:  npm test
 *
 * PHAT*SS parallel apply (phatassChunks.js): chunks rendered from their own
 * run-in and laid end to end must be the continuous render.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkCount, planChunks, RENDER_BLOCK, MIN_CHUNK_S, MAX_CHUNK_WORKERS } from '../../src/audio/phatassChunks.js'
import { renderPhatassChunk } from '../../src/audio/phatassChunkRender.js'
import { processPhatassBuffer } from '../../src/audio/phatassProcessor.js'
import { toKernelParams, phatassLatencySamples, WARMTH_LAYERS } from '../../src/audio/phatassParams.js'

const SR = 44100
const db = x => 20 * Math.log10(x)

/** 48 s of syllable-like bursts over a wandering low tone, bright enough to work the tape HF shelf. */
function material(seconds = 48) {
  const n = seconds * SR
  const x = new Float32Array(n)
  let r = 5
  const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647 }
  let env = 0, target = 0
  for (let i = 0; i < n; i++) {
    if (i % 6000 === 0) target = rnd() < 0.7 ? 0.2 + 0.6 * rnd() : 0
    env += (target - env) * 0.002
    const t = i / SR
    x[i] = env * (0.5 * Math.sin(2 * Math.PI * (110 + 20 * Math.sin(t)) * t) + 0.25 * (rnd() * 2 - 1) + 0.2 * Math.sin(2 * Math.PI * 7000 * t))
  }
  return x
}

function stitched(x, kp, preRoll, count) {
  const latency = phatassLatencySamples(SR)
  const numSamples = x.length - preRoll - latency
  const plan = planChunks(numSamples, preRoll, latency, SR, count)
  const out = new Float32Array(numSamples)
  for (const c of plan) {
    const input = new Float32Array(c.to - c.from)
    input.set(x.subarray(c.from, Math.min(c.to, x.length)))
    out.set(renderPhatassChunk([input], SR, kp, c.skip, c.length)[0], c.start)
  }
  return { out, plan, numSamples, latency }
}

test('chunk count: one per 15 s, cores − 1, at most 8; short regions stay whole', () => {
  assert.equal(chunkCount(10 * SR, SR, 8), 1)
  assert.equal(chunkCount(MIN_CHUNK_S * SR * 3, SR, 8), 3)
  assert.equal(chunkCount(600 * SR, SR, 4), 3)
  assert.equal(chunkCount(600 * SR, SR, 64), MAX_CHUNK_WORKERS)
  assert.equal(chunkCount(600 * SR, SR, 1), 1)
})

test('the plan covers the region exactly, every chunk starts on the continuous render\'s block grid', () => {
  const plan = planChunks(1_000_003, 44100, 182, SR, 5)
  assert.equal(plan[0].from, 0)
  assert.equal(plan[0].skip, 44100)
  let at = 0
  for (const c of plan) {
    assert.equal(c.start, at)
    at += c.length
    assert.equal(c.from % RENDER_BLOCK, 0)
    assert.equal(c.from + c.skip, 44100 + c.start)
    assert.equal(c.to, 44100 + c.start + c.length + 182)
  }
  assert.equal(at, 1_000_003)
})

for (const [name, p, floorDb] of [
  ['CLEAN, Warmth and TAPE up, 7.5 ips', { warmth: 8, tape: 8, hf: 'ips7' }, -120],
  ['THICK (the loop\'s memory outlasts any run-in)', { warmth: 5, tape: 8, tapeCurve: 'hysteresis' }, -70],
]) {
  test(`chunks stitch into the continuous render: ${name}`, () => {
    const x = material()
    let pk = 0
    for (const v of x) pk = Math.max(pk, Math.abs(v))
    const kp = toKernelParams({ ...p, voiceLevelDb: -20, warmthCeilingDb: db(pk), warmthRefPeaksDb: WARMTH_LAYERS.map(() => -10), tapeMakeupDb: 3 })
    const preRoll = SR // the region starts 1 s into x
    const { out, numSamples, latency } = stitched(x, kp, preRoll, 3)
    const whole = processPhatassBuffer([x], SR, kp).channelData[0].subarray(preRoll + latency, preRoll + latency + numSamples)
    let worst = 0
    for (let i = 0; i < numSamples; i++) worst = Math.max(worst, Math.abs(out[i] - whole[i]))
    assert.ok(db(worst / pk) < floorDb, `worst seam difference ${db(worst / pk).toFixed(1)} dB re peak`)
  })
}
