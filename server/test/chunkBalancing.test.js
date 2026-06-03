/**
 * Tests for concurrency-aware chunk balancing in planChunkBoundaries.
 *
 * The planner nudges the chunk count to a multiple of the parallel slot count
 * (concurrencyHint) so every dispatch wave is full — no idle-worker "overhang"
 * (e.g. 3 chunks on 2 slots wastes ~half a wave). These tests drive the pure
 * planner directly with synthetic frame arrays (no FFmpeg / audio), asserting
 * the realised chunk count comes out as a multiple of the hint, that it falls
 * back safely when no balanced count fits the duration rails, and that the
 * default (hint ≤ 1) path is unchanged.
 *
 * Run with:  cd server && npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planChunkBoundaries } from '../pipeline/chunking.js'

const SR        = 44100
const FRAME_LEN = Math.round(0.025 * SR)  // 25 ms frame

/**
 * Build a frame array spanning `durationS` seconds with a `silenceDurS`-long
 * silence window every `silenceEveryS` seconds, giving the planner regular,
 * qualifying split candidates.
 */
function makeFrames(durationS, { silenceEveryS = 30, silenceDurS = 1 } = {}) {
  const n = Math.floor((durationS * SR) / FRAME_LEN)
  const frames = []
  for (let i = 0; i < n; i++) {
    const offsetSamples = i * FRAME_LEN
    const t = offsetSamples / SR
    const phase = t % silenceEveryS
    const isSilence = phase >= (silenceEveryS - silenceDurS)
    frames.push({
      index: i,
      offsetSamples,
      lengthSamples: FRAME_LEN,
      isSilence,
      rmsDbfs: isSilence ? -90 : -10,
    })
  }
  return { frames, totalSamples: n * FRAME_LEN }
}

function plan(durationS, options) {
  const { frames, totalSamples } = makeFrames(durationS)
  return planChunkBoundaries({ frames, sampleRate: SR, totalSamples, options })
}

test('baseline (no hint) leaves an odd chunk count that would overhang on 2 slots', () => {
  // 360 s at the 120 s target → 3 chunks. 3 on 2 slots is the overhang case
  // the balancing exists to fix; this pins the pre-balancing behaviour.
  const p = plan(360, {})
  assert.equal(p.chunks.length, 3, `expected 3 baseline chunks, got ${p.chunks.length}`)
  assert.equal(p.balancedChunkCount, null, 'no hint → no balancing')
})

test('concurrencyHint=2 rounds the count up to an even number of chunks', () => {
  const p = plan(360, { concurrencyHint: 2 })
  assert.equal(p.chunks.length % 2, 0,
    `expected an even chunk count for concurrency 2, got ${p.chunks.length}`)
  assert.equal(p.balancedChunkCount, 4, `expected balanced target of 4, got ${p.balancedChunkCount}`)
  assert.equal(p.chunks.length, 4)
})

test('concurrencyHint=3 keeps the already-aligned count of 3', () => {
  const p = plan(360, { concurrencyHint: 3 })
  assert.equal(p.chunks.length % 3, 0,
    `expected a multiple of 3, got ${p.chunks.length}`)
  assert.equal(p.balancedChunkCount, 3)
  assert.equal(p.chunks.length, 3)
})

test('concurrencyHint=4 produces four chunks (one full wave)', () => {
  const p = plan(360, { concurrencyHint: 4 })
  assert.equal(p.chunks.length % 4, 0,
    `expected a multiple of 4, got ${p.chunks.length}`)
  assert.equal(p.balancedChunkCount, 4)
})

test('falls back to plain target when no balanced count fits the duration rails', () => {
  // 360 s with minChunk 30 s → at most 12 chunks. A hint of 13 cannot be
  // honoured (one full wave would bust the minimum), so balancing returns null
  // and the planner uses the raw 120 s target → the same 3 chunks as the
  // baseline. (The old 60 s floor would have made hint=7 sufficient to trigger
  // this case; the new 30 s floor requires a larger hint to exceed maxCount.)
  const p = plan(360, { concurrencyHint: 13 })
  assert.equal(p.balancedChunkCount, null, 'no fitting multiple → null')
  assert.equal(p.chunks.length, 3, 'fallback matches the concurrency-unaware plan')
})

test('hint=1 is a no-op identical to omitting it', () => {
  const withHint    = plan(360, { concurrencyHint: 1 })
  const withoutHint = plan(360, {})
  assert.equal(withHint.balancedChunkCount, null)
  assert.equal(withHint.chunks.length, withoutHint.chunks.length)
})

test('lowered 30 s minimum lets short files balance at higher concurrencies', () => {
  // Both cases were measured drifting off the multiple under the old 60 s floor
  // (the implied per-chunk duration grazed the rail and the silence-snap loop
  // overshot). At the new 30 s floor each chunk sits comfortably above the
  // overhead-amortisation floor and balancing realises the target count.
  const p200c3 = plan(200, { concurrencyHint: 3 })
  assert.equal(p200c3.balancedChunkCount, 3,
    `200 s @ c=3: expected balanced count of 3, got ${p200c3.chunks.length}`)
  assert.equal(p200c3.chunks.length % 3, 0)

  const p300c4 = plan(300, { concurrencyHint: 4 })
  assert.equal(p300c4.balancedChunkCount, 4,
    `300 s @ c=4: expected balanced count of 4, got ${p300c4.chunks.length}`)
  assert.equal(p300c4.chunks.length % 4, 0)
})

test('balanced chunk counts respect the min/max duration rails', () => {
  // Sweep a range of lengths and concurrencies; whenever balancing fires, the
  // resulting chunks must all sit within [min, max] and the count must be a
  // multiple of the hint.
  for (const durationS of [200, 300, 360, 480, 600, 900]) {
    for (const concurrency of [2, 3, 4]) {
      const p = plan(durationS, { concurrencyHint: concurrency })
      if (p.balancedChunkCount == null) continue  // fell back — nothing to assert here
      assert.equal(p.chunks.length % concurrency, 0,
        `dur=${durationS}s c=${concurrency}: count ${p.chunks.length} not a multiple of ${concurrency}`)
      for (const c of p.chunks) {
        const durS = (c.endSample - c.startSample) / SR
        assert.ok(durS >= 30 - 1 && durS <= 600 + 1,
          `dur=${durationS}s c=${concurrency}: chunk of ${durS.toFixed(1)}s out of [30,600] rails`)
      }
    }
  }
})
