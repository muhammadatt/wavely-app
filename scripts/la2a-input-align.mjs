#!/usr/bin/env node
/**
 * INPUT ALIGNMENT BENCH — how well does a candidate statistic make a knob
 * position mean the same thing on every file?
 *
 *   npm run la2a:align                  # the corpus, plus derived variants
 *   npm run la2a:align -- --dir path/   # every .wav in a directory, as sources
 *   npm run la2a:align -- --no-variants # real files only, no perturbations
 *   npm run fet:align                   # score the same statistics for FET Punch
 *
 * ⚠ THIS EXISTS BECAUSE ALIGN_GATE_RANGE_DB IS FITTED ON ONE PROGRAMME. There
 * is exactly one dry source in `data/corpus/` — `hardware.unknown.dry.wav` and
 * `cla2a.unknown.dry.wav` are byte-identical, correlation 1.0000 — so the
 * shipping 30 dB was chosen against perturbations of a single capture. That is
 * the same exposure SC_DRIVE_MAX_DB carried, and there the single reference
 * turned out to be the wrong unit entirely. Point `--dir` at real narration
 * from more than one voice and re-read the table before trusting the number.
 *
 * WHAT IT MEASURES. Each candidate is calibrated so the FIRST source lands at
 * exactly TARGET_GR dB of gain reduction at Peak Reduction 50; every other
 * source is then aligned to that same target and rendered. A statistic that
 * perfectly captures "how hard is this file driving the detector" holds
 * TARGET_GR across the whole row, so the SPREAD column is the score and lower
 * is better. Absolute GR is NOT comparable between rows — each row sits at its
 * own alignment target, by construction.
 *
 * ⚠ AND THE SPREAD OF AN UNALIGNED BASELINE FLATTERS ITSELF. `as captured` sits
 * at a much lower operating point than the aligned rows, and spread scales with
 * operating point, so read it against what it delivers rather than on its own.
 */

import path from 'node:path'
import { readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { readWav } from '../test/voicerx/wav.js'
import { LA2AKernel } from '../src/audio/la2aProcessor.js'
import { FET1176Kernel } from '../src/audio/fet1176Processor.js'
import { percentileOfChannels, MAKEUP_PERCENTILE } from '../src/audio/dsp/makeupReference.js'
import {
  gatedRmsFromBlocks, ALIGN_GATE_RANGE_DB, ALIGN_BLOCK_MS, ALIGN_TARGET_DBFS,
} from '../src/audio/dsp/inputAlign.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DIR = path.join(ROOT, 'data/corpus/la2a-cellmod')

const args = process.argv.slice(2)
const argOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}
const DIR = argOf('--dir') ?? DEFAULT_DIR
const WITH_VARIANTS = !args.includes('--no-variants')
/**
 * `--fet` scores the same statistics against FET Punch instead of OptoSmooth.
 *
 * ⚠ THE TWO UNITS ARE NOT GUARANTEED TO WANT THE SAME STATISTIC, and that is
 * the question this flag exists to answer. Gated RMS was chosen because gain
 * reduction is an integral over the envelope distribution, so an ENERGY
 * statistic summarises it — an argument that rests on the T4's ~10 ms attack
 * smoothing the detector into something envelope-like. FET Punch's detector is
 * a full-wave rectified PEAK follower with deliberately no smoothing (see
 * `fet1176Processor.js`), so at the fast dials the cell tracks the waveform and
 * the same argument does not obviously carry.
 *
 * It ships on gated RMS anyway, for two reasons: one statistic across both
 * compressors means a serial chain cannot have its two devices drift apart on
 * material that separates them, and nothing available here can settle the
 * question — see the note by `--fet`'s render function.
 */
const FET = args.includes('--fet')
const PR = Number(argOf('--pr') ?? 50)
const TARGET_GR = Number(argOf('--gr') ?? 4)

// ---------------------------------------------------------------- statistics

const blockRmsOf = (x, sr) => {
  const B = Math.max(1, Math.round(sr * ALIGN_BLOCK_MS / 1000))
  const out = new Float64Array(Math.floor(x.length / B))
  for (let b = 0; b < out.length; b++) {
    let s = 0
    for (let i = 0; i < B; i++) { const v = x[b * B + i]; s += v * v }
    out[b] = Math.sqrt(s / B)
  }
  return out
}
const plainRms = (x) => {
  let s = 0
  for (const v of x) s += v * v
  return Math.sqrt(s / x.length)
}
/**
 * The shipping gate, at an arbitrary range, so a re-fit can sweep the one
 * constant without editing the module. At ALIGN_GATE_RANGE_DB this is exactly
 * `gatedRmsOfChannels`, and the row is labelled to say so.
 */
