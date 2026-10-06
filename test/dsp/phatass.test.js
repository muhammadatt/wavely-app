/**
 * PHAT*SS — the claims the design rests on: the Warmth stage and its peak
 * guard (moved here from the HF Limiter), the Tame/Tone macro onto the tape
 * shelf, and the constant latency of the whole chain.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processPhatassBuffer } from '../../src/audio/phatassProcessor.js'
import {
  toKernelParams, phatassLatencySamples, tapeShelf, softenLaw, TAPE_SHELF, PHATASS_DEFAULTS, FATSO_CORNER_HZ,
  DETECT_4K_HZ, DETECT_4K_COMP_DB, CURVE_DETECT, TAPE_LATENCY_SAMPLES, TAPE_MAX_DB, tapePeakU, tapeLayer,
  WARMTH_LAYERS, WARMTH_LATENCY_SAMPLES, WARMTH_EVEN_MATCH_DB, WARMTH_TOP_DB, ODD_EVEN_SPAN, warmthLayers,
  WARMTH_MAX_LAYERS, checkWarmthLayers, warmthLevelDb, slotOversample, WARMTH_BASE_RATE_MAX_HZ,
} from '../../src/audio/phatassParams.js'
import { HF_LIMITER_DEFAULTS, toKernelParams as toHFLimiterKernelParams } from '../../src/audio/hfLimiterParams.js'
import { processHFLimiterBuffer } from '../../src/audio/hfLimiterProcessor.js'
import { processSaturationBenchBuffer, SAT_BENCH_LAYER_LATENCY } from '../../src/audio/dsp/saturationLayers.js'
import { warmthGuardLatencySamples } from '../../src/audio/dsp/warmthGuard.js'
import { shelfLatencySamples } from '../../src/audio/dsp/hfLimit.js'
import { measureTapeMakeup } from '../../src/audio/phatassTapeMakeup.js'

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
const run = (x, p) => processPhatassBuffer([x], SR, toKernelParams(p))

// ── The chain ────────────────────────────────────────────────────────────────

test('the latency is Warmth + guard + TAPE + shelf, constant at every setting (Soften adds none)', () => {
  const L = phatassLatencySamples(SR)
  assert.equal(L, WARMTH_LATENCY_SAMPLES + warmthGuardLatencySamples(SR) + TAPE_LATENCY_SAMPLES + shelfLatencySamples(SR))
  for (const [warmth, tame, soften, tape] of [[0, 0, false, 0], [0, 10, false, 0], [6, 0, false, 0], [10, 10, true, 0], [0, 5, true, 0], [0, 0, false, 6], [8, 8, true, 3]]) {
    const x = new Float32Array(8192)
    x[100] = 0.001 // far below every threshold
    const { channelData: [y], latencySamples } = run(x, { voiceLevelDb: -20, warmth, tame, soften, tape, warmthCeilingDb: -3 })
    assert.equal(latencySamples, L)
    // TAPE, and Warmth's full-band layers, run a full-band 4x oversampler,
    // whose band edge (−0.2 dB at 20 kHz) shaves a one-sample impulse a
    // little (more with Warmth's Amount above 0 dB); the impulse still lands at L.
    const tol = tape > 0 || warmth > 0 ? 0.06 * x[100] : 1e-5
    assert.ok(Math.abs(y[100 + L] - x[100]) < tol, `warmth ${warmth} tame ${tame} soften ${soften} tape ${tape}: impulse at ${L} reads ${y[100 + L]}`)
  }
})

// ── TAPE: a full-band cubic soft clipper, knob in dB of peak reduction ──────

test('TAPE: the knob inverts the cubic exactly — f(u)/u at the peak is the knob\'s reduction', () => {
  const cubic = u => (u >= 1 ? 2 / 3 : u - (u * u * u) / 3)
  for (let t = 0.1; t <= TAPE_MAX_DB; t += 0.1) {
    const u = tapePeakU(t)
    assert.ok(Math.abs(db(cubic(u) / u) + t) < 1e-9, `${t.toFixed(1)} dB: u ${u}`)
  }
  assert.equal(tapeLayer(0, -3).on, false)
  const l = tapeLayer(2, -3)
  assert.equal(l.on, true)
  assert.equal(l.curve, 'cubic')
  assert.equal(l.refPeakDb, -3)
  assert.equal(l.amountDb, 0)
  assert.equal(PHATASS_DEFAULTS.tape, 0)
})

test('TAPE takes its number off a low-frequency peak, and leaves quiet material alone', () => {
  const peak = 0.7
  const x = sine(110, peak)
  for (const tape of [1, 2, 3.5, 6]) {
    const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tame: 0, tape, warmthCeilingDb: db(peak) })
    let p = 0
    for (let i = L + 2000; i < x.length; i++) p = Math.max(p, Math.abs(y[i]))
    // Past 3.52 dB the top is on the cubic's flat — a hard clip — and its
    // band-limited ringing gives a few tenths back.
    const tol = tape <= 3.5 ? 0.1 : 0.5
    assert.ok(Math.abs(db(p / peak) + tape) < tol, `TAPE ${tape}: peak moved ${db(p / peak).toFixed(2)} dB`)
  }
  // 20 dB under the selection's peak, TAPE 2 moves the fundamental by under 0.05 dB.
  const q = sine(110, peak / 10)
  const { channelData: [y], latencySamples: L } = run(q, { warmth: 0, tame: 0, tape: 2, warmthCeilingDb: db(peak) })
  const a = toneAmp(y.subarray(L), 110, 4000, q.length - L - 100)
  assert.ok(Math.abs(db(a / (peak / 10))) < 0.05, `quiet sine moved ${db(a / (peak / 10)).toFixed(3)} dB`)
})

test('TAPE is symmetric: odd harmonics only', () => {
  const peak = 0.7
  const x = sine(200, peak)
  const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tame: 0, tape: 3, warmthCeilingDb: db(peak) })
  const from = L + 4000, to = from + 30000
  const h3 = harmonicDbc(y, 200, 3, from, to), h2 = harmonicDbc(y, 200, 2, from, to)
  assert.ok(h3 > -30, `H3 ${h3.toFixed(1)} dBc`)
  assert.ok(h2 < h3 - 40, `H2 ${h2.toFixed(1)} dBc against H3 ${h3.toFixed(1)}`)
})

test('TAPE at a quiet level is flat to 18 kHz (the 4x oversampler\'s band edge is above it)', () => {
  for (const f of [100, 1000, 10000, 18000]) {
    const x = sine(f, 0.001)
    const amp = tape => {
      const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tame: 0, tape, warmthCeilingDb: -3 })
      return toneAmp(y.subarray(L), f, 4000, x.length - L - 100)
    }
    const d = db(amp(6) / amp(0))
    assert.ok(Math.abs(d) < 0.02, `${f} Hz: ${d.toFixed(3)} dB`)
  }
})

test('TAPE makeup restores the peak: measured, so it matches the knob on a low tone and is smaller on a sibilant-band one', () => {
  const peak = 0.6
  for (const [f, tape] of [[110, 1], [110, 2], [110, 3.5], [8000, 3], [8000, 6]]) {
    const x = sine(f, peak, SR / 2)
    const base = { warmth: 0, tame: 0, tape, warmthCeilingDb: db(peak) }
    const { makeupDb } = measureTapeMakeup([x], SR, base)
    if (f === 110) assert.ok(Math.abs(makeupDb - tape) < 0.2, `${f} Hz TAPE ${tape}: makeup ${makeupDb.toFixed(2)}`)
    else assert.ok(makeupDb < tape - 0.5 && makeupDb > 0, `${f} Hz TAPE ${tape}: makeup ${makeupDb.toFixed(2)} should be under the knob`)
    // With the makeup in, the peak is back where it started — never above it.
    const { channelData: [y], latencySamples: L } = run(x, { ...base, tapeMakeupDb: makeupDb })
    let p = 0
    for (let i = L; i < x.length; i++) p = Math.max(p, Math.abs(y[i]))
    assert.ok(db(p / peak) < 0.02, `${f} Hz TAPE ${tape}: peak ${db(p / peak).toFixed(3)} dB over the source`)
    assert.ok(db(p / peak) > -0.1, `${f} Hz TAPE ${tape}: peak ${db(p / peak).toFixed(3)} dB, not restored`)
  }
})

test('TAPE makeup is 0 with TAPE off, and the kernel ignores a stale makeup then', () => {
  const x = sine(110, 0.5, 4096)
  assert.equal(measureTapeMakeup([x], SR, { tape: 0 }).makeupDb, 0)
  assert.equal(toKernelParams({ tape: 0, tapeMakeupDb: 3 }).tapeMakeupDb, 0)
  assert.equal(toKernelParams({ tape: 2, tapeMakeupDb: 1.7 }).tapeMakeupDb, 1.7)
})

test('TAPE with no measured peak calibrates on the voice level + 18 dB', () => {
  const k = toKernelParams({ tape: 2, voiceLevelDb: -20, warmthCeilingDb: null })
  assert.equal(k.tapeLayer.refPeakDb, -2)
})

test('Warmth 0, Soften off and Tame 0 pass the audio through untouched', () => {
  const x = add(sine(200, 0.5), sine(3000, 0.2), sine(9000, 0.2))
  const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tame: 0, oddEven: 30 })
  for (let i = L; i < x.length; i++) if (y[i] !== x[i - L]) assert.fail(`sample ${i} differs`)
})

test('the deprecated original Tame/Tone curve: Tame 5 / Tone 10 is −8 dB, Range 18, 12 kHz', () => {
  const s = tapeShelf(5, 10)
  assert.ok(Math.abs(s.cornerHz - 12000) < 1e-9)
  assert.equal(s.thresholdRelDb, -8)
  assert.ok(Math.abs(s.rangeDb - 18) < 1e-9)
  // The ends: Tame 0 is out, Tame 10 the deepest; Tone sweeps 2–12 kHz on a log scale.
  assert.equal(tapeShelf(0, 10).rangeDb, 0)
  assert.ok(Math.abs(tapeShelf(10, 10).rangeDb - 36) < 1e-9)
  assert.ok(Math.abs(tapeShelf(5, 0).cornerHz - 2000) < 1e-9)
  assert.ok(Math.abs(tapeShelf(5, 5).cornerHz - Math.sqrt(2000 * 12000)) < 1e-6)
  // Threshold and Range move together, monotone: more Tame acts earlier and deeper.
  for (let t = 1; t <= 10; t++) {
    assert.ok(tapeShelf(t, 10).thresholdRelDb < tapeShelf(t - 1, 10).thresholdRelDb)
    assert.ok(tapeShelf(t, 10).rangeDb > tapeShelf(t - 1, 10).rangeDb)
  }
  // Shape and timing are pinned, whatever the panel sends.
  const k = toKernelParams({ ...PHATASS_DEFAULTS, curve: 'original', voiceLevelDb: -20 })
  for (const key of Object.keys(TAPE_SHELF)) assert.equal(k[key], TAPE_SHELF[key], key)
  assert.equal(k.thresholdDb, -28)
})

test('FATSO mode: Tame lands on the fitted Fatso points, corner pinned at 2 kHz, Tone ignored', () => {
  // Fatso Warmth 5 / 6 / 7 were fitted at threshold +10 / +4 / 0 dB re the voice,
  // Range ≥ 3 / 3 / ≥ 9 — Tame 1 / 4 / 6 under the law.
  for (const [tame, thr, range] of [[1, 10, 3], [4, 4, 3], [6, 0, 9]]) {
    const s = tapeShelf(tame, 10, 'fatso')
    assert.equal(s.thresholdRelDb, thr, `Tame ${tame} threshold`)
    assert.ok(Math.abs(s.rangeDb - range) < 1e-9, `Tame ${tame} range ${s.rangeDb}`)
  }
  for (const tone of [0, 3.7, 10]) assert.equal(tapeShelf(5, tone, 'fatso').cornerHz, FATSO_CORNER_HZ)
  assert.equal(tapeShelf(0, 10, 'fatso').rangeDb, 0)
  for (let t = 1; t <= 10; t++) {
    assert.ok(tapeShelf(t, 0, 'fatso').thresholdRelDb < tapeShelf(t - 1, 0, 'fatso').thresholdRelDb)
    assert.ok(tapeShelf(t, 0, 'fatso').rangeDb >= tapeShelf(t - 1, 0, 'fatso').rangeDb)
  }
  // The kernel follows the curve.
  const k = toKernelParams({ ...PHATASS_DEFAULTS, curve: 'fatso', detect: CURVE_DETECT.fatso, tame: 4, tone: 9, voiceLevelDb: -20 })
  assert.equal(k.cornerHz, FATSO_CORNER_HZ)
  assert.equal(k.thresholdDb, -16)
  assert.equal(k.rangeDb, 3)
})

test('VOICE curve (the default): FATSO\'s shape 6 dB lower, Range opening sooner, corner pinned at 2 kHz', () => {
  assert.equal(PHATASS_DEFAULTS.curve, 'voice')
  for (const [tame, thr, range] of [[1, 4, 3], [2, 2, 3], [4, -2, 9], [6, -6, 15], [10, -14, 27]]) {
    const s = tapeShelf(tame, 10, 'voice')
    assert.equal(s.thresholdRelDb, thr, `Tame ${tame} threshold`)
    assert.ok(Math.abs(s.rangeDb - range) < 1e-9, `Tame ${tame} range ${s.rangeDb}`)
    assert.equal(s.cornerHz, FATSO_CORNER_HZ)
    // 6 dB under FATSO at every setting.
    assert.equal(tapeShelf(tame, 10, 'fatso').thresholdRelDb - s.thresholdRelDb, 6)
  }
  assert.equal(tapeShelf(0, 10, 'voice').rangeDb, 0)
  for (let t = 1; t <= 10; t++) {
    assert.ok(tapeShelf(t, 0, 'voice').thresholdRelDb < tapeShelf(t - 1, 0, 'voice').thresholdRelDb)
    assert.ok(tapeShelf(t, 0, 'voice').rangeDb >= tapeShelf(t - 1, 0, 'voice').rangeDb)
  }
  // An unknown curve falls back to the default rather than to the deprecated one.
  assert.deepEqual(toKernelParams({ curve: 'nope', tame: 5 }), toKernelParams({ curve: 'voice', tame: 5 }))
})

test('DETECT: 2K shares the cut band, 4K listens above 4 kHz with the threshold 3 dB lower, the cut stays at 2 kHz', () => {
  const at = (curve, detect) => toKernelParams({ curve, detect, tame: 5, voiceLevelDb: -20 })
  // The default is the VOICE curve's pair.
  assert.equal(PHATASS_DEFAULTS.detect, CURVE_DETECT[PHATASS_DEFAULTS.curve])
  assert.deepEqual(CURVE_DETECT, { voice: '4k', fatso: '2k' })
  for (const curve of ['voice', 'fatso']) {
    const a = at(curve, '2k'), b = at(curve, '4k')
    assert.equal(a.detectCornerHz, null)
    assert.equal(b.detectCornerHz, DETECT_4K_HZ)
    assert.equal(a.thresholdDb - b.thresholdDb, DETECT_4K_COMP_DB)
    assert.equal(b.cornerHz, FATSO_CORNER_HZ)
    assert.equal(a.rangeDb, b.rangeDb)
  }
  // The deprecated curve has its own corner: Detect does not apply to it.
  assert.deepEqual(at('original', '4k'), at('original', '2k'))
})

test('DETECT 4K cuts a sibilant-band tone harder and a vowel-band tone less than 2K', () => {
  const base = { warmth: 0, soften: false, voiceLevelDb: -20, curve: 'voice', tame: 6 }
  const from = Math.floor(0.5 * SR), to = SR - 2000
  const cut = (f, detect) => {
    // At the voice level, so neither position reaches the Range floor.
    const x = sine(f, 0.1)
    const { channelData: [y], latencySamples: L } = run(x, { ...base, detect })
    return db(toneAmp(y.subarray(L), f, from - L, to - L) / 0.1)
  }
  const s2 = cut(8000, '2k'), s4 = cut(8000, '4k'), v2 = cut(2200, '2k'), v4 = cut(2200, '4k')
  assert.ok(s4 < s2 - 1, `8 kHz: 4K ${s4.toFixed(2)} vs 2K ${s2.toFixed(2)} dB`)
  assert.ok(v4 > v2 + 0.3, `2.2 kHz: 4K ${v4.toFixed(2)} vs 2K ${v2.toFixed(2)} dB`)
  assert.ok(v2 < -1 && s2 < -1, 'both tones are being cut at all')
})

test('either curve and either detector with Tame 0 (and Warmth, Soften off) pass the audio through untouched', () => {
  const x = add(sine(300, 0.3), noise(SR, 0.2, 7))
  for (const curve of ['voice', 'fatso']) for (const detect of ['2k', '4k']) {
    const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tame: 0, curve, detect })
    for (let i = L; i < x.length; i++) if (y[i] !== x[i - L]) assert.fail(`${curve}/${detect}: sample ${i} differs`)
  }
})

test('FATSO mode cuts the top end from 2 kHz, and only above its higher threshold', () => {
  // A loud 6 kHz tone with a 200 Hz bed, voice level pinned so the threshold is known.
  const n = SR
  const lo = sine(200, 0.1, n), hi = sine(6000, 0.3, n)
  const x = add(lo, hi)
  const base = { warmth: 0, soften: false, voiceLevelDb: -20, curve: 'fatso', detect: CURVE_DETECT.fatso }
  const from = Math.floor(0.5 * SR), to = n - 2000
  const out = tame => {
    const { channelData: [y], latencySamples: L } = run(x, { ...base, tame })
    return { hi: toneAmp(y.subarray(L), 6000, from - L, to - L), lo: toneAmp(y.subarray(L), 200, from - L, to - L) }
  }
  // Tame 1: threshold −10 dBFS on the band; the 6 kHz peak (−10.5 dBFS) sits under it.
  const t1 = out(1)
  assert.ok(Math.abs(db(t1.hi / 0.3)) < 0.1, `Tame 1 cut ${db(t1.hi / 0.3)}`)
  // Tame 6: threshold −20 dBFS, Range 9 — the tone comes down by up to 9 dB.
  const t6 = out(6)
  const cut = db(t6.hi / 0.3)
  assert.ok(cut < -5 && cut > -9.2, `Tame 6 cut ${cut}`)
  assert.ok(Math.abs(db(t6.lo / 0.1)) < 1, `200 Hz moved ${db(t6.lo / 0.1)}`)
})

test('with Warmth off, the tape shelf is the HF Limiter at the matching settings', () => {
  const x = add(sine(300, 0.3), sine(6000, 0.2), noise(SR, 0.05, 3))
  const ph = run(x, { voiceLevelDb: -20, warmth: 0, tame: 5, tone: 10, curve: 'original' })
  const hf = processHFLimiterBuffer([x], SR, toHFLimiterKernelParams({
    ...HF_LIMITER_DEFAULTS, voiceLevelDb: -20, freq: 12000, threshold: -8, range: 18,
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

// Warmth layers by role, so these tests survive fixed layers being added.
const ROLE = WARMTH_LAYERS.map(l => l.blend ?? 'fixed')
const I_EVEN = ROLE.indexOf('even'), I_ODD = ROLE.indexOf('odd')
const pair = list => [list[I_EVEN], list[I_ODD]]
const SLOTS = WARMTH_LAYERS.length

test('Warmth layers by role: the shipped even/odd pair is exactly the old two-layer law', () => {
  // The law before roles existed, written out: [quartic, cubic], sin/cos crossfade, quartic +17.4 dB.
  const legacy = (w, oe, refs) => {
    const b = ODD_EVEN_SPAN * Math.min(100, Math.max(0, oe)) / 100
    const levelDb = warmthLevelDb(w)
    const gains = [Math.sin((b * Math.PI) / 2), Math.cos((b * Math.PI) / 2)]
    const offsets = [WARMTH_EVEN_MATCH_DB, 0]
    return [0, 1].map(k => {
      const amountDb = levelDb + offsets[k] + 20 * Math.log10(Math.max(gains[k], 1e-12))
      const on = w > 0 && amountDb > -80
      return { on, amountDb: on ? amountDb : 0, ...(refs ? { refPeakDb: refs[k] } : {}) }
    })
  }
  assert.deepEqual(WARMTH_LAYERS.map(l => l.blend).slice(0, 2), ['even', 'odd'])
  for (const w of [0, 0.5, 3, 5, 10]) for (const oe of [0, 36, 50, 100]) for (const refs of [undefined, [-12, -13]]) {
    const got = warmthLayers(w, oe, refs).slice(0, 2)
    const want = legacy(w, oe, refs)
    got.forEach((l, k) => {
      assert.equal(l.on, want[k].on, `w ${w} oe ${oe} layer ${k} on`)
      assert.equal(l.amountDb, want[k].amountDb, `w ${w} oe ${oe} layer ${k} amount`)
      assert.equal(l.refPeakDb, want[k].refPeakDb)
      assert.equal('blend' in l || 'amountOffsetDb' in l, false, 'role keys never reach the kernel')
    })
  }
})

test('a FIXED Warmth layer follows the Warmth level at its offset, and Odd/Even does not touch it', () => {
  const layers = [...WARMTH_LAYERS.slice(0, 2), { blend: 'fixed', amountOffsetDb: -6, curve: 'tanh', driveDb: 30, loHz: 1, hiHz: 400, mode: 'full' }]
  for (const w of [2, 5, 10]) {
    const a = warmthLayers(w, 0, null, layers)[2], b = warmthLayers(w, 100, null, layers)[2]
    assert.equal(a.amountDb, warmthLevelDb(w) - 6)
    assert.equal(b.amountDb, a.amountDb)
    assert.equal(a.on, true)
    assert.equal(a.curve, 'tanh')
  }
  assert.equal(warmthLayers(0, 50, null, layers)[2].on, false)
  // A bench Amount carries over as amountOffsetDb: within 0.02 dB at Warmth 5
  // (warmthLevelDb(5) = 6 + 20·log10 ½ = −0.0206).
  const carried = warmthLayers(5, 50, null, [{ blend: 'fixed', amountOffsetDb: -4, curve: 'tanh' }])[0].amountDb
  assert.ok(Math.abs(carried - -4) < 0.025, `bench Amount −4 → ${carried}`)
  // No role means fixed, no offset.
  assert.equal(warmthLayers(5, 50, null, [{ curve: 'tanh' }])[0].amountDb, warmthLevelDb(5))
})

test('Warmth takes 1–4 layers with known roles', () => {
  assert.equal(WARMTH_MAX_LAYERS, 4)
  const l = { blend: 'fixed', curve: 'tanh' }
  assert.doesNotThrow(() => checkWarmthLayers([l, l, l, l]))
  assert.throws(() => checkWarmthLayers([l, l, l, l, l]), /1–4 layers/)
  assert.throws(() => checkWarmthLayers([]), /1–4 layers/)
  assert.throws(() => checkWarmthLayers([{ blend: 'sideways' }]), /unknown blend/)
  // No VOICED mode in PHAT*SS: refused at load, and every layer is sent FULL.
  assert.throws(() => checkWarmthLayers([{ blend: 'fixed', mode: 'voiced' }]), /FULL/)
  assert.doesNotThrow(() => checkWarmthLayers([{ blend: 'fixed', mode: 'full' }]))
  assert.ok(warmthLayers(5, 50).every(l => l.mode === 'full'))
  assert.ok(warmthLayers(5, 50, null, [{ curve: 'tanh' }]).every(l => l.mode === 'full'))
})

test('Warmth 0 leaves the audio untouched', () => {
  const x = add(sine(200, 0.5), sine(3000, 0.2))
  const { channelData: [y], latencySamples: L } = run(x, { ...WARM, warmth: 0, oddEven: 30 })
  for (let i = L; i < x.length; i++) if (y[i] !== x[i - L]) assert.fail(`sample ${i} differs`)
})

test('Warmth at full Odd is the odd (cubic) layer as voiced on the Saturation Bench, at the law\'s Amount', () => {
  const x = add(sine(120, 0.25), sine(240, 0.1), noise(SR, 0.01))
  const refs = WARMTH_LAYERS.map((_, k) => -14 - 2 * k)
  const { channelData: [y], latencySamples: L } = run(x, { ...WARM, warmth: 8, oddEven: 0, warmthRefPeaksDb: refs })
  // At full Odd the even side is out and the odd side sits at the law's Amount;
  // any fixed layers ride along as the law sets them.
  const law = warmthLayers(8, 0, refs)
  assert.equal(law[I_EVEN].on, false)
  assert.ok(Math.abs(law[I_ODD].amountDb - warmthLevelDb(8)) < 1e-12)
  const { blend: _b, amountOffsetDb: _o, ...oddSpec } = WARMTH_LAYERS[I_ODD]
  const layers = law.map((l, k) => (k === I_ODD ? { ...oddSpec, on: true, amountDb: law[I_ODD].amountDb, refPeakDb: refs[k] } : l))
  const bench = processSaturationBenchBuffer([x], SR, { layers }, { slots: SLOTS, oversample: slotOversample() })
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
  const refs = WARMTH_LAYERS.map((_, k) => -14 - 2 * k)
  const { channelData: [y], latencySamples: L } = run(x, { ...WARM, warmth: 3, oddEven: 0, warmthRefPeaksDb: refs })
  const bench = processSaturationBenchBuffer([x], SR, {
    layers: warmthLayers(3, 0, refs),
  }, { slots: SLOTS, oversample: slotOversample() })
  const b = bench.channelData[0], Lb = bench.latencySamples
  let worst = 0
  for (let i = 0; i < 0.05 * SR; i++) worst = Math.max(worst, Math.abs(y[i + L] - b[i + Lb]))
  assert.ok(worst < 1e-6, `first 50 ms differ by ${worst}`)
})

test('Odd/Even: 0 is pure odd (cubic); turning it up brings in the even (quartic)', () => {
  // The crossfaded pair alone, on the bench kernel — fixed layers would add
  // harmonics of their own and say nothing about the crossfade.
  const f = 120
  const at = oddEven => {
    const layers = pair(warmthLayers(10, oddEven, WARMTH_LAYERS.map(() => -10)))
    const { channelData: [y], latencySamples: L } = processSaturationBenchBuffer([sine(f, 0.3)], SR, { layers }, { slots: 2 })
    return { h2: harmonicDbc(y, f, 2, L + SR / 4, SR), h3: harmonicDbc(y, f, 3, L + SR / 4, SR) }
  }
  const odd = at(0), mixed = at(100)
  assert.ok(odd.h3 > odd.h2 + 10, `Odd: H2 ${odd.h2.toFixed(1)}, H3 ${odd.h3.toFixed(1)} dBc`)
  assert.ok(mixed.h2 > odd.h2 + 10, `100: H2 ${mixed.h2.toFixed(1)} vs ${odd.h2.toFixed(1)} dBc at 0`)
})

test('the Warmth law: linear in amplitude to +6 dB, equal-power Odd/Even over the first ODD_EVEN_SPAN of the blend', () => {
  // [even, odd], by role.
  const amt = (w, b) => pair(warmthLayers(w, b)).map(l => (l.on ? l.amountDb : -Infinity))
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
  // 0 takes the quartic out; 100 keeps both; Warmth 0 takes every layer out.
  assert.deepEqual(pair(warmthLayers(8, 0)).map(l => l.on), [false, true])
  assert.deepEqual(pair(warmthLayers(8, 100)).map(l => l.on), [true, true])
  assert.ok(warmthLayers(0, 50).every(l => !l.on))
  // Calibration rides along when measured, and only then.
  const refs = WARMTH_LAYERS.map((_, k) => -12 - k)
  assert.equal(warmthLayers(5, 50, refs)[I_ODD].refPeakDb, refs[I_ODD])
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
const SOFT = { voiceLevelDb: -20, warmth: 0 }

/** Energy removed around the click, dB re the click's own energy (0 = all of it). */
function removedDb(x, y, L, at) {
  let e = 0, c = 0
  for (let i = at - 50; i < at + Math.round(0.01 * SR); i++) e += (y[i + L] - x[i]) ** 2
  for (let i = at; i < at + Math.round(0.002 * SR); i++) c += (x[i] - 0.2 * Math.sin((2 * Math.PI * 150 * i) / SR)) ** 2
  return 10 * Math.log10(e / c)
}

