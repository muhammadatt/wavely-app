/**
 * Run with:  npm test
 *
 * PHAT*SS — the HF detents that replace the Tame knob, and the treble
 * statistics they calibrate from (`phatassTrebleStats.js`).
 *
 * ⚠ THE LOAD-BEARING TEST IS THE BRIGHT / DULL PAIR. The point of calibrating
 * on the file's own treble WITH A FLOOR is that a detent eases a bright take's
 * sibilance and leaves a dull take's alone (owner's call: preserve, don't
 * normalise). That is a statement about two files, so it is tested on two.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processPhatassBuffer } from '../../src/audio/phatassProcessor.js'
import {
  toKernelParams, hfDetentShelf, tapeShelf, HF_DETENTS, HF_PANEL_DETENTS, HF_MODES, TREBLE_STATS_FALLBACK,
  PHATASS_DEFAULTS, FATSO_CORNER_HZ, DETECT_4K_HZ, TAPE_SHELF,
} from '../../src/audio/phatassParams.js'
import { measureTrebleStats, TREBLE_DETECT_HZ, TREBLE_PERCENTILES } from '../../src/audio/phatassTrebleStats.js'
import { onePoleLowpass } from '../../src/audio/dsp/hfLimit.js'
import { highpass } from '../../src/audio/dsp/biquad.js'

const SR = 44100
const db = x => 20 * Math.log10(x)

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

const segmentOf = (channels, { outputStart = 0 } = {}) => ({
  outputStart,
  sourceStart: 0,
  sourceEnd: channels[0].length / SR,
  sourceBuffer: { getChannelData: ch => channels[ch], numberOfChannels: channels.length },
})

const msDb = x => { let s = 0; for (const v of x) s += v * v; return 10 * Math.log10(s / x.length) }

/**
 * Narration stand-in: a vowel bed (a 150 Hz harmonic series rolling off to
 * ~3 kHz, syllable-gated) with a 120 ms sibilant burst (noise above 4.5 kHz)
 * every 600 ms, `sibDb` relative to the bed's own level.
 */
function narration(seconds, sibDb, seed = 5) {
  const n = Math.round(seconds * SR)
  const bed = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * 3 * t) // syllables
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

// ── The law ──────────────────────────────────────────────────────────────────

test('the HF detents: OFF ships, the panel offers OFF / AIR / SMOOTH / DARK / FATSO, the bench is not a detent', () => {
  assert.equal(PHATASS_DEFAULTS.hf, 'off')
  assert.deepEqual([...HF_PANEL_DETENTS], ['off', 'air', 'smooth', 'dark', 'fatso'])
  assert.ok(HF_MODES.includes('bench') && !HF_PANEL_DETENTS.includes('bench'))
  assert.equal(PHATASS_DEFAULTS.trebleStats, null)
  // Down the calibrated detents: a lower percentile, a lower window, a deeper Range.
  const cal = ['air', 'smooth', 'dark'].map(k => HF_DETENTS[k])
  for (const d of cal) assert.ok(d.capDb > d.floorDb)
  for (let i = 1; i < cal.length; i++) {
    assert.ok(TREBLE_PERCENTILES[cal[i].percentile] < TREBLE_PERCENTILES[cal[i - 1].percentile])
    assert.ok(cal[i].capDb <= cal[i - 1].floorDb, 'windows do not overlap')
    assert.ok(cal[i].rangeDb > cal[i - 1].rangeDb)
  }
})

test('a calibrated detent sits on the file\'s treble percentile, inside its floor-to-cap window re the voice', () => {
  const voice = -20
  const at = v => ({ bands: { '2k': { p75: v, p90: v, p95: v, p98: v, p99: v }, '4k': { p75: v, p90: v, p95: v, p98: v, p99: v } } })
  const harsh = at(30), dull = at(-30)
  for (const key of ['air', 'smooth', 'dark']) {
    const d = HF_DETENTS[key]
    // Inside the window: the percentile (plus offset) is the threshold.
    const mid = (d.floorDb + d.capDb) / 2 - d.offsetDb
    const b = hfDetentShelf(key, voice, at(mid))
    assert.ok(Math.abs(b.thresholdDb - (voice + mid + d.offsetDb)) < 1e-9, key)
    assert.equal(b.rangeDb, d.rangeDb)
    assert.equal(b.cornerHz, FATSO_CORNER_HZ)
    assert.equal(b.detectCornerHz, d.detect === '4k' ? DETECT_4K_HZ : null)
    // A dull take's treble is under the floor: the floor sets the threshold.
    assert.equal(hfDetentShelf(key, voice, dull).thresholdDb, voice + d.floorDb, `${key} on a dull take`)
    // A uniformly harsh take cannot calibrate its harshness away: the cap holds.
    assert.equal(hfDetentShelf(key, voice, harsh).thresholdDb, voice + d.capDb, `${key} on a harsh take`)
    // Unmeasured: the voiced-on stand-in, not a crash and not off.
    const fb = TREBLE_STATS_FALLBACK.bands[d.detect][d.percentile] + d.offsetDb
    assert.equal(hfDetentShelf(key, voice, null).thresholdDb, voice + Math.min(d.capDb, Math.max(d.floorDb, fb)))
    // It follows the voice level, like every other threshold here.
    assert.ok(Math.abs(hfDetentShelf(key, voice - 7, at(mid)).thresholdDb - (b.thresholdDb - 7)) < 1e-9)
  }
  const bright = at(0)
  assert.equal(hfDetentShelf('off', voice, bright), null)
  assert.equal(hfDetentShelf('bench', voice, bright), null)
})

