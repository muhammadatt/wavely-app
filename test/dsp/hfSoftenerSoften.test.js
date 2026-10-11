/**
 * Run with:  npm test
 *
 * HF Softener — the Soften post-stage (hfSoftenerSoftenStage.js): an onset
 * softener on the band above 500 Hz, moved here from PHAT*SS and run on the
 * HF Limiter's kernel with its shelf out.
 *
 * ⚠ THE MOVE WAS CHECKED BIT FOR BIT, not just re-tested: against PHAT*SS's
 * Soften at 828e9e3 (Tame 0, everything else off) on 10 s of real narration,
 * the HF-Limiter-hosted stage differs by 0 at Soften 3 / 7 / 10, latency
 * aligned (414 samples there, 132 here). The tests below pin the behaviour
 * the move was for; the dev log keeps the equivalence run.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processHFLimiterBuffer } from '../../src/audio/hfLimiterProcessor.js'
import {
  softenLaw, softenKernelParams, softenLatencySamples,
  SOFTEN_MAX, SOFTEN_FREQ_HZ, SOFTEN_GATE_BELOW_DB, SOFTEN_NOMINAL_DBFS,
} from '../../src/audio/hfSoftenerSoftenStage.js'
import { HF_SOFTENER_DEFAULTS, softenOn, softenStageKernelParams } from '../../src/audio/hfSoftenerParams.js'
import { shelfLatencySamples } from '../../src/audio/dsp/hfLimit.js'

const SR = 44100
const db = x => 20 * Math.log10(x)

function sine(f, amp, n = SR) {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / SR)
  return x
}

function noise(n, amp, seed = 1) {
  let s = seed
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647
    x[i] = amp * ((s / 2147483647) * 2 - 1)
  }
  return x
}

/** Room tone, a steady 150 Hz voice-like tone, and a 2 ms HF click burst at `at`. */
function clickOverVoice(at = Math.round(0.4 * SR), clickAmp = 0.3) {
  const a = sine(150, 0.2), b = noise(SR, 0.0005, 7)
  const x = new Float32Array(SR)
  for (let i = 0; i < SR; i++) x[i] = a[i] + b[i]
  let r = 9
  for (let i = at; i < at + Math.round(0.002 * SR); i++) {
    r = (r * 16807) % 2147483647
    x[i] += clickAmp * ((r / 2147483647) * 2 - 1)
  }
  return x
}

/** Energy removed around the click, dB re the click's own energy (0 = all of it). */
function removedDb(x, y, L, at) {
  let e = 0, c = 0
  for (let i = at - 50; i < at + Math.round(0.01 * SR); i++) e += (y[i + L] - x[i]) ** 2
  for (let i = at; i < at + Math.round(0.002 * SR); i++) c += (x[i] - 0.2 * Math.sin((2 * Math.PI * 150 * i) / SR)) ** 2
  return 10 * Math.log10(e / c)
}

function toneAmp(y, f, from, to) {
  let c = 0, s = 0
  for (let i = from; i < to; i++) {
    const w = (2 * Math.PI * f * i) / SR
    c += y[i] * Math.cos(w)
    s += y[i] * Math.sin(w)
  }
  return (2 * Math.hypot(c, s)) / (to - from)
}

// A −20 dBFS voice: the softener's nominal, level offset 0.
const run = (x, soften, levelOffsetDb = 0) => processHFLimiterBuffer([x], SR, softenKernelParams(soften, levelOffsetDb))

test('the Soften law (moved unchanged from PHAT*SS): 0–10, 3.6 dB of ceiling a step, slope 0.5 → 1', () => {
  assert.deepEqual(softenLaw(0), { depthDb: 0, slope: 0.5 })
  assert.ok(Math.abs(softenLaw(5).depthDb - 18) < 1e-9)
  assert.ok(Math.abs(softenLaw(10).depthDb - 36) < 1e-9)
  assert.ok(Math.abs(softenLaw(5).slope - 0.75) < 1e-12)
  assert.equal(softenLaw(25).depthDb, softenLaw(SOFTEN_MAX).depthDb)
  assert.equal(softenLaw(-3).depthDb, 0)
})

test('the stage is the HF Limiter\'s kernel with the shelf out and the Transient on its own 500 Hz band, gated under the voice', () => {
  const k = softenKernelParams(10, 3)
  assert.equal(k.rangeDb, 0, 'the shelf is out')
  assert.ok(Math.abs(k.transientDb - 36) < 1e-9)
  assert.equal(k.transientCornerHz, SOFTEN_FREQ_HZ)
  assert.ok(Math.abs(k.transientSlope - 1) < 1e-12)
  // The voice level is the softener's nominal plus its measured level offset.
  assert.equal(k.transientGateDb, SOFTEN_NOMINAL_DBFS + 3 - SOFTEN_GATE_BELOW_DB)
  assert.equal(k.outputGainDb, 0)
  assert.equal(softenLatencySamples(SR), shelfLatencySamples(SR))
  // Through the HF Softener's params: the knob and the file's level offset.
  assert.deepEqual(softenStageKernelParams({ ...HF_SOFTENER_DEFAULTS, soften: 4, levelOffset: -6 }), softenKernelParams(4, -6))
})

test('HF Softener: Soften ships off and is in the chain only above 0', () => {
  assert.equal(HF_SOFTENER_DEFAULTS.soften, 0)
  assert.equal(softenOn(HF_SOFTENER_DEFAULTS), false)
  assert.equal(softenOn({ soften: 0.1 }), true)
  assert.equal(softenOn({ soften: 0 }), false)
  // Reso left the panel when Soften took its slot, and stays off.
  assert.equal(HF_SOFTENER_DEFAULTS.resoAmount, 0)
})

test('at 0 the stage is a pure delay of its latency', () => {
  const x = clickOverVoice()
  const { channelData: [y], latencySamples: L } = run(x, 0)
  assert.equal(L, softenLatencySamples(SR))
  for (let i = L; i < x.length; i++) if (y[i] !== x[i - L]) assert.fail(`sample ${i} differs`)
})

test('more Soften removes more of a burst', () => {
  const at = Math.round(0.4 * SR)
  const x = clickOverVoice(at)
  let prev = -Infinity
  for (const soften of [2, 5, 10]) {
    const { channelData: [y], latencySamples: L } = run(x, soften)
    const r = removedDb(x, y, L, at)
    assert.ok(r > prev + 0.5, `Soften ${soften}: removed ${r.toFixed(2)} dB, not more than ${prev.toFixed(2)}`)
    prev = r
  }
})

test('Soften leaves steady sound alone', () => {
  const at = Math.round(0.4 * SR)
  const x = clickOverVoice(at)
  const on = run(x, 10), L = on.latencySamples
  // Away from the burst, Soften leaves the voice as it was.
  let worst = 0
  for (let i = Math.round(0.6 * SR); i < Math.round(0.9 * SR); i++) worst = Math.max(worst, Math.abs(on.channelData[0][i + L] - x[i]))
  assert.ok(worst < 1e-4, `steady voice moved by ${worst}`)
  // A held 6 kHz tone is not a transient.
  const t = sine(6000, 0.1), n = noise(SR, 0.0005, 3)
  const tone = new Float32Array(SR)
  for (let i = 0; i < SR; i++) tone[i] = t[i] + n[i]
  const y = run(tone, 10).channelData[0]
  const g = db(toneAmp(y, 6000, SR / 2, SR) / toneAmp(tone, 6000, SR / 2, SR))
  assert.ok(Math.abs(g) < 0.1, `Soften moved a steady 6 kHz tone ${g.toFixed(2)} dB`)
})
