/**
 * Shared by the chunkedApply*.test.js files: the test materials, every chunked
 * plugin wired as applyRegion wires it, and the stitch-vs-continuous
 * measurement. Split across files only so node --test runs the materials in
 * parallel.
 *
 * `seamDbfs` is applyChunkedRegion's arithmetic with the worker replaced by a
 * direct call to the worker's own function, compared against one continuous
 * render of the same chain. The figure is ABSOLUTE (dBFS), because what
 * matters is whether a seam can be heard or survives a 16-bit export (one LSB
 * is −90.3 dBFS), not how it compares to the material's peak.
 */

import assert from 'node:assert/strict'
import { planChunks } from '../../src/audio/chunkedApply.js'
import { renderChunk, CHUNK_RENDERERS } from '../../src/audio/chunkRender.js'
import { toKernelParams as toPhatassKernelParams, phatassLatencySamples, PHATASS_PREROLL_S, WARMTH_LAYERS } from '../../src/audio/phatassParams.js'
import { LA2A_DEFAULTS, la2aPatchLatencySamples, toKernelParams as toLA2AKernelParams } from '../../src/audio/effects/la2aParams.js'
import { LA2A_PREROLL_S } from '../../src/audio/la2aProcessor.js'
import { SCHEPS_DEFAULTS, SCHEPS_LATENCY_SAMPLES, toKernelParams as toSchepsKernelParams } from '../../src/audio/effects/schepsParams.js'
import { SCHEPS_PREROLL_S } from '../../src/audio/schepsProcessor.js'
import { FET1176_DEFAULTS, FET1176_LATENCY_SAMPLES, toKernelParams as toFETKernelParams } from '../../src/audio/effects/fet1176Params.js'
import { FET1176_PREROLL_S } from '../../src/audio/fet1176Processor.js'
import {
  RESONANCE_DEFAULTS, RESONANCE_FRAME_SIZE, resonanceHopSamples, toKernelParams as toResonanceKernelParams,
} from '../../src/audio/resonanceParams.js'
import { SATURATION_BENCH_DEFAULTS, toKernelParams as toSatBenchKernelParams } from '../../src/audio/saturationBenchParams.js'
import { SAT_BENCH_LATENCY_SAMPLES, SAT_BENCH_PREROLL_S } from '../../src/audio/saturationBenchProcessor.js'
import {
  HF_SOFTENER_DEFAULTS, toKernelParams as toHFSoftenerKernelParams,
  resoKernelParams, softenStageKernelParams,
} from '../../src/audio/deEsserParams.js'
import { HF_RESO_FRAME_SIZE, HF_RESO_LATENCY_SAMPLES } from '../../src/audio/deEsserResoStage.js'
import { softenLatencySamples } from '../../src/audio/deEsserSoftenStage.js'
import { HF_SOFTENER_PREROLL_S } from '../../src/audio/deEsserProcessor.js'

export const SR = 44100

/**
 * The floor every plugin's seams must stay under, dBFS. Measured at
 * CHUNK_RUN_IN_S the worst is −144.5 (Reso Soothe and PHAT*SS CLEAN); a 16-bit
 * LSB is −90.3, so a regression past this floor is still far from audible —
 * the floor catches it while it is a number and not yet a sound.
 */
export const SEAM_FLOOR_DBFS = -130
const db = x => 20 * Math.log10(x)

function lcg(seed) {
  let r = seed
  return () => { r = (r * 16807) % 2147483647; return r / 2147483647 }
}

/** Built once per test file: the generators are not cheap and nothing mutates them. */
function memo(make) {
  let v = null
  return () => (v ??= make())
}

/**
 * The materials, each { xs, start, end } in seconds. Each one found a residue
 * the others did not — see CHUNK_RUN_IN_S.
 */
