/**
 * Saturation Bench — the layered waveshaper moved out of the HF Softener.
 *
 * Synthetic voice with realistic upper formants (energy above 3 kHz at −19.9
 * dB of the vowel): a low-passed test voice makes every exciter look inert.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  processSaturationBenchBuffer, SaturationBenchKernel, SAT_BENCH_LATENCY_SAMPLES, SAT_BENCH_MAX_LAYERS,
  SAT_EMPH_CORNER_HZ, SAT_EMPH_DB, SAT_EMPH_Q, SAT_EMPH_TYPES, SAT_EMPH_QUICK, SAT_REF_CREST_DB,
  emphasisSections, layerBand, layerBandSections, bandHighpassCornerHz, normalizeLayer,
} from '../../src/audio/saturationBenchProcessor.js'
import { measureBandSpectrum, bandRefPeakDb, voicingOffsetDb } from '../../src/audio/saturationBenchAnalysis.js'
import { toKernelParams, SATURATION_BENCH_DEFAULTS, SAT_BENCH_LAYER_PRESETS } from '../../src/audio/saturationBenchParams.js'
import { SHAPER_CURVES, SHAPER_REF_THD, sineThd, unitDriveU } from '../../src/audio/dsp/shaperCurves.js'
import { EMPHASIS_CORNER_HZ, EMPHASIS_MAX_DB, EMPHASIS_DEFAULT } from '../../src/audio/la2aProcessor.js'
import { BiquadCascade, highpass, lowpass, peaking, magnitudeResponseDb } from '../../src/audio/dsp/biquad.js'

const L = SAT_BENCH_LATENCY_SAMPLES

/** Minimal per-sample biquad over the shared coefficient builders. */
class Biquad {
  constructor(c) { this.c = new BiquadCascade(1, 1); this.c.setSections([c]); this.b = new Float64Array(1); this.o = new Float64Array(1) }
  tick(x) { this.b[0] = x; this.c.process(this.b, this.o, 1, 0); return this.o[0] }
}

function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 4294967296) * 2 - 1
  }
}

function pink(n, seed = 1) {
  const rnd = lcg(seed)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  const o = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const w = rnd()
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.05
    b6 = w * 0.115926
  }
  return o
}

function makeRichSpeech(sr, { seconds = 3, seed = 3 } = {}) {
  const rnd = lcg(seed)
  const n = Math.round(sr * seconds)
  const x = new Float32Array(n)
  const labels = new Uint8Array(n)
  const a = Math.exp(-2 * Math.PI * 500 / sr)
  let lp = 0
  const fs = [peaking(sr, 700, 3, 12), peaking(sr, 1200, 3, 10), peaking(sr, 2600, 4, 5), peaking(sr, 3500, 4, 3), lowpass(sr, 4000, 0.6)]
    .map(c => new Biquad(c))
  const sh = new Biquad(highpass(sr, 5000, 0.7))
  const sl = new Biquad(lowpass(sr, 9000, 0.7))
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = (i % sr) / sr
    let v = 0
    let lab = 0
    const voiced = t < 0.35 || (t >= 0.39 && t < 0.6)
    let pulse = 0
    if (voiced) {
      phase += 130 / sr
      if (phase >= 1) phase -= 1
      pulse = phase < 130 / sr ? 1 : 0
    }
    lp = (1 - a) * pulse + a * lp
    let vv = lp
    for (const f of fs) vv = f.tick(vv)
    if (voiced) { v = vv * 7.249; lab = 1 }
    const sib = sl.tick(sh.tick(rnd()))
    if ((t >= 0.35 && t < 0.39) || (t >= 0.7 && t < 0.735)) {
      const tt = t < 0.5 ? t - 0.35 : t - 0.7
      v += sib * Math.pow(10, -22 / 20) * 2.2 * Math.min(1, tt / 0.003)
      lab = 2
    }
    x[i] = v
    labels[i] = lab
  }
  return { x, labels }
}


