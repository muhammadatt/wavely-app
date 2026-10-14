/**
 * PHAT*SS — the claims the design rests on: the Warmth stage and its peak
 * guard (moved here from the HF Limiter), TAPE, and the constant latency of the
 * whole chain. (The Tame / FATSO limiter shelf and its tests were removed in
 * October 2026 — recoverable at e427de9.)
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processPhatassBuffer, PhatassKernel } from '../../src/audio/phatassProcessor.js'
import {
  toKernelParams as toKernelParamsShipped, phatassLatencySamples, PHATASS_DEFAULTS,
  TAPE_LATENCY_SAMPLES, TAPE_MAX_DB, tapePeakU, tapeLayer, TAPE_CURVES, OUTPUT_MAKEUPS, TAPE_LOW_PUSHES, TAPE_LOW_PUSH_HZ, TAPE_HEAD_BUMPS, TAPE_HEAD_BUMP_HZ,
  WARMTH_LAYERS, WARMTH_LATENCY_SAMPLES, WARMTH_EVEN_MATCH_DB, WARMTH_TOP_DB, ODD_EVEN_SPAN, warmthLayers,
  WARMTH_MAX_LAYERS, checkWarmthLayers, warmthLevelDb, slotOversample, WARMTH_BASE_RATE_MAX_HZ, headBumpMaxLiftDb,
} from '../../src/audio/phatassParams.js'
import { processSaturationBenchBuffer, SAT_BENCH_LAYER_LATENCY } from '../../src/audio/dsp/saturationLayers.js'
import { warmthGuardLatencySamples } from '../../src/audio/dsp/warmthGuard.js'
import { measureTapeMakeup as measureTapeMakeupShipped } from '../../src/audio/phatassTapeMakeup.js'
import { measureOutputMakeup as measureOutputMakeupShipped, PREVIEW_CAP_S } from '../../src/audio/phatassOutputMakeup.js'

/**
 * ⚠ THIS SUITE PINS TAPE, WARMTH AND THE LIMITER SHELF WITH THE TOP END OFF AND
 * NO HEAD BUMP, as it was written. Since October 2026 PHAT*SS ships a tape
 * speed (30 ips: the tape HF shelf, and the A800 bump while TAPE is up), so
 * every call here starts from `ISOLATED` and a test that wants the speed asks
 * for it. The shipping defaults themselves are pinned in phatassHfDetents.test.js.
 */
const ISOLATED = { hf: 'off', tapeHeadBump: 0 }
const toKernelParams = p => toKernelParamsShipped({ ...ISOLATED, ...p })
const measureTapeMakeup = (c, sr, p, o) => measureTapeMakeupShipped(c, sr, { ...ISOLATED, ...p }, o)
const measureOutputMakeup = (c, sr, p, o) => measureOutputMakeupShipped(c, sr, { ...ISOLATED, ...p }, o)

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

test('the latency is Warmth + guard + TAPE, constant at every setting (the limiter shelf is gone)', () => {
  const L = phatassLatencySamples(SR)
  assert.equal(L, WARMTH_LATENCY_SAMPLES + warmthGuardLatencySamples(SR) + TAPE_LATENCY_SAMPLES)
  for (const [warmth, tape, hf] of [[0, 0, 'off'], [0, 0, 'ips7'], [6, 0, 'off'], [10, 0, 'ips30'], [0, 6, 'off'], [8, 3, 'ips15']]) {
    const x = new Float32Array(8192)
    x[100] = 0.001 // far below every threshold
    const { channelData: [y], latencySamples } = run(x, { voiceLevelDb: -20, hf, warmth, tape, warmthCeilingDb: -3 })
    assert.equal(latencySamples, L)
    // TAPE, and Warmth's full-band layers, run a full-band 4x oversampler,
    // whose band edge (−0.2 dB at 20 kHz) shaves a one-sample impulse a
    // little (more with Warmth's Amount above 0 dB); the impulse still lands at L.
    const tol = tape > 0 || warmth > 0 ? 0.06 * x[100] : 1e-5
    assert.ok(Math.abs(y[100 + L] - x[100]) < tol, `warmth ${warmth} tape ${tape} ${hf}: impulse at ${L} reads ${y[100 + L]}`)
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
    const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tape, warmthCeilingDb: db(peak) })
    let p = 0
    for (let i = L + 2000; i < x.length; i++) p = Math.max(p, Math.abs(y[i]))
    // Past 3.52 dB the top is on the cubic's flat — a hard clip — and its
    // band-limited ringing gives a few tenths back.
    const tol = tape <= 3.5 ? 0.1 : 0.5
    assert.ok(Math.abs(db(p / peak) + tape) < tol, `TAPE ${tape}: peak moved ${db(p / peak).toFixed(2)} dB`)
  }
  // 20 dB under the selection's peak, TAPE 2 moves the fundamental by under 0.05 dB.
  const q = sine(110, peak / 10)
  const { channelData: [y], latencySamples: L } = run(q, { warmth: 0, tape: 2, warmthCeilingDb: db(peak) })
  const a = toneAmp(y.subarray(L), 110, 4000, q.length - L - 100)
  assert.ok(Math.abs(db(a / (peak / 10))) < 0.05, `quiet sine moved ${db(a / (peak / 10)).toFixed(3)} dB`)
})

test('TAPE is symmetric: odd harmonics only', () => {
  const peak = 0.7
  const x = sine(200, peak)
  const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tape: 3, warmthCeilingDb: db(peak) })
  const from = L + 4000, to = from + 30000
  const h3 = harmonicDbc(y, 200, 3, from, to), h2 = harmonicDbc(y, 200, 2, from, to)
  assert.ok(h3 > -30, `H3 ${h3.toFixed(1)} dBc`)
  assert.ok(h2 < h3 - 40, `H2 ${h2.toFixed(1)} dBc against H3 ${h3.toFixed(1)}`)
})

