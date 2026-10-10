#!/usr/bin/env node
/**
 * PHAT*SS — score the tape shelf against EL7 Fatso Warmth bounces.
 *
 *   node scripts/phatass-fatso-fit.mjs <dry.wav> <Warmth 2.wav> <5.wav> <6.wav> <7.wav> [--grid]
 *
 * The owner's bounces (2_FATSO_EL7x_-_Input_2.wav = Warmth off, and Warmth
 * 2 / 5 / 6 / 7 over it; music, 96 kHz float stereo, 8.35 s). Not in the repo
 * (no audio is); the readings this prints are kept in
 * data/fatso/el7_warmth_fits.json.
 *
 * This is the harness the dev log's "PHAT*SS — Tame/Tone against the EL7
 * Fatso's Warmth 2/5/6/7" describes, rebuilt (the original was scratch):
 *
 *   ALIGN   — each bounce carries a ~13-sample drop at one point and ±1 of
 *             drift. Per 85 ms block, the integer lag in ±24 that best
 *             correlates the bounce with the dry; a block whose neighbours'
 *             lags differ from its own by more than 2 sits next to the jump
 *             and is dropped. (Exact agreement kept only 27 of 98 blocks at
 *             Warmth 7, where the lag wanders 0–2 with the cut.)
 *   METRIC  — per 1024-sample frame (10.7 ms), per band (100–500, 0.5–1, 1–2,
 *             2–4, 4–8, 8–16 kHz), out/in energy in dB; ours minus the
 *             Fatso's, the mean solved out as Output, rms over frames and bands.
 *   OURS    — the tape shelf alone (`ShelfLimiterStage`, TAPE_SHELF's WARM /
 *             35 ms, corner 2 kHz), threshold re the dry's voice level as the
 *             app measures it (`regionAlignDb`). PHAT*SS at Warmth / TAPE /
 *             Soften 0 is exactly this plus a delay.
 *
 * Without --grid it prints the gain-only baselines and the shipping FATSO
 * law's Tame 1 / 4 / 6 against Warmth 5 / 6 / 7 — the dev log's 0.002 / 0.210
 * / 0.556 / 1.357 and 0.165 / 0.345 / 0.574, which is what validates the
 * rebuild. With --grid it also fits threshold / Range per Warmth under each
 * gain law (the limiter, quadratic soft knees, tanh).
 */

import { readFileSync } from 'node:fs'
import { ShelfLimiterStage } from '../src/audio/dsp/hfLimit.js'
import { regionAlignDb } from '../src/audio/analysisWindow.js'
import { ALIGN_TARGET_DBFS } from '../src/audio/dsp/inputAlign.js'
import { tapeShelf, TAPE_SHELF, FATSO_CORNER_HZ } from '../src/audio/phatassParams.js'
import { getFFT } from '../src/audio/dsp/fft.js'

const FRAME = 1024
const BANDS = [[100, 500], [500, 1000], [1000, 2000], [2000, 4000], [4000, 8000], [8000, 16000]]
const BLOCK_S = 0.085
const MAX_LAG = 24
const LAG_JITTER = 2
const BAND_FLOOR_DB = -100 // a band this quiet on the dry carries no reading

/** Float or 16/24-bit PCM WAV, every channel kept. */
function readWavChannels(path) {
  const buf = readFileSync(path)
  let pos = 12, fmt = null, data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size))
    if (id === 'fmt ') {
      fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) }
      if (fmt.format === 0xfffe && body.length >= 26) fmt.format = body.readUInt16LE(24)
    } else if (id === 'data') data = body
    pos += 8 + size + (size % 2)
  }
  const bytes = fmt.bits / 8
  const n = Math.floor(data.length / (bytes * fmt.channels))
  const read = fmt.format === 3
    ? (bytes === 8 ? o => data.readDoubleLE(o) : o => data.readFloatLE(o))
    : bytes === 2 ? o => data.readInt16LE(o) / 32768
      : o => (((data[o] << 8) | (data[o + 1] << 16) | (data[o + 2] << 24)) >> 8) / 8388608
  const ch = Array.from({ length: fmt.channels }, () => new Float32Array(n))
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.channels; c++) ch[c][i] = read((i * fmt.channels + c) * bytes)
  return { ch, sr: fmt.sampleRate }
}

const monoOf = ch => { const m = new Float32Array(ch[0].length); for (const c of ch) for (let i = 0; i < m.length; i++) m[i] += c[i] / ch.length; return m }

