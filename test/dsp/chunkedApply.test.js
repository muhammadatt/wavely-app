/**
 * Run with:  npm test
 *
 * Parallel apply (chunkedApply.js / chunkRender.js): chunks rendered from
 * their own run-in and laid end to end must be the continuous render, for
 * every plugin that opts in. `stitch` below is applyChunkedRegion's arithmetic
 * with the worker replaced by a direct call to the worker's own function.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunkCount, planChunks, RENDER_BLOCK, MIN_CHUNK_S, MAX_CHUNK_WORKERS,
  RESONANCE_CHUNK_RUN_IN_S, SAT_BENCH_CHUNK_RUN_IN_S, HF_SOFTENER_CHUNK_RUN_IN_S,
} from '../../src/audio/chunkedApply.js'
import { renderChunk, CHUNK_RENDERERS } from '../../src/audio/chunkRender.js'
import { toKernelParams as toPhatassKernelParams, phatassLatencySamples, WARMTH_LAYERS } from '../../src/audio/phatassParams.js'
import { LA2A_DEFAULTS, la2aPatchLatencySamples, toKernelParams as toLA2AKernelParams } from '../../src/audio/effects/la2aParams.js'
import { LA2A_PREROLL_S } from '../../src/audio/la2aProcessor.js'
import { SCHEPS_DEFAULTS, SCHEPS_LATENCY_SAMPLES, toKernelParams as toSchepsKernelParams } from '../../src/audio/effects/schepsParams.js'
import { SCHEPS_PREROLL_S } from '../../src/audio/schepsProcessor.js'
import { FET1176_DEFAULTS, FET1176_LATENCY_SAMPLES, toKernelParams as toFETKernelParams } from '../../src/audio/effects/fet1176Params.js'
import { FET1176_PREROLL_S } from '../../src/audio/fet1176Processor.js'
import {
  RESONANCE_DEFAULTS, RESONANCE_FRAME_SIZE, resonanceHopSamples, toKernelParams as toResonanceKernelParams,
} from '../../src/audio/resonanceParams.js'
import { ResonanceKernel } from '../../src/audio/resonanceProcessor.js'
import { SATURATION_BENCH_DEFAULTS, toKernelParams as toSatBenchKernelParams } from '../../src/audio/saturationBenchParams.js'
import { SAT_BENCH_LATENCY_SAMPLES } from '../../src/audio/saturationBenchProcessor.js'
import {
  HF_SOFTENER_DEFAULTS, toKernelParams as toHFSoftenerKernelParams,
  resoKernelParams, softenStageKernelParams,
} from '../../src/audio/hfSoftenerParams.js'
import { HF_RESO_FRAME_SIZE, HF_RESO_LATENCY_SAMPLES } from '../../src/audio/hfSoftenerResoStage.js'
import { softenLatencySamples } from '../../src/audio/hfSoftenerSoftenStage.js'
import { HF_SOFTENER_PREROLL_S } from '../../src/audio/hfSoftenerProcessor.js'

const SR = 44100
const db = x => 20 * Math.log10(x)

/**
 * 48 s of syllable-like bursts over a wandering low tone, with noise and a
 * 7 kHz partial so the top-end plugins have something to work on, and a loud
 * stretch then a quiet one so every release has somewhere to travel.
 */
function material(seconds = 48, seed = 5) {
  const n = seconds * SR
  const x = new Float32Array(n)
  let r = seed
  const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647 }
  let env = 0, target = 0
  for (let i = 0; i < n; i++) {
    if (i % 6000 === 0) target = rnd() < 0.7 ? 0.2 + 0.6 * rnd() : 0
    env += (target - env) * 0.002
    const t = i / SR
    const phrase = Math.sin(2 * Math.PI * t / 13) > -0.3 ? 1 : 0.15
    x[i] = phrase * env * (0.5 * Math.sin(2 * Math.PI * (110 + 20 * Math.sin(t)) * t) + 0.25 * (rnd() * 2 - 1) + 0.2 * Math.sin(2 * Math.PI * 7000 * t))
  }
  return x
}

/** Render a chain over a whole input, as the one-thread worklet graph would. */
function renderChain(channels, stages) {
  let data = channels
  for (const st of stages) data = CHUNK_RENDERERS[st.renderer](data, SR, st.kernelParams, st.options).channelData
  return data
}

/**
 * Stitched against continuous, worst sample difference in dB re the peak.
 * The region starts `preRoll` into `xs`; `xs` carries `latency` past its end.
 */
function seamDb(xs, stages, { preRoll, latency, count = 3, runInS, grid }) {
  const numSamples = xs[0].length - preRoll - latency
  const plan = planChunks(numSamples, preRoll, latency, SR, count, { runInS, grid })
  const whole = renderChain(xs.map(c => c.slice()), stages)
  let worst = 0, pk = 0
  for (const c of plan) {
    const input = xs.map(src => src.slice(c.from, c.to))
    assert.ok(c.to <= xs[0].length)
    const part = renderChunk(input, SR, { stages, latency, skip: c.skip, length: c.length })
    for (let ch = 0; ch < xs.length; ch++) {
      for (let i = 0; i < c.length; i++) {
        const ref = whole[ch][preRoll + latency + c.start + i]
        worst = Math.max(worst, Math.abs(part[ch][i] - ref))
        pk = Math.max(pk, Math.abs(ref))
      }
    }
  }
  return worst === 0 ? -Infinity : db(worst / pk)
}

const stereo = () => [material(48, 5), material(48, 11)]

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

