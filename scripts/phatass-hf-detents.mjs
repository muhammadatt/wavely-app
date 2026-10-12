#!/usr/bin/env node
/**
 * PHAT*SS — what each HF detent does on narration.
 *
 *   node scripts/phatass-hf-detents.mjs <clip.wav> [<clip.wav> ...]
 *
 * For each clip: the tape HF shelf's detector level (the emphasised band's
 * energy, attack 3 / release 80 ms, re the voice level, over active frames)
 * at each speed's emphasis corner, then, for each detent at TAPE 0 / 4 / 8
 * (with TAPE's makeup measured as the app does, since the shelf hears it),
 * the change against the SAME chain with HF off (so TAPE's own effect drops
 * out):
 *
 *   sib  — energy at 4–16 kHz on SIBILANT frames (4–16 kHz outweighs
 *          100–1000 Hz), dB
 *     on / body — the same split: the first frame of each sibilant run (its
 *          onset, ~12 ms) against the rest of the run
 *   vow  — energy at 2–4 kHz on VOICED frames (the rest), dB
 *   hf   — energy above 2 kHz over all active frames, dB
 *   cut% — share of active frames losing more than 1 dB above 2 kHz
 *
 * The metric is the one the VOICE curve was voiced with, so the numbers line
 * up with the dev log. Warmth and Soften are off.
 */

import { readWav } from './lib/wav.js'
import { regionAlignDb } from '../src/audio/analysisWindow.js'
import { ALIGN_TARGET_DBFS } from '../src/audio/dsp/inputAlign.js'
import { onePoleLowpass } from '../src/audio/dsp/hfLimit.js'
import { processPhatassBuffer } from '../src/audio/phatassProcessor.js'
import { measureTapeMakeup } from '../src/audio/phatassTapeMakeup.js'
import { toKernelParams, HF_PANEL_DETENTS, TAPE_SPEEDS, TAPE_HF_LAW, tapeHfShelfParams } from '../src/audio/phatassParams.js'
import { getFFT } from '../src/audio/dsp/fft.js'

const FRAME = 1024
const HOP = 512
const ACTIVE_BELOW_DB = 30
const TAPES = [0, 4, 8]

function voiceLevel(x, sr) {
  const seg = { outputStart: 0, sourceStart: 0, sourceEnd: x.length / sr, sourceBuffer: { getChannelData: () => x, numberOfChannels: 1 } }
  return ALIGN_TARGET_DBFS - regionAlignDb([seg], 0, x.length / sr, sr, 1)
}

/** The tape HF shelf's detector level re the voice, percentiles over active samples. */
function detectorStats(x, sr, voice, hz) {
  const { b0, a1 } = onePoleLowpass(sr, hz)
  const att = Math.exp(-1 / (TAPE_HF_LAW.attackMs * 1e-3 * sr)), rel = Math.exp(-1 / (TAPE_HF_LAW.releaseMs * 1e-3 * sr))
  const bbc = Math.exp(-1 / (0.05 * sr))
  let x1 = 0, y1 = 0, env = 0, bb = 0
  const vals = []
  for (let i = 0; i < x.length; i++) {
    const d = b0 * (x[i] + x1) - a1 * y1
    x1 = x[i]; y1 = d
    const h = x[i] - d
    env = h * h + (env - h * h) * (h * h > env ? att : rel)
    bb = x[i] * x[i] + (bb - x[i] * x[i]) * bbc
    if (i % 64 === 0 && 10 * Math.log10(bb + 1e-20) > voice - ACTIVE_BELOW_DB) vals.push(10 * Math.log10(env + 1e-20) - voice)
  }
  vals.sort((a, b) => a - b)
  const q = f => vals[Math.round(f * (vals.length - 1))]
  return { p50: q(0.5), p90: q(0.9), p98: q(0.98), max: q(1) }
}

const BANDS = [[100, 1000], [4000, 16000], [2000, 4000], [2000, 16000]]

function frameBands(x, sr) {
  const fft = getFFT(FRAME)
  const re = new Float64Array(FRAME / 2 + 1), im = new Float64Array(FRAME / 2 + 1)
  const buf = new Float64Array(FRAME), win = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)
  const bins = BANDS.map(([lo, hi]) => [Math.ceil((lo * FRAME) / sr), Math.min(FRAME / 2, Math.floor((hi * FRAME) / sr))])
  const out = []
  for (let s = 0; s + FRAME <= x.length; s += HOP) {
    let ms = 0
    for (let i = 0; i < FRAME; i++) { buf[i] = x[s + i] * win[i]; ms += x[s + i] * x[s + i] }
    fft.rfft(buf, re, im)
    out.push({ ms: ms / FRAME, e: bins.map(([a, b]) => { let e = 0; for (let k = a; k <= b; k++) e += re[k] * re[k] + im[k] * im[k]; return e }) })
  }
  return out
}

