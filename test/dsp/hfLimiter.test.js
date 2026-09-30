/**
 * HF Limiter — the claims the design rests on (see src/audio/dsp/hfLimit.js).
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HFLimiterKernel, processHFLimiterBuffer } from '../../src/audio/hfLimiterProcessor.js'
import {
  toKernelParams, hfLimiterLatencySamples, HF_LIMITER_DEFAULTS,
} from '../../src/audio/hfLimiterParams.js'
import { shelfResponseDb, splitResponse, splitTaps } from '../../src/audio/dsp/hfLimit.js'

const SR = 44100

function sine(f, amp, n = SR, phase = 0) {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / SR + phase)
  return x
}

function add(...xs) {
  const y = new Float32Array(xs[0].length)
  for (const x of xs) for (let i = 0; i < y.length; i++) y[i] += x[i]
  return y
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

/** Amplitude of the component at `f`, by correlation over [from, to). */
function toneAmp(y, f, from, to) {
  let c = 0, s = 0
  for (let i = from; i < to; i++) {
    const w = (2 * Math.PI * f * i) / SR
    c += y[i] * Math.cos(w)
    s += y[i] * Math.sin(w)
  }
  return (2 * Math.hypot(c, s)) / (to - from)
}

function peak(y, from = 0, to = y.length) {
  let m = 0
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(y[i]))
  return m
}

const db = x => 20 * Math.log10(x)
const run = (x, p) => processHFLimiterBuffer([x], SR, toKernelParams(p))
// Threshold −30 dBFS absolute: voice −20 plus −10.
const BASE = { voiceLevelDb: -20, threshold: -10, range: 24, release: 60 }

test('bit-transparent below threshold, delayed by the latency, with the accel stage in or out', () => {
  // Loud bass and mids plus a top well under the ceiling, faded in: a tone
  // switched on abruptly IS a sharp edge, and the accel stage rightly takes it.
  const x = add(sine(150, 0.5), sine(1200, 0.2), sine(9000, 0.005))
  const fade = Math.round(0.05 * SR)
  for (let i = 0; i < fade; i++) x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade)
  for (const transient of [0, 100]) {
    const { channelData: [y], latencySamples: L } = run(x, { ...BASE, transient })
    assert.equal(L, hfLimiterLatencySamples(SR))
    for (let i = L; i < x.length; i++) {
      if (y[i] !== x[i - L]) assert.fail(`transient ${transient}: sample ${i} differs (${y[i]} vs ${x[i - L]})`)
    }
  }
})

test('the shelf holds the band above the corner at the threshold, with no overshoot', () => {
  const T = Math.pow(10, -30 / 20)
  for (const f of [8000, 12000]) {
    const { channelData: [y] } = run(sine(f, 0.1), BASE)
    // Well above the transition, the band IS the signal, so the output peak is the band's.
    const p = peak(y, SR / 4)
    assert.ok(p <= T * 1.0005, `${f} Hz peak ${db(p).toFixed(3)} dBFS over the −30 ceiling`)
    assert.ok(p > T * 0.97, `${f} Hz held at ${db(p).toFixed(2)} dBFS, well under the ceiling`)
  }
})

test('the bass under a limited top is left alone', () => {
  const x = add(sine(200, 0.4), sine(10000, 0.1))
  const { channelData: [y], latencySamples: L } = run(x, BASE)
  const lo = toneAmp(y, 200, SR / 4 + L, SR)
  const hi = toneAmp(y, 10000, SR / 4 + L, SR)
  assert.ok(Math.abs(db(lo / 0.4)) < 0.01, `200 Hz moved ${db(lo / 0.4).toFixed(3)} dB`)
  assert.ok(db(hi / 0.1) < -8, `10 kHz only came down ${db(hi / 0.1).toFixed(2)} dB`)
})

test('Range is a floor the cut never goes past', () => {
  // 40 dB over the ceiling, 6 dB of Range: 6 dB of cut, not 40.
  const { channelData: [y] } = run(sine(10000, 0.3), { ...BASE, threshold: -50, range: 6 })
  const p = peak(y, SR / 4)
  assert.ok(Math.abs(db(p / 0.3) + 6) < 0.05, `cut ${db(p / 0.3).toFixed(3)} dB at Range 6`)
  // And Range 0 takes the shelf out: bit-transparent however far over.
  const x = sine(10000, 0.3)
  const { channelData: [z], latencySamples: L } = run(x, { ...BASE, threshold: -50, range: 0 })
  for (let i = L; i < x.length; i++) if (z[i] !== x[i - L]) assert.fail(`Range 0 changed sample ${i}`)
})