/** Energy of `y` in [lo, hi) Hz over samples where `mask(i)`, after the first second. */
function bandEnergy(y, sr, mask, lo, hi) {
  const f = []
  if (lo) f.push(new Biquad(highpass(sr, lo, 0.7)), new Biquad(highpass(sr, lo, 0.7)))
  if (hi) f.push(new Biquad(lowpass(sr, hi, 0.7)), new Biquad(lowpass(sr, hi, 0.7)))
  let s = 0
  for (let i = 0; i < y.length; i++) {
    let v = y[i]
    for (const q of f) v = q.tick(v)
    if (i > sr && mask(i)) s += v * v
  }
  return s
}

/** Render with the latency removed, so output index i lines up with input i. */
function render(x, sr, params, options) {
  const y = processSaturationBenchBuffer([x], sr, params, options).channelData[0]
  const o = new Float32Array(x.length)
  o.set(y.subarray(L))
  return o
}

const layers = (...ls) => ({ layers: ls.map(l => ({ on: true, ...l })) })

test('curves: unity slope at zero, matched to the reference THD at their unit drive', () => {
  for (const c of SHAPER_CURVES) {
    assert.equal(c.f(0), 0, c.id)
    const slope = (c.f(1e-6) - c.f(-1e-6)) / 2e-6
    assert.ok(Math.abs(slope - 1) < 1e-6, `${c.id} slope ${slope}`)
    const thd = sineThd(c.f, unitDriveU(c.id))
    assert.ok(Math.abs(thd - SHAPER_REF_THD) < 1e-4, `${c.id} THD ${thd}`)
  }
})

test('latency is constant: every layer off is a pure delay of exactly SAT_BENCH_LATENCY_SAMPLES', () => {
  const sr = 44100
  const x = pink(sr, 4)
  const y = processSaturationBenchBuffer([x], sr, { layers: [] }).channelData[0]
  assert.equal(L, SAT_BENCH_MAX_LAYERS * 50)
  let worst = 0
  for (let i = 0; i < x.length - L; i++) worst = Math.max(worst, Math.abs(y[i + L] - x[i]))
  assert.equal(worst, 0)
})

test('a layer sounds the same in any slot: the voicing weight is aligned per slot', () => {
  const sr = 44100
  const { x } = makeRichSpeech(sr)
  const layer = { on: true, curve: 'tanh', driveDb: 14, emph: 'reverse', loHz: 3000, mode: 'voiced' }
  const first = render(x, sr, { layers: [layer] })
  const last = render(x, sr, { layers: [{ on: false }, { on: false }, { on: false }, layer] })
  let worst = 0
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(first[i] - last[i]))
  assert.ok(worst < 1e-7, `slot 1 vs slot 4: ${worst}`)
})

test('drive follows the reference peak dB for dB: level-invariant', () => {
  const sr = 44100
  const { x } = makeRichSpeech(sr)
  const a = 2 // +6.02 dB
  const hot = x.map(v => v * a)
  const p = { curve: 'tanh', driveDb: 6, emph: 'opto', mode: 'full', refPeakDb: -10 }
  const y1 = render(x, sr, layers(p))
  const y2 = render(hot, sr, layers({ ...p, refPeakDb: -10 + 20 * Math.log10(a) }))
  let worst = 0
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(y2[i] / a - y1[i]))
  assert.ok(worst < 1e-5, `worst ${worst}`)
})

test('emphasis: the corner is OptoSmooth’s (copied not imported), the depth is deliberately twice its', () => {
  assert.equal(SAT_EMPH_CORNER_HZ, EMPHASIS_CORNER_HZ)
  // Set by hand on the bench: 24 × 0.85, against OptoSmooth's 12 × 0.85.
  assert.equal(SAT_EMPH_DB, 24 * 0.85)
  assert.equal(SAT_EMPH_DB, 2 * (EMPHASIS_MAX_DB * EMPHASIS_DEFAULT / 100))
})