/** Per-block integer lag of `wet` against `dry`; null where a block sits next to a jump. */
function blockLags(dry, wet, sr) {
  const B = Math.round(BLOCK_S * sr)
  const a = monoOf(dry), b = monoOf(wet)
  const lags = []
  for (let s = MAX_LAG; s + B + MAX_LAG <= a.length; s += B) {
    let best = 0, bestC = -Infinity
    for (let l = -MAX_LAG; l <= MAX_LAG; l++) {
      let c = 0
      for (let i = s; i < s + B; i++) c += a[i] * b[i + l]
      if (c > bestC) { bestC = c; best = l }
    }
    lags.push({ start: s, lag: best })
  }
  return lags.map((x, k) => {
    const prev = lags[k - 1]?.lag ?? x.lag, next = lags[k + 1]?.lag ?? x.lag
    // ±JITTER is the Fatso's own phase moving with its gain (a one-pole's group
    // delay follows g), not timing; the drop is ~13 samples.
    return { ...x, ok: Math.abs(prev - x.lag) <= LAG_JITTER && Math.abs(next - x.lag) <= LAG_JITTER }
  })
}

/** Band energies per frame over the aligned, kept blocks: { [frameStart]: Float64Array(bands) }. */
function frameBandEnergies(ch, sr, frames, lagOf) {
  const fft = getFFT(FRAME)
  const re = new Float64Array(FRAME / 2 + 1), im = new Float64Array(FRAME / 2 + 1)
  const buf = new Float64Array(FRAME)
  const win = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)
  const bins = BANDS.map(([lo, hi]) => [Math.ceil((lo * FRAME) / sr), Math.floor((hi * FRAME) / sr)])
  return frames.map(f => {
    const e = new Float64Array(BANDS.length)
    const off = f + lagOf(f)
    for (const c of ch) {
      for (let i = 0; i < FRAME; i++) buf[i] = c[off + i] * win[i]
      fft.rfft(buf, re, im)
      bins.forEach(([a, b], k) => { for (let j = a; j <= b; j++) e[k] += re[j] * re[j] + im[j] * im[j] })
    }
    return e
  })
}

/** Run the tape shelf on the dry; output aligned to the input (latency removed). */
function renderShelf(dry, sr, p) {
  const st = new ShelfLimiterStage(sr)
  st.setParams({
    cornerHz: p.cornerHz ?? FATSO_CORNER_HZ, thresholdLin: Math.pow(10, p.thresholdDb / 20),
    floorLin: Math.pow(10, -p.rangeDb / 20), releaseMs: p.releaseMs ?? TAPE_SHELF.releaseMs,
    shape: TAPE_SHELF.shape, tailMs: 0, kneeDb: p.kneeDb ?? 0, law: p.law ?? 'limit',
  })
  const L = st.latencySamples
  const n = dry[0].length
  const bufs = dry.map(c => { const b = new Float32Array(n + L); b.set(c); return b })
  const Q = 128
  for (let o = 0; o < n + L; o += Q) {
    const len = Math.min(Q, n + L - o)
    st.process(bufs.map(b => b.subarray(o, o + len)), len)
  }
  return bufs.map(b => b.subarray(L, L + n))
}

/** rms of (ours − Fatso) in dB over frames × bands, the mean removed (Output). */
function score(dryE, oursE, fatE) {
  const d = []
  for (let f = 0; f < dryE.length; f++) {
    for (let k = 0; k < BANDS.length; k++) {
      if (10 * Math.log10(dryE[f][k] + 1e-30) < BAND_FLOOR_DB) continue
      const ours = 10 * Math.log10((oursE[f][k] + 1e-30) / (dryE[f][k] + 1e-30))
      const fat = 10 * Math.log10((fatE[f][k] + 1e-30) / (dryE[f][k] + 1e-30))
      d.push(ours - fat)
    }
  }
  const mean = d.reduce((s, v) => s + v, 0) / d.length
  return { rms: Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length), output: -mean }
}