test('the curve the panel draws is the cut the kernel applies', () => {
  // Threshold far below anything: the gain sits on the Range floor, so the
  // stage is a fixed filter and its tone response can be read off directly.
  const range = 12
  const g = Math.pow(10, -range / 20)
  for (const corner of [3000, 6000]) {
    const freqs = [1000, corner / 1.5, corner / 1.2, corner, corner * 1.2, corner * 1.5, 15000]
    const drawn = shelfResponseDb(SR, corner, g, freqs)
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i]
      const x = sine(f, 0.25)
      const { channelData: [y], latencySamples: L } = run(x, {
        ...BASE, freq: corner, threshold: -30, voiceLevelDb: -60, range,
      })
      const measured = db(toneAmp(y, f, SR / 4 + L, SR) / 0.25)
      assert.ok(
        Math.abs(measured - drawn[i]) < 0.05,
        `corner ${corner}, ${f.toFixed(0)} Hz: drawn ${drawn[i].toFixed(3)}, measured ${measured.toFixed(3)}`,
      )
    }
  }
})

test('the split is unity at DC, half at the corner, and monotone at every depth', () => {
  for (const corner of [2000, 5000, 12000]) {
    const taps = splitTaps(SR, corner)
    assert.ok(Math.abs(taps.reduce((a, b) => a + b, 0) - 1) < 1e-12)
    assert.ok(Math.abs(splitResponse(SR, corner, [corner])[0] - 0.5) < 0.03)
    const freqs = Array.from({ length: 200 }, (_, i) => 200 * Math.pow(20000 / 200, i / 199))
    for (const g of [0.1, 0.5]) {
      const r = shelfResponseDb(SR, corner, g, freqs)
      for (let i = 1; i < r.length; i++) {
        // Window ripple is allowed; a notch or a bump is not.
        assert.ok(r[i] <= r[i - 1] + 0.02, `corner ${corner} g ${g}: rises at ${freqs[i].toFixed(0)} Hz`)
        assert.ok(r[i] >= db(g) - 0.05 && r[i] <= 0.02, `corner ${corner} g ${g}: ${r[i].toFixed(3)} dB out of [floor, 0]`)
      }
    }
  }
})

test('the latency does not move when Transient crosses 0', () => {
  const L = hfLimiterLatencySamples(SR)
  for (const transient of [0, 1, 100]) {
    const x = new Float32Array(4096)
    x[100] = 0.001 // far below every threshold
    const { channelData: [y] } = run(x, { ...BASE, transient })
    assert.equal(y[100 + L], x[100], `transient ${transient}`)
  }
})

test('the acceleration limiter tightens with frequency and leaves the low end alone', () => {
  const P = { ...BASE, range: 0, transient: 100 }
  const lowCut = db(peak(run(sine(500, 0.5), P).channelData[0], SR / 4) / 0.5)
  const at6k = db(peak(run(sine(6000, 0.1), P).channelData[0], SR / 4) / 0.1)
  const at12k = db(peak(run(sine(12000, 0.1), P).channelData[0], SR / 4) / 0.1)
  assert.ok(lowCut > -0.01, `500 Hz at −6 dBFS moved ${lowCut.toFixed(3)} dB`)
  assert.ok(at6k < -2, `6 kHz only ${at6k.toFixed(2)} dB`)
  assert.ok(at12k < at6k - 3, `12 kHz ${at12k.toFixed(2)} dB is not tighter than 6 kHz ${at6k.toFixed(2)}`)
})

test('the acceleration limiter is stable: no drift, and it returns to exact silence', () => {
  const P = { ...BASE, transient: 100 }
  const n = noise(3 * SR, 0.7)
  const { channelData: [y] } = run(n, P)
  let mean = 0
  for (const v of y) mean += v
  mean /= y.length
  assert.ok(Math.abs(mean) < 2e-3, `mean ${mean}`)
  assert.ok(peak(y) < 1, `peak ${peak(y)}`)

  const burst = new Float32Array(SR)
  burst.set(sine(9000, 0.5, 4410))
  const { channelData: [z] } = run(burst, P)
  const last = z.findLastIndex(v => v !== 0)
  assert.ok(last < 0.25 * SR, `still non-zero at ${(last / SR).toFixed(3)} s`)
})

