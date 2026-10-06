/**
 * Saturation meter: the scale, the energy followers, the needle spring, and
 * PHAT*SS's kernel sums (what TAPE and Warmth add, against the clean signal).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  satMeterValue, SaturationMeterFollower, NeedleSpring, SAT_METER_FLOOR_DB, SAT_METER_TOP_DB,
  SAT_METER_RED_DB, SAT_METER_RED_VALUE,
} from '../../src/audio/dsp/saturationMeter.js'
import { PhatassKernel, processPhatassBuffer } from '../../src/audio/phatassProcessor.js'
import { toKernelParams } from '../../src/audio/phatassParams.js'

const SR = 44100

test('the scale is linear in dB from the floor (0) to the top (100), clamped; rest is 0', () => {
  assert.equal(satMeterValue(SAT_METER_FLOOR_DB), 0)
  assert.equal(satMeterValue(SAT_METER_TOP_DB), 100)
  assert.equal(satMeterValue(-20), 50)
  assert.equal(satMeterValue(-80), 0)
  assert.equal(satMeterValue(12), 100)
  assert.equal(satMeterValue(-Infinity), 0)
  assert.equal(SAT_METER_RED_VALUE, satMeterValue(SAT_METER_RED_DB))
})

test('the followers smooth the two energies separately and read their ratio; silence rests', () => {
  const f = new SaturationMeterFollower(SR)
  assert.equal(f.readingDb, -Infinity)
  // Clean power 0.01 (−20 dBFS), added 100× less: −20 dB.
  for (let k = 0; k < 200; k++) f.push({ added: 1e-4 * 1024, clean: 1e-2 * 1024, count: 1024 }, 1024)
  assert.ok(Math.abs(f.readingDb + 20) < 1e-6, `${f.readingDb}`)
  // A second of silence: the clean energy falls under the gate and the needle rests.
  for (let k = 0; k < 60; k++) f.push({ added: 0, clean: 0, count: 1024 }, 1024)
  assert.equal(f.readingDb, -Infinity)
})

test('the needle moves like a VU movement: ~300 ms to a step, a small overshoot, stable on a long frame', () => {
  const s = new NeedleSpring()
  let t = 0, at99 = null, peak = 0
  while (t < 1.5) {
    const x = s.step(100, 1 / 60)
    t += 1 / 60
    if (at99 === null && x >= 99) at99 = t
    peak = Math.max(peak, x)
  }
  assert.ok(at99 > 0.2 && at99 < 0.45, `99 % at ${at99} s`)
  assert.ok(peak > 100 && peak < 103, `overshoot to ${peak}`)
  // A dropped frame (half a second) must not throw it off.
  const s2 = new NeedleSpring()
  const x = s2.step(50, 0.5)
  assert.ok(x > 0 && x < 60, `after a 500 ms frame: ${x}`)
})

function sine(f, amp, n = SR) {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / SR)
  return x
}

function meterOf(x, p) {
  const k = new PhatassKernel(SR)
  k.setParams(toKernelParams(p), true)
  k.enableMeter()
  const out = new Float32Array(128)
  for (let o = 0; o + 128 <= x.length; o += 128) k.process([x.subarray(o, o + 128)], [out], 128)
  return k.takeMeter()
}

test('PHAT*SS meter: nothing added with TAPE and Warmth off; exactly what TAPE adds with it on', () => {
  const x = sine(110, 0.5)
  const off = meterOf(x, { warmth: 0, tame: 0, tape: 0, warmthCeilingDb: -6 })
  assert.equal(off.added, 0)
  assert.ok(off.clean > 0 && off.count > 0)
  // TAPE 3 with its makeup; Tame 0 and Soften off leave the shelf a pure delay,
  // so the rendered output minus the makeup-scaled input IS what was added.
  const p = { warmth: 0, tame: 0, soften: false, tape: 3, tapeMakeupDb: 2.5, warmthCeilingDb: -6 }
  const m = meterOf(x, p)
  const { channelData: [y], latencySamples: L } = processPhatassBuffer([x], SR, toKernelParams(p))
  const mk = Math.pow(10, 2.5 / 20)
  let a = 0, c = 0
  for (let i = 0; i + L < x.length - (x.length % 128); i++) {
    a += (y[i + L] - mk * x[i]) ** 2
    c += (mk * x[i]) ** 2
  }
  const metered = 10 * Math.log10(m.added / m.clean), rendered = 10 * Math.log10(a / c)
  assert.ok(rendered > -40 && rendered < -10, `TAPE 3 adds ${rendered.toFixed(2)} dB`)
  assert.ok(Math.abs(metered - rendered) < 0.05, `meter ${metered.toFixed(3)} vs render ${rendered.toFixed(3)} dB`)
})

test('PHAT*SS meter: Warmth reads, and more Warmth reads more', () => {
  const x = new Float32Array(SR)
  for (let i = 0; i < SR; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 120 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 1500 * i) / SR)
  const at = warmth => {
    const r = meterOf(x, { warmth, oddEven: 50, tame: 0, warmthCeilingDb: -3, warmthRefPeaksDb: [-14, -14, -14, -14] })
    return 10 * Math.log10(r.added / r.clean)
  }
  const w2 = at(2), w8 = at(8)
  assert.ok(Number.isFinite(w2) && w8 > w2 + 3, `Warmth 2 ${w2.toFixed(1)} dB, 8 ${w8.toFixed(1)} dB`)
})