// ── main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const grid = process.argv.includes('--grid')
const WARMTHS = [2, 5, 6, 7]
const { ch: dry, sr } = readWavChannels(args[0])
const seg = { outputStart: 0, sourceStart: 0, sourceEnd: dry[0].length / sr, sourceBuffer: { getChannelData: c => dry[c], numberOfChannels: dry.length } }
const voice = ALIGN_TARGET_DBFS - regionAlignDb([seg], 0, dry[0].length / sr, sr, dry.length)
console.log(`dry ${args[0].split('/').pop()}  ${sr} Hz  ${(dry[0].length / sr).toFixed(2)} s  voice ${voice.toFixed(2)} dBFS`)

const sets = WARMTHS.map((w, i) => {
  const { ch: wet } = readWavChannels(args[i + 1])
  const lags = blockLags(dry, wet, sr)
  const kept = lags.filter(b => b.ok)
  const B = Math.round(BLOCK_S * sr)
  const frames = []
  for (const b of kept) for (let f = b.start; f + FRAME <= b.start + B; f += FRAME) frames.push(f)
  const lagAt = new Map(); for (const b of kept) for (let f = b.start; f + FRAME <= b.start + B; f += FRAME) lagAt.set(f, b.lag)
  const dryE = frameBandEnergies(dry, sr, frames, () => 0)
  const fatE = frameBandEnergies(wet, sr, frames, f => lagAt.get(f))
  const jumps = lags.filter((b, k) => k > 0 && Math.abs(b.lag - lags[k - 1].lag) > LAG_JITTER).map(b => `${(b.start / sr).toFixed(2)} s → ${b.lag}`)
  console.log(`Warmth ${w}: ${kept.length}/${lags.length} blocks kept, ${frames.length} frames; lag changes ${jumps.join(', ') || 'none'}`)
  return { w, frames, dryE, fatE }
})

const cache = new Map()
function oursE(set, p) {
  const key = JSON.stringify(p)
  let y = cache.get(key)
  if (!y) { y = renderShelf(dry, sr, p); cache.set(key, y) }
  return frameBandEnergies(y, sr, set.frames, () => 0)
}
const fmt = r => `${r.rms.toFixed(3)} (Output ${r.output >= 0 ? '+' : ''}${r.output.toFixed(2)})`

console.log('\ngain-only baselines (dev log 0.002 / 0.210 / 0.556 / 1.357):')
for (const s of sets) console.log(`  Warmth ${s.w}: ${fmt(score(s.dryE, s.dryE, s.fatE))}`)

console.log('\nshipping FATSO law (dev log Warmth 5 / 6 / 7 at Tame 1 / 4 / 6: 0.165 / 0.345 / 0.574):')
for (const [w, tame] of [[5, 1], [6, 4], [7, 6]]) {
  const t = tapeShelf(tame, 10, 'fatso')
  const s = sets.find(x => x.w === w)
  console.log(`  Warmth ${w} / Tame ${tame} (thr ${t.thresholdRelDb}, R${t.rangeDb}): ${fmt(score(s.dryE, oursE(s, { thresholdDb: voice + t.thresholdRelDb, rangeDb: t.rangeDb }), s.fatE))}`)
}

if (grid) {
  const LAWS = [
    { name: 'limit', p: {} },
    { name: 'knee 3', p: { kneeDb: 3 } },
    { name: 'knee 6', p: { kneeDb: 6 } },
    { name: 'knee 9', p: { kneeDb: 9 } },
    { name: 'knee 12', p: { kneeDb: 12 } },
    { name: 'tanh', p: { law: 'tanh' } },
  ]
  const RANGES = [3, 6, 9, 12, 18]
  console.log('\nbest threshold (re voice) / Range per law, rms (coarse 2 dB grid, then ±1 refined):')
  for (const s of sets.filter(x => x.w >= 5)) {
    const line = []
    for (const law of LAWS) {
      let best = null
      const tryP = (thr, R) => {
        const r = score(s.dryE, oursE(s, { ...law.p, thresholdDb: voice + thr, rangeDb: R }), s.fatE)
        if (!best || r.rms < best.rms) best = { ...r, thr, R }
      }
      for (let thr = -10; thr <= 16; thr += 2) for (const R of RANGES) tryP(thr, R)
      const c = best
      for (const thr of [c.thr - 1, c.thr - 0.5, c.thr + 0.5, c.thr + 1]) tryP(thr, c.R)
      line.push(`${law.name}: ${best.rms.toFixed(3)} @ ${best.thr >= 0 ? '+' : ''}${best.thr} / R${best.R}`)
      cache.clear()
    }
    console.log(`  Warmth ${s.w}: ${line.join('  |  ')}`)
  }
}