const gatedAt = (range) => (x, sr) => {
  const blocks = blockRmsOf(x, sr)
  if (blocks.length < 1) return plainRms(x)
  if (range === ALIGN_GATE_RANGE_DB) return gatedRmsFromBlocks(blocks) || plainRms(x)
  const sorted = Float64Array.from(blocks).sort()
  const ref = sorted[Math.min(sorted.length - 1,
    Math.max(0, Math.round(0.95 * (sorted.length - 1))))]
  const thr = ref * Math.pow(10, -range / 20)
  let sum = 0, n = 0
  for (const b of blocks) if (b > thr) { sum += b * b; n++ }
  return n > 0 ? Math.sqrt(sum / n) : plainRms(x)
}

const STATS = {
  'true peak': (x) => { let p = 0; for (const v of x) { const a = v < 0 ? -v : v; if (a > p) p = a } return p },
  '99.9th pct': (x) => percentileOfChannels([x], MAKEUP_PERCENTILE),
  'plain RMS': (x) => plainRms(x),
  'gated 20dB': gatedAt(20),
  'gated 25dB': gatedAt(25),
  [`gated ${ALIGN_GATE_RANGE_DB}dB *`]: gatedAt(ALIGN_GATE_RANGE_DB),
  'gated 35dB': gatedAt(35),
  'gated 40dB': gatedAt(40),
}

// ------------------------------------------------------------------- kernel

function avgGr(x, sr, pr) {
  const k = new LA2AKernel(sr)
  k.setParams({
    mode: 'compress', peakReduction: pr, gainDb: 0, r37: 100, mix: 1,
    lookaheadMs: 0, tube: false, cellMod: 0, oversample: false,
  })
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i += 128) {
    const n = Math.min(128, x.length - i)
    k.process([x.subarray(i, i + n)], [out.subarray(i, i + n)], n)
  }
  return k.grActive ? k.grSum / k.grActive : 0
}

/**
 * FET Punch's average gain reduction, aligned by the SHIPPING MECHANISM.
 *
 * ⚠ IT TAKES AN OFFSET AND NOT A PRE-SCALED BUFFER, AND THAT ASYMMETRY WITH THE
 * OPTO PATH ABOVE IS LOAD-BEARING. On the LA-2A, scaling the input and adding
 * side-chain drive are the same thing to the detector and to everything else
 * (`inputAlign.test.js` pins it bit-identical), so the opto rows may align by
 * scaling. On this unit they are NOT the same thing: the Input attenuator feeds
 * the audio path as well as the detector, so a scaled buffer would drive the FET
 * saturator harder as well — which is exactly the input-gain behaviour
 * `inputAlignDb` exists to avoid. Scoring a statistic against a mechanism the
 * plugin does not use would measure the wrong plugin.
 *
 * The opto path is deliberately left scaling rather than converted to match:
 * its published spreads are quoted in CLAUDE.md and there is no corpus in this
 * checkout to re-run them against.
 */
function avgGrFet(x, sr, drive, alignDb) {
  const k = new FET1176Kernel(sr)
  k.setParams({
    inputDrive: drive, outputGainDb: 0, attack: 4, release: 4, ratio: '4',
    fetDrive: 0, scHpfHz: 0, mix: 1, oversample: false,
    inputAlignDb: Math.max(-48, Math.min(48, alignDb)),
  })
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i += 128) {
    const n = Math.min(128, x.length - i)
    k.process([x.subarray(i, i + n)], [out.subarray(i, i + n)], n)
  }
  return k.grActive ? k.grSum / k.grActive : 0
}

/**
 * One row's reduction for a case, given the statistic target in dBFS. Hides
 * which unit is under test from the scoring loop.
 */
