/**
 * Run with:  npm test
 *
 * Plosive Tamer: the POP stage (a P or B's low thump) and the BURST stage (a
 * T, K or P release out of a stop's silence — the De-Esser's old "Plosives"
 * detector, whose tests moved here with it). Deterministic synthetic voice.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PlosiveKernel, PLOSIVE_KERNEL_DEFAULTS, PLOSIVE_TUNING, processPlosiveBuffer,
} from '../../src/audio/plosiveProcessor.js'
import {
  PLOSIVE_DEFAULTS, toKernelParams, plosiveLatencySamples, popThresholdsDb, burstRiseDb,
} from '../../src/audio/plosiveParams.js'
import { highpass, lowpass, peaking } from '../../src/audio/dsp/biquad.js'

const SR = 44100

function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 4294967296) * 2 - 1
  }
}

function biquad(c) {
  let z1 = 0
  let z2 = 0
  return (x) => {
    const y = c.b0 * x + z1
    z1 = c.b1 * x - c.a1 * y + z2
    z2 = c.b2 * x - c.a2 * y
    return y
  }
}

/**
 * Vowel (pulse train through a glottal roll-off and two formants), a gap of
 * `gapMs` (the closure), then an event at the gap's end, then the vowel again
 * after `eventMs`:
 *   'pop'   a 45 Hz decaying thump (30 ms) — a P's air on the capsule
 *   't'     3–10 kHz noise with a `rampMs` onset — a T's release
 *   'none'  nothing: the vowel simply restarts after the gap
 * `f0` sets the voice's pitch; `level` scales the event; `vowelMs` (default
 * `eventMs`) is when the vowel restarts after the gap — 0 puts the event over
 * the vowel's own onset.
 */
function makeVoice(sr, { f0 = 130, event = 'none', gapMs = 40, eventMs = 25, vowelMs = eventMs, rampMs = 1, level = 1, seed = 7, seconds = 1 } = {}) {
  const rnd = lcg(seed)
  const n = Math.round(sr * seconds)
  const x = new Float32Array(n)
  const glot = biquad(lowpass(sr, 400, 0.7))
  const f1 = biquad(peaking(sr, 700, 3, 12))
  const f2 = biquad(peaking(sr, 1200, 3, 10))
  const h1 = biquad(highpass(sr, 3000, 0.7))
  const h2 = biquad(highpass(sr, 3000, 0.7))
  const l1 = biquad(lowpass(sr, 10000, 0.7))
  const g0 = Math.round(sr * 0.4)
  const b0 = g0 + Math.round(sr * gapMs / 1000)
  const b1 = b0 + Math.round(sr * eventMs / 1000)
  const v1 = b0 + Math.round(sr * vowelMs / 1000)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const voiced = i < g0 || i >= v1
    phase += f0 / sr
    if (phase >= 1) phase -= 1
    const v = f2(f1(glot(voiced && phase < f0 / sr ? 1 : 0))) * 12.6
    const nz = l1(h2(h1(rnd())))
    let e = 0
    if (event === 'pop' && i >= b0) {
      const t = (i - b0) / sr
      e = 0.5 * level * Math.sin(2 * Math.PI * 45 * t) * Math.exp(-t / 0.03) * Math.min(1, t / 0.003)
    } else if (event === 't' && i >= b0 && i < b1) {
      e = nz * 0.25 * level * Math.min(1, (i - b0) / Math.max(1, sr * rampMs / 1000))
    }
    x[i] = (voiced ? v : 0) + e
  }
  return { x, b0, b1 }
}

/** Run the kernel; returns the output re-aligned to the input, and the kernel. */
function run(x, params = {}, opts = {}) {
  const r = processPlosiveBuffer([x], SR, toKernelParams({ ...PLOSIVE_DEFAULTS, ...params }), opts)
  return { y: r.channelData[0].subarray(r.latencySamples), kernel: r.kernel, latency: r.latencySamples }
}

/** Band energy, dB, over [a, b) of `y` (filter state run from the start). */
function bandDb(y, a, b, coeffs) {
  const fs = coeffs.map(biquad)
  let e = 0
  for (let i = 0; i < y.length && i < b; i++) {
    let v = y[i]
    for (const f of fs) v = f(v)
    if (i >= a) e += v * v
  }
  return 10 * Math.log10(e / (b - a))
}
const LOW = [lowpass(SR, 120, 0.7), lowpass(SR, 120, 0.7)]
const HIGH = [highpass(SR, 3000, 0.7), highpass(SR, 3000, 0.7)]