test('FATSO is the fitted law at Tame 6 on a 2K detector, unmoved by the file\'s treble', () => {
  const s = tapeShelf(HF_DETENTS.fatso.tame, 10, 'fatso')
  for (const stats of [null, TREBLE_STATS_FALLBACK, { bands: { '2k': { p90: 30 }, '4k': { p90: 30 } } }]) {
    const k = toKernelParams({ hf: 'fatso', voiceLevelDb: -20, trebleStats: stats })
    assert.equal(k.thresholdDb, -20 + s.thresholdRelDb)
    assert.equal(k.rangeDb, s.rangeDb)
    assert.equal(k.cornerHz, FATSO_CORNER_HZ)
    assert.equal(k.detectCornerHz, null)
  }
  // The Fatso Warmth 7 point: threshold at the voice level, Range 9.
  assert.equal(s.thresholdRelDb, 0)
  assert.equal(s.rangeDb, 9)
  // And it is exactly what the bench renders at FATSO / 2K / Tame 6.
  const bench = toKernelParams({ hf: 'bench', curve: 'fatso', detect: '2k', tame: 6, voiceLevelDb: -20 })
  const det = toKernelParams({ hf: 'fatso', voiceLevelDb: -20 })
  for (const key of ['cornerHz', 'thresholdDb', 'rangeDb', 'detectCornerHz']) assert.equal(det[key], bench[key], key)
})

test('the detents run the tape shelf\'s pinned shape and timing; Tame / CURVE / DETECT reach the shelf only on the bench', () => {
  for (const hf of HF_MODES) {
    const k = toKernelParams({ hf, tame: 7, voiceLevelDb: -20 })
    for (const key of Object.keys(TAPE_SHELF)) assert.equal(k[key], TAPE_SHELF[key], `${hf} ${key}`)
  }
  // Off the bench, Tame and its rockers do nothing.
  for (const hf of HF_PANEL_DETENTS) {
    assert.deepEqual(
      toKernelParams({ hf, tame: 0, curve: 'voice', detect: '4k', voiceLevelDb: -20 }),
      toKernelParams({ hf, tame: 9, curve: 'fatso', detect: '2k', voiceLevelDb: -20 }),
      hf,
    )
  }
  assert.equal(toKernelParams({ hf: 'off', voiceLevelDb: -20 }).rangeDb, 0)
  // An unknown detent is the shipping one.
  assert.deepEqual(toKernelParams({ hf: 'nope', voiceLevelDb: -20 }), toKernelParams({ hf: PHATASS_DEFAULTS.hf, voiceLevelDb: -20 }))
})

test('HF OFF, with everything else at 0, passes the audio through untouched', () => {
  const { x } = narration(1, 6)
  const stats = measureTrebleStats([segmentOf([x])], x.length / SR, SR, 1, msDb(x))
  const { channelData: [y], latencySamples: L } = processPhatassBuffer(
    [x], SR, toKernelParams({ hf: 'off', warmth: 0, soften: 0, tape: 0, voiceLevelDb: msDb(x), trebleStats: stats }),
  )
  for (let i = L; i < x.length; i++) if (y[i] !== x[i - L]) assert.fail(`sample ${i} differs`)
})

// ── The measurement ──────────────────────────────────────────────────────────