test('emphasis: OPTO distorts the highs harder, REVERSE spares them (sine)', () => {
  const sr = 44100
  const n = sr * 2
  const thdAt = (f0, emph) => {
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = Math.pow(10, -8 / 20) * Math.sin(2 * Math.PI * f0 * i / sr)
    const y = render(x, sr, layers({ curve: 'quartic', driveDb: 4.5, mode: 'full', emph, refPeakDb: -8 }))
    const a = sr, b = n - 4096, N = b - a
    const pw = (f) => {
      let c = 0, s = 0
      for (let i = a; i < b; i++) {
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - a) / N)
        c += w * y[i] * Math.cos(2 * Math.PI * f * i / sr)
        s += w * y[i] * Math.sin(2 * Math.PI * f * i / sr)
      }
      return c * c + s * s
    }
    let h = 0
    for (let k = 2; k * f0 < 21000; k++) h += pw(k * f0)
    return Math.sqrt(h / pw(f0))
  }
  const off = thdAt(5000, 'off'), opto = thdAt(5000, 'opto'), rev = thdAt(5000, 'reverse')
  assert.ok(opto > off * 1.3, `5 kHz: opto ${opto} vs off ${off}`)
  assert.ok(rev < off * 0.2, `5 kHz: reverse ${rev} vs off ${off}`)
})

test('emphasis: a legacy OPTO / REV / OFF layer migrates to the equivalent filter, bit for bit', () => {
  const sr = 44100
  const { x } = makeRichSpeech(sr, { seconds: 2 })
  const base = { curve: 'tanh', driveDb: 12, mode: 'full', refPeakDb: -10 }
  for (const [emph, db] of [['opto', SAT_EMPH_DB], ['reverse', -SAT_EMPH_DB], ['off', 0]]) {
    const n = normalizeLayer({ emph })
    assert.deepEqual([n.emphType, n.emphHz, n.emphQ, n.emphDb], ['hishelf', SAT_EMPH_CORNER_HZ, SAT_EMPH_Q, db])
    const a = render(x, sr, layers({ ...base, emph }))
    const b = render(x, sr, layers({ ...base, emphType: 'hishelf', emphHz: SAT_EMPH_CORNER_HZ, emphQ: SAT_EMPH_Q, emphDb: db }))
    assert.deepEqual(a, b, emph)
  }
  // An explicit gain wins over a stale legacy string.
  assert.equal(normalizeLayer({ emph: 'opto', emphDb: -3 }).emphDb, -3)
})

test('emphasis: every shape\'s de-emphasis is the exact inverse of its pre-emphasis', () => {
  const sr = 44100
  const freqs = [60, 150, 400, 1000, 2300, 5000, 9000, 15000, 20000]
  for (const type of SAT_EMPH_TYPES) {
    for (const [hz, q, db] of [[2300, SAT_EMPH_Q, 20.4], [800, 2.5, -14], [6000, 0.4, 24], [250, 4, 9]]) {
      const { pre, de } = emphasisSections(type, hz, q, db, sr)
      const a = magnitudeResponseDb(pre, freqs, sr)
      const b = magnitudeResponseDb(de, freqs, sr)
      for (let i = 0; i < freqs.length; i++) {
        assert.ok(Math.abs(a[i] + b[i]) < 1e-6, `${type} ${hz}/${q}/${db} @ ${freqs[i]}: ${a[i]} + ${b[i]}`)
      }
    }
  }
})

