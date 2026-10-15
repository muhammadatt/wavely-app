/**
 * Run with:  npm test
 *
 * Parallel apply (chunkedApply.js / chunkRender.js): the planner, and every
 * chunked plugin stitched against its continuous render on the first test
 * material. The other materials are chunkedApplyGaps.test.js and
 * chunkedApplyPhrased.test.js; the shared harness is chunkStitch.js.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunkCount, planChunks, RENDER_BLOCK, MIN_CHUNK_S, MAX_CHUNK_WORKERS, CHUNK_RUN_IN_S,
} from '../../src/audio/chunkedApply.js'
import { renderChunk } from '../../src/audio/chunkRender.js'
import { RESONANCE_DEFAULTS, RESONANCE_FRAME_SIZE, resonanceHopSamples, toKernelParams as toResonanceKernelParams } from '../../src/audio/resonanceParams.js'
import { ResonanceKernel } from '../../src/audio/resonanceProcessor.js'
import { HF_RESO_FRAME_SIZE } from '../../src/audio/hfSoftenerResoStage.js'
import { MATERIALS, PLUGINS, SEAM_FLOOR_DBFS, seamDbfs } from './chunkStitch.js'

const SR = 44100

test('chunk count: one per 15 s, cores − 1, at most 8; short regions stay whole', () => {
  assert.equal(chunkCount(10 * SR, SR, 8), 1)
  assert.equal(chunkCount(MIN_CHUNK_S * SR * 3, SR, 8), 3)
  assert.equal(chunkCount(600 * SR, SR, 4), 3)
  assert.equal(chunkCount(600 * SR, SR, 64), MAX_CHUNK_WORKERS)
  assert.equal(chunkCount(600 * SR, SR, 1), 1)
})

for (const grid of [RENDER_BLOCK, 512]) {
  test(`the plan covers the region exactly, every chunk starts on the ${grid}-sample grid`, () => {
    const plan = planChunks(1_000_003, 44100, 182, SR, 5, { grid })
    assert.equal(plan[0].from, 0)
    assert.equal(plan[0].skip, 44100)
    let at = 0
    for (const c of plan) {
      assert.equal(c.start, at)
      at += c.length
      assert.equal(c.from % grid, 0)
      assert.equal(c.from + c.skip, 44100 + c.start)
      const end = 44100 + c.start + c.length + 182
      assert.ok(c.to >= end && c.to - end < RENDER_BLOCK)
      assert.ok(c.to % RENDER_BLOCK === 0 || c.to === 44100 + 1_000_003 + 182)
    }
    assert.equal(at, 1_000_003)
  })
}

test('a grid that is not a multiple of the render block is refused', () => {
  assert.throws(() => planChunks(SR * 60, 0, 0, SR, 3, { grid: 100 }), /multiple of 128/)
})

test('ResoTame\'s chunk grid is its kernel\'s own hop', () => {
  for (const frameSize of [RESONANCE_FRAME_SIZE, HF_RESO_FRAME_SIZE]) {
    assert.equal(resonanceHopSamples(frameSize), new ResonanceKernel(SR, { frameSize }).hopSize)
  }
})

test('the worker refuses a renderer it does not know (Tube Saturation is not chunked)', () => {
  assert.throws(() => renderChunk([new Float32Array(256)], SR, {
    stages: [{ renderer: 'vocalSat', kernelParams: {} }], latency: 0, skip: 0, length: 128,
  }), /no chunk renderer/)
})

for (const [name, build] of PLUGINS) {
  test(`chunks stitch into the continuous render (bursts): ${name}`, () => {
    const mat = MATERIALS.bursts()
    const got = seamDbfs(mat, build(mat.xs))
    assert.ok(got < SEAM_FLOOR_DBFS, `worst seam difference ${got.toFixed(1)} dBFS (floor ${SEAM_FLOOR_DBFS})`)
  })
}

test('⚠ ResoTame cut on the render-block grid alone does NOT stitch — the hop grid is load-bearing', () => {
  const mat = MATERIALS.bursts()
  const reso = {
    stages: [{ renderer: 'resonance', kernelParams: toResonanceKernelParams(RESONANCE_DEFAULTS) }],
    latency: RESONANCE_FRAME_SIZE, preRollS: 0, grid: RENDER_BLOCK,
  }
  const got = seamDbfs(mat, reso, { runInS: CHUNK_RUN_IN_S + 0.01 })
  assert.ok(got > -60, `off the hop grid the chunks should disagree audibly; got ${got.toFixed(1)} dBFS`)
})

// RETIRED: "ResoTame's memory needs the long run-in even on this material"
// asserted that a 2 s run-in still left an audible seam (> −100 dBFS). It
// pinned the old 200/500 ms ballistics; at the 50/200 ms defaults ResoTame
// settles within 2 s (−132.5 dBFS), so its premise no longer holds. The 6 s
// shared run-in stays, and the stitch tests above still hold it to the floor.