test('treble stats: a steady tone reads its detector band\'s peak at every percentile, re the voice level', () => {
  const f = 9000, a = 0.2
  const n = SR
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = a * Math.sin((2 * Math.PI * f * i) / SR)
  const voice = db(a / Math.SQRT2)
  const s = measureTrebleStats([segmentOf([x])], n / SR, SR, 1, voice)
  assert.ok(s.windows > 90)
  for (const [key, hz] of Object.entries(TREBLE_DETECT_HZ)) {
    // |1 − LP1| of the kernel's own bilinear one-pole at f.
    const { b0, a1 } = onePoleLowpass(SR, hz)
    const w = (2 * Math.PI * f) / SR
    const nr = b0 * (1 + Math.cos(w)), ni = -b0 * Math.sin(w)
    const dr = 1 + a1 * Math.cos(w), di = -a1 * Math.sin(w)
    const den = dr * dr + di * di
    const hr = 1 - (nr * dr + ni * di) / den, hi = -(ni * dr - nr * di) / den
    const want = db(a * Math.hypot(hr, hi)) - voice
    for (const p of Object.keys(TREBLE_PERCENTILES)) {
      assert.ok(Math.abs(s.bands[key][p] - want) < 0.15, `${key} ${p}: ${s.bands[key][p].toFixed(2)} vs ${want.toFixed(2)}`)
    }
  }
})

test('treble stats: pauses do not count, silence is null, and a hard-panned channel reads as it would alone', () => {
  const { x } = narration(2, 0)
  const voice = msDb(x)
  const alone = measureTrebleStats([segmentOf([x])], x.length / SR, SR, 1, voice)
  // Percentiles rise monotonically.
  for (const band of Object.values(alone.bands)) {
    const v = Object.keys(TREBLE_PERCENTILES).map(p => band[p])
    for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1])
  }
  // A second of silence spliced in front changes nothing: those windows are pauses.
  const gap = [{ outputStart: 0, sourceStart: 0, sourceEnd: 1, sourceBuffer: null }, segmentOf([x], { outputStart: 1 })]
  const withGap = measureTrebleStats(gap, 1 + x.length / SR, SR, 1, voice)
  for (const key of Object.keys(alone.bands)) {
    for (const p of Object.keys(TREBLE_PERCENTILES)) {
      assert.ok(Math.abs(withGap.bands[key][p] - alone.bands[key][p]) < 0.25, `${key} ${p}`)
    }
  }
  // Stereo, voice hard left and nothing right: the peak is the loudest channel's.
  const stereo = measureTrebleStats([segmentOf([x, new Float32Array(x.length)])], x.length / SR, SR, 2, voice - 3)
  for (const key of Object.keys(alone.bands)) {
    // Activity is the mean of the channels' power (3 dB down), so pass the
    // voice level 3 dB down too; the peaks then read 3 dB higher re it.
    assert.ok(Math.abs(stereo.bands[key].p90 - (alone.bands[key].p90 + 3)) < 0.25, `${key}`)
  }
  assert.equal(measureTrebleStats([segmentOf([new Float32Array(SR)])], 1, SR, 1, -20), null)
})

// ── The behaviour the floor exists for ───────────────────────────────────────

/** Energy change of `part` (bed or sibilance) through the chain, dB, by projecting the output on it. */
function partChangeDb(y, L, part) {
  let num = 0, den = 0
  for (let i = 0; i + L < y.length; i++) { num += y[i + L] * part[i]; den += part[i] * part[i] }
  return db(Math.abs(num / den))
}

test('AIR eases a bright take\'s sibilance and leaves its vowels; on a dull take the floor leaves the sibilance alone', () => {
  // Every S here is equally loud, so this also pins the cap: without it the
  // 98th percentile sat on top of all of them and AIR did nothing (−0.13 dB).
  const run = (take, hf) => {
    const voice = msDb(take.x)
    const trebleStats = measureTrebleStats([segmentOf([take.x])], take.x.length / SR, SR, 1, voice)
    const { channelData: [y], latencySamples: L } = processPhatassBuffer(
      [take.x], SR, toKernelParams({ hf, warmth: 0, soften: 0, tape: 0, voiceLevelDb: voice, trebleStats }),
    )
    return { sib: partChangeDb(y, L, take.sib), bed: partChangeDb(y, L, take.bed) }
  }
  const bright = narration(6, 6), dull = narration(6, -10)
  const b = run(bright, 'air'), d = run(dull, 'air')
  assert.ok(b.sib < -1, `bright sibilance ${b.sib.toFixed(2)} dB`)
  assert.ok(b.bed > -0.2, `bright vowels ${b.bed.toFixed(2)} dB`)
  assert.ok(d.sib > -0.3, `dull sibilance ${d.sib.toFixed(2)} dB`)
  // Deeper detents take more of the bright take's sibilance.
  const s = run(bright, 'smooth'), k = run(bright, 'dark')
  assert.ok(s.sib < b.sib - 0.5 && k.sib < s.sib - 0.5, `air ${b.sib.toFixed(2)} smooth ${s.sib.toFixed(2)} dark ${k.sib.toFixed(2)}`)
})