function maxDiff(a, b) {
  let d = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(a[i] - b[i]))
  return d
}

// ── Contract ────────────────────────────────────────────────────────────────

test('kernel defaults are the panel defaults; Burst Sensitivity 50 is the De-Esser\'s 12 dB', () => {
  assert.deepEqual(PLOSIVE_KERNEL_DEFAULTS, toKernelParams(PLOSIVE_DEFAULTS))
  assert.equal(burstRiseDb(50), 12)
  const lo = popThresholdsDb(0)
  const hi = popThresholdsDb(100)
  assert.ok(hi.ratioDb < lo.ratioDb && hi.riseDb < lo.riseDb, 'higher sensitivity lowers both thresholds')
})

test('latency is constant, the same with both stages out, and matches the params module', () => {
  const { x } = makeVoice(SR, { event: 'pop' })
  for (const p of [{}, { popDepth: 0, burstDepth: 0 }, { popFreq: 250, burstLength: 80 }]) {
    const r = processPlosiveBuffer([x], SR, toKernelParams(p))
    assert.equal(r.latencySamples, plosiveLatencySamples(SR))
  }
  for (const sr of [44100, 48000, 96000]) assert.equal(new PlosiveKernel(sr).latencySamples, plosiveLatencySamples(sr))
})

test('where nothing is caught the audio passes through bit for bit, delayed', () => {
  const { x } = makeVoice(SR, { event: 'none' })
  const { y, kernel } = run(x)
  assert.equal(kernel.pops + kernel.bursts, 0)
  for (let i = 0; i < y.length; i++) assert.equal(y[i], x[i])
})

test('both stages at Depth 0 are a pure delay, even on a pop and a T', () => {
  for (const event of ['pop', 't']) {
    const { x } = makeVoice(SR, { event })
    const { y } = run(x, { popDepth: 0, burstDepth: 0 })
    for (let i = 0; i < y.length; i++) assert.equal(y[i], x[i])
  }
})

test('delta is exactly what was removed', () => {
  const { x } = makeVoice(SR, { event: 'pop' })
  const { y } = run(x)
  const { y: d } = run(x, {}, { listen: 'delta' })
  let worst = 0
  for (let i = 0; i < y.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i] - d[i]))
  assert.ok(worst < 1e-6, `worst ${worst}`)
})

test('stereo is linked: identical channels come out identical', () => {
  const { x } = makeVoice(SR, { event: 'pop' })
  const r = processPlosiveBuffer([x, x.slice()], SR, toKernelParams({}))
  for (let i = 0; i < x.length; i++) assert.equal(r.channelData[0][i], r.channelData[1][i])
})

// ── POP ─────────────────────────────────────────────────────────────────────

test('pop: a P thump is caught and its low band taken down; the top is untouched', () => {
  const { x, b0 } = makeVoice(SR, { event: 'pop' })
  const { y, kernel } = run(x)
  assert.equal(kernel.pops, 1)
  const a = b0
  const b = b0 + Math.round(SR * 0.08)
  const cut = bandDb(x, a, b, LOW) - bandDb(y, a, b, LOW)
  assert.ok(cut > 6, `low band down ${cut.toFixed(2)} dB`)
  const top = Math.abs(bandDb(x, a, b, HIGH) - bandDb(y, a, b, HIGH))
  assert.ok(top < 0.2, `top band moved ${top.toFixed(2)} dB`)
  // Before the pop, nothing moved.
  for (let i = 0; i < b0 - plosiveLatencySamples(SR); i++) assert.equal(y[i], x[i])
})

test('pop: Depth caps the cut, and a deeper Depth cuts more', () => {
  const { x, b0 } = makeVoice(SR, { event: 'pop', level: 2 })
  const a = b0
  const b = b0 + Math.round(SR * 0.06)
  const cuts = [3, 9, 18].map(d => bandDb(x, a, b, LOW) - bandDb(run(x, { popDepth: d }).y, a, b, LOW))
  assert.ok(cuts[0] < cuts[1] && cuts[1] < cuts[2], cuts.map(c => c.toFixed(2)).join(' '))
  assert.ok(cuts[0] < 3.5, `Depth 3 cut ${cuts[0].toFixed(2)} dB`)
})