test('TAPE TANH / ALGEBRAIC: the knob inverts f(u)/u, and lands the peak on its number (no flat to ring off)', () => {
  const curves = { tanh: u => Math.tanh(u), algebraic: u => u / Math.sqrt(1 + u * u) }
  for (const [name, f] of Object.entries(curves)) {
    for (let t = 0.1; t <= TAPE_MAX_DB; t += 0.1) {
      const u = tapePeakU(t, name)
      assert.ok(Math.abs(db(f(u) / u) + t) < 1e-9, `${name} ${t.toFixed(1)} dB: u ${u}`)
    }
  }
  assert.deepEqual(TAPE_CURVES, ['cubic', 'tanh', 'algebraic', 'hysteresis'])
  assert.equal(PHATASS_DEFAULTS.tapeCurve, 'cubic')
  assert.equal(tapeLayer(2, -3, 'tanh').curve, 'tanh')
  assert.equal(tapeLayer(2, -3, 'bogus').curve, 'cubic')
  assert.equal(toKernelParams({ tape: 2, tapeCurve: 'tanh', warmthCeilingDb: -3 }).tapeLayer.curve, 'tanh')
  const peak = 0.7
  const x = sine(110, peak)
  for (const tapeCurve of ['tanh', 'algebraic']) for (const tape of [1, 2, 3.5, 6]) {
    const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tape, tapeCurve, warmthCeilingDb: db(peak) })
    let p = 0
    for (let i = L + 2000; i < x.length; i++) p = Math.max(p, Math.abs(y[i]))
    assert.ok(Math.abs(db(p / peak) + tape) < 0.15, `${tapeCurve} TAPE ${tape}: peak moved ${db(p / peak).toFixed(2)} dB`)
  }
})

test('TAPE: below its flat the cubic is the third harmonic alone; tanh and algebraic bring every odd order', () => {
  const f = 110, peak = 0.6
  const x = sine(f, peak)
  const high = (tapeCurve) => {
    const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tape: 2, tapeCurve, warmthCeilingDb: db(peak) })
    const from = L + 1000, to = from + 39690 // 99 whole cycles
    let e = 0
    for (let k = 7; k <= 21; k += 2) e += Math.pow(10, harmonicDbc(y, f, k, from, to) / 10)
    return { h3: harmonicDbc(y, f, 3, from, to), high: 10 * Math.log10(e) }
  }
  const c = high('cubic'), t = high('tanh'), a = high('algebraic')
  assert.ok(Math.abs(c.h3 - t.h3) < 2 && Math.abs(c.h3 - a.h3) < 2, `H3 cubic ${c.h3.toFixed(1)} / tanh ${t.h3.toFixed(1)} / algebraic ${a.h3.toFixed(1)} dBc`)
  assert.ok(c.high < -90 && t.high > -80, `H7–H21 cubic ${c.high.toFixed(1)}, tanh ${t.high.toFixed(1)} dBc`)
  // Algebraic bends earliest: more high orders than tanh.
  assert.ok(a.high > t.high, `H7–H21 algebraic ${a.high.toFixed(1)} vs tanh ${t.high.toFixed(1)} dBc`)
})

test('TAPE TANH / ALGEBRAIC makeup restores the peak too', () => {
  const peak = 0.6
  for (const tapeCurve of ['tanh', 'algebraic']) for (const [f, tape] of [[110, 2], [110, 6], [8000, 6]]) {
    const x = sine(f, peak, SR / 2)
    const base = { warmth: 0, tape, tapeCurve, warmthCeilingDb: db(peak) }
    const { makeupDb } = measureTapeMakeup([x], SR, base)
    assert.ok(makeupDb > 0 && makeupDb <= tape + 0.2, `${f} Hz TAPE ${tape}: makeup ${makeupDb.toFixed(2)}`)
    const { channelData: [y], latencySamples: L } = run(x, { ...base, tapeMakeupDb: makeupDb })
    let p = 0
    for (let i = L; i < x.length; i++) p = Math.max(p, Math.abs(y[i]))
    assert.ok(Math.abs(db(p / peak)) < 0.05, `${f} Hz TAPE ${tape}: peak ${db(p / peak).toFixed(3)} dB re source`)
  }
})