test('emphasis: 0 dB is off whatever the shape, frequency and Q, and the three shapes aim differently', () => {
  const sr = 44100
  const n = sr * 2
  const tone = f0 => {
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = Math.pow(10, -8 / 20) * Math.sin(2 * Math.PI * f0 * i / sr)
    return x
  }
  const base = { curve: 'tanh', driveDb: 0, mode: 'full', refPeakDb: -8 }
  const x = tone(200)
  const off = render(x, sr, layers({ ...base, emphDb: 0 }))
  for (const type of SAT_EMPH_TYPES) {
    assert.deepEqual(render(x, sr, layers({ ...base, emphType: type, emphHz: 1234, emphQ: 3, emphDb: 0 })), off, type)
  }
  // The energy a layer adds on a 200 Hz tone: a low shelf and a bell on it push the tone into the
  // curve; a high shelf well above it does not.
  const added = (type, hz, db) => {
    const y = render(x, sr, layers({ ...base, emphType: type, emphHz: hz, emphQ: 1, emphDb: db }))
    let e = 0
    for (let i = sr; i < n; i++) e += (y[i] - x[i]) * (y[i] - x[i])
    return e
  }
  const e0 = added('hishelf', 2300, 0)
  assert.ok(added('loshelf', 1000, 18) > e0 * 3, 'low shelf')
  assert.ok(added('bell', 200, 18) > e0 * 3, 'bell')
  assert.ok(added('hishelf', 2300, 18) < e0 * 1.5, 'high shelf leaves a 200 Hz tone alone')
})

test('emphasis: out-of-range values are clamped, and the quick buttons are the 2300 Hz pair', () => {
  const n = normalizeLayer({ emphType: 'nope', emphHz: 1e9, emphQ: 0.001, emphDb: 99 })
  assert.deepEqual([n.emphType, n.emphHz, n.emphQ, n.emphDb], ['hishelf', 16000, 0.3, 24])
  assert.equal(SAT_EMPH_QUICK.opto.emphDb, -SAT_EMPH_QUICK.reverse.emphDb)
  assert.deepEqual(Object.keys(SAT_EMPH_QUICK.off), ['emphDb'])
})

test('band: the Low edge fades in from open — no cliff at 20 → 20.1 Hz, open untouched', () => {
  assert.equal(bandHighpassCornerHz(20), 0)
  assert.equal(bandHighpassCornerHz(10), 0)
  assert.ok(Math.abs(bandHighpassCornerHz(21) - (21 - 400 / 21)) < 1e-12)
  assert.ok(Math.abs(bandHighpassCornerHz(100) - 96) < 1e-12)
  assert.ok(Math.abs(bandHighpassCornerHz(3000) - 3000) < 0.2)
  const sr = 44100
  const n = sr * 3
  // A vowel-like stack with a syllable envelope: an even curve rectifies it and
  // its added signal is mostly below 60 Hz, which a hard 21 Hz corner stripped.
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * i / sr)
    let v = 0
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * 140 * h * i / sr) / h
    x[i] = 0.18 * env * v
  }
  const layer = lo => ({
    curve: 'quartic', driveDb: 0, loHz: lo, hiHz: 400, mode: 'full', refPeakDb: -12,
    emphType: 'bell', emphHz: 350, emphQ: 0.5, emphDb: 24,
  })
  const addedRms = y => {
    let e = 0
    for (let i = sr; i < n - L; i++) e += (y[i] - x[i]) ** 2
    return 10 * Math.log10(e / (n - L - sr))
  }
  const open = render(x, sr, layers(layer(20)))
  const next = render(x, sr, layers(layer(20.1)))
  const one = render(x, sr, layers(layer(21)))
  assert.ok(Math.abs(addedRms(next) - addedRms(open)) < 0.05, `20.1: ${addedRms(next)} vs open ${addedRms(open)}`)
  assert.ok(Math.abs(addedRms(one) - addedRms(open)) < 1.5, `21: ${addedRms(one)} vs open ${addedRms(open)}`)
  // What the first click used to do: the knob position whose faded corner is
  // 21 Hz reproduces the old hard step, and it is a cliff on this material.
  const hard21 = render(x, sr, layers(layer((21 + Math.sqrt(21 * 21 + 1600)) / 2)))
  assert.ok(addedRms(hard21) < addedRms(open) - 4, `hard 21 Hz: ${addedRms(hard21)} vs open ${addedRms(open)}`)
  // Open is still no filter at all.
  assert.deepEqual(layerBandSections(20, 20000, sr).slice(0, 2), [
    { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }, { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 },
  ])
})

