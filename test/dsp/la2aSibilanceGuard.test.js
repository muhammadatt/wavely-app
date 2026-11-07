/**
 * Sibilance guard — the cell shaper's drive, ducked on top-end-dominated input.
 *
 * ⚠ THE CLAIMS ARE NARROW ON PURPOSE. It must take the cell's distortion off a
 * loud sibilant, and it must do NOTHING else: not to the compression (it never
 * reaches the detector), not to a voiced signal (the ratio stays under its
 * floor, so the scale holds at exactly 1), and not to anything at 0.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  processLA2ABuffer, LA2A_KERNEL_DEFAULTS, SIBILANCE_GUARD_DEFAULT,
} from '../../src/audio/la2aProcessor.js'
import { LA2A_TUNING_DEFAULTS } from '../../src/audio/effects/la2aTuning.js'

const SR = 44100

let seed = 99
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1

/** One second of 4-10 kHz noise peaking near full scale, after a quiet vowel. */
function loudSibilant() {
  const n = SR
  const x = new Float32Array(n)
  // Second-order-ish band: two cascaded one-pole high-passes at 4 kHz on white noise.
  const c = Math.exp(-2 * Math.PI * 4000 / SR)
  let l1 = 0; let l2 = 0
  for (let i = 0; i < n; i++) {
    const w = rnd()
    l1 = (1 - c) * w + c * l1
    const h1 = w - l1
    l2 = (1 - c) * h1 + c * l2
    x[i] = 0.9 * (h1 - l2)
  }
  return x
}

function vowel(seconds = 1.5) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    x[i] = 0.5 * Math.sin(2 * Math.PI * 140 * t) + 0.2 * Math.sin(2 * Math.PI * 280 * t)
      + 0.08 * Math.sin(2 * Math.PI * 700 * t)
  }
  // A 20 ms fade-in: a step onset is a broadband click, which the guard is
  // right to read as top end for the first millisecond or two.
  const fade = Math.round(0.02 * SR)
  for (let i = 0; i < fade; i++) x[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fade)
  return x
}

const render = (x, p) => processLA2ABuffer([x], SR, { peakReduction: 70, gainDb: 6, ...p })
const residualDb = (a, b, ref, from) => {
  let e = 0; let s = 0
  for (let i = from; i < a.length; i++) { e += (a[i] - b[i]) ** 2; s += ref[i] ** 2 }
  return 10 * Math.log10(e / s)
}

test('ships on, and the bench store tracks the kernel default', () => {
  assert.equal(LA2A_KERNEL_DEFAULTS.sibilanceGuard, SIBILANCE_GUARD_DEFAULT)
  assert.equal(LA2A_TUNING_DEFAULTS.sibilanceGuard, SIBILANCE_GUARD_DEFAULT)
  assert.ok(SIBILANCE_GUARD_DEFAULT > 0)
})

test('takes the cell distortion off a loud sibilant', () => {
  const x = loudSibilant()
  const clean = render(x, { analog: false }).channelData[0]
  const off = render(x, { sibilanceGuard: 0 }).channelData[0]
  const on = render(x, { sibilanceGuard: 100 }).channelData[0]
  const skip = Math.round(0.1 * SR)
  const dOff = residualDb(off, clean, clean, skip)
  const dOn = residualDb(on, clean, clean, skip)
  assert.ok(dOff - dOn > 12, `guard bought only ${(dOff - dOn).toFixed(1)} dB (${dOff.toFixed(1)} → ${dOn.toFixed(1)})`)
})

test('leaves a voiced signal bit-identical', () => {
  const x = vowel()
  const off = render(x, { sibilanceGuard: 0 }).channelData[0]
  const on = render(x, { sibilanceGuard: 100 }).channelData[0]
  for (let i = 0; i < x.length; i++) assert.equal(on[i], off[i], `sample ${i}`)
})

test('never touches the compression', () => {
  const x = loudSibilant()
  const off = render(x, { sibilanceGuard: 0 }).metering
  const on = render(x, { sibilanceGuard: 100 }).metering
  assert.equal(on.maxGainReductionDb, off.maxGainReductionDb)
  assert.equal(on.avgGainReductionDb, off.avgGainReductionDb)
})