test('TAPE at a quiet level is flat to 18 kHz (the 4x oversampler\'s band edge is above it)', () => {
  for (const f of [100, 1000, 10000, 18000]) {
    const x = sine(f, 0.001)
    const amp = tape => {
      const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tape, warmthCeilingDb: -3 })
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
    const base = { warmth: 0, tape, warmthCeilingDb: db(peak) }
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

test('TAPE comes before Warmth: its makeup ignores Warmth, and Warmth still never raises the peak', () => {
  // A speech-ish signal: voiced body, a bright burst, and level changes.
  const x = add(sine(120, 0.3), sine(240, 0.15), sine(2600, 0.05))
  for (let i = 0; i < x.length; i++) x[i] *= 0.4 + 0.6 * Math.abs(Math.sin((2 * Math.PI * 1.7 * i) / SR))
  const burst = add(sine(6500, 0.35, 4096), noise(4096, 0.1))
  x.set(burst.map((v, i) => x[20000 + i] + v), 20000)
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  const base = { tape: 3, warmthCeilingDb: db(peak), warmthRefPeaksDb: WARMTH_LAYERS.map(() => -14) }
  const quiet = measureTapeMakeup([x], SR, { ...base, warmth: 0 }).makeupDb
  const hot = measureTapeMakeup([x], SR, { ...base, warmth: 10, oddEven: 100 }).makeupDb
  assert.ok(quiet > 0.5)
  assert.equal(hot, quiet, 'Warmth comes after TAPE and cannot move its makeup')
  for (const warmth of [0, 5, 10]) {
    const { channelData: [y], latencySamples: L } = run(x, { ...base, warmth, oddEven: 100, tapeMakeupDb: quiet })
    let p = 0
    for (let i = L; i < y.length; i++) p = Math.max(p, Math.abs(y[i]))
    assert.ok(db(p / peak) < 0.02, `Warmth ${warmth}: peak ${db(p / peak).toFixed(3)} dB over the source`)
    assert.ok(db(p / peak) > -0.1, `Warmth ${warmth}: peak ${db(p / peak).toFixed(3)} dB, not restored`)
  }
})

test('the fast TAPE makeup (preview) reads the exact one (apply) to 0.02 dB', () => {
  const x = new Float32Array(SR * 3)
  for (let k = 0; k < 12; k++) {
    // Syllables of different levels and brightness.
    const at = k * 11000, a = 0.15 + 0.5 * ((k * 7) % 5) / 4
    const syl = k % 3 === 2 ? add(sine(7000, a * 0.6, 8000), noise(8000, a * 0.2)) : add(sine(110 + 10 * k, a, 8000), sine(330, a * 0.3, 8000))
    for (let i = 0; i < 8000; i++) x[at + i] += syl[i] * Math.sin((Math.PI * i) / 8000)
  }
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  for (const tape of [0.5, 2, 4, 6]) {
    const p = { tape, warmthCeilingDb: db(peak) }
    const exact = measureTapeMakeup([x], SR, p).makeupDb
    const fast = measureTapeMakeup([x], SR, p, { exact: false }).makeupDb
    assert.ok(exact > 0)
    assert.ok(Math.abs(fast - exact) < 0.02, `TAPE ${tape}: fast ${fast.toFixed(4)} vs exact ${exact.toFixed(4)}`)
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

test('Warmth 0 and TAPE 0 (top end off) pass the audio through untouched', () => {
  const x = add(sine(200, 0.5), sine(3000, 0.2), sine(9000, 0.2))
  const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, oddEven: 30 })
  for (let i = L; i < x.length; i++) if (y[i] !== x[i - L]) assert.fail(`sample ${i} differs`)
})

// ── Warmth: low-end harmonics ───────────────────────────

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

const WARM = { voiceLevelDb: -20 } // top end off (ISOLATED), so only Warmth acts

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

test('TAPE order is pinned first: a stale tapeOrder param changes nothing', () => {
  assert.equal('tapeOrder' in PHATASS_DEFAULTS, false)
  const x = add(sine(110, 0.4), sine(220, 0.15), sine(3000, 0.05))
  const base = { tape: 3, warmth: 6, oddEven: 50, tapeMakeupDb: 1.5, warmthCeilingDb: db(0.6), warmthRefPeaksDb: WARMTH_LAYERS.map(() => -14) }
  const a = run(x, base).channelData[0]
  const b = run(x, { ...base, tapeOrder: 'last' }).channelData[0]
  assert.deepEqual(a, b)
})

/** Syllables of different levels and brightness over `seconds`, with the peak. */
function syllableTrack(seconds, seed = 1) {
  const x = new Float32Array(Math.round(SR * seconds))
  // Levels and types drawn at random, not in a repeating pattern: a loop is a
  // sampling question of its own (see phatassOutputMakeup.js).
  let r = seed * 7919
  const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647
  for (let k = 0, at = 0; at + 8000 < x.length; k++, at += 11000) {
    const a = 0.12 + 0.5 * rnd()
    const syl = rnd() < 0.33 ? add(sine(7000, a * 0.6, 8000), noise(8000, a * 0.2, k + seed)) : add(sine(110 + 10 * (k % 12), a, 8000), sine(330, a * 0.3, 8000))
    for (let i = 0; i < 8000; i++) x[at + i] += syl[i] * Math.sin((Math.PI * i) / 8000)
  }
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  return { x, peak }
}

const outStats = (x, p) => {
  const { channelData: [y], latencySamples: L } = run(x, p)
  let pk = 0, e = 0
  for (let i = 0; i < x.length; i++) { const v = y[L + i] ?? 0; pk = Math.max(pk, Math.abs(v)); e += v * v }
  return { pkDb: db(pk), msDb: 10 * Math.log10(e / x.length) }
}
const srcMsDb = (x) => { let e = 0; for (const v of x) e += v * v; return 10 * Math.log10(e / x.length) }

test('output trim: OFF ships, and the kernel ignores a stale trim unless PEAK, KEEP or RMS is on', () => {
  assert.deepEqual(OUTPUT_MAKEUPS, ['off', 'peak', 'keep', 'rms'])
  assert.equal(PHATASS_DEFAULTS.outputMakeup, 'off')
  assert.equal(toKernelParams({ outputMakeupDb: -2 }).outputMakeupDb, 0)
  assert.equal(toKernelParams({ outputMakeup: 'bogus', outputMakeupDb: -2 }).outputMakeupDb, 0)
  assert.equal(toKernelParams({ outputMakeup: 'rms', outputMakeupDb: -2 }).outputMakeupDb, -2)
  const { x } = syllableTrack(0.5)
  assert.equal(measureOutputMakeup([x], SR, { outputMakeup: 'off' }).makeupDb, 0)
})

test('output trim lands the whole chain on the source: PEAK on its peak, RMS on its RMS, on top of Output and TAPE\'s own makeup', () => {
  const { x, peak } = syllableTrack(3)
  const base = { warmth: 6, oddEven: 40, tape: 2.5, hf: 'ips15', warmthCeilingDb: db(peak), voiceLevelDb: srcMsDb(x) }
  const tapeMakeupDb = measureTapeMakeup([x], SR, base).makeupDb
  for (const mode of ['peak', 'rms']) {
    const p = { ...base, tapeMakeupDb, outputMakeup: mode }
    const { makeupDb } = measureOutputMakeup([x], SR, p)
    const s = outStats(x, { ...p, outputMakeupDb: makeupDb })
    if (mode === 'peak') assert.ok(Math.abs(s.pkDb - db(peak)) < 0.02, `PEAK: output peak ${(s.pkDb - db(peak)).toFixed(3)} dB off the source`)
    else assert.ok(Math.abs(s.msDb - srcMsDb(x)) < 0.02, `RMS: output RMS ${(s.msDb - srcMsDb(x)).toFixed(3)} dB off the source`)
    // Output rides on top, unchanged.
    const t = outStats(x, { ...p, outputMakeupDb: makeupDb, output: -3 })
    assert.ok(Math.abs(t.msDb - s.msDb + 3) < 0.01)
    // The trim never touches TAPE's makeup.
    assert.equal(toKernelParams({ ...p, outputMakeupDb: makeupDb }).tapeMakeupDb, tapeMakeupDb)
  }
  // Warmth and TAPE's makeup add level, so the level-matched trim pulls down.
  assert.ok(measureOutputMakeup([x], SR, { ...base, tapeMakeupDb, outputMakeup: 'rms' }).makeupDb < 0)
})

test('output trim preview: exact up to its cap, a close estimate past it', () => {
  const short = syllableTrack(2)
  const p0 = { warmth: 5, tape: 2, hf: 'ips15', warmthCeilingDb: db(short.peak), voiceLevelDb: srcMsDb(short.x) }
  for (const outputMakeup of ['peak', 'rms']) {
    const p = { ...p0, outputMakeup }
    assert.equal(measureOutputMakeup([short.x], SR, p, { exact: false }).makeupDb, measureOutputMakeup([short.x], SR, p).makeupDb)
  }
  const long = syllableTrack(PREVIEW_CAP_S + 10, 3)
  const p = { ...p0, warmthCeilingDb: db(long.peak), voiceLevelDb: srcMsDb(long.x), outputMakeup: 'rms' }
  const exact = measureOutputMakeup([long.x], SR, p).makeupDb
  const fast = measureOutputMakeup([long.x], SR, p, { exact: false }).makeupDb
  // Loose on purpose: pure tones against noise bursts make Warmth's gain swing
  // ~11 dB from block to block, far more than real material (0.00–0.18 dB, see
  // phatassOutputMakeup.js), so 40 blocks sample this track coarsely.
  assert.ok(Math.abs(fast - exact) < 0.35, `RMS: sampled ${fast.toFixed(3)} vs whole ${exact.toFixed(3)}`)
  const pe = measureOutputMakeup([long.x], SR, { ...p, outputMakeup: 'peak' }).makeupDb
  const pf = measureOutputMakeup([long.x], SR, { ...p, outputMakeup: 'peak' }, { exact: false }).makeupDb
  // The loudest blocks give a lower bound on the output peak: never a smaller trim.
  assert.ok(pf >= pe - 1e-6 && pf - pe < 0.5, `PEAK: sampled ${pf.toFixed(3)} vs whole ${pe.toFixed(3)}`)
})

/** A kick: a 55 Hz burst with a fast decay, over a light 2 kHz bed. */
function kickTrack() {
  const x = new Float32Array(SR * 2)
  for (let k = 0; k < 4; k++) {
    const at = Math.round(k * 0.5 * SR)
    for (let i = 0; i < 0.3 * SR; i++) x[at + i] += 0.8 * Math.exp(-i / (0.08 * SR)) * Math.sin(2 * Math.PI * 55 * i / SR)
  }
  for (let i = 0; i < x.length; i++) x[i] += 0.1 * Math.sin(2 * Math.PI * 2000 * i / SR)
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  return { x, peak }
}

test('TAPE low push: off ships, and the knob keeps its no-push drive', () => {
  assert.deepEqual(TAPE_LOW_PUSHES, [0, 3, 6])
  assert.equal(PHATASS_DEFAULTS.tapeLowPush, 0)
  const flat = tapeLayer(2, -3)
  assert.equal(flat.emphDb, 0)
  const pushed = tapeLayer(2, -3, 'cubic', 6)
  assert.equal(pushed.emphType, 'loshelf')
  assert.equal(pushed.emphHz, TAPE_LOW_PUSH_HZ)
  assert.equal(pushed.emphDb, 6)
  assert.equal(pushed.driveDb, flat.driveDb)
  assert.equal(tapeLayer(0, -3, 'cubic', 6).on, false)
  assert.equal(toKernelParams({ tape: 2, tapeLowPush: 3, warmthCeilingDb: -3 }).tapeLayer.emphDb, 3)
  // A stored 12 or 18 from before the trim clamps to the new top.
  assert.equal(toKernelParams({ tape: 2, tapeLowPush: 18, warmthCeilingDb: -3 }).tapeLayer.emphDb, 6)
})

test('TAPE low push squashes a kick\'s low end and leaves the clean path flat', () => {
  const { x, peak } = kickTrack()
  const base = { warmth: 0, tape: 2, warmthCeilingDb: db(peak) }
  const lowPeak = (y, L) => {
    // 55 Hz content of the first kick, by correlation over its first 40 ms.
    return toneAmp(y.subarray(L), 55, 0, Math.round(0.04 * SR))
  }
  const flat = run(x, { ...base, tapeMakeupDb: 0 })
  const pushed = run(x, { ...base, tapeLowPush: 6, tapeMakeupDb: 0 })
  const dryLow = toneAmp(x, 55, 0, Math.round(0.04 * SR))
  const flatLoss = db(lowPeak(flat.channelData[0], flat.latencySamples) / dryLow)
  const pushLoss = db(lowPeak(pushed.channelData[0], pushed.latencySamples) / dryLow)
  assert.ok(pushLoss < flatLoss - 1, `push ${pushLoss.toFixed(2)} dB vs flat ${flatLoss.toFixed(2)} dB on the kick's low end`)
  // Below the curve the push is a filter and its exact inverse: a quiet signal comes through untouched.
  const quiet = add(sine(55, 0.002), sine(2000, 0.002))
  const q = run(quiet, { ...base, tapeLowPush: 6, tapeMakeupDb: 0, warmthCeilingDb: db(0.8) })
  let err = 0
  for (let i = 4096; i < quiet.length - 4096; i++) err = Math.max(err, Math.abs(q.channelData[0][i + q.latencySamples] - quiet[i]))
  assert.ok(err < 1e-4, `quiet signal moved ${err}`)
})

test('TAPE low push: the makeup still restores the peak, and the fast search still reads the exact one', () => {
  const { x, peak } = kickTrack()
  for (const tapeLowPush of [3, 6]) {
    const p = { warmth: 0, tape: 3, tapeLowPush, warmthCeilingDb: db(peak) }
    const exact = measureTapeMakeup([x], SR, p).makeupDb
    const fast = measureTapeMakeup([x], SR, p, { exact: false }).makeupDb
    assert.ok(Math.abs(fast - exact) < 0.02, `push ${tapeLowPush}: fast ${fast.toFixed(3)} vs exact ${exact.toFixed(3)}`)
    const { channelData: [y], latencySamples: L } = run(x, { ...p, tapeMakeupDb: exact })
    let pk = 0
    for (let i = L; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]))
    assert.ok(Math.abs(db(pk / peak)) < 0.05, `push ${tapeLowPush}: peak ${db(pk / peak).toFixed(3)} dB off the source`)
  }
})

test('TAPE runs to 12 dB: a voiced peak loses nearly its number, and the makeup still brings it back', () => {
  assert.equal(TAPE_MAX_DB, 12)
  const x = add(sine(110, 0.6, SR), sine(220, 0.2, SR))
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  const p = { warmth: 0, tape: 12, warmthCeilingDb: db(peak) }
  const { makeupDb } = measureTapeMakeup([x], SR, p)
  assert.ok(makeupDb > 10 && makeupDb < 12.5, `makeup ${makeupDb.toFixed(2)} dB`)
  const { channelData: [y], latencySamples: L } = run(x, { ...p, tapeMakeupDb: makeupDb })
  let pk = 0
  for (let i = L; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]))
  assert.ok(Math.abs(db(pk / peak)) < 0.05, `peak ${db(pk / peak).toFixed(3)} dB off the source`)
})

