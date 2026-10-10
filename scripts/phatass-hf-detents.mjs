#!/usr/bin/env node
/**
 * PHAT*SS — the tape shelf's HF detents, measured on narration.
 *
 *   node scripts/phatass-hf-detents.mjs <clip.wav> [<clip.wav> ...]
 *
 * For each clip it prints the detector bands' 10 ms peak distribution (re the
 * file's gated RMS, the voice level the shelf already reads) and then, for each
 * detent in `HF_DETENTS` and each Tame position on the VOICE / FATSO curves,
 * what the shelf does:
 *
 *   sib  — energy change at 4–16 kHz on SIBILANT frames (4–16 kHz outweighs
 *          100–1000 Hz), dB
 *   vow  — energy change at 2–4 kHz on VOICED frames (the rest, above the
 *          activity gate), dB
 *   hf   — energy change above 2 kHz over all active frames, dB
 *   cut% — share of active frames losing more than 1 dB above 2 kHz
 *
 * The metric is the one the VOICE curve was voiced with (dev log, "PHAT*SS —
 * VOICE curve, original Tame/Tone deprecated, DETECT 2K/4K"), so the numbers
 * line up with it. Warmth, TAPE and Soften are off: this scores the shelf alone.
 */

import { readWav } from './lib/wav.js'
import { regionAlignDb } from '../src/audio/analysisWindow.js'
import { ALIGN_TARGET_DBFS } from '../src/audio/dsp/inputAlign.js'
import { processPhatassBuffer } from '../src/audio/phatassProcessor.js'
import { toKernelParams, HF_DETENTS, hfDetentShelf } from '../src/audio/phatassParams.js'
import { measureTrebleStats } from '../src/audio/phatassTrebleStats.js'
import { getFFT } from '../src/audio/dsp/fft.js'

const FRAME = 1024
const HOP = 512
const ACTIVE_BELOW_DB = 30

function voiceLevel(x, sr) {
  const seg = { outputStart: 0, sourceStart: 0, sourceEnd: x.length / sr, sourceBuffer: { getChannelData: () => x, numberOfChannels: 1 } }
  return ALIGN_TARGET_DBFS - regionAlignDb([seg], 0, x.length / sr, sr, 1)
}

/** Per-frame band energies (linear power) for a list of [lo, hi] bands. */
function frameBands(x, sr, bands) {
  const fft = getFFT(FRAME)
  const re = new Float64Array(FRAME / 2 + 1), im = new Float64Array(FRAME / 2 + 1)
  const buf = new Float64Array(FRAME)
  const win = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)
  const bins = bands.map(([lo, hi]) => [Math.ceil((lo * FRAME) / sr), Math.min(FRAME / 2, Math.floor((hi * FRAME) / sr))])
  const out = []
  for (let s = 0; s + FRAME <= x.length; s += HOP) {
    let ms = 0
    for (let i = 0; i < FRAME; i++) { buf[i] = x[s + i] * win[i]; ms += x[s + i] * x[s + i] }
    fft.rfft(buf, re, im)
    out.push({ ms: ms / FRAME, e: bins.map(([a, b]) => { let e = 0; for (let k = a; k <= b; k++) e += re[k] * re[k] + im[k] * im[k]; return e }) })
  }
  return out
}

const BANDS = [[100, 1000], [4000, 16000], [2000, 4000], [2000, 16000]]

function score(dry, wet, sr, voiceDb) {
  const a = frameBands(dry, sr, BANDS), b = frameBands(wet, sr, BANDS)
  const gate = Math.pow(10, (voiceDb - ACTIVE_BELOW_DB) / 10)
  let sIn = 0, sOut = 0, vIn = 0, vOut = 0, hIn = 0, hOut = 0, n = 0, cut = 0, nSib = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i].ms < gate) continue
    n++
    const [lo, sib, mid, hf] = a[i].e
    const [, sibO, midO, hfO] = b[i].e
    hIn += hf; hOut += hfO
    if (hf > 0 && 10 * Math.log10(hfO / hf) < -1) cut++
    if (sib > lo) { nSib++; sIn += sib; sOut += sibO } else { vIn += mid; vOut += midO }
  }
  const db = (o, i) => (i > 0 ? 10 * Math.log10(o / i) : 0)
  return { sib: db(sOut, sIn), vow: db(vOut, vIn), hf: db(hOut, hIn), cutPct: (100 * cut) / n, sibPct: (100 * nSib) / n }
}

function render(x, sr, params) {
  const { channelData, latencySamples } = processPhatassBuffer([x], sr, toKernelParams(params))
  return channelData[0].subarray(latencySamples)
}

const fmt = v => (v >= 0 ? ' ' : '') + v.toFixed(2)
const row = (label, r) => console.log(`  ${label.padEnd(16)} sib ${fmt(r.sib)}  vow ${fmt(r.vow)}  hf ${fmt(r.hf)}  cut% ${r.cutPct.toFixed(1).padStart(5)}`)

for (const path of process.argv.slice(2)) {
  const { mono, sampleRate: sr } = readWav(path)
  const x = Float32Array.from(mono)
  const voice = voiceLevel(x, sr)
  const seg = [{ outputStart: 0, sourceStart: 0, sourceEnd: x.length / sr, sourceBuffer: { getChannelData: () => x, numberOfChannels: 1 } }]
  const stats = measureTrebleStats(seg, x.length / sr, sr, 1, voice)
  console.log(`\n${path.split('/').pop()}  ${sr} Hz  ${(x.length / sr).toFixed(1)} s  voice ${voice.toFixed(2)} dBFS`)
  for (const [k, s] of Object.entries(stats.bands)) {
    console.log(`  ${k} 10 ms peaks re voice: ` + Object.entries(s).map(([p, v]) => `${p} ${fmt(v)}`).join('  '))
  }
  const base = { warmth: 0, tape: 0, soften: 0, voiceLevelDb: voice, trebleStats: stats }
  const dry = x.subarray(0, x.length - 1)
  const sib = score(dry, dry, sr, voice).sibPct
  console.log(`  sibilant frames ${sib.toFixed(1)} %`)
  console.log('  detents:')
  for (const d of Object.keys(HF_DETENTS)) {
    const sh = hfDetentShelf(d, voice, stats)
    const y = render(x, sr, { ...base, hf: d })
    row(`${d} (${sh ? `${(sh.thresholdDb - voice).toFixed(1)} / R${sh.rangeDb}` : 'off'})`, score(x.subarray(0, y.length), y, sr, voice))
  }
  if (process.env.CURVES) {
    for (const curve of ['voice', 'fatso']) {
      for (const tame of [1, 3, 5, 7, 10]) {
        const y = render(x, sr, { ...base, hf: 'bench', curve, tame, detect: curve === 'voice' ? '4k' : '2k' })
        row(`${curve} ${tame}`, score(x.subarray(0, y.length), y, sr, voice))
      }
    }
  }
}