test('inert with Harmonics off', () => {
  const x = loudSibilant()
  const a = render(x, { analog: false, sibilanceGuard: 0 }).channelData[0]
  const b = render(x, { analog: false, sibilanceGuard: 100 }).channelData[0]
  for (let i = 0; i < x.length; i++) assert.equal(b[i], a[i])
})

test('with lookahead, the guard waits for the delayed sibilant (PR #186 review)', () => {
  // A compressing vowel, then a loud sibilant from t0. With Lookahead the audio
  // runs `lookaheadSamples` behind the side-chain, so an undelayed guard dipped
  // the cell on the vowel's last 20 ms. Delayed, every sample before the
  // sibilant reaches the audio path is untouched.
  const t0 = Math.round(0.8 * SR)
  const v = vowel(0.8)
  const s = loudSibilant()
  const x = new Float32Array(t0 + Math.round(0.3 * SR))
  x.set(v.subarray(0, t0), 0)
  x.set(s.subarray(0, x.length - t0), t0)
  const p = { lookaheadMs: 20 }
  const off = render(x, { ...p, sibilanceGuard: 0 })
  const on = render(x, { ...p, sibilanceGuard: 100 })
  const lat = on.latencySamples
  for (let i = 0; i < t0 - 64; i++) {
    assert.equal(on.channelData[0][i + lat], off.channelData[0][i + lat], `input-time sample ${i}`)
  }
  // ...and it still does its job on the sibilant itself.
  const clean = render(x, { ...p, analog: false }).channelData[0]
  const from = t0 + lat + Math.round(0.05 * SR)
  const dOff = residualDb(off.channelData[0], clean, clean, from)
  const dOn = residualDb(on.channelData[0], clean, clean, from)
  assert.ok(dOff - dOn > 12, `guard bought only ${(dOff - dOn).toFixed(1)} dB with lookahead`)
})

test('BENCH corner: the default is the 2.5 kHz kernel bit for bit, and it reaches a darker "sh"', async () => {
  const { SIB_GUARD_HZ } = await import('../../src/audio/la2aProcessor.js')
  assert.equal(LA2A_KERNEL_DEFAULTS.sibilanceGuardHz, SIB_GUARD_HZ)
  assert.equal(LA2A_TUNING_DEFAULTS.sibilanceGuardHz, SIB_GUARD_HZ)
  // An "sh": noise band-passed ~2-5 kHz, loud, after a vowel.
  const n = SR
  const x = new Float32Array(Math.round(SR * 1.5) + n)
  x.set(vowel())
  const lo = Math.exp(-2 * Math.PI * 2000 / SR)
  const hi = Math.exp(-2 * Math.PI * 5000 / SR)
  let a = 0; let b = 0; let c = 0
  for (let i = 0; i < n; i++) {
    const w = rnd()
    a = (1 - lo) * w + lo * a // low-pass at 2 kHz
    b = (1 - hi) * w + hi * b // low-pass at 5 kHz
    c = (1 - hi) * (b - a) + hi * c
    x[Math.round(SR * 1.5) + i] = 2.2 * c
  }
  const asDefault = render(x, {}).channelData[0]
  assert.deepEqual(render(x, { sibilanceGuardHz: SIB_GUARD_HZ }).channelData[0], asDefault)
  const clean = render(x, { analog: false }).channelData[0]
  const from = Math.round(SR * 1.6)
  const at4kRender = render(x, { sibilanceGuardHz: 4000 }).channelData[0]
  const at4k = residualDb(at4kRender, clean, clean, from)
  const at25 = residualDb(asDefault, clean, clean, from)
  assert.ok(at25 < at4k - 1, `"sh": 4 kHz ${at4k.toFixed(1)} vs 2.5 kHz ${at25.toFixed(1)} dB`)
  // The vowel before it is untouched by the lower corner.
  const vowelEnd = Math.round(SR * 1.4)
  const v4 = at4kRender.subarray(SR / 10, vowelEnd)
  const v25 = asDefault.subarray(SR / 10, vowelEnd)
  let d = 0
  for (let i = 0; i < v4.length; i++) d = Math.max(d, Math.abs(v4[i] - v25[i]))
  assert.ok(d < 1e-6, `vowel moved ${d}`)
})