test('pop: a deep voice\'s steady low end is never caught, at any sensitivity', () => {
  for (const f0 of [85, 100, 120]) {
    const { x } = makeVoice(SR, { f0, event: 'none', gapMs: 300 })
    const { y, kernel } = run(x, { popSensitivity: 100 })
    assert.equal(kernel.pops, 0, `f0 ${f0}`)
    assert.equal(maxDiff(y, x), 0, `f0 ${f0}`)
  }
})

test('pop: a vowel onset after a closure is not a pop (its voice band arrives with it)', () => {
  const { x } = makeVoice(SR, { event: 'none', gapMs: 60 })
  assert.equal(run(x, { popSensitivity: 100 }).kernel.pops, 0)
})

test('pop: a jump far below the file\'s voice level is room rumble, not a pop', () => {
  const { x } = makeVoice(SR, { event: 'pop' })
  const quiet = x.map(v => v * 0.002) // −54 dB: the thump now sits far under a −20 dBFS voice
  const { kernel } = run(quiet, { voiceLevelDb: -20 })
  assert.equal(kernel.pops, 0)
  // Measured at its own level, the same file's pop is caught.
  assert.equal(run(quiet, { voiceLevelDb: -74 }).kernel.pops, 1)
})

test('pop: Sensitivity — a mild thump is missed at 0 and caught at 100, once', () => {
  for (const level of [0.12, 0.15, 0.2]) {
    const { x } = makeVoice(SR, { event: 'pop', level })
    assert.equal(run(x, { popSensitivity: 0 }).kernel.pops, 0, `level ${level}`)
    assert.equal(run(x, { popSensitivity: 100 }).kernel.pops, 1, `level ${level}: one thump, one pop`)
  }
})

test('pop: the cut is in place by the pop\'s first sample (lookahead)', () => {
  const { x, b0 } = makeVoice(SR, { event: 'pop' })
  const k = new PlosiveKernel(SR)
  k.setParams(toKernelParams({}))
  const out = new Float32Array(x.length)
  const gains = new Float32Array(x.length)
  for (let o = 0; o < x.length; o += 1) {
    k.process([x.subarray(o, o + 1)], [out.subarray(o, o + 1)], 1)
    gains[o] = k.popGain.g
  }
  // gains[o] is applied to input sample o − latency; the pop is fully detected
  // a few ms in, and the cut must already be there within 1 ms of its start.
  const L = k.latencySamples
  const at = b0 + Math.round(SR * 0.004) + L
  assert.ok(gains[at] < 0.8, `gain ${gains[at].toFixed(3)} 4 ms into the pop`)
})

// ── BURST (from the De-Esser) ───────────────────────────────────────────────

test('burst: a T after a closure is caught and its top band cut; the low band is untouched', () => {
  const { x, b0, b1 } = makeVoice(SR, { event: 't' })
  const { y, kernel } = run(x)
  assert.equal(kernel.bursts, 1)
  assert.equal(kernel.pops, 0)
  const cut = bandDb(x, b0, b1, HIGH) - bandDb(y, b0, b1, HIGH)
  assert.ok(cut > 4, `T burst top band down ${cut.toFixed(2)} dB`)
  const low = Math.abs(bandDb(x, b0, b1 + 2000, LOW) - bandDb(y, b0, b1 + 2000, LOW))
  assert.ok(low < 0.2, `low band moved ${low.toFixed(2)} dB`)
})

test('burst: a pause is not a closure, and an "s" building up is not a burst', () => {
  // A fricative after a long pause (phrase start): not a stop's closure.
  assert.equal(run(makeVoice(SR, { event: 't', gapMs: 400, seconds: 1.4 }).x).kernel.bursts, 0, 'a 400 ms pause should not count')
  // No closure at all: the burst runs straight out of the vowel.
  assert.equal(run(makeVoice(SR, { event: 't', gapMs: 0 }).x).kernel.bursts, 0, 'no closure should mean no burst')
  // An "s" after a closure that builds over 40 ms rises too slowly to count.
  assert.equal(run(makeVoice(SR, { event: 't', rampMs: 40, eventMs: 100 }).x).kernel.bursts, 0, 'a slow-onset "s" should not count')
})

