/**
 * Run with:  npm test
 *
 * PHAT*SS — the HF detent (OFF / 30 / 15 / 7.5 IPS / FATSO) and the tape HF
 * shelf the speeds run (`dsp/tapeHfShelf.js`).
 *
 * ⚠ THE LOAD-BEARING TEST IS ONSET AGAINST BODY. What makes the tape shelf a
 * different thing from the limiter shelf it sits beside is that it listens to
 * energy with no lookahead: an attack goes through bright and sustained
 * brightness darkens, where a lookahead limiter cuts the attack first. That is
 * a statement about time, so it is tested in time.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processPhatassBuffer } from '../../src/audio/phatassProcessor.js'
import {
  toKernelParams, tapeHfShelfParams, hfDetentShelf, tapeShelf, phatassLatencySamples,
  HF_DETENTS, HF_PANEL_DETENTS, HF_MODES, TAPE_SPEEDS, TAPE_HF_LAW, TAPE_HF_DB_PER_TAPE_DB, TAPE_MAX_DB,
  PHATASS_DEFAULTS, FATSO_CORNER_HZ, TAPE_SHELF,
} from '../../src/audio/phatassParams.js'
import { TapeHfShelf } from '../../src/audio/dsp/tapeHfShelf.js'
import { highpass } from '../../src/audio/dsp/biquad.js'

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

function biquad(x, c) {
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v
    y[i] = v
  }
  return y
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

const msDb = (x, from = 0, to = x.length) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return 10 * Math.log10(s / (to - from)) }

/** Run the tape HF shelf alone, in blocks like the worklet. */
function runShelf(x, p) {
  const st = new TapeHfShelf(SR)
  st.setParams(p)
  const y = Float32Array.from(x)
  for (let o = 0; o < y.length; o += 128) st.process([y.subarray(o, Math.min(o + 128, y.length))], Math.min(128, y.length - o))
  return y
}

/** A 15 ips shelf with its threshold placed re a known level. */
const shelfAt = (thresholdDb, extra = {}) => ({ ...tapeHfShelfParams('ips15', 0, 0), thresholdDb, ...extra })

/** Narration stand-in: a syllable-gated vowel bed plus 120 ms sibilant bursts `sibDb` re the bed. */
function narration(seconds, sibDb, seed = 5) {
  const n = Math.round(seconds * SR)
  const bed = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * 3 * t)
    let v = 0
    for (let k = 1; k <= 20; k++) v += Math.sin(2 * Math.PI * 150 * k * t) / k
    bed[i] = 0.08 * env * v
  }
  const hiss = biquad(biquad(noise(n, 1, seed), highpass(SR, 4500)), highpass(SR, 4500))
  const sib = new Float32Array(n)
  const burst = Math.round(0.12 * SR), period = Math.round(0.6 * SR)
  const g = 0.08 * Math.pow(10, sibDb / 20)
  for (let s0 = Math.round(0.3 * SR); s0 + burst < n; s0 += period) {
    for (let i = 0; i < burst; i++) sib[s0 + i] = g * hiss[s0 + i] * Math.sin((Math.PI * i) / burst)
  }
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = bed[i] + sib[i]
  return { x, bed, sib }
}

/** Energy change of `part` through the chain, dB, by projecting the output on it. */
function partChangeDb(y, L, part) {
  let num = 0, den = 0
  for (let i = 0; i + L < y.length; i++) { num += y[i + L] * part[i]; den += part[i] * part[i] }
  return db(Math.abs(num / den))
}

// ── The dial ─────────────────────────────────────────────────────────────────

test('the HF dial: OFF ships; OFF / 30 / 15 / 7.5 IPS / FATSO on the panel; the bench is not a detent', () => {
  assert.equal(PHATASS_DEFAULTS.hf, 'off')
  assert.deepEqual([...HF_PANEL_DETENTS], ['off', 'ips30', 'ips15', 'ips7', 'fatso'])
  assert.ok(HF_MODES.includes('bench') && !HF_PANEL_DETENTS.includes('bench'))
  assert.equal(PHATASS_DEFAULTS.trebleStats, undefined, 'the treble statistics went with AIR / SMOOTH / DARK')
  // Slower tape, less HF headroom: the detector listens lower, the shelf starts
  // lower and slides further, and it may cut deeper.
  const sp = ['ips30', 'ips15', 'ips7'].map(k => TAPE_SPEEDS[k])
  for (let i = 1; i < sp.length; i++) {
    assert.ok(sp[i].detectHz < sp[i - 1].detectHz)
    assert.ok(sp[i].cornerMaxHz < sp[i - 1].cornerMaxHz && sp[i].cornerMinHz < sp[i - 1].cornerMinHz)
    assert.ok(sp[i].rangeDb > sp[i - 1].rangeDb)
  }
  for (const s of sp) assert.ok(s.cornerMinHz < s.cornerMaxHz)
  // The emphasis corners are the IEC time constants 17.5 / 35 / 70 µs.
  for (const [s, us] of sp.map((s, i) => [s, [17.5, 35, 70][i]])) {
    assert.ok(Math.abs(s.detectHz - 1 / (2 * Math.PI * us * 1e-6)) < 1e-9, `${s.label} ips`)
  }
})