test('TAPE head bump: it follows the Speed dial (shipping), the bench can override it, and it only rides along while TAPE is up', () => {
  assert.deepEqual(TAPE_HEAD_BUMPS, ['speed', 0, 3, 6, 9, 'a800-30', 'a800-15', 'a800-7'])
  assert.equal(TAPE_HEAD_BUMP_HZ, 40)
  assert.equal(PHATASS_DEFAULTS.tapeHeadBump, 'speed')
  // Following the speed: each speed's own A800 curve; OFF has none.
  for (const [hf, bump] of [['ips30', 'a800-30'], ['ips15', 'a800-15'], ['ips7', 'a800-7'], ['off', 0]]) {
    assert.equal(toKernelParamsShipped({ tape: 2, hf }).headBump, bump, hf)
    assert.equal(toKernelParamsShipped({ tape: 0, hf }).headBump, 0, `${hf} with TAPE off`)
  }
  assert.equal(toKernelParamsShipped({ tape: 2 }).headBump, 'a800-30', 'the shipping speed is 30 ips')
  // A bench override wins over the speed.
  assert.equal(toKernelParamsShipped({ tape: 2, hf: 'ips7', tapeHeadBump: 0 }).headBump, 0)
  assert.equal(toKernelParamsShipped({ tape: 2, hf: 'ips7', tapeHeadBump: 'a800-30' }).headBump, 'a800-30')
  assert.equal(toKernelParams({ tape: 2, tapeHeadBump: 6 }).headBump, 6)
  assert.equal(toKernelParams({ tape: 2, tapeHeadBump: 'a800-30' }).headBump, 'a800-30')
  assert.equal(toKernelParams({ tape: 2, tapeHeadBump: 'bogus' }).headBump, 0)
  assert.equal(toKernelParams({ tape: 0, tapeHeadBump: 6 }).headBump, 0)
  assert.equal(toKernelParams({ tape: 2 }).headBump, 0)
})