// ── What each plugin stitches to ───────────────────────────────────────────
//
// Each case is the plugin as applyRegion wires it (kernel params from its
// defaults, its latency, its run-in, its grid) on 48 s of stereo, with the
// region starting 2 s in so the pre-roll is exercised too. The floor is a
// little above what was measured, so a regression is a real one.

function phatassCase(p) {
  return () => {
    const x = material()
    let pk = 0
    for (const v of x) pk = Math.max(pk, Math.abs(v))
    const kp = toPhatassKernelParams({ ...p, voiceLevelDb: -20, warmthCeilingDb: db(pk), warmthRefPeaksDb: WARMTH_LAYERS.map(() => -10), tapeMakeupDb: 3 })
    return { xs: [x], stages: [{ renderer: 'phatass', kernelParams: kp }], latency: phatassLatencySamples(SR), runInS: 1 }
  }
}

function hfSoftenerCase(extra) {
  return () => {
    const merged = { ...HF_SOFTENER_DEFAULTS, ...extra }
    const stages = [{ renderer: 'hfSoftener', kernelParams: toHFSoftenerKernelParams(merged) }]
    let latency = 0
    if (merged.resoAmount > 0) {
      stages.push({ renderer: 'resonance', kernelParams: resoKernelParams(merged), options: { frameSize: HF_RESO_FRAME_SIZE } })
      latency += HF_RESO_LATENCY_SAMPLES
    }
    if (merged.soften > 0) {
      stages.push({ renderer: 'hfLimiter', kernelParams: softenStageKernelParams(merged) })
      latency += softenLatencySamples(SR)
    }
    return {
      xs: stereo(), stages, latency,
      preRoll: HF_SOFTENER_PREROLL_S * SR,
      runInS: HF_SOFTENER_CHUNK_RUN_IN_S,
      grid: merged.resoAmount > 0 ? resonanceHopSamples(HF_RESO_FRAME_SIZE) : undefined,
    }
  }
}

const CASES = [
  ['PHAT*SS CLEAN, Warmth and TAPE up, 7.5 ips', phatassCase({ warmth: 8, tape: 8, hf: 'ips7' }), -120],
  ['PHAT*SS THICK (the loop\'s memory outlasts any run-in)', phatassCase({ warmth: 5, tape: 8, tapeCurve: 'hysteresis' }), -70],
  ['ResoTame, on its hop grid', () => ({
    xs: stereo(),
    stages: [{ renderer: 'resonance', kernelParams: toResonanceKernelParams(RESONANCE_DEFAULTS) }],
    latency: RESONANCE_FRAME_SIZE, preRoll: 0,
    runInS: RESONANCE_CHUNK_RUN_IN_S, grid: resonanceHopSamples(RESONANCE_FRAME_SIZE),
  }), -120],
  ['Saturation Bench, factory layers', () => ({
    xs: stereo(),
    stages: [{ renderer: 'saturationBench', kernelParams: toSatBenchKernelParams(SATURATION_BENCH_DEFAULTS) }],
    latency: SAT_BENCH_LATENCY_SAMPLES, runInS: SAT_BENCH_CHUNK_RUN_IN_S,
  }), -120],
  ['Scheps Parallel', () => ({
    xs: stereo(),
    stages: [{ renderer: 'scheps', kernelParams: toSchepsKernelParams(SCHEPS_DEFAULTS) }],
    latency: SCHEPS_LATENCY_SAMPLES, preRoll: SCHEPS_PREROLL_S * SR, runInS: SCHEPS_PREROLL_S,
  }), -120],
  ['OptoSmooth at Peak Reduction 70', () => {
    const merged = { ...LA2A_DEFAULTS, peakReduction: 70 }
    return {
      xs: stereo(),
      stages: [{ renderer: 'la2a', kernelParams: toLA2AKernelParams(merged) }],
      latency: la2aPatchLatencySamples(merged, SR), preRoll: LA2A_PREROLL_S * SR, runInS: LA2A_PREROLL_S,
    }
  }, -120],
  ['HF Softener, defaults', hfSoftenerCase({}), -120],
  ['HF Softener, Soften 6', hfSoftenerCase({ soften: 6 }), -120],
  ['HF Softener, Reso and Soften', hfSoftenerCase({ soften: 6, resoAmount: 50 }), -120],
  ['FET Punch at Input 70', () => ({
    xs: stereo(),
    stages: [{ renderer: 'fet1176', kernelParams: toFETKernelParams({ ...FET1176_DEFAULTS, input: 70 }) }],
    latency: FET1176_LATENCY_SAMPLES, preRoll: FET1176_PREROLL_S * SR, runInS: FET1176_PREROLL_S,
  }), -120],
]

for (const [name, build, floorDb] of CASES) {
  test(`chunks stitch into the continuous render: ${name}`, () => {
    const { xs, stages, latency, preRoll = 2 * SR, runInS, grid } = build()
    const got = seamDb(xs, stages, { preRoll, latency, runInS, grid })
    assert.ok(got < floorDb, `worst seam difference ${got.toFixed(1)} dB re peak (floor ${floorDb})`)
  })
}

test('⚠ ResoTame cut on the render-block grid alone does NOT stitch — the hop grid is load-bearing', () => {
  const got = seamDb(stereo(), [{ renderer: 'resonance', kernelParams: toResonanceKernelParams(RESONANCE_DEFAULTS) }], {
    preRoll: 0, latency: RESONANCE_FRAME_SIZE, runInS: RESONANCE_CHUNK_RUN_IN_S + 0.01, grid: RENDER_BLOCK,
  })
  assert.ok(got > -60, `off the hop grid the chunks should disagree audibly; got ${got.toFixed(1)} dB re peak`)
})