test('band: what a layer adds stays inside its band', () => {
  const sr = 44100
  const { x, labels } = makeRichSpeech(sr)
  const vow = i => labels[i] === 1
  // An even curve on a high band makes difference tones below it; the second
  // band pass removes them.
  const hf = render(x, sr, layers({ curve: 'asym', driveDb: 16, loHz: 3000, mode: 'full' }))
  const dHf = hf.map((v, i) => v - x[i])
  const below = 10 * Math.log10(bandEnergy(dHf, sr, vow, 0, 2000) / bandEnergy(dHf, sr, vow, 3000, 0))
  assert.ok(below < -20, `HF layer, added below 2 kHz re above 3 kHz: ${below.toFixed(1)} dB`)
  // An odd curve on a low band makes harmonics above it; the low-pass keeps them in.
  const lf = render(x, sr, layers({ curve: 'tanh', driveDb: 12, hiHz: 500, mode: 'full' }))
  const dLf = lf.map((v, i) => v - x[i])
  const above = 10 * Math.log10(bandEnergy(dLf, sr, vow, 1500, 0) / bandEnergy(dLf, sr, vow, 0, 500))
  assert.ok(above < -20, `LF layer, added above 1.5 kHz re below 500 Hz: ${above.toFixed(1)} dB`)
})

test('band: open edges are no filter at all, and the band never closes', () => {
  assert.deepEqual(layerBand(20, 20000, 44100), { lo: null, hi: null })
  assert.deepEqual(layerBand(3000, 20000, 44100), { lo: 3000, hi: null })
  const tight = layerBand(1000, 1000, 44100)
  assert.ok(tight.hi / tight.lo >= Math.pow(2, 1 / 3) - 1e-9, JSON.stringify(tight))
})

test('VOICED keeps an exciter out of sibilants and pauses; FULL excites the "s"', () => {
  const sr = 44100
  const { x: voice, labels } = makeRichSpeech(sr)
  const floor = pink(voice.length, 11)
  const x = voice.map((v, i) => v + floor[i] * 0.002)
  // The 3 kHz-up band's measured reference on this voice (see the calibration
  // test); the app measures it per file.
  const p = { curve: 'tanh', driveDb: 27, emph: 'reverse', loHz: 3000, refPeakDb: -23 }
  const y0 = x
  const yv = render(x, sr, layers({ ...p, mode: 'voiced' }))
  const yf = render(x, sr, layers({ ...p, mode: 'full' }))
  const lift = (y, m) => 10 * Math.log10(bandEnergy(y, sr, m, 5000, 0) / bandEnergy(y0, sr, m, 5000, 0))
  const vow = i => labels[i] === 1
  const sib = i => labels[i] === 2
  const t = i => (i % sr) / sr
  const gap = i => labels[i] === 0 && ((t(i) > 0.62 && t(i) < 0.7) || t(i) > 0.755)
  const vV = lift(yv, vow), sV = lift(yv, sib), sF = lift(yf, sib), gV = lift(yv, gap)
  assert.ok(vV > 1, `vowels brightened: ${vV.toFixed(2)} dB`)
  // FULL's margin over VOICED on the "s" was +0.9 dB at ±10.2 dB emphasis; REV at ±20.4 dB takes the
  // sibilants out before the curve too, so at +27 it is ~+0.3.
  assert.ok(sV < 0.3 && sF > sV + 0.2, `"s": voiced ${sV.toFixed(2)}, full ${sF.toFixed(2)} dB`)
  assert.ok(Math.abs(gV) < 0.1, `pauses: ${gV.toFixed(3)} dB`)
})