test('TAPE head bump below the curve is a low shelf that stays in the output', () => {
  const x = add(sine(25, 0.002, SR * 2), sine(1000, 0.002, SR * 2))
  const p = { warmth: 0, tape: 2, tapeHeadBump: 6, tapeMakeupDb: 0, warmthCeilingDb: db(0.8) }
  const { channelData: [y], latencySamples: L } = run(x, p)
  const from = SR, to = 2 * SR - 1000
  const lo = db(toneAmp(y.subarray(L), 25, from, to) / 0.002)
  const hi = db(toneAmp(y.subarray(L), 1000, from, to) / 0.002)
  assert.ok(lo > 4.5 && lo < 6.2, `25 Hz lifted ${lo.toFixed(2)} dB`)
  assert.ok(Math.abs(hi) < 0.1, `1 kHz moved ${hi.toFixed(2)} dB`)
})

test('TAPE head bump: the makeup is measured through it (fast = exact) and still lands the peak on the source', () => {
  const { x, peak } = kickTrack()
  for (const tapeHeadBump of [3, 6, 9]) {
    const p = { warmth: 0, tape: 6, tapeHeadBump, warmthCeilingDb: db(peak) }
    const exact = measureTapeMakeup([x], SR, p).makeupDb
    const fast = measureTapeMakeup([x], SR, p, { exact: false }).makeupDb
    assert.ok(Math.abs(fast - exact) < 0.02, `bump ${tapeHeadBump}: fast ${fast.toFixed(3)} vs exact ${exact.toFixed(3)}`)
    const { channelData: [y], latencySamples: L } = run(x, { ...p, tapeMakeupDb: exact })
    let pk = 0
    for (let i = L; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]))
    assert.ok(Math.abs(db(pk / peak)) < 0.05, `bump ${tapeHeadBump}: peak ${db(pk / peak).toFixed(3)} dB off the source`)
  }
})

test('the saturation meter does not read the head bump as saturation', () => {
  const x = add(sine(30, 0.002, SR), sine(800, 0.002, SR))
  const k = new PhatassKernel(SR)
  k.setParams(toKernelParams({ warmth: 0, tape: 2, tapeHeadBump: 9, warmthCeilingDb: db(0.8) }), true)
  k.enableMeter()
  const out = new Float32Array(128)
  for (let o = 0; o + 128 <= x.length; o += 128) k.process([x.subarray(o, o + 128)], [out], 128)
  const m = k.takeMeter()
  assert.ok(10 * Math.log10(m.added / m.clean) < -40, `meter read ${(10 * Math.log10(m.added / m.clean)).toFixed(1)} dB`)
})