test('stereo is gain-linked: a bright left turns the right down with it', () => {
  const left = sine(10000, 0.1)
  const right = sine(10000, 0.01)
  const k = new HFLimiterKernel(SR)
  k.setParams(toKernelParams(BASE))
  const outL = new Float32Array(SR), outR = new Float32Array(SR)
  for (let off = 0; off < SR; off += 128) {
    k.process([left.subarray(off, off + 128), right.subarray(off, off + 128)],
      [outL.subarray(off, off + 128), outR.subarray(off, off + 128)], 128)
  }
  const cutL = db(peak(outL, SR / 4) / 0.1)
  const cutR = db(peak(outR, SR / 4) / 0.01)
  assert.ok(Math.abs(cutL - cutR) < 0.05, `left ${cutL.toFixed(2)} dB, right ${cutR.toFixed(2)} dB`)
})

test('delta is exactly the input minus the output', () => {
  const x = add(sine(300, 0.3), sine(9000, 0.1))
  const params = toKernelParams({ ...BASE, transient: 50 })
  const ref = processHFLimiterBuffer([x], SR, params).channelData[0]
  const k = new HFLimiterKernel(SR)
  k.setParams(params)
  k.setListen('delta')
  const d = new Float32Array(x.length)
  for (let off = 0; off < x.length; off += 128) {
    k.process([x.subarray(off, off + 128)], [d.subarray(off, off + 128)], 128)
  }
  const L = k.latencySamples
  for (let i = L; i < x.length; i++) {
    assert.ok(Math.abs(d[i] - (x[i - L] - ref[i])) < 1e-6, `sample ${i}`)
  }
})

test('the threshold follows the file\'s voice level, not the knob alone', () => {
  const quiet = toKernelParams({ ...HF_LIMITER_DEFAULTS, voiceLevelDb: -30 })
  const hot = toKernelParams({ ...HF_LIMITER_DEFAULTS, voiceLevelDb: -14 })
  assert.equal(hot.thresholdDb - quiet.thresholdDb, 16)
  assert.equal(toKernelParams({ transient: 0 }).accel, false)
  const t1 = toKernelParams({ transient: 1 })
  const t100 = toKernelParams({ transient: 100 })
  assert.ok(t1.accel && t100.accel)
  assert.ok(t1.accelThresholdDb > t100.accelThresholdDb)
  assert.equal(t100.accelThresholdDb, t100.thresholdDb)
})

// ── WARM shape and the two-stage release ────────────────────────────────────

import { onePoleLowpass } from '../../src/audio/dsp/hfLimit.js'

function onePole(x, corner) {
  const { b0, a1 } = onePoleLowpass(SR, corner)
  const y = new Float64Array(x.length)
  let x1 = 0, y1 = 0
  for (let i = 0; i < x.length; i++) { y1 = b0 * (x[i] + x1) - a1 * y1; x1 = x[i]; y[i] = y1 }
  return y
}

test('WARM is bit-transparent below threshold and at Range 0, with the same latency as TIGHT', () => {
  // Quieter mids than the TIGHT version: WARM's band is a first-order high-pass,
  // so a −14 dBFS tone at 1.2 kHz reads −26.5 dBFS in it, over the −30 line, and
  // is rightly cut — a WARM threshold hears more of the spectrum.
  const x = add(sine(150, 0.5), sine(1200, 0.03), sine(9000, 0.002))
  const fade = Math.round(0.05 * SR)
  for (let i = 0; i < fade; i++) x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade)
  for (const p of [{ ...BASE, shape: 'warm' }, { ...BASE, shape: 'warm', threshold: -50, range: 0 }]) {
    const { channelData: [y], latencySamples: L } = run(x, p)
    assert.equal(L, hfLimiterLatencySamples(SR))
    for (let i = L; i < x.length; i++) if (y[i] !== x[i - L]) assert.fail(`sample ${i} differs`)
  }
})

test('WARM holds its one-pole band at the threshold, with no overshoot', () => {
  // The output is LP1(x) + g·h, h = x − LP1(x), so the band is recoverable
  // exactly from the output: y − LP1(x delayed).
  const T = Math.pow(10, -30 / 20)
  const x = sine(10000, 0.1)
  const { channelData: [y], latencySamples: L } = run(x, { ...BASE, shape: 'warm', freq: 3000 })
  const xd = new Float32Array(x.length)
  xd.set(x.subarray(0, x.length - L), L)
  const lp = onePole(xd, 3000)
  let p = 0
  for (let i = SR / 4; i < x.length; i++) p = Math.max(p, Math.abs(y[i] - lp[i]))
  assert.ok(p <= T * 1.0005, `band peak ${db(p).toFixed(3)} dBFS over the −30 ceiling`)
  assert.ok(p > T * 0.97, `band held at ${db(p).toFixed(2)} dBFS, well under the ceiling`)
})