function grAtTarget(c, fn, targetDb) {
  const stat = fn(c.x, c.sr)
  if (!(stat > 0)) return FET ? avgGrFet(c.x, c.sr, PR, 0) : avgGr(c.x, c.sr, PR)
  const offsetDb = targetDb - 20 * Math.log10(stat)
  return FET
    ? avgGrFet(c.x, c.sr, PR, offsetDb)
    : avgGr(scaled(c.x, Math.pow(10, offsetDb / 20)), c.sr, PR)
}
const scaled = (x, g) => {
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) y[i] = Math.fround(x[i] * g)
  return y
}

// ------------------------------------------------------------------ sources

function variantsOf(x, sr, label) {
  const quant = (a, q) => {
    const s = Array.from(a).sort((p, r) => p - r)
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]
  }
  const noise = (d) => {
    const y = new Float32Array(x.length)
    let s = 1234
    const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1
    const a = Math.pow(10, d / 20)
    for (let i = 0; i < x.length; i++) y[i] = Math.fround(x[i] + a * r())
    return y
  }
  const clip = (t) => {
    const y = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) {
      const v = x[i], a = Math.abs(v)
      y[i] = Math.fround(a <= t ? v : Math.sign(v) * t)
    }
    return y
  }
  const shelf = (g) => {
    const y = new Float32Array(x.length)
    let lp = 0
    for (let i = 0; i < x.length; i++) { lp += (x[i] - lp) * 0.30; y[i] = Math.fround(lp + g * (x[i] - lp)) }
    return y
  }
  const room = () => {
    const D = Math.round(sr * 0.037), buf = new Float32Array(D), y = new Float32Array(x.length)
    let p = 0
    for (let i = 0; i < x.length; i++) { const t = buf[p]; buf[p] = x[i] + t * 0.45; p = (p + 1) % D; y[i] = Math.fround(x[i] * 0.5 + t * 0.5) }
    return y
  }
  const dense = () => {
    const B = Math.max(1, Math.round(sr * ALIGN_BLOCK_MS / 1000))
    const b = blockRmsOf(x, sr), f = quant(b, 0.10), keep = []
    for (let i = 0; i < b.length; i++) if (b[i] > f * 2) keep.push(i)
    const y = new Float32Array(keep.length * B)
    keep.forEach((q, i) => y.set(x.subarray(q * B, (q + 1) * B), i * B))
    return y
  }
  const pad = (sec, floorDb) => {
    const N = Math.round(sr * sec), y = new Float32Array(x.length + 2 * N)
    let s = 77
    const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1
    const a = Math.pow(10, floorDb / 20)
    for (let i = 0; i < y.length; i++) y[i] = Math.fround(a * r())
    y.set(x, N)
    return y
  }
  const precomp = () => {
    const k = new LA2AKernel(sr)
    k.setParams({ mode: 'compress', peakReduction: 70, gainDb: 0, r37: 100, mix: 1,
      lookaheadMs: 0, tube: false, cellMod: 0, oversample: false })
    const hot = scaled(x, Math.pow(10, 6 / 20)), o = new Float32Array(x.length)
    for (let i = 0; i < hot.length; i += 128) {
      const n = Math.min(128, hot.length - i)
      k.process([hot.subarray(i, i + n)], [o.subarray(i, i + n)], n)
    }
    return o
  }
  return [
    [`${label}`, x],
    [`${label}/noisy-25`, noise(-25)],
    [`${label}/noisy-18`, noise(-18)],
    [`${label}/clipped`, clip(0.20)],
    [`${label}/bright`, shelf(4.0)],
    [`${label}/dark`, shelf(0.25)],
    [`${label}/roomy`, room()],
    [`${label}/dense`, dense()],
    [`${label}/precomp`, precomp()],
    [`${label}/pad10s`, pad(10, -55)],
    [`${label}/pad30s`, pad(30, -55)],
    [`${label}/pad30s-40`, pad(30, -40)],
  ]
}

if (!existsSync(DIR)) {
  console.error(`no such directory: ${DIR}`)
  process.exit(1)
}
const files = readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.wav')).sort()
if (files.length === 0) {
  console.error(`no .wav files in ${DIR}`)
  process.exit(1)
}

// Byte-identical sources contribute nothing but a wider table, and the corpus
// contains a pair of them. Deduplicate on the samples, and say so.
const sources = []
for (const f of files) {
  const w = readWav(path.join(DIR, f))
  const dup = sources.find(s => s.sr === w.sampleRate && s.x.length === w.mono.length
    && s.x.every((v, i) => v === w.mono[i]))
  if (dup) {
    console.log(`  (skipping ${f}: byte-identical to ${dup.label})`)
    continue
  }
  sources.push({ label: f.replace(/\.wav$/i, '').slice(0, 22), x: w.mono, sr: w.sampleRate })
}