test('TAPE HYSTERESIS: the knob is calibrated on a steady sine, and the makeup still lands the peak (fast = exact)', () => {
  const x = sine(110, 0.5, SR * 2)
  for (const tape of [1, 3, 6, 12]) {
    const p = { warmth: 0, tape, tapeCurve: 'hysteresis', tapeMakeupDb: 0, warmthCeilingDb: db(0.5) }
    assert.equal(toKernelParams(p).tapeLayer.curve, 'hysteresis')
    const { channelData: [y], latencySamples: L } = run(x, p)
    let pk = 0
    for (let i = L + SR; i < L + 2 * SR - 4096; i++) pk = Math.max(pk, Math.abs(y[i]))
    // The solve is per-sample; the layer band-limits what the loop adds (4x
    // oversampled), which gives back a little at the top (TAPE 12: −11.4).
    assert.ok(Math.abs(db(pk / 0.5) + tape) < 0.75, `TAPE ${tape}: steady sine peak moved ${db(pk / 0.5).toFixed(2)} dB`)
  }
  const { x: s, peak } = kickTrack()
  const p = { warmth: 0, tape: 8, tapeCurve: 'hysteresis', warmthCeilingDb: db(peak) }
  const exact = measureTapeMakeup([s], SR, p).makeupDb
  assert.ok(Math.abs(measureTapeMakeup([s], SR, p, { exact: false }).makeupDb - exact) < 0.02)
  const { channelData: [y], latencySamples: L } = run(s, { ...p, tapeMakeupDb: exact })
  let pk = 0
  for (let i = L; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]))
  assert.ok(Math.abs(db(pk / peak)) < 0.05, `peak ${db(pk / peak).toFixed(3)} dB off the source`)
})

test('TAPE head bump is pinned after the curve: the lift passes TAPE at full size', () => {
  assert.equal('tapeHeadBumpPos' in PHATASS_DEFAULTS, false)
  // A loud 30 Hz tone: the curve sees the bare tone, and the bump lifts what comes out.
  const x = sine(30, 0.5, SR * 2)
  const out = (tapeHeadBump) => {
    const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tape: 6, tapeHeadBump, tapeMakeupDb: 0, warmthCeilingDb: db(0.5) })
    return db(toneAmp(y.subarray(L), 30, SR, 2 * SR - 4096) / 0.5)
  }
  const lift = out(9) - out(0)
  assert.ok(lift > 5.5, `30 Hz lifted ${lift.toFixed(2)} dB through a TAPE 6 curve`)
})

test('TAPE head bump: the makeup is measured through it, may be a cut, and lands the peak on the source (preview = apply)', () => {
  const { x, peak } = kickTrack()
  for (const [tape, tapeHeadBump] of [[1, 9], [6, 6], [12, 3]]) {
    const p = { warmth: 0, tape, tapeHeadBump, warmthCeilingDb: db(peak) }
    const exact = measureTapeMakeup([x], SR, p).makeupDb
    assert.equal(measureTapeMakeup([x], SR, p, { exact: false }).makeupDb, exact)
    if (tape === 1) assert.ok(exact < 0, `TAPE 1 / +9: makeup ${exact.toFixed(2)} dB should be a cut`)
    const { channelData: [y], latencySamples: L } = run(x, { ...p, tapeMakeupDb: exact })
    let pk = 0
    for (let i = L; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]))
    assert.ok(Math.abs(db(pk / peak)) < 0.05, `TAPE ${tape} / +${tapeHeadBump}: peak ${db(pk / peak).toFixed(3)} dB off the source`)
  }
  assert.equal(toKernelParams({ tape: 2, tapeMakeupDb: -3 }).tapeMakeupDb, -3)
  assert.equal(toKernelParams({ tape: 0, tapeMakeupDb: -3 }).tapeMakeupDb, 0)
})


test('TAPE head bump A800 curves: 30 ips as edited (high-pass at 20 Hz), 15 ips the published curve an octave down, 7.5 another octave', () => {
  const amp = (bump, f) => {
    const x = sine(f, 0.002, SR * 3)
    const { channelData: [y], latencySamples: L } = run(x, { warmth: 0, tape: 0.01, tapeHeadBump: bump, tapeMakeupDb: 0, warmthCeilingDb: db(0.8) })
    return db(toneAmp(y.subarray(L), f, 2 * SR, 3 * SR - 1000) / 0.002)
  }
  // endino.com A800 graph at 30 ips, eye-digitised (dB): 20 −7.8, 45 +1.5, 85 −0.55, 1k 0.
  // ⚠ The owner moved the 30 ips high-pass from the fitted 35.3 Hz to 20 Hz
  // (acf0534), which takes out the roll-off and reshapes the dip: as edited it
  // reads +0.1 at 20 Hz (published −7.8), +1.34 at 45 (+1.5) and −0.96 at 85
  // (−0.55). The 15 and 7.5 ips curves keep the fitted shape.
  for (const [f, want, tol] of [[20, 0.13, 0.6], [45, 1.34, 0.4], [85, -0.96, 0.3], [1000, 0, 0.1]]) {
    const got = amp('a800-30', f)
    assert.ok(Math.abs(got - want) < tol, `A800 30 ips at ${f} Hz: ${got.toFixed(2)} dB, want ${want}`)
  }
  for (const [f, want, tol] of [[10, -7.8, 0.8], [22.5, 1.5, 0.4], [42.5, -0.55, 0.3]]) {
    const got = amp('a800-15', f)
    assert.ok(Math.abs(got - want) < tol, `A800 15 ips at ${f} Hz: ${got.toFixed(2)} dB, want ${want}`)
  }
  // 7.5 ips: the 15 ips curve an octave further down.
  for (const [f, want, tol] of [[11.25, 1.5, 0.4], [21.25, -0.55, 0.3], [1000, 0, 0.1]]) {
    const got = amp('a800-7', f)
    assert.ok(Math.abs(got - want) < tol, `A800 7.5 ips at ${f} Hz: ${got.toFixed(2)} dB, want ${want}`)
  }
})

