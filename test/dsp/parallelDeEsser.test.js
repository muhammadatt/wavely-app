import { test } from 'node:test'
import assert from 'node:assert/strict'
import { narration } from '../helpers/narration.js'
import {
  ParallelDeEsser, PARALLEL_DEESS_DETECT_HZ, PARALLEL_DEESS_RATIO_LO, PARALLEL_DEESS_RATIO_HI,
} from '../../src/audio/dsp/parallelDeEsser.js'
import { SIB_GUARD_HZ, SIB_GUARD_RATIO_LO, SIB_GUARD_RATIO_HI } from '../../src/audio/la2aProcessor.js'
import { VoxPressorKernel, VOX_KERNEL_DEFAULTS } from '../../src/audio/voxPressorProcessor.js'

const SR = 44100
const db = v => 20 * Math.log10(v)

function run(x, depthDb, block = 128) {
  const d = new ParallelDeEsser(SR)
  d.setDepthDb(depthDb)
  const y = Float32Array.from(x)
  for (let o = 0; o < y.length; o += block) {
    const n = Math.min(block, y.length - o)
    d.process([y.subarray(o, o + n)], n)
  }
  return y
}

function rms(x, from = 0, to = x.length) {
  let e = 0
  for (let i = from; i < to; i++) e += x[i] * x[i]
  return Math.sqrt(e / (to - from))
}

function noise(n, seed = 1) {
  let s = seed
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    x[i] = s / 2 ** 31 - 1
  }
  return x
}

test('its detector is LA Vintage 2A\'s sibilance guard\'s (copied constants, pinned)', () => {
  assert.equal(PARALLEL_DEESS_DETECT_HZ, SIB_GUARD_HZ)
  assert.equal(PARALLEL_DEESS_RATIO_LO, SIB_GUARD_RATIO_LO)
  assert.equal(PARALLEL_DEESS_RATIO_HI, SIB_GUARD_RATIO_HI)
})

test('depth 0 is a no-op, bit for bit', () => {
  const x = narration(SR, { seconds: 2, levelDb: -20 })
  assert.deepEqual(run(x, 0), x)
})

test('it cuts an "s" and leaves a vowel alone', () => {
  const n = SR
  // A vowel: harmonics of 140 Hz under 2 kHz.
  const vowel = new Float32Array(n)
  for (let h = 1; h * 140 < 2000; h++) {
    for (let i = 0; i < n; i++) vowel[i] += 0.05 / h * Math.sin(2 * Math.PI * 140 * h * i / SR)
  }
  const v = run(vowel, 18)
  // Past the first 100 ms: a start out of digital silence is a step, and a
  // step IS top-heavy for a sample (the gain dips 0.14 dB there and recovers).
  let worst = 0
  for (let i = SR / 10; i < n; i++) worst = Math.max(worst, Math.abs(v[i] - vowel[i]))
  assert.ok(db(worst / 0.05) < -60, `vowel moved ${db(worst / 0.05).toFixed(1)} dB re its level`)
  // An "s": noise high-passed hard above 5 kHz (a crude 2nd difference).
  const w = noise(n)
  const s = new Float32Array(n)
  for (let i = 2; i < n; i++) s[i] = 0.1 * (w[i] - 2 * w[i - 1] + w[i - 2])
  const cut = db(rms(run(s, 18), SR / 10) / rms(s, SR / 10))
  assert.ok(cut < -9, `"s" only ${cut.toFixed(2)} dB`)
})

test('it is homogeneous: a gain before it is a gain after it (the makeup commutes)', () => {
  const x = narration(SR, { seconds: 3, levelDb: -24 })
  const k = 10 ** (9 / 20)
  const a = run(x.map(v => v * k), 12)
  const b = run(x, 12)
  let worst = 0
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i] * k))
  assert.ok(worst < 1e-5, `differs by ${worst}`)
})

test('the kernel\'s own blend path reproduces the compressor\'s blend where nothing is caught', () => {
  // Pure low-frequency material: the de-esser never engages, so the only
  // difference is who sums the blend (the kernel, or VoxPressor) and the ceiling.
  const n = 3 * SR
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.3 * i / SR)
    x[i] = 0.3 * env * (Math.sin(2 * Math.PI * 110 * i / SR) + 0.5 * Math.sin(2 * Math.PI * 330 * i / SR))
  }
  for (const parallelComp of ['1176', 'la2a']) {
    const base = {
      ...VOX_KERNEL_DEFAULTS, peaksOn: false, bodyOn: false, parallelOn: true, parallelMix: 0.4,
      parallelComp, parallelMakeupDb: 6, sourcePeakDb: -6, parallelCeilingKneeDb: 1.5,
    }
    const render = (extra) => {
      const k = new VoxPressorKernel(SR)
      k.setParams({ ...base, ...extra })
      const y = new Float32Array(n)
      for (let o = 0; o < n; o += 128) {
        const m = Math.min(128, n - o)
        k.process([x.subarray(o, o + m)], [y.subarray(o, o + m)], m)
      }
      return y
    }
    const a = render({})
    let p = 0
    for (const v of a) p = Math.max(p, Math.abs(v))
    const worstDb = (y, from) => {
      let w = 0
      for (let i = from; i < n; i++) w = Math.max(w, Math.abs(a[i] - y[i]))
      return db(w / p)
    }
    // The arithmetic: a depth too small to cut anything is the compressor's
    // own blend and ceiling to float32 rounding, start included.
    const exact = worstDb(render({ parallelDeEss: 1e-4 }), 0)
    assert.ok(exact < -120, `${parallelComp}: blend path ${exact.toFixed(1)} dB re peak`)
    // And at a real depth the detector leaves a vowel alone once past the
    // start-from-silence step (see above).
    const idle = worstDb(render({ parallelDeEss: 50 }), SR / 4)
    assert.ok(idle < -100, `${parallelComp}: ${idle.toFixed(1)} dB re peak`)
  }
})
