/**
 * PHAT*SS — the claims the design rests on: the Warmth stage and its peak
 * guard (moved here from the HF Limiter), the Tame/Tone macro onto the tape
 * shelf, and the constant latency of the whole chain.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processPhatssBuffer } from '../../src/audio/phatssProcessor.js'
import {
  toKernelParams, phatssLatencySamples, tapeShelf, TAPE_SHELF, PHATSS_DEFAULTS,
  WARMTH_LAYERS, WARMTH_LATENCY_SAMPLES, WARMTH_EVEN_MATCH_DB, WARMTH_TOP_DB, ODD_EVEN_SPAN, warmthLayers,
} from '../../src/audio/phatssParams.js'
import { HF_LIMITER_DEFAULTS, toKernelParams as toHFLimiterKernelParams } from '../../src/audio/hfLimiterParams.js'
import { processHFLimiterBuffer } from '../../src/audio/hfLimiterProcessor.js'
import { processSaturationBenchBuffer } from '../../src/audio/dsp/saturationLayers.js'
import { warmthGuardLatencySamples } from '../../src/audio/dsp/warmthGuard.js'
import { shelfLatencySamples } from '../../src/audio/dsp/hfLimit.js'

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

const db = x => 20 * Math.log10(x)
const run = (x, p) => processPhatssBuffer([x], SR, toKernelParams(p))

// ── The chain ────────────────────────────────────────────────────────────────

test('the latency is Warmth + guard + shelf, constant at every setting (Soften adds none)', () => {
  const L = phatssLatencySamples(SR)
  assert.equal(L, WARMTH_LATENCY_SAMPLES + warmthGuardLatencySamples(SR) + shelfLatencySamples(SR))
  for (const [warmth, tame, soften] of [[0, 0, 0], [0, 10, 0], [6, 0, 0], [10, 10, 10], [0, 0, 10]]) {
    const x = new Float32Array(8192)
    x[100] = 0.001 // far below every threshold
    const { channelData: [y], latencySamples } = run(x, { voiceLevelDb: -20, warmth, tame, soften })
    assert.equal(latencySamples, L)
    assert.ok(Math.abs(y[100 + L] - x[100]) < 1e-5, `warmth ${warmth} tame ${tame} soften ${soften}: impulse at ${L} reads ${y[100 + L]}`)
  }
})

test('Warmth 0, Soften 0 and Tame 0 pass the audio through untouched', () => {
  const x = add(sine(200, 0.5), sine(3000, 0.2), sine(9000, 0.2))
  const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tame: 0, oddEven: 30 })
  for (let i = L; i < x.length; i++) if (y[i] !== x[i - L]) assert.fail(`sample ${i} differs`)
})

test('the Tame/Tone macro: Tame 5 / Tone 10 is the HF Limiter default shelf', () => {
  const s = tapeShelf(5, 10)
  assert.ok(Math.abs(s.cornerHz - 12000) < 1e-9)
  assert.equal(s.thresholdRelDb, -8)
  assert.ok(Math.abs(s.rangeDb - 12) < 1e-9)
  // The ends: Tame 0 is out, Tame 10 the deepest; Tone sweeps 2–12 kHz on a log scale.
  assert.equal(tapeShelf(0, 10).rangeDb, 0)
  assert.ok(Math.abs(tapeShelf(10, 10).rangeDb - 24) < 1e-9)
  assert.ok(Math.abs(tapeShelf(5, 0).cornerHz - 2000) < 1e-9)
  assert.ok(Math.abs(tapeShelf(5, 5).cornerHz - Math.sqrt(2000 * 12000)) < 1e-6)
  // Threshold and Range move together, monotone: more Tame acts earlier and deeper.
  for (let t = 1; t <= 10; t++) {
    assert.ok(tapeShelf(t, 10).thresholdRelDb < tapeShelf(t - 1, 10).thresholdRelDb)
    assert.ok(tapeShelf(t, 10).rangeDb > tapeShelf(t - 1, 10).rangeDb)
  }
  // Shape and timing are pinned, whatever the panel sends.
  const k = toKernelParams({ ...PHATSS_DEFAULTS, voiceLevelDb: -20 })
  for (const key of Object.keys(TAPE_SHELF)) assert.equal(k[key], TAPE_SHELF[key], key)
  assert.equal(k.thresholdDb, -28)
})

test('with Warmth off, the tape shelf is the HF Limiter at the matching settings', () => {
  const x = add(sine(300, 0.3), sine(6000, 0.2), noise(SR, 0.05, 3))
  const ph = run(x, { voiceLevelDb: -20, warmth: 0, tame: 5, tone: 10 })
  const hf = processHFLimiterBuffer([x], SR, toHFLimiterKernelParams({
    ...HF_LIMITER_DEFAULTS, voiceLevelDb: -20, freq: 12000, threshold: -8, range: 12,
    shape: 'warm', release: TAPE_SHELF.releaseMs, tail: 0, transient: 0, output: 0,
  }))
  const a = ph.channelData[0], b = hf.channelData[0]
  const off = ph.latencySamples - hf.latencySamples
  let worst = 0
  for (let i = hf.latencySamples; i < x.length - off; i++) worst = Math.max(worst, Math.abs(a[i + off] - b[i]))
  assert.ok(worst < 1e-6, `differs from the HF Limiter by ${worst}`)
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

const WARM = { voiceLevelDb: -20, tame: 0 } // shelf out, so only Warmth acts

test('Warmth 0 leaves the audio untouched', () => {
  const x = add(sine(200, 0.5), sine(3000, 0.2))
  const { channelData: [y], latencySamples: L } = run(x, { ...WARM, warmth: 0, oddEven: 30 })
  for (let i = L; i < x.length; i++) if (y[i] !== x[i - L]) assert.fail(`sample ${i} differs`)
})

test('Warmth at full Odd is the odd (cubic) layer as voiced on the Saturation Bench, at the law\'s Amount', () => {
  const x = add(sine(120, 0.25), sine(240, 0.1), noise(SR, 0.01))
  const refs = [-14, -16]
  const { channelData: [y], latencySamples: L } = run(x, { ...WARM, warmth: 8, oddEven: 0, warmthRefPeaksDb: refs })
  const amountDb = warmthLayers(8, 0)[1].amountDb
  const bench = processSaturationBenchBuffer([x], SR, {
    layers: [{ on: false }, { ...WARMTH_LAYERS[1], on: true, amountDb, refPeakDb: refs[1] }],
  }, { slots: 2 })
  const b = bench.channelData[0], Lb = bench.latencySamples
  let worst = 0, added = 0
  for (let i = SR / 4; i < x.length - L; i++) {
    worst = Math.max(worst, Math.abs((y[i + L] - x[i]) - (b[i + Lb] - x[i])))
    added = Math.max(added, Math.abs(b[i + Lb] - x[i]))
  }
  assert.ok(added > 1e-3, 'the odd layer must add something')
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

test('Odd/Even: 0 is pure odd (cubic); turning it up brings in the even (quartic)', () => {
  const f = 120
  const at = oddEven => {
    const { channelData: [y], latencySamples: L } = run(sine(f, 0.3), { ...WARM, warmth: 10, oddEven, warmthRefPeaksDb: [-10, -10] })
    return { h2: harmonicDbc(y, f, 2, L + SR / 4, SR), h3: harmonicDbc(y, f, 3, L + SR / 4, SR) }
  }
  const odd = at(0), mixed = at(100)
  assert.ok(odd.h3 > odd.h2 + 10, `Odd: H2 ${odd.h2.toFixed(1)}, H3 ${odd.h3.toFixed(1)} dBc`)
  assert.ok(mixed.h2 > odd.h2 + 10, `100: H2 ${mixed.h2.toFixed(1)} vs ${odd.h2.toFixed(1)} dBc at 0`)
})

test('the Warmth law: linear in amplitude to +6 dB, equal-power Odd/Even over the first ODD_EVEN_SPAN of the blend', () => {
  const amt = (w, b) => warmthLayers(w, b).map(l => (l.on ? l.amountDb : -Infinity))
  // The top is +6 dB at full Odd; the added amplitude is proportional to the knob.
  assert.ok(Math.abs(amt(10, 0)[1] - WARMTH_TOP_DB) < 1e-9)
  for (const w of [1, 2.5, 5, 8]) {
    const ratio = 10 ** ((amt(w, 0)[1] - amt(10, 0)[1]) / 20)
    assert.ok(Math.abs(ratio - w / 10) < 1e-12, `Warmth ${w}: amplitude ratio ${ratio}`)
  }
  // So Warmth 5 is half of 10: Amount 0, the bench voicing, within float rounding.
  assert.ok(Math.abs(amt(5, 0)[1] - (WARMTH_TOP_DB + 20 * Math.log10(0.5))) < 1e-9)
  // Knob 100 is the old scale's 25: the crossfade angle is ODD_EVEN_SPAN · 90°.
  const th = (ODD_EVEN_SPAN * Math.PI) / 2
  const lv = WARMTH_TOP_DB + 20 * Math.log10(0.8) // Warmth 8's level before the split
  const [q, t] = amt(8, 100).map(v => v - lv)
  assert.ok(Math.abs(t - 20 * Math.log10(Math.cos(th))) < 1e-9, `odd at 100: ${t}`)
  assert.ok(Math.abs(q - (WARMTH_EVEN_MATCH_DB + 20 * Math.log10(Math.sin(th)))) < 1e-9, `quartic at 100: ${q}`)
  // Equal power: the two gains' squares sum to one at every position.
  for (const b of [0, 36, 100]) {
    const [qq, tt] = amt(8, b).map(v => v - lv)
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

// ── Warmth peak guard ────────────────────────────────────────────────────────

const peakOf = (y, from = 0) => { let m = 0; for (let i = from; i < y.length; i++) m = Math.max(m, Math.abs(y[i])); return m }

test('the peak guard holds the result at the source peak, and only touches the added signal', () => {
  // A bass-heavy voice stand-in: Odd 10 overshoots the source peak by several dB.
  const x = add(sine(110, 0.3), sine(220, 0.12), noise(SR, 0.01))
  const refs = [-16, -18]
  const ceilingDb = 20 * Math.log10(peakOf(x))
  const p = { ...WARM, warmth: 10, oddEven: 0, warmthRefPeaksDb: refs, warmthCeilingDb: ceilingDb }
  // No ceiling measured: the guard has nothing to hold to, which is the unguarded stage.
  const off = run(x, { ...p, warmthCeilingDb: null })
  const on = run(x, p)
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
  // No ceiling measured: the guard has nothing to hold to.
  const off = run(x, p).channelData[0]
  // A ceiling far above anything the stage reaches is the same render, bit for bit.
  const high = run(x, { ...p, warmthCeilingDb: 12 }).channelData[0]
  for (let i = 0; i < x.length; i++) if (high[i] !== off[i]) assert.fail(`high ceiling: sample ${i} differs`)
  assert.equal(toKernelParams({ ...p, warmth: 0, warmthCeilingDb: -6 }).warmthGuard.on, false)
  // Pinned on with Warmth: there is no switch.
  assert.equal(toKernelParams({ ...p, warmthCeilingDb: -6 }).warmthGuard.on, true)
})

// ── Soften: the shelf's Transient on its own band ───────────────────────────

/** Room tone, a steady 150 Hz voice-like tone, and an HF click burst at `at`. */
function clickOverVoice(at = Math.round(0.4 * SR), clickAmp = 0.3) {
  const x = add(sine(150, 0.2), noise(SR, 0.0005, 7))
  let r = 9
  for (let i = at; i < at + Math.round(0.002 * SR); i++) {
    r = (r * 16807) % 2147483647
    x[i] += clickAmp * ((r / 2147483647) * 2 - 1)
  }
  return x
}
const rmsDb = (y, a, b) => { let s = 0; for (let i = a; i < b; i++) s += y[i] * y[i]; return 10 * Math.log10(s / (b - a)) }
const SOFT = { voiceLevelDb: -20, warmth: 0, tame: 0 }