test('TAPE head bump A800: the makeup is measured through it (preview = apply) and lands the peak on the source; the meter ignores it', () => {
  const { x, peak } = kickTrack()
  for (const tapeHeadBump of ['a800-30', 'a800-15']) {
    const p = { warmth: 0, tape: 6, tapeHeadBump, warmthCeilingDb: db(peak) }
    const exact = measureTapeMakeup([x], SR, p).makeupDb
    assert.equal(measureTapeMakeup([x], SR, p, { exact: false }).makeupDb, exact)
    const { channelData: [y], latencySamples: L } = run(x, { ...p, tapeMakeupDb: exact })
    let pk = 0
    for (let i = L; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]))
    assert.ok(Math.abs(db(pk / peak)) < 0.05, `${tapeHeadBump}: peak ${db(pk / peak).toFixed(3)} dB off the source`)
    const k = new PhatassKernel(SR)
    k.setParams(toKernelParams({ warmth: 0, tape: 0.01, tapeHeadBump, warmthCeilingDb: db(peak) }), true)
    k.enableMeter()
    const out = new Float32Array(128)
    for (let o = 0; o + 128 <= x.length; o += 128) k.process([x.subarray(o, o + 128)], [out], 128)
    const m = k.takeMeter()
    assert.ok(10 * Math.log10(m.added / m.clean) < -40, `${tapeHeadBump}: meter read ${(10 * Math.log10(m.added / m.clean)).toFixed(1)} dB`)
  }
})

test('a runtime makeup or output change glides over ~20 ms instead of stepping; an immediate set snaps', () => {
  const k = new PhatassKernel(SR)
  k.setParams(toKernelParams({ warmth: 0, tape: 0 }), true)
  const n = 128
  const run = () => {
    const x = new Float32Array(n).fill(0.1)
    const y = [new Float32Array(n)]
    k.process([x], y, n)
    return y[0]
  }
  for (let i = 0; i < 40; i++) run()
  // +12 dB of output trim arrives from a measurement: no sample-to-sample jump.
  k.setParams({ outputMakeupDb: 12 })
  let worst = 0, prev = run()
  worst = Math.max(worst, ...prev.slice(1).map((v, i) => Math.abs(v - prev[i])))
  for (let b = 0; b < 10; b++) {
    const y = run()
    worst = Math.max(worst, Math.abs(y[0] - prev[n - 1]), ...y.slice(1).map((v, i) => Math.abs(v - y[i])))
    prev = y
  }
  assert.ok(worst < 0.01, `the gain stepped by ${worst} in one sample`)
  assert.ok(Math.abs(prev[n - 1] - 0.1 * 10 ** (12 / 20)) < 1e-4, 'the ramp lands on the target')
  // An immediate set (the offline render's) snaps.
  k.setParams({ outputMakeupDb: 0 }, true)
  assert.ok(Math.abs(run()[0] - 0.1) < 1e-6)
})

test('headBumpMaxLiftDb: the largest lift a bump adds, 0 when off', () => {
  assert.equal(headBumpMaxLiftDb(0), 0)
  assert.ok(Math.abs(headBumpMaxLiftDb(9) - 9) < 0.1)
  const a800 = headBumpMaxLiftDb('a800-30')
  assert.ok(a800 > 0.5 && a800 < 3, `A800 30 ips lifts ${a800.toFixed(2)} dB`)
})

test('output trim KEEP keeps outputKeep of TAPE\'s makeup (85 % by default) and trims the rest, with no render', () => {
  assert.equal(PHATASS_DEFAULTS.outputKeep, 0.85)
  const p = { tape: 10, tapeMakeupDb: 8, outputMakeup: 'keep' }
  assert.ok(Math.abs(toKernelParams(p).outputMakeupDb - -1.2) < 1e-9)
  assert.ok(Math.abs(toKernelParams({ ...p, outputKeep: 0.9 }).outputMakeupDb - -0.8) < 1e-9)
  // Ignores a stale measured trim; nothing to give back with TAPE off or a negative makeup.
  assert.ok(Math.abs(toKernelParams({ ...p, outputMakeupDb: -5 }).outputMakeupDb - -1.2) < 1e-9)
  assert.equal(toKernelParams({ ...p, tape: 0 }).outputMakeupDb, 0)
  assert.equal(toKernelParams({ ...p, tapeMakeupDb: -2 }).outputMakeupDb, 0)
  const { x } = syllableTrack(0.5)
  assert.ok(Math.abs(measureOutputMakeup([x], SR, p).makeupDb - -1.2) < 1e-9)
})

test('Warmth readout blocks: one per stratum across the whole selection, each with its run-in, inside the selection', async () => {
  const { readoutBlocks, READOUT_BLOCKS, READOUT_BLOCK_S, READOUT_PREROLL_S } = await import('../../src/audio/phatassWarmthReadout.js')
  const n = 120 * SR
  const b = readoutBlocks(n, SR)
  assert.equal(b.length, READOUT_BLOCKS)
  for (let k = 0; k < b.length; k++) {
    const [a, e, skip] = b[k]
    assert.ok(a >= 0 && e <= n)
    assert.equal(e - (a + skip), Math.round(READOUT_BLOCK_S * SR))
    assert.equal(skip, Math.round(READOUT_PREROLL_S * SR))
    // Inside its own stratum.
    assert.ok(a + skip >= Math.floor((k * n) / READOUT_BLOCKS) && e <= Math.ceil(((k + 1) * n) / READOUT_BLOCKS) + 1)
  }
})