test('the WARM curve the panel draws is the cut the kernel applies, and it is a gentle tilt', () => {
  const range = 12, corner = 2500
  const g = Math.pow(10, -range / 20)
  const freqs = [500, 1000, 2000, 2500, 4000, 8000, 15000]
  const drawn = shelfResponseDb(SR, corner, g, freqs, 'warm')
  for (let i = 0; i < freqs.length; i++) {
    const x = sine(freqs[i], 0.25)
    const { channelData: [y], latencySamples: L } = run(x, {
      ...BASE, shape: 'warm', freq: corner, threshold: -30, voiceLevelDb: -60, range,
    })
    const measured = db(toneAmp(y, freqs[i], SR / 4 + L, SR) / 0.25)
    assert.ok(Math.abs(measured - drawn[i]) < 0.05, `${freqs[i]} Hz: drawn ${drawn[i].toFixed(3)}, measured ${measured.toFixed(3)}`)
  }
  // Unlike TIGHT, WARM reaches below the corner: an octave down it is already cutting.
  const tight = shelfResponseDb(SR, corner, g, [1000], 'tight')[0]
  assert.ok(drawn[1] < -0.5 && tight > -0.05, `1 kHz: warm ${drawn[1].toFixed(2)}, tight ${tight.toFixed(2)}`)
})

/** The shelf gain after every block, from a fresh kernel. */
function gainTrace(x, p) {
  const k = new HFLimiterKernel(SR)
  k.setParams(toKernelParams(p))
  const out = new Float32Array(128), trace = []
  for (let off = 0; off + 128 <= x.length; off += 128) {
    k.process([x.subarray(off, off + 128)], [out], 128)
    trace.push(k.shelf.gain)
  }
  return trace
}

/** Blocks from the end of a burst until the gain is back within 1 dB. */
function recoveryBlocks(trace, burstEndBlock) {
  const lim = Math.pow(10, -1 / 20)
  for (let i = burstEndBlock; i < trace.length; i++) if (trace[i] >= lim) return i - burstEndBlock
  return Infinity
}

test('Tail 0 is the single-stage release, and a Tail below its minimum is off', () => {
  assert.equal(toKernelParams({ tail: 0 }).tailMs, 0)
  assert.equal(toKernelParams({ tail: 20 }).tailMs, 0)
  assert.equal(toKernelParams({ tail: 200 }).tailMs, 200)
  const x = add(sine(300, 0.2), sine(9000, 0.1))
  const a = run(x, { ...BASE, tail: 0 }).channelData[0]
  const b = run(x, { ...BASE, tail: 20 }).channelData[0]
  for (let i = 0; i < x.length; i++) if (a[i] !== b[i]) assert.fail(`sample ${i} differs`)
})

test('the Tail is program-dependent: a sustained cut leaves a long tail, a click does not', () => {
  const P = { ...BASE, release: 20, range: 24 }
  const n = SR
  const burst = (ms) => {
    const x = new Float32Array(n)
    const len = Math.round((ms / 1000) * SR)
    x.set(sine(9000, 0.2, len), SR / 10)
    return { x, end: Math.ceil((SR / 10 + len) / 128) + 1 }
  }
  const click = burst(3), long = burst(400)
  const clickSingle = recoveryBlocks(gainTrace(click.x, { ...P, tail: 0 }), click.end)
  const clickTail = recoveryBlocks(gainTrace(click.x, { ...P, tail: 300 }), click.end)
  const longSingle = recoveryBlocks(gainTrace(long.x, { ...P, tail: 0 }), long.end)
  const longTail = recoveryBlocks(gainTrace(long.x, { ...P, tail: 300 }), long.end)
  // A click barely charges the slow stage: it recovers nearly as fast as with no Tail.
  assert.ok(clickTail <= clickSingle * 1.5 + 2, `click: ${clickTail} blocks with Tail vs ${clickSingle} without`)
  // A sustained cut charges it: recovery is several times slower.
  assert.ok(longTail > longSingle * 3, `sustained: ${longTail} blocks with Tail vs ${longSingle} without`)
})

test('the Tail never lets the gain overshoot the lookahead ceiling', () => {
  const T = Math.pow(10, -30 / 20)
  const x = add(sine(8000, 0.1), sine(12000, 0.05))
  const { channelData: [y] } = run(x, { ...BASE, tail: 400 })
  const p = peak(y, SR / 4)
  // Both tones sit above TIGHT's transition, so the output IS the band.
  assert.ok(p <= T * 1.0005, `peak ${db(p).toFixed(3)} dBFS over the −30 ceiling`)
})