/** Energy removed around the click, dB re the click's own energy (0 = all of it). */
function removedDb(x, y, L, at) {
  let e = 0, c = 0
  for (let i = at - 50; i < at + Math.round(0.01 * SR); i++) e += (y[i + L] - x[i]) ** 2
  for (let i = at; i < at + Math.round(0.002 * SR); i++) c += (x[i] - 0.2 * Math.sin((2 * Math.PI * 150 * i) / SR)) ** 2
  return 10 * Math.log10(e / c)
}

test('Soften cuts a sudden HF burst, more as the knob rises, more than the HF Limiter Transient can', () => {
  const at = Math.round(0.4 * SR)
  const x = clickOverVoice(at)
  let prev = -Infinity
  for (const soften of [2, 5, 10]) {
    const { channelData: [y], latencySamples: L } = run(x, { ...SOFT, soften })
    const r = removedDb(x, y, L, at)
    assert.ok(r > prev + 0.5, `Soften ${soften}: removed ${r.toFixed(2)} dB re the click (previous ${prev.toFixed(2)})`)
    prev = r
  }
  // The HF Limiter's Transient at its maximum, same corner and split shape.
  const h = processHFLimiterBuffer([x], SR, toHFLimiterKernelParams({
    ...HF_LIMITER_DEFAULTS, voiceLevelDb: -20, range: 0, transient: 12, freq: 3000, shape: 'warm',
  }))
  const rh = removedDb(x, h.channelData[0], h.latencySamples, at)
  assert.ok(prev > rh + 1, `full Soften removed ${prev.toFixed(2)} dB, the HF Limiter's Transient 12 ${rh.toFixed(2)}`)
})