test('TAPE drives the tape speeds: the threshold drops with TAPE, re the voice level', () => {
  for (const hf of ['ips30', 'ips15', 'ips7']) {
    const at0 = tapeHfShelfParams(hf, -20, 0)
    assert.equal(at0.thresholdDb, -20 + TAPE_SPEEDS[hf].thresholdRelDb)
    for (const tape of [1, 6, 12]) {
      assert.equal(tapeHfShelfParams(hf, -20, tape).thresholdDb, at0.thresholdDb - TAPE_HF_DB_PER_TAPE_DB * tape)
    }
    assert.equal(tapeHfShelfParams(hf, -20, 99).thresholdDb, at0.thresholdDb - TAPE_HF_DB_PER_TAPE_DB * TAPE_MAX_DB)
    assert.equal(tapeHfShelfParams(hf, -27, 0).thresholdDb, at0.thresholdDb - 7)
    for (const k of Object.keys(TAPE_HF_LAW)) assert.equal(at0[k], TAPE_HF_LAW[k], k)
  }
  for (const hf of ['off', 'fatso', 'bench']) assert.equal(tapeHfShelfParams(hf, -20, 6), null)
})

test('each detent runs one shelf: a tape speed takes the limiter shelf out, FATSO is the fitted law with no tape shelf, OFF neither', () => {
  for (const hf of ['ips30', 'ips15', 'ips7']) {
    const k = toKernelParams({ hf, voiceLevelDb: -20, tape: 3 })
    assert.equal(k.rangeDb, 0, `${hf}: the limiter shelf is out`)
    assert.deepEqual(k.tapeHf, tapeHfShelfParams(hf, -20, 3))
  }
  const f = toKernelParams({ hf: 'fatso', voiceLevelDb: -20 })
  const law = tapeShelf(HF_DETENTS.fatso.tame, 10, 'fatso')
  assert.equal(f.tapeHf, null)
  assert.deepEqual([f.cornerHz, f.thresholdDb, f.rangeDb, f.detectCornerHz], [FATSO_CORNER_HZ, -20 + law.thresholdRelDb, law.rangeDb, null])
  assert.deepEqual(hfDetentShelf('fatso', -20), { cornerHz: f.cornerHz, thresholdDb: f.thresholdDb, rangeDb: f.rangeDb, detectCornerHz: null })
  const o = toKernelParams({ hf: 'off', voiceLevelDb: -20 })
  assert.equal(o.tapeHf, null)
  assert.equal(o.rangeDb, 0)
  assert.equal(toKernelParams({ hf: 'bench', tame: 5, voiceLevelDb: -20 }).tapeHf, null)
  // An unknown detent is the shipping one.
  assert.deepEqual(toKernelParams({ hf: 'nope', voiceLevelDb: -20 }), toKernelParams({ hf: PHATASS_DEFAULTS.hf, voiceLevelDb: -20 }))
  for (const hf of HF_MODES) {
    const k = toKernelParams({ hf, voiceLevelDb: -20 })
    for (const key of Object.keys(TAPE_SHELF)) assert.equal(k[key], TAPE_SHELF[key], `${hf} ${key}`)
  }
})

test('the tape shelf adds no latency: every detent renders at the plugin\'s one latency, and OFF passes the audio untouched', () => {
  const L = phatassLatencySamples(SR)
  const { x } = narration(1, 6)
  for (const hf of HF_PANEL_DETENTS) {
    const r = processPhatassBuffer([x], SR, toKernelParams({ hf, warmth: 0, soften: 0, tape: 0, voiceLevelDb: msDb(x) }))
    assert.equal(r.latencySamples, L, hf)
    if (hf === 'off') for (let i = L; i < x.length; i++) if (r.channelData[0][i] !== x[i - L]) assert.fail(`OFF: sample ${i} differs`)
  }
})

// ── The tape HF shelf ────────────────────────────────────────────────────────

test('tape shelf: bit-transparent while the emphasised band stays under its threshold, and when off', () => {
  const x = new Float32Array(SR)
  const t = sine(9000, 0.02), b = sine(200, 0.4)
  for (let i = 0; i < SR; i++) x[i] = t[i] + b[i]
  // The 9 kHz tone reads ~−37 dBFS of band energy; the knee starts 3 dB under −20.
  const y = runShelf(x, shelfAt(-20))
  for (let i = 0; i < SR; i++) if (y[i] !== x[i]) assert.fail(`sample ${i} differs under threshold`)
  const z = runShelf(x, null)
  for (let i = 0; i < SR; i++) if (z[i] !== x[i]) assert.fail(`sample ${i} differs when off`)
})