test('calibration: a band’s reference peak is its gated level plus crest', () => {
  const sr = 44100
  const { x } = makeRichSpeech(sr, { seconds: 4 })
  const seg = [{ outputStart: 0, sourceStart: 0, sourceEnd: x.length / sr, sourceBuffer: { numberOfChannels: 1, getChannelData: () => x } }]
  const s = measureBandSpectrum(seg, 0, x.length / sr, sr, 1)
  const full = bandRefPeakDb(s, 20, 20000)
  assert.ok(Math.abs(full - (s.gatedRmsDb + SAT_REF_CREST_DB)) < 0.2, `full ${full} vs gated ${s.gatedRmsDb}`)
  const hf = bandRefPeakDb(s, 3000, 20000)
  const lo = bandRefPeakDb(s, 80, 500)
  assert.ok(hf < full - 10 && lo < full, `3k+ ${hf.toFixed(1)}, 80–500 ${lo.toFixed(1)}, full ${full.toFixed(1)}`)
  assert.ok(Math.abs(voicingOffsetDb(s) - (s.gatedRmsDb + 20)) < 1e-9)
  // A silent region measures nothing, and the fallback is the nominal point.
  const quiet = [{ ...seg[0], sourceBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(x.length) } }]
  assert.equal(measureBandSpectrum(quiet, 0, x.length / sr, sr, 1), null)
  assert.equal(bandRefPeakDb(null, 3000, 20000), -8)
})

test('analysis: channels are measured apart, never summed', () => {
  const sr = 44100
  const { x } = makeRichSpeech(sr, { seconds: 4 })
  const neg = x.map(v => -v)
  const silent = new Float32Array(x.length)
  const stereo = (l, r) => [{
    outputStart: 0, sourceStart: 0, sourceEnd: x.length / sr,
    sourceBuffer: { numberOfChannels: 2, getChannelData: ch => (ch === 0 ? l : r) },
  }]
  const mono = measureBandSpectrum([{ outputStart: 0, sourceStart: 0, sourceEnd: x.length / sr, sourceBuffer: { numberOfChannels: 1, getChannelData: () => x } }], 0, x.length / sr, sr, 1)
  // Opposite phase on both sides: a mono sum would cancel to null.
  const anti = measureBandSpectrum(stereo(x, neg), 0, x.length / sr, sr, 2)
  assert.ok(anti, 'opposite-phase stereo must not cancel')
  assert.ok(Math.abs(anti.gatedRmsDb - mono.gatedRmsDb) < 1e-6, `${anti.gatedRmsDb} vs ${mono.gatedRmsDb}`)
  // Hard-panned: the shaper sees the full-level channel, so the reading is per channel's power
  // averaged with silence — 3 dB under mono, not the 6 dB a (L + R) / 2 sum would give.
  const panned = measureBandSpectrum(stereo(x, silent), 0, x.length / sr, sr, 2)
  assert.ok(Math.abs(panned.gatedRmsDb - (mono.gatedRmsDb - 10 * Math.log10(2))) < 1e-6, `${panned.gatedRmsDb}`)
})

test('analysis: a long file is sampled, not scanned, and agrees with the full read', () => {
  const sr = 44100
  const { x } = makeRichSpeech(sr, { seconds: 8 })
  const seg = [{ outputStart: 0, sourceStart: 0, sourceEnd: x.length / sr, sourceBuffer: { numberOfChannels: 1, getChannelData: () => x } }]
  const full = measureBandSpectrum(seg, 0, x.length / sr, sr, 1)
  const sampled = measureBandSpectrum(seg, 0, x.length / sr, sr, 1, { maxRmsBlocks: 32 })
  assert.ok(Math.abs(full.gatedRmsDb - sampled.gatedRmsDb) < 1.5, `${full.gatedRmsDb} vs ${sampled.gatedRmsDb}`)
})

test('params: plain, four layers, the factory pair on by default', () => {
  const k = toKernelParams(SATURATION_BENCH_DEFAULTS)
  assert.deepEqual(JSON.parse(JSON.stringify(k)), k)
  assert.equal(k.layers.length, SAT_BENCH_MAX_LAYERS)
  assert.deepEqual(SAT_BENCH_LAYER_PRESETS.map(l => l.on), [true, true, false, false])
  assert.equal(normalizeLayer({ curve: 'nope', emph: 'nope', mode: 'nope' }).curve, 'quartic')
  const kern = new SaturationBenchKernel(44100)
  kern.setParams(k, true)
  assert.equal(kern.latencySamples, L)
})