test('Soften leaves steady sound and the voice below its band alone', () => {
  const at = Math.round(0.4 * SR)
  const x = clickOverVoice(at)
  const { channelData: [yr], latencySamples: L } = run(x, { ...SOFT, soften: 10 })
  const y = yr.subarray(L)
  // Away from the burst the 150 Hz voice passes untouched.
  const quiet = [Math.round(0.6 * SR), Math.round(0.9 * SR)]
  assert.ok(Math.abs(rmsDb(y, ...quiet) - rmsDb(x, ...quiet)) < 0.01, 'the steady voice moved')
  // During the burst the 150 Hz fundamental barely moves: the cut is on the band above Soft Freq.
  const f0 = toneAmp(y, 150, at - Math.round(0.002 * SR), at + Math.round(0.02 * SR)) / toneAmp(x, 150, at - Math.round(0.002 * SR), at + Math.round(0.02 * SR))
  assert.ok(db(f0) > -0.5, `the 150 Hz voice under the click moved ${db(f0).toFixed(2)} dB`)
  // A steady HF tone (an S held) is not a transient.
  const s = add(sine(6000, 0.1), noise(SR, 0.0005, 3))
  const { channelData: [ys], latencySamples: Ls } = run(s, { ...SOFT, soften: 10 })
  const g = db(toneAmp(ys, 6000, Ls + SR / 2, SR) / 0.1)
  assert.ok(Math.abs(g) < 0.1, `a steady 6 kHz tone moved ${g.toFixed(2)} dB`)
})