export const MATERIALS = Object.fromEntries(Object.entries({
  /**
   * Syllable-like bursts over a wandering low tone, with noise and a 7 kHz
   * partial, phrased loud / quiet. The first material; Reso Soothe's memory shows
   * here (−67 dB re peak at 2 s of run-in).
   */
  bursts() {
    const make = seed => {
      const n = 48 * SR, x = new Float32Array(n), rnd = lcg(seed)
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
    return { xs: [make(5), make(11)], start: 2, end: 46 }
  },

  /**
   * Speech-like phrases with DIGITAL SILENCE between them, and sibilant noise
   * bursts. The HF Softener's trackers settle slowly through the gaps: at 2 s of
   * run-in a seam read −95 dBFS, 33 ms in.
   */
  gaps() {
    const secs = 90, n = secs * SR, rnd = lcg(11)
    const gaps = []
    for (let t = 0; t < secs;) {
      const ph = 2 + 4 * rnd(), gp = 0.25 + 0.8 * rnd()
      gaps.push([t + ph, t + ph + gp])
      t += ph + gp
    }
    const inGap = t => gaps.some(([a, b]) => t >= a && t < b)
    const xs = [0, 1].map((ch) => {
      const x = new Float32Array(n)
      let env = 0, target = 0, hiss = 0
      for (let i = 0; i < n; i++) {
        const t = i / SR
        if (inGap(t)) { env = 0; continue }
        if (i % 5500 === 0) { target = rnd() < 0.8 ? 0.15 + 0.5 * rnd() : 0; hiss = rnd() < 0.2 ? 1 : 0 }
        env += (target - env) * 0.003
        const f0 = 115 + 25 * Math.sin(t * 0.7)
        let v = 0
        for (let h = 1; h < 14; h++) v += Math.sin(2 * Math.PI * f0 * h * t + h) / h
        x[i] = env * (0.35 * v + (hiss ? 0.5 : 0.03) * (rnd() * 2 - 1)) * (ch ? 0.9 : 1)
      }
      return x
    })
    return { xs, start: 3.3, end: 86.1 }
  },

  /**
   * Syllables at 3.1 Hz phrased by a 13 s cycle, no gaps. Scheps' opto cell
   * releases slowly through it: at 2 s of run-in a seam read −115 dBFS AT the
   * seam sample.
   */
  phrased() {
    const n = 75 * SR
    const xs = [0, 1].map((ch) => {
      const x = new Float32Array(n)
      let s = 7 + ch
      for (let i = 0; i < n; i++) {
        s = (s * 16807) % 2147483647
        const t = i / SR
        const env = Math.max(0, Math.sin(2 * Math.PI * 3.1 * t)) ** 2 * (Math.sin(2 * Math.PI * t / 13) > -0.3 ? 1 : 0.15)
        x[i] = env * (0.4 * Math.sin(2 * Math.PI * 130 * t) + 0.15 * (s / 2147483647 - 0.5) + 0.1 * Math.sin(2 * Math.PI * 7000 * t))
      }
      return x
    })
    return { xs, start: 3.3, end: 70.1 }
  },
}).map(([k, make]) => [k, memo(make)]))

function peakDb(xs) {
  let pk = 0
  for (const x of xs) for (const v of x) pk = Math.max(pk, Math.abs(v))
  return db(pk)
}

function hfSoftener(extra) {
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
    return { stages, latency, preRollS: HF_SOFTENER_PREROLL_S, grid: merged.resoAmount > 0 ? resonanceHopSamples(HF_RESO_FRAME_SIZE) : undefined }
  }
}

function phatass(p) {
  return (xs) => ({
    stages: [{
      renderer: 'phatass',
      kernelParams: toPhatassKernelParams({ ...p, voiceLevelDb: -20, warmthCeilingDb: peakDb(xs), warmthRefPeaksDb: WARMTH_LAYERS.map(() => -10), tapeMakeupDb: 3 }),
    }],
    latency: phatassLatencySamples(SR),
    preRollS: PHATASS_PREROLL_S,
  })
}

