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
  WARMTH_LAYERS, WARMTH_LATENCY_SAMPLES, WARMTH_EVEN_MATCH_DB, ODD_EVEN_SPAN, warmthLayers,
} from '../../src/audio/hfLimiterParams.js'
import { shelfResponseDb, splitResponse, splitTaps } from '../../src/audio/dsp/hfLimit.js'
import { processSaturationBenchBuffer } from '../../src/audio/dsp/saturationLayers.js'
import { warmthGuardLatencySamples } from '../../src/audio/dsp/warmthGuard.js'

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

test('bit-transparent below threshold, delayed by the latency, with Transient on or off', () => {
  // Loud bass and mids plus a top well under the ceiling, faded in: a tone
  // switched on abruptly IS a sharp edge, and the Transient stage rightly takes it.
  const x = add(sine(150, 0.5), sine(1200, 0.2), sine(9000, 0.005))
  const fade = Math.round(0.05 * SR)
  for (let i = 0; i < fade; i++) x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade)
  // Transient acts below Threshold ON PURPOSE (it catches quiet clicks), and a
  // fade in from digital silence is an onset, so with it on the claim is
  // "untouched once steady": from 0.1 s, after the fade.
  for (const [transient, from] of [[0, 0], [12, Math.round(0.1 * SR)]]) {
    const { channelData: [y], latencySamples: L } = run(x, { ...BASE, transient })
    assert.equal(L, hfLimiterLatencySamples(SR))
    for (let i = L + from; i < x.length; i++) {
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

test('the latency does not move with Transient or Warmth', () => {
  const L = hfLimiterLatencySamples(SR)
  // The warmth layers' oversampler round trips, then the shelf's split and lookahead.
  assert.equal(L, WARMTH_LATENCY_SAMPLES + warmthGuardLatencySamples(SR) + 3 * Math.round(0.001 * SR))
  for (const [transient, warmth] of [[0, 0], [6, 0], [12, 0], [0, 6]]) {
    const x = new Float32Array(4096)
    x[100] = 0.001 // far below every threshold
    const { channelData: [y] } = run(x, { ...BASE, transient, warmth })
    if (warmth === 0) assert.equal(y[100 + L], x[100], `transient ${transient}`)
    else assert.ok(Math.abs(y[100 + L] - x[100]) < 1e-5, `warmth ${warmth}: impulse at ${L} reads ${y[100 + L]}`)
  }
})

// ── Transient: the onset softener ───────────────────────────────────────────

/** Room tone plus one noise event over [att, hold, decay] ms, scaled so its band peak is `bandDb`. */
function event(att, hold, dec, bandDb, n = Math.round(0.5 * SR), at = Math.round(0.15 * SR), seed = 5) {
  let r = seed
  const rnd = () => { r = (r * 16807) % 2147483647; return (r / 2147483647) * 2 - 1 }
  const x = new Float32Array(n)
  for (let i = at; i < n; i++) {
    const t = ((i - at) / SR) * 1000
    const e = t < att ? t / att : t < att + hold ? 1 : Math.exp(-(t - att - hold) / dec)
    x[i] = rnd() * e
  }
  // Band peak via the kernel's own split: run it with nothing engaged and read h.
  // Band peak, approximated by the first difference (a +6 dB/oct tilt that
  // puts noise's energy where the split does).
  let pk = 0
  for (let i = 1; i < n; i++) pk = Math.max(pk, Math.abs(x[i] - x[i - 1]) / 2)
  const g = Math.pow(10, bandDb / 20) / pk
  for (let i = 0; i < n; i++) x[i] = x[i] * g + 0.00056 * rnd() // room tone at −65 dBFS
  return { x, at }
}

/** Deepest transient cut (dB, positive) and the time it takes to let go, block by block. */
function transientTrace(x, p) {
  const k = new HFLimiterKernel(SR)
  k.setParams(toKernelParams(p))
  const out = new Float32Array(128), cuts = []
  for (let off = 0; off + 128 <= x.length; off += 128) {
    k.process([x.subarray(off, off + 128)], [out], 128)
    const g = k.shelf.takeMinTransientGain()
    cuts.push(g < 1 ? -20 * Math.log10(g) : 0)
  }
  return cuts
}

test('a click is cut by up to the Transient depth, even below Threshold, and let go within milliseconds', () => {
  for (const [bandDb, want] of [[-18, [11, 12.01]], [-40, [3, 12.01]]]) {
    const { x, at } = event(0.05, 0.1, 0.3, bandDb)
    const cuts = transientTrace(x, { ...BASE, range: 0, transient: 12 })
    const deepest = Math.max(...cuts)
    assert.ok(deepest >= want[0] && deepest <= want[1], `click at ${bandDb}: deepest cut ${deepest.toFixed(2)} dB`)
    const peakBlock = cuts.indexOf(deepest)
    const back = cuts.findIndex((c, i) => i > peakBlock && c < 0.1)
    const ms = ((back - peakBlock) * 128 / SR) * 1000
    assert.ok(back > 0 && ms < 30, `click at ${bandDb}: still cutting ${ms.toFixed(1)} ms later`)
    // And the cut is on the click, not somewhere else: it peaks within 2 ms of
    // it, as the shelf hears it — behind the Warmth stage and its peak guard.
    const seen = at + WARMTH_LATENCY_SAMPLES + warmthGuardLatencySamples(SR)
    assert.ok(Math.abs(peakBlock * 128 - seen) < 0.002 * SR + 128, `cut peaks ${((peakBlock * 128 - seen) / SR * 1000).toFixed(1)} ms from the click`)
  }
})

test('a steady or naturally rising S is left to the shelf', () => {
  // 20 ms onset, 150 ms body: the shape of an ordinary S out of room tone.
  const { x } = event(20, 150, 30, -20)
  const off = run(x, { ...BASE, range: 0, transient: 0 }).channelData[0]
  const on = run(x, { ...BASE, range: 0, transient: 12 }).channelData[0]
  let eOff = 0, eOn = 0
  for (let i = 1; i < x.length; i++) { eOff += (off[i] - off[i - 1]) ** 2; eOn += (on[i] - on[i - 1]) ** 2 }
  const loss = 10 * Math.log10(eOn / eOff)
  assert.ok(loss > -0.3, `a natural S lost ${loss.toFixed(2)} dB of top end to Transient 12`)
})

test('Transient stacks on the shelf: Range caps the shelf only', () => {
  const { x } = event(0.05, 0.1, 0.3, -10)
  // Threshold far below the click so the shelf sits on its 6 dB floor.
  const P = { ...BASE, threshold: -30, range: 6 }
  const k = new HFLimiterKernel(SR)
  k.setParams(toKernelParams({ ...P, transient: 12 }))
  const out = new Float32Array(128)
  let deepest = 0
  for (let off = 0; off + 128 <= x.length; off += 128) {
    k.process([x.subarray(off, off + 128)], [out], 128)
    const s = k.shelf.takeMinGain(), t = k.shelf.takeMinTransientGain()
    deepest = Math.max(deepest, -20 * Math.log10(s * t))
  }
  assert.ok(deepest > 6 + 10, `combined cut ${deepest.toFixed(2)} dB never went past Range 6 by the Transient`)
  assert.ok(deepest <= 6 + 12 + 0.01, `combined cut ${deepest.toFixed(2)} dB is past Range + Transient`)
})

test('the limiter never adds energy or raises the peak, whatever the settings', () => {
  // The regression that retired the acceleration limiter: its correction was
  // louder than an S, put +44 dB into 200–1000 Hz and raised the file peak.
  const sounds = [event(20, 150, 30, -20).x, event(2, 150, 30, -20).x, event(0.05, 0.1, 0.3, -18).x,
    add(sine(150, 0.4), sine(3000, 0.1), sine(9000, 0.05))]
  // Shelf off with Transient on is the case that exposed it: the old stage
  // raised the peak 4.5–6.9 dB and the band under ~350 Hz 7–9 dB there.
  const settings = [{}, { range: 0, transient: 12 }, { range: 0, transient: 1 }, { transient: 12 }, { transient: 12, range: 24, threshold: -30 },
    { shape: 'warm', transient: 12, tail: 300 }, { freq: 2000, transient: 6, threshold: -20 }]
  const bandsOf = y => {
    const lo = new Float64Array(y.length)
    let a = 0
    for (let i = 0; i < y.length; i++) { a += 0.05 * (y[i] - a); lo[i] = a } // one-pole ~350 Hz split
    let eLo = 0, eHi = 0, pk = 0
    for (let i = 0; i < y.length; i++) { eLo += lo[i] ** 2; eHi += (y[i] - lo[i]) ** 2; pk = Math.max(pk, Math.abs(y[i])) }
    return { eLo, eHi, pk }
  }
  for (const x of sounds) {
    const ref = bandsOf(x)
    for (const p of settings) {
      const { channelData: [y], latencySamples: L } = run(x, { ...BASE, ...p })
      const got = bandsOf(y.subarray(L))
      const tag = JSON.stringify(p)
      assert.ok(got.pk <= ref.pk * 1.0001, `${tag}: peak rose ${db(got.pk / ref.pk).toFixed(3)} dB`)
      assert.ok(got.eLo <= ref.eLo * 1.001, `${tag}: low band gained ${(10 * Math.log10(got.eLo / ref.eLo)).toFixed(3)} dB`)
      assert.ok(got.eHi <= ref.eHi * 1.001, `${tag}: high band gained ${(10 * Math.log10(got.eHi / ref.eHi)).toFixed(3)} dB`)
    }
  }
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
  const params = toKernelParams({ ...BASE, transient: 6 })
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
  assert.equal(toKernelParams({ transient: 0 }).transientDb, 0)
  assert.equal(toKernelParams({ transient: 6 }).transientDb, 6)
  assert.equal(toKernelParams({ transient: 40 }).transientDb, 12)
  assert.equal(toKernelParams({ transient: -3 }).transientDb, 0)
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


// ── Warmth: low-end harmonics ahead of the shelf ───────────────────────────

/**
 * Harmonic k of a steady tone at `f`, dB re the fundamental. Hann-weighted: an
 * unwindowed span that is not a whole number of cycles leaks the fundamental
 * ~63 dB down at 900 Hz, which read as a third-harmonic floor that was never there.
 */
function harmonicDbc(y, f, k, from, to) {
  const amp = fr => {
    let c = 0, s = 0
    for (let i = from; i < to; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - from)) / (to - from))
      const ph = (2 * Math.PI * fr * i) / SR
      c += w * y[i] * Math.cos(ph)
      s += w * y[i] * Math.sin(ph)
    }
    return Math.hypot(c, s)
  }
  return db(amp(k * f) / amp(f))
}

const WARM = { ...BASE, range: 0 } // shelf out, so only Warmth acts

test('Warmth 0 leaves the audio untouched', () => {
  const x = add(sine(200, 0.5), sine(3000, 0.2))
  const { channelData: [y], latencySamples: L } = run(x, { ...WARM, warmth: 0, oddEven: 30 })
  for (let i = L; i < x.length; i++) if (y[i] !== x[i - L]) assert.fail(`sample ${i} differs`)
})

test('Warmth 8 at full Odd is the tanh layer exactly as voiced on the Saturation Bench', () => {
  const x = add(sine(120, 0.25), sine(240, 0.1), noise(SR, 0.01))
  const refs = [-14, -16]
  const { channelData: [y], latencySamples: L } = run(x, { ...WARM, warmth: 8, oddEven: 0, warmthRefPeaksDb: refs })
  const bench = processSaturationBenchBuffer([x], SR, {
    layers: [{ on: false }, { ...WARMTH_LAYERS[1], on: true, amountDb: 0, refPeakDb: refs[1] }],
  }, { slots: 2 })
  const b = bench.channelData[0], Lb = bench.latencySamples
  let worst = 0, added = 0
  for (let i = SR / 4; i < x.length - L; i++) {
    worst = Math.max(worst, Math.abs((y[i + L] - x[i]) - (b[i + Lb] - x[i])))
    added = Math.max(added, Math.abs(b[i + Lb] - x[i]))
  }
  assert.ok(added > 1e-3, 'the tanh layer must add something')
  assert.ok(worst < 1e-6, `differs from the bench by ${worst}`)
})

test('a render from rest starts at the setting, not ramping in from the defaults', () => {
  // The kernel's constructor sets the defaults (Warmth off); the first real
  // params must jump, or the first 20 ms glide the Warmth amount in from 0 dB.
  const x = add(sine(120, 0.25), sine(240, 0.1))
  const refs = [-14, -16]
  const { channelData: [y], latencySamples: L } = run(x, { ...WARM, warmth: 3, oddEven: 0, warmthRefPeaksDb: refs })
  const bench = processSaturationBenchBuffer([x], SR, {
    layers: warmthLayers(3, 0, refs),
  }, { slots: 2 })
  const b = bench.channelData[0], Lb = bench.latencySamples
  let worst = 0
  for (let i = 0; i < 0.05 * SR; i++) worst = Math.max(worst, Math.abs(y[i + L] - b[i + Lb]))
  assert.ok(worst < 1e-6, `first 50 ms differ by ${worst}`)
})

test('Odd/Even: 0 is pure odd (tanh); turning it up brings in the even (quartic)', () => {
  const f = 120
  const at = oddEven => {
    const { channelData: [y], latencySamples: L } = run(sine(f, 0.3), { ...WARM, warmth: 10, oddEven, warmthRefPeaksDb: [-10, -10] })
    return { h2: harmonicDbc(y, f, 2, L + SR / 4, SR), h3: harmonicDbc(y, f, 3, L + SR / 4, SR) }
  }
  const odd = at(0), mixed = at(100)
  assert.ok(odd.h3 > odd.h2 + 10, `Odd: H2 ${odd.h2.toFixed(1)}, H3 ${odd.h3.toFixed(1)} dBc`)
  assert.ok(mixed.h2 > odd.h2 + 10, `100: H2 ${mixed.h2.toFixed(1)} vs ${odd.h2.toFixed(1)} dBc at 0`)
})

test('the Warmth law: 3 dB a step, equal-power Odd/Even over the first ODD_EVEN_SPAN of the blend', () => {
  const amt = (w, b) => warmthLayers(w, b).map(l => (l.on ? l.amountDb : -Infinity))
  // Warmth 8 at full Odd is the tanh at Amount 0; each step is 3 dB.
  assert.ok(Math.abs(amt(8, 0)[1]) < 1e-9)
  assert.ok(Math.abs(amt(10, 0)[1] - 6) < 1e-9)
  assert.ok(Math.abs(amt(10, 0)[1] - amt(7, 0)[1] - 9) < 1e-9)
  // Knob 100 is the old scale's 25: the crossfade angle is ODD_EVEN_SPAN · 90°.
  const th = (ODD_EVEN_SPAN * Math.PI) / 2
  const [q, t] = amt(8, 100)
  assert.ok(Math.abs(t - 20 * Math.log10(Math.cos(th))) < 1e-9, `tanh at 100: ${t}`)
  assert.ok(Math.abs(q - (WARMTH_EVEN_MATCH_DB + 20 * Math.log10(Math.sin(th)))) < 1e-9, `quartic at 100: ${q}`)
  // Equal power: the two gains' squares sum to one at every position.
  for (const b of [0, 36, 100]) {
    const [qq, tt] = amt(8, b)
    const p = (qq === -Infinity ? 0 : 10 ** ((qq - WARMTH_EVEN_MATCH_DB) / 10)) + 10 ** (tt / 10)
    assert.ok(Math.abs(p - 1) < 1e-9, `power at ${b}: ${p}`)
  }
  // 0 takes the quartic out; 100 keeps both; Warmth 0 takes both out.
  assert.deepEqual(warmthLayers(8, 0).map(l => l.on), [false, true])
  assert.deepEqual(warmthLayers(8, 100).map(l => l.on), [true, true])
  assert.deepEqual(warmthLayers(0, 50).map(l => l.on), [false, false])
  // Calibration rides along when measured, and only then.
  assert.equal(warmthLayers(5, 50, [-12, -13])[1].refPeakDb, -13)
  assert.equal('refPeakDb' in warmthLayers(5, 50)[0], false)
})

test('Warmth works only in its low band: material above it passes untouched', () => {
  // ⚠ NOT "quiet material passes at its own level": at these drives the layers
  // saturate even quiet low-band content, and what they add includes the
  // band's own reshaped level — that is the character (Southern Sunrise at
  // Warmth 8: +4.9 dB at 120–250 Hz). Above the bands nothing moves.
  const quiet = sine(1500, 0.003)
  const { channelData: [q], latencySamples: L } = run(quiet, { ...WARM, warmth: 10, oddEven: 50 })
  const g = db(toneAmp(q, 1500, L + SR / 4, SR) / 0.003)
  assert.ok(Math.abs(g) < 0.05, `a 1.5 kHz tone moved ${g.toFixed(3)} dB at Warmth 10`)
})

test('AUTO makeup: a plain gain after the Warmth stage, only with AUTO on and a layer up', () => {
  const x = add(sine(120, 0.25), sine(240, 0.1), noise(SR, 0.01))
  const refs = [-14, -16]
  const p = { ...WARM, warmth: 6, oddEven: 30, warmthRefPeaksDb: refs, warmthMakeupDb: -4 }
  const off = run(x, p).channelData[0]
  const on = run(x, { ...p, warmthMakeup: 'loud' }).channelData[0]
  const g = 10 ** (-4 / 20)
  let worst = 0
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(on[i] - off[i] * g))
  // From rest, the first sample is already at the makeup: no glide in.
  assert.ok(worst < 1e-6, `AUTO differs from the stage times the makeup by ${worst}`)
  assert.equal(toKernelParams({ ...p, warmthMakeup: 'off' }).warmthMakeupDb, 0)
  assert.equal(toKernelParams({ ...p, warmthMakeup: 'loud', warmth: 0 }).warmthMakeupDb, 0)
  assert.equal(toKernelParams({ ...p, warmthMakeup: 'loud', warmthMakeupDb: -60 }).warmthMakeupDb, -24)
})

// ── Warmth peak guard ────────────────────────────────────────────────────────

const peakOf = (y, from = 0) => { let m = 0; for (let i = from; i < y.length; i++) m = Math.max(m, Math.abs(y[i])); return m }

test('the peak guard holds the result at the source peak, and only touches the added signal', () => {
  // A bass-heavy voice stand-in: Odd 10 overshoots the source peak by several dB.
  const x = add(sine(110, 0.3), sine(220, 0.12), noise(SR, 0.01))
  const refs = [-16, -18]
  const ceilingDb = 20 * Math.log10(peakOf(x))
  const p = { ...WARM, warmth: 10, oddEven: 0, warmthRefPeaksDb: refs, warmthCeilingDb: ceilingDb }
  const off = run(x, p)
  const on = run(x, { ...p, warmthGuard: true })
  const L = on.latencySamples
  assert.equal(L, off.latencySamples, 'the guard never moves the audio')
  const yOff = peakOf(off.channelData[0], L), yOn = peakOf(on.channelData[0], L)
  assert.ok(yOff > peakOf(x) * 1.2, `the fixture must overshoot: ${(20 * Math.log10(yOff / peakOf(x))).toFixed(2)} dB`)
  assert.ok(yOn <= peakOf(x) * (1 + 1e-6), `guarded peak ${(20 * Math.log10(yOn / peakOf(x))).toFixed(4)} dB over the source`)
  // Between the voice and the full warmth: every output sample is x + g·a with 0 ≤ g ≤ 1.
  const yo = off.channelData[0], yn = on.channelData[0]
  for (let i = L; i < x.length; i++) {
    const dry = x[i - L], a = yo[i] - dry, b = yn[i] - dry
    if (Math.abs(a) > 1e-6) {
      const g = b / a
      if (g < -1e-4 || g > 1 + 1e-4) assert.fail(`sample ${i}: gain on the added signal ${g}`)
    }
  }
})

test('the peak guard is a pure delay when it has nothing to catch, or no ceiling', () => {
  const x = add(sine(110, 0.3), sine(220, 0.12))
  const refs = [-16, -18]
  const p = { ...WARM, warmth: 4, oddEven: 30, warmthRefPeaksDb: refs }
  const off = run(x, p).channelData[0]
  // No ceiling measured: the guard has nothing to hold to.
  const none = run(x, { ...p, warmthGuard: true }).channelData[0]
  for (let i = 0; i < x.length; i++) if (none[i] !== off[i]) assert.fail(`no ceiling: sample ${i} differs`)
  // A ceiling far above anything the stage reaches.
  const high = run(x, { ...p, warmthGuard: true, warmthCeilingDb: 12 }).channelData[0]
  for (let i = 0; i < x.length; i++) if (high[i] !== off[i]) assert.fail(`high ceiling: sample ${i} differs`)
  assert.equal(toKernelParams({ ...p, warmth: 0, warmthGuard: true, warmthCeilingDb: -6 }).warmthGuard.on, false)
})