test('Soften rides Tame: off cuts nothing extra, on cuts a sudden burst deeper as Tame rises', () => {
  const at = Math.round(0.4 * SR)
  const x = clickOverVoice(at)
  // At each Tame, Soften on removes more of the click than Soften off (the shelf alone).
  let prev = -Infinity
  for (const tame of [2, 5, 10]) {
    const off = run(x, { ...SOFT, tame, soften: false })
    const on = run(x, { ...SOFT, tame, soften: true })
    const rOff = removedDb(x, off.channelData[0], off.latencySamples, at)
    const rOn = removedDb(x, on.channelData[0], on.latencySamples, at)
    assert.ok(rOn > rOff + 0.5, `Tame ${tame}: Soften on removed ${rOn.toFixed(2)} dB, off ${rOff.toFixed(2)}`)
    assert.ok(rOn > prev, `Tame ${tame}: ${rOn.toFixed(2)} dB, not more than at the lower Tame (${prev.toFixed(2)})`)
    prev = rOn
  }
  // Tame 0 takes Soften out with the shelf: a pure delay.
  const zero = run(x, { ...SOFT, tame: 0, soften: true })
  for (let i = zero.latencySamples; i < x.length; i++) if (zero.channelData[0][i] !== x[i - zero.latencySamples]) assert.fail(`Tame 0: sample ${i} differs`)
})