/** Classify frames on the DRY so every render is read on the same frames. */
function classify(dry, sr, voice) {
  const gate = Math.pow(10, (voice - ACTIVE_BELOW_DB) / 10)
  const f = frameBands(dry, sr)
  let prevSib = false
  return f.map(fr => {
    const active = fr.ms >= gate
    const sib = active && fr.e[1] > fr.e[0]
    const kind = !active ? null : sib ? (prevSib ? 'body' : 'onset') : 'vow'
    prevSib = sib
    return kind
  })
}

function compare(kinds, A, B) {
  const acc = { sib: [0, 0], onset: [0, 0], body: [0, 0], vow: [0, 0], hf: [0, 0] }
  let n = 0, cut = 0
  for (let i = 0; i < Math.min(A.length, B.length, kinds.length); i++) {
    const k = kinds[i]
    if (!k) continue
    n++
    acc.hf[0] += A[i].e[3]; acc.hf[1] += B[i].e[3]
    if (A[i].e[3] > 0 && 10 * Math.log10(B[i].e[3] / A[i].e[3]) < -1) cut++
    if (k === 'vow') { acc.vow[0] += A[i].e[2]; acc.vow[1] += B[i].e[2] } else {
      acc.sib[0] += A[i].e[1]; acc.sib[1] += B[i].e[1]
      acc[k][0] += A[i].e[1]; acc[k][1] += B[i].e[1]
    }
  }
  const d = ([i, o]) => (i > 0 ? 10 * Math.log10(o / i) : 0)
  return { sib: d(acc.sib), onset: d(acc.onset), body: d(acc.body), vow: d(acc.vow), hf: d(acc.hf), cutPct: (100 * cut) / n }
}

function render(x, sr, params) {
  const { channelData, latencySamples } = processPhatassBuffer([x], sr, toKernelParams(params))
  return channelData[0].subarray(latencySamples)
}

const fmt = v => (v >= 0 ? ' ' : '') + v.toFixed(2)

for (const path of process.argv.slice(2)) {
  const { mono, sampleRate: sr } = readWav(path)
  const x = Float32Array.from(mono)
  const voice = voiceLevel(x, sr)
  console.log(`\n${path.split('/').pop()}  ${sr} Hz  ${(x.length / sr).toFixed(1)} s  voice ${voice.toFixed(2)} dBFS`)
  for (const [key, sp] of Object.entries(TAPE_SPEEDS)) {
    const s = detectorStats(x, sr, voice, sp.detectHz)
    console.log(`  detector ${sp.label.padStart(3)} ips (${sp.detectHz} Hz) re voice: p50 ${fmt(s.p50)}  p90 ${fmt(s.p90)}  p98 ${fmt(s.p98)}  max ${fmt(s.max)}`)
  }
  // Classify on the dry, aligned to the renders (which have their latency removed).
  const kinds = classify(x, sr, voice)
  for (const tape of TAPES) {
    let pk = 0
    for (const v of x) pk = Math.max(pk, Math.abs(v))
    const base0 = { warmth: 0, tape, voiceLevelDb: voice, warmthCeilingDb: 20 * Math.log10(pk) }
    const base = { ...base0, tapeMakeupDb: tape > 0 ? measureTapeMakeup([x], sr, base0).makeupDb : 0 }
    const ref = frameBands(render(x, sr, { ...base, hf: 'off' }), sr)
    console.log(`  TAPE ${tape} (makeup ${base.tapeMakeupDb.toFixed(2)} dB):`)
    for (const hf of HF_PANEL_DETENTS.filter(d => d !== 'off')) {
      const r = compare(kinds, ref, frameBands(render(x, sr, { ...base, hf }), sr))
      const t = tapeHfShelfParams(hf, voice)
      const label = `${TAPE_SPEEDS[hf].label} ips (${(t.thresholdDb - voice).toFixed(1)})`
      console.log(`    ${label.padEnd(18)} sib ${fmt(r.sib)} (on ${fmt(r.onset)} / body ${fmt(r.body)})  vow ${fmt(r.vow)}  hf ${fmt(r.hf)}  cut% ${r.cutPct.toFixed(1).padStart(5)}`)
    }
  }
}