const cases = []
for (const s of sources) {
  if (WITH_VARIANTS) for (const [l, x] of variantsOf(s.x, s.sr, s.label)) cases.push({ label: l, x, sr: s.sr })
  else cases.push({ label: s.label, x: s.x, sr: s.sr })
}

console.log(`\n${sources.length} distinct source(s) from ${path.relative(ROOT, DIR) || DIR}`
  + `, ${cases.length} cases, ${FET ? 'FET Punch, Input' : 'OptoSmooth, PR'} ${PR}`
  + `, calibrated to ${TARGET_GR.toFixed(2)} dB GR\n`)
if (sources.length < 2) {
  console.log('⚠ ONE SOURCE ONLY — every case below is a perturbation of the same')
  console.log('  recording, so this cannot tell you how the gate behaves across voices,')
  console.log('  rooms or microphones. Pass --dir with more material.\n')
}

const anchor = cases[0]
const width = Math.max(12, ...cases.map(c => c.label.length)) + 1

console.log('statistic'.padEnd(14) + 'target'.padStart(8) + '  ' + 'spread'.padStart(7)
  + '  ' + 'max err'.padStart(8) + '   worst case')
console.log('-'.repeat(70))

const rows = []
for (const [name, fn] of Object.entries(STATS)) {
  // Bisect the alignment target that puts the anchor at TARGET_GR.
  let lo = -80, hi = 12
  // 24 halvings of a 92 dB bracket is 5e-6 dB, far below anything measurable
  // here, and the calibration renders the anchor once per iteration — this is
  // where the bench's runtime goes.
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2
    if (grAtTarget(anchor, fn, m) < TARGET_GR) lo = m
    else hi = m
  }
  const target = (lo + hi) / 2
  const got = cases.map(c => ({ label: c.label, gr: grAtTarget(c, fn, target) }))
  const grs = got.map(g => g.gr)
  const spread = Math.max(...grs) - Math.min(...grs)
  const worst = got.reduce((a, b) => Math.abs(b.gr - TARGET_GR) > Math.abs(a.gr - TARGET_GR) ? b : a)
  rows.push({ name, target, spread, worst })
  console.log(name.padEnd(14) + target.toFixed(2).padStart(8) + '  ' + spread.toFixed(2).padStart(7)
    + '  ' + (worst.gr - TARGET_GR).toFixed(2).padStart(8) + '   ' + worst.label)
}

// Baselines, at whatever operating point they land on.
for (const [label, fn, tgt] of [
  ['peak -> -1 dB', STATS['true peak'], -1],
  ['as captured', null, null],
]) {
  const grs = cases.map(c => fn
    ? grAtTarget(c, fn, tgt)
    : (FET ? avgGrFet(c.x, c.sr, PR, 0) : avgGr(c.x, c.sr, PR)))
  const mean = grs.reduce((a, b) => a + b, 0) / grs.length
  const spread = Math.max(...grs) - Math.min(...grs)
  console.log(label.padEnd(14) + '     n/a' + '  ' + spread.toFixed(2).padStart(7)
    + '       -     mean GR ' + mean.toFixed(2) + ' dB  <- unaligned')
}

const best = rows.reduce((a, b) => b.spread < a.spread ? b : a)
console.log(`\nbest: ${best.name.trim()}  (spread ${best.spread.toFixed(2)} dB)`)
console.log(`shipping: gated ${ALIGN_GATE_RANGE_DB}dB, target ${ALIGN_TARGET_DBFS} dBFS`)
if (!best.name.includes('*')) {
  console.log('\n⚠ THE SHIPPING GATE IS NOT THE BEST ROW. Before changing it, check that')
  console.log('  the winner is not winning on one pathological case — read the worst-case')
  console.log('  column, and re-run with --no-variants to see the real files alone.')
}
console.log(`\nnote: the shipping target is anchored so the reference capture trims to 0.00 dB,`)
console.log(`      NOT to the per-row calibration above. Moving ALIGN_TARGET_DBFS re-voices`)
console.log(`      every patch; moving ALIGN_GATE_RANGE_DB only changes how it is measured.`)