test('burst: Depth 0 takes the stage out; Depth sets how far it is cut', () => {
  const { x, b0, b1 } = makeVoice(SR, { event: 't' })
  const off = run(x, { burstDepth: 0 })
  assert.equal(off.kernel.bursts, 0)
  const c3 = bandDb(x, b0, b1, HIGH) - bandDb(run(x, { burstDepth: 3 }).y, b0, b1, HIGH)
  const c12 = bandDb(x, b0, b1, HIGH) - bandDb(run(x, { burstDepth: 12 }).y, b0, b1, HIGH)
  assert.ok(c12 > c3 + 3, `Depth 3: ${c3.toFixed(2)} dB, Depth 12: ${c12.toFixed(2)} dB`)
})

test('burst: Sensitivity 0 misses a T that rises more slowly; 100 catches it', () => {
  const { x } = makeVoice(SR, { event: 't', rampMs: 15, eventMs: 35 })
  assert.equal(run(x, { burstSensitivity: 0 }).kernel.bursts, 0)
  assert.equal(run(x, { burstSensitivity: 100 }).kernel.bursts, 1)
})

test('burst: a bright vowel onset after a closure trips the detector but the window closes on the voice', () => {
  // A vowel restarting under a short bright burst passes every timing test a T
  // does; what gives it away is that the voice band leads.
  const { x, b0 } = makeVoice(SR, { event: 't', level: 0.24, vowelMs: 0 })
  const tuning = (gate) => ({ ...PLOSIVE_TUNING, burstVoiceGate: gate })
  // At full Sensitivity, so the onset certainly trips the detector.
  const p = toKernelParams({ burstSensitivity: 100 })
  const open = processPlosiveBuffer([x], SR, p, { tuning: tuning(false) })
  const gated = processPlosiveBuffer([x], SR, p, { tuning: tuning(true) })
  assert.ok(open.kernel.bursts === 1 && gated.kernel.bursts === 1, 'the onset should still trip the detector')
  const L = open.latencySamples
  const end = b0 + Math.round(SR * 0.05)
  const cutOf = r => bandDb(x, b0, end, HIGH) - bandDb(r.channelData[0].subarray(L), b0, end, HIGH)
  assert.ok(cutOf(open) > 2, `ungated, the window cuts the vowel onset (${cutOf(open).toFixed(2)} dB)`)
  // The cut here is on the top band only, which the onset's own noise sits in,
  // so the gate shortens it rather than removing it (the De-Esser's broadband
  // Duck dropped from −1.2 to under −0.5 dB on the same test).
  assert.ok(cutOf(gated) < cutOf(open) - 2, `gated, the window lets go on the voice (${cutOf(gated).toFixed(2)} dB against ${cutOf(open).toFixed(2)})`)
})

test('scope: a T is flagged as a burst, and its input peak lines up with the output', () => {
  const { x, b0, b1 } = makeVoice(SR, { event: 't' })
  const k = new PlosiveKernel(SR)
  k.setParams(toKernelParams({}))
  const out = new Float32Array(128)
  const L = k.latencySamples
  let inT = 0
  let elsewhere = 0
  let worstQuiet = 0
  for (let o = 0; o + 128 <= x.length; o += 128) {
    k.process([x.subarray(o, o + 128)], [out], 128)
    const src = o - L // the input the output of this block came from
    if (src >= b0 && src < b1) inT = Math.max(inT, k.scopeBurst)
    else if (src < b0 - 4096) {
      elsewhere = Math.max(elsewhere, k.scopeBurst)
      if (k.scopeIn > 0) worstQuiet = Math.max(worstQuiet, Math.abs(20 * Math.log10(k.scopeOut / k.scopeIn)))
    }
  }
  assert.equal(inT, 1)
  assert.equal(elsewhere, 0)
  assert.equal(worstQuiet, 0, 'untouched audio reads as untouched')
})

test('meters: the deepest cuts and the running event counts', () => {
  const { x } = makeVoice(SR, { event: 'pop' })
  const k = new PlosiveKernel(SR)
  k.setParams(toKernelParams({}))
  const out = new Float32Array(x.length)
  let pop = 0
  for (let o = 0; o < x.length; o += 128) {
    const n = Math.min(128, x.length - o)
    k.process([x.subarray(o, o + n)], [out.subarray(o, o + n)], n)
    const m = k.takeMeters()
    if (m) pop = Math.max(pop, m.popDb)
  }
  const last = k.takeMeters(true)
  assert.ok(pop > 3 && pop <= PLOSIVE_DEFAULTS.popDepth + 1e-4, `deepest pop cut ${pop.toFixed(2)} dB`)
  assert.equal(last.pops, 1)
  assert.equal(last.bursts, 0)
})