test('valve guard: a loud "s" through the valve comes out clean, a vowel is bit-identical, 0 is the previous kernel', async () => {
  const { VALVE_GUARD_DEFAULT, LA2A_TUBESAT_PATCH } = await import('../../src/audio/la2aProcessor.js')
  assert.equal(LA2A_KERNEL_DEFAULTS.valveGuard, VALVE_GUARD_DEFAULT)
  assert.equal(LA2A_TUNING_DEFAULTS.valveGuard, VALVE_GUARD_DEFAULT)
  assert.equal(LA2A_TUBESAT_PATCH.valveGuard, 0)
  const s = loudSibilant()
  const clean = render(s, { analog: false }).channelData[0]
  const from = SR / 4
  const cellOnly = residualDb(render(s, { valveGuard: 0 }).channelData[0], clean, clean, from)
  const both = residualDb(render(s, { valveGuard: 100 }).channelData[0], clean, clean, from)
  assert.ok(both < cellOnly - 10, `valve guard: ${cellOnly.toFixed(1)} → ${both.toFixed(1)} dB`)
  const v = vowel()
  assert.deepEqual(render(v, { valveGuard: 100 }).channelData[0], render(v, { valveGuard: 0 }).channelData[0])
})

test('the guard listens to the audio, not to a caller\'s sidechain', async () => {
  const { LA2AKernel } = await import('../../src/audio/la2aProcessor.js')
  const s = loudSibilant()
  const run = (sc) => {
    const k = new LA2AKernel(SR)
    k.setParams({ peakReduction: 70, gainDb: 6 })
    const y = new Float32Array(s.length)
    for (let o = 0; o < s.length; o += 128) {
      k.process([s.subarray(o, o + 128)], [y.subarray(o, o + 128)], 128, sc ? sc.subarray(o, o + 128) : undefined)
    }
    return k.sibGain
  }
  // A sidechain with the top end taken away (as VoxPressor's Body tap does)
  // still leaves the guard reading the audio's "s".
  const dull = new Float32Array(s.length)
  let l = 0
  for (let i = 0; i < s.length; i++) { l += (s[i] - l) * 0.02; dull[i] = l }
  assert.ok(run(dull) < 0.1, `guard scale with a dull sidechain ${run(dull)}`)
  assert.equal(run(dull), run(null))
})

test('BENCH shaper split: off is the shipping kernel, the halves sum back exactly, and an "s" above it is not shaped', async () => {
  const { LA2A_KERNEL_DEFAULTS: D } = await import('../../src/audio/la2aProcessor.js')
  assert.equal(D.shaperSplitHz, 0)
  assert.equal(LA2A_TUNING_DEFAULTS.shaperSplitHz, 0)
  const v = vowel()
  assert.deepEqual(render(v, { shaperSplitHz: 0 }).channelData[0], render(v, {}).channelData[0])
  // Linear (valve off, cell drive ~0): the split changes nothing but rounding.
  const lin = { tube: false, cellCurveDriveMax: 1e-9, sibilanceGuard: 0, valveGuard: 0 }
  const a = render(v, lin).channelData[0]
  const b = render(v, { ...lin, shaperSplitHz: 3000 }).channelData[0]
  let worst = 0
  let pk = 0
  for (let i = 0; i < a.length; i++) { worst = Math.max(worst, Math.abs(a[i] - b[i])); pk = Math.max(pk, Math.abs(a[i])) }
  assert.ok(20 * Math.log10(worst / pk) < -100, `split not transparent: ${(20 * Math.log10(worst / pk)).toFixed(1)} dB`)
  // A loud 4-10 kHz "s", guards off: below a 3 kHz split it barely meets the curves.
  const s = loudSibilant()
  const clean = render(s, { analog: false }).channelData[0]
  const off = { sibilanceGuard: 0, valveGuard: 0 }
  const whole = residualDb(render(s, off).channelData[0], clean, clean, SR / 4)
  const split = residualDb(render(s, { ...off, shaperSplitHz: 3000 }).channelData[0], clean, clean, SR / 4)
  assert.ok(split < whole - 10, `"s" distortion ${whole.toFixed(1)} → ${split.toFixed(1)} dB`)
})