test('Warmth readout sampled bands track the whole render; the guard holds the peak, so a long selection can report its bound', async () => {
  const { measureWarmthReadout, measureWarmthBandsSampled, readoutBlocks } = await import('../../src/audio/phatassWarmthReadout.js')
  // 40 s of syllables with a low-heavy part that swells in and out twice — the
  // material changes across the selection, so a window would misread it.
  // (Joins are smooth: a hard cut between sections is itself sub content.)
  const a = syllableTrack(40)
  const x = new Float32Array(40 * SR)
  for (let i = 0; i < x.length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * 2 * i) / x.length)
    x[i] = a.x[i] + w * 0.4 * Math.sin((2 * Math.PI * 70 * i) / SR) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 2 * i) / SR))
  }
  let pk = 0
  for (const v of x) pk = Math.max(pk, Math.abs(v))
  const kp = toKernelParams({ warmth: 6, oddEven: 40, warmthCeilingDb: db(pk), warmthRefPeaksDb: WARMTH_LAYERS.map(() => -14) })
  const whole = measureWarmthReadout([x], SR, kp.warmthLayers, { guard: kp.warmthGuard })
  const blocks = readoutBlocks(x.length, SR).map(([s, e, skip]) => ({ channelData: [x.subarray(s, e)], skip }))
  const sampled = measureWarmthBandsSampled(blocks, SR, kp.warmthLayers, kp.warmthGuard)
  for (let i = 0; i < whole.bandsDb.length; i++) {
    if (whole.bandsDb[i] === null) continue
    assert.ok(Math.abs(sampled[i] - whole.bandsDb[i]) < 1, `band ${i}: sampled ${sampled[i].toFixed(2)} vs whole ${whole.bandsDb[i].toFixed(2)}`)
  }
  // The guard's ceiling is the selection's peak, and the stage never passes it.
  assert.ok(whole.peakDb <= whole.inputPeakDb + 1e-6, `peak moved ${whole.peakDb - whole.inputPeakDb}`)
})

// ── Input and Mix (the Modula panel) ─────────────────────────────────────────

test('Input 0 and Mix 1 (the defaults) are bit-identical to the chain without them', () => {
  assert.equal(PHATASS_DEFAULTS.inputDb, 0)
  assert.equal(PHATASS_DEFAULTS.mix, 1)
  const x = add(sine(110, 0.4), sine(3000, 0.1), noise(SR, 0.02))
  const p = { warmth: 6, tape: 3, warmthCeilingDb: -3, warmthRefPeaksDb: WARMTH_LAYERS.map(() => -14), tapeMakeupDb: 2 }
  const a = run(x, p).channelData[0]
  const b = run(x, { ...p, inputDb: 0, mix: 1 }).channelData[0]
  assert.deepEqual(a, b)
})

test('Input is a drive: TAPE hears the signal after it, and its makeup restores the driven peak', () => {
  const peak = 0.3
  const x = sine(110, peak, SR / 2)
  const base = { warmth: 0, tape: 2, warmthCeilingDb: db(peak) }
  const flat = measureTapeMakeup([x], SR, base).makeupDb
  const driven = measureTapeMakeup([x], SR, { ...base, inputDb: 6 }).makeupDb
  assert.ok(driven > flat + 1, `+6 dB in drives TAPE harder: makeup ${flat.toFixed(2)} → ${driven.toFixed(2)}`)
  const { channelData: [y], latencySamples: L } = run(x, { ...base, inputDb: 6, tapeMakeupDb: driven })
  let p = 0
  for (let i = L; i < x.length; i++) p = Math.max(p, Math.abs(y[i]))
  const over = db(p / (peak * 10 ** (6 / 20)))
  assert.ok(Math.abs(over) < 0.1, `the peak lands on the driven peak: ${over.toFixed(3)} dB`)
})

test('Input with everything idle is a plain gain, delayed by the latency', () => {
  const x = sine(440, 0.1, 8192)
  const { channelData: [y], latencySamples: L } = run(x, { inputDb: -6 })
  const g = 10 ** (-6 / 20)
  for (let i = L; i < x.length; i++) assert.ok(Math.abs(y[i] - g * x[i - L]) < 1e-6)
})

test('Mix 0 is the dry input delayed by the latency: no comb, nothing added', () => {
  const x = add(sine(110, 0.4, SR / 2), noise(SR / 2, 0.05))
  const p = { warmth: 8, tape: 4, warmthCeilingDb: -3, warmthRefPeaksDb: WARMTH_LAYERS.map(() => -14), tapeMakeupDb: 3, mix: 0 }
  const { channelData: [y], latencySamples: L } = run(x, p)
  for (let i = L; i < x.length; i++) assert.ok(Math.abs(y[i] - x[i - L]) < 1e-6, `sample ${i}`)
})

test('Mix blends linearly between the aligned dry path and the wet path', () => {
  const x = add(sine(110, 0.4, SR / 2), noise(SR / 2, 0.05))
  const p = { warmth: 8, tape: 4, warmthCeilingDb: -3, warmthRefPeaksDb: WARMTH_LAYERS.map(() => -14), tapeMakeupDb: 3 }
  const { channelData: [wet], latencySamples: L } = run(x, { ...p, mix: 1 })
  const [half] = run(x, { ...p, mix: 0.5 }).channelData
  for (let i = L; i < x.length; i += 7) {
    const want = 0.5 * x[i - L] + 0.5 * wet[i]
    assert.ok(Math.abs(half[i] - want) < 1e-5, `sample ${i}`)
  }
})

test('a runtime Mix change glides rather than stepping', () => {
  const k = new PhatassKernel(SR)
  k.setParams(toKernelParams({ tape: 0, warmth: 0 }), true)
  const n = 128
  const ins = [new Float32Array(n).fill(0.5)]
  const outs = [new Float32Array(n)]
  for (let b = 0; b < 20; b++) k.process(ins, outs, n)
  // Wet and dry are the same signal here, so make them differ with Output.
  k.setParams(toKernelParams({ tape: 0, warmth: 0, mix: 0 }))
  k.process(ins, outs, n)
  assert.ok(k.mix.left > 0 || k.mix.value === 0)
  assert.ok(k.mix.value < 1 && k.mix.value > 0, `mid-ramp after one block: ${k.mix.value}`)
})