test('tape shelf: an attack goes through bright and the sustained part darkens — no lookahead', () => {
  // A held 8 kHz tone switched on at 0.2 s, well over threshold.
  const n = SR
  const x = new Float32Array(n)
  const on = Math.round(0.2 * SR)
  const t = sine(8000, 0.3, n)
  for (let i = on; i < n; i++) x[i] = t[i]
  const y = runShelf(x, shelfAt(-30))
  const first = Math.round(0.0005 * SR) // the first half-millisecond
  const att = db(Math.sqrt(10 ** (msDb(y, on, on + first) / 10)) / Math.sqrt(10 ** (msDb(x, on, on + first) / 10)))
  const body = db(toneAmp(y, 8000, on + Math.round(0.3 * SR), n) / 0.3)
  assert.ok(att > -1.5, `the attack lost ${att.toFixed(2)} dB in its first 0.5 ms`)
  assert.ok(body < -6, `the held tone only came down ${body.toFixed(2)} dB`)
  // The limiter shelf beside it does the opposite: its lookahead has the cut in place when the attack arrives.
})

test('tape shelf: the louder the top end, the further down the loss reaches (the corner slides)', () => {
  // A quiet 3 kHz probe under a driving 9 kHz tone at two levels.
  const probe = sine(3000, 0.01)
  const loss = drive => {
    const d = sine(9000, drive)
    const x = new Float32Array(SR)
    for (let i = 0; i < SR; i++) x[i] = probe[i] + d[i]
    const y = runShelf(x, shelfAt(-30))
    return { probe: db(toneAmp(y, 3000, SR / 2, SR) / 0.01), top: db(toneAmp(y, 9000, SR / 2, SR) / drive) }
  }
  const mild = loss(0.05), hot = loss(0.5)
  assert.ok(hot.top < mild.top - 1, `9 kHz: ${mild.top.toFixed(2)} → ${hot.top.toFixed(2)} dB`)
  // The probe sits under the corner when the cut is shallow and inside it when deep.
  assert.ok(hot.probe < mild.probe - 0.5, `3 kHz: ${mild.probe.toFixed(2)} → ${hot.probe.toFixed(2)} dB`)
  const st = new TapeHfShelf(SR)
  st.setParams(shelfAt(-30))
  for (let c = 0; c < 30; c++) assert.ok(st.cornerFor(c + 1) <= st.cornerFor(c))
  assert.equal(st.cornerFor(100), st.cornerMinHz)
  assert.equal(st.cornerFor(0), st.cornerMaxHz)
})

test('tape shelf: it only ever turns down — no component comes out louder, at any drive', () => {
  for (const drive of [0.02, 0.2, 0.8]) {
    const x = new Float32Array(SR)
    const parts = [[200, 0.2], [1500, 0.1], [5000, drive], [12000, drive / 2]]
    for (const [f, a] of parts) { const s = sine(f, a); for (let i = 0; i < SR; i++) x[i] += s[i] }
    const y = runShelf(x, shelfAt(-40))
    for (const [f, a] of parts) {
      const g = db(toneAmp(y, f, SR / 2, SR) / toneAmp(x, f, SR / 2, SR))
      assert.ok(g < 0.02, `${f} Hz at drive ${drive}: ${g.toFixed(3)} dB`)
    }
  }
})

test('through PHAT*SS: a bright take loses sibilance and keeps its vowels; a dull one is left alone at 30 IPS; TAPE drives it further', () => {
  const run = (take, hf, tape = 0) => {
    const voice = msDb(take.x)
    const r = processPhatassBuffer([take.x], SR, toKernelParams({ hf, warmth: 0, soften: 0, tape, tapeMakeupDb: 0, voiceLevelDb: voice }))
    return { sib: partChangeDb(r.channelData[0], r.latencySamples, take.sib), bed: partChangeDb(r.channelData[0], r.latencySamples, take.bed) }
  }
  const bright = narration(4, 6), dull = narration(4, -14)
  const b30 = run(bright, 'ips30'), b15 = run(bright, 'ips15'), b7 = run(bright, 'ips7')
  assert.ok(b30.sib < -0.5, `30 ips on the bright take: ${b30.sib.toFixed(2)} dB`)
  assert.ok(b15.sib < b30.sib && b7.sib < b15.sib, `30 ${b30.sib.toFixed(2)} / 15 ${b15.sib.toFixed(2)} / 7.5 ${b7.sib.toFixed(2)}`)
  assert.ok(b15.bed > -0.5, `15 ips took ${b15.bed.toFixed(2)} dB off the vowels`)
  assert.ok(run(dull, 'ips30').sib > -0.1, 'a dull take is left alone at 30 ips')
  // TAPE drives it: the same detent takes more at TAPE 6, measured on the shelf's
  // own threshold (rendering TAPE itself would add its own change).
  const st0 = tapeHfShelfParams('ips15', msDb(bright.x), 0), st6 = tapeHfShelfParams('ips15', msDb(bright.x), 6)
  const sibOnly = y => partChangeDb(y, 0, bright.sib)
  assert.ok(sibOnly(runShelf(bright.x, st6)) < sibOnly(runShelf(bright.x, st0)) - 0.5)
})