test('Soften leaves steady sound alone', () => {
  const at = Math.round(0.4 * SR)
  const x = clickOverVoice(at)
  const on = run(x, { ...SOFT, tame: 10, soften: true }).channelData[0]
  const off = run(x, { ...SOFT, tame: 10, soften: false }).channelData[0]
  // Away from the burst, Soften on and off render the same.
  let worst = 0
  for (let i = Math.round(0.6 * SR); i < Math.round(0.9 * SR); i++) worst = Math.max(worst, Math.abs(on[i] - off[i]))
  assert.ok(worst < 1e-4, `steady voice moved by ${worst}`)
  // A held 6 kHz tone is not a transient.
  const tone = add(sine(6000, 0.1), noise(SR, 0.0005, 3))
  const a = run(tone, { ...SOFT, tame: 10, soften: true }).channelData[0]
  const b = run(tone, { ...SOFT, tame: 10, soften: false }).channelData[0]
  const g = db(toneAmp(a, 6000, SR / 2, SR) / toneAmp(b, 6000, SR / 2, SR))
  assert.ok(Math.abs(g) < 0.1, `Soften moved a steady 6 kHz tone ${g.toFixed(2)} dB`)
})

test('the Soften law: a toggle, depth and slope from Tame, corner pinned at 500 Hz', () => {
  assert.deepEqual(softenLaw(false, 10), { depthDb: 0, slope: 1 })
  assert.equal(softenLaw(true, 0).depthDb, 0)
  assert.ok(Math.abs(softenLaw(true, 5).depthDb - 18) < 1e-9)
  assert.ok(Math.abs(softenLaw(true, 10).depthDb - 36) < 1e-9)
  assert.ok(Math.abs(softenLaw(true, 5).slope - 0.75) < 1e-12)
  const k = toKernelParams({ soften: true, tame: 10, voiceLevelDb: -20 })
  assert.ok(Math.abs(k.transientDb - 36) < 1e-9)
  assert.equal(k.transientCornerHz, 500)
  assert.equal(k.transientGateDb, -52)
  assert.equal(toKernelParams({ soften: false, tame: 10 }).transientDb, 0)
  assert.equal(PHATASS_DEFAULTS.soften, false)
})

test('Warmth\'s low layers run at the base rate: no latency, and only a low band may', () => {
  // As voiced: the even/odd pair is ≤ 250 Hz and runs at 1x; the fixed
  // full-band and high-band layers keep their oversamplers.
  assert.deepEqual(slotOversample(), WARMTH_LAYERS.map(l => l.oversample !== false))
  assert.equal(WARMTH_LATENCY_SAMPLES, slotOversample().filter(Boolean).length * SAT_BENCH_LAYER_LATENCY)
  for (const l of WARMTH_LAYERS) if (l.oversample === false) assert.ok(l.hiHz <= WARMTH_BASE_RATE_MAX_HZ)
  const low = { blend: 'odd', curve: 'cubic', driveDb: 50, loHz: 1, hiHz: 220, oversample: false }
  assert.doesNotThrow(() => checkWarmthLayers([low]))
  assert.throws(() => checkWarmthLayers([{ ...low, hiHz: 20000 }]), /low band/)
})