/**
 * Every chunked plugin, as applyRegion wires it: [name, build(xs) → { stages,
 * latency, preRollS, grid }].
 */
export const PLUGINS = [
  ['PHAT*SS CLEAN, Warmth and TAPE up, 7.5 ips', phatass({ warmth: 8, tape: 8, hf: 'ips7' })],
  ['PHAT*SS THICK', phatass({ warmth: 5, tape: 8, tapeCurve: 'hysteresis' })],
  ['Reso Soothe, on its hop grid', () => ({
    stages: [{ renderer: 'resonance', kernelParams: toResonanceKernelParams(RESONANCE_DEFAULTS) }],
    latency: RESONANCE_FRAME_SIZE, preRollS: 0, grid: resonanceHopSamples(RESONANCE_FRAME_SIZE),
  })],
  ['Saturation Bench, factory layers', () => ({
    stages: [{ renderer: 'saturationBench', kernelParams: toSatBenchKernelParams(SATURATION_BENCH_DEFAULTS) }],
    latency: SAT_BENCH_LATENCY_SAMPLES, preRollS: SAT_BENCH_PREROLL_S,
  })],
  ['Scheps Parallel', () => ({
    stages: [{ renderer: 'scheps', kernelParams: toSchepsKernelParams(SCHEPS_DEFAULTS) }],
    latency: SCHEPS_LATENCY_SAMPLES, preRollS: SCHEPS_PREROLL_S,
  })],
  ['LA Vintage 2A at Peak Reduction 70', () => {
    const merged = { ...LA2A_DEFAULTS, peakReduction: 70 }
    return {
      stages: [{ renderer: 'la2a', kernelParams: toLA2AKernelParams(merged) }],
      latency: la2aPatchLatencySamples(merged, SR), preRollS: LA2A_PREROLL_S,
    }
  }],
  ['HF Softener, defaults', hfSoftener({})],
  ['HF Softener, Soften 6', hfSoftener({ soften: 6 })],
  ['HF Softener, Reso and Soften', hfSoftener({ soften: 6, resoAmount: 50 })],
  ['LA Classic 76 at Input 70', () => ({
    stages: [{ renderer: 'fet1176', kernelParams: toFETKernelParams({ ...FET1176_DEFAULTS, input: 70 }) }],
    latency: FET1176_LATENCY_SAMPLES, preRollS: FET1176_PREROLL_S,
  })],
]

/** Render a chain over a whole input, as the one-thread worklet graph would. */
function renderChain(channels, stages) {
  let data = channels
  for (const st of stages) data = CHUNK_RENDERERS[st.renderer](data, SR, st.kernelParams, st.options).channelData
  return data
}

/**
 * Worst stitched-vs-continuous difference over the region, dBFS (−Infinity
 * when exact). Three chunks, the plugin's own pre-roll before the region, the
 * planner's default run-in unless `runInS` is given.
 */
export function seamDbfs({ xs, start, end }, { stages, latency, preRollS, grid }, { runInS, count = 3 } = {}) {
  const preRoll = Math.round(preRollS * SR)
  const at = Math.round(start * SR) - preRoll
  const numSamples = Math.round((end - start) * SR)
  const input = xs.map(x => x.slice(at, at + preRoll + numSamples + latency))
  const whole = renderChain(input.map(c => c.slice()), stages)
  const plan = planChunks(numSamples, preRoll, latency, SR, count, { runInS, grid })
  let worst = 0
  for (const c of plan) {
    assert.ok(c.to <= input[0].length)
    const part = renderChunk(input.map(src => src.slice(c.from, c.to)), SR, { stages, latency, skip: c.skip, length: c.length })
    for (let ch = 0; ch < input.length; ch++) {
      for (let i = 0; i < c.length; i++) {
        worst = Math.max(worst, Math.abs(part[ch][i] - whole[ch][preRoll + latency + c.start + i]))
      }
    }
  }
  return worst === 0 ? -Infinity : db(worst)
}
