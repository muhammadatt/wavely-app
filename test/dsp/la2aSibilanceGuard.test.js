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