test('Soften has its own corner: moving Soft Freq moves where it cuts, Tone does not', () => {
  const at = Math.round(0.4 * SR)
  const x = clickOverVoice(at)
  const removed = p => { const { channelData: [y], latencySamples: L } = run(x, { ...SOFT, soften: 10, ...p }); return removedDb(x, y, L, at) }
  // Lower Soft Freq reaches further down the burst's spectrum, so takes more of it.
  const lo = removed({ softenFreq: 1500 }), hi = removed({ softenFreq: 8000 })
  assert.ok(lo > hi + 1, `Soft Freq 1.5 kHz removed ${lo.toFixed(2)} dB, 8 kHz ${hi.toFixed(2)}`)
  // Tone only moves the tape shelf, which is out at Tame 0.
  const a = run(x, { ...SOFT, soften: 10, tone: 0 }).channelData[0]
  const b = run(x, { ...SOFT, soften: 10, tone: 10 }).channelData[0]
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail(`sample ${i}: Tone changed Soften`)
})

test('Soften maps onto the shelf Transient: deeper ceiling, steeper law, own corner, gate on the voice', () => {
  const k0 = toKernelParams({ soften: 0, voiceLevelDb: -20 })
  assert.equal(k0.transientDb, 0)
  const k = toKernelParams({ soften: 10, softenFreq: 2500, voiceLevelDb: -20 })
  assert.ok(Math.abs(k.transientDb - 36) < 1e-9)
  assert.equal(k.transientSlope, 1)
  assert.equal(k.transientCornerHz, 2500)
  assert.equal(k.transientGateDb, -52)
  assert.ok(Math.abs(toKernelParams({ soften: 5 }).transientSlope - 0.75) < 1e-12)
  assert.equal(toKernelParams({ softenFreq: 50 }).transientCornerHz, 1000)
  assert.equal(PHATSS_DEFAULTS.soften, 0)
})
