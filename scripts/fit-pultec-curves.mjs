#!/usr/bin/env node
/**
 * Fit biquad cascades to the measured Pultec stage curves.
 *
 *   node scripts/fit-pultec-curves.mjs            # report the fit
 *   node scripts/fit-pultec-curves.mjs --write    # rewrite the constants
 *
 * Input is `data/pultec_curves/scheps_{thick,presence}_curve_data.csv` — 120
 * log-spaced points per stage, measured by swept-sine deconvolution against a
 * reference EQP-1A emulation (see docs/scheps_vocal_chain_*_spec.md). Output is
 * `src/audio/dsp/pultec.js`, whose constants the worklet kernel and the panel's
 * curve display both read.
 *
 * WHY FIT RATHER THAN CONVOLVE. The measured curves are minimum-phase, smooth
 * and only four sections' worth of structure each; a three-section RBJ cascade
 * lands inside a tenth of a dB of them, runs at zero latency, and costs six
 * multiplies a sample. An FIR of the measured IR would cost latency the
 * parallel blend would then have to compensate, for no audible gain.
 *
 * WHY A JOINT FIT ACROSS SAMPLE RATES. RBJ coefficients warp: a shelf fitted at
 * 44.1 kHz does not draw the same curve at 48 kHz, and the error is worst
 * exactly at the top of the band, which is where these curves are still moving.
 * The objective below sums the error over every rate in `FIT_RATES`, so one set
 * of constants serves both without a per-rate table. The verification pass
 * reports 88.2/96 kHz too, where the fit is extrapolating rather than trading.
 *
 * The optimiser is Nelder-Mead with random restarts — the parameter count is
 * tiny (9 per stage) and the objective is cheap, so there is no reason to hand
 * either a gradient.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { peaking, lowShelf, highShelf, magnitudeResponseDb } from '../src/audio/dsp/biquad.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Rates the constants have to serve. Everything the app decodes to is 44.1. */
const FIT_RATES = [44100, 48000, 96000]
const CHECK_RATES = [44100, 48000, 88200, 96000]

const CHARACTERS = ['thick', 'presence']
const STAGES = ['pre', 'post']

/**
 * Candidate section topologies per stage; the lowest-cost one wins.
 *
 * Both stages are shelf-plus-bell shapes, but which shelf carries which end
 * differs by curve and is not obvious by eye — the pre curve rises to a maximum
 * at 8 kHz and turns back down (a bell), while the post curve's high cut keeps
 * deepening out to 20 kHz with no plateau (a shelf). Rather than assert that,
 * fit every plausible arrangement and let the measured error decide.
 */
const TOPOLOGIES = {
  pre: [
    ['lowShelf', 'peaking', 'peaking'],
    ['lowShelf', 'highShelf', 'peaking'],
    ['lowShelf', 'peaking', 'peaking', 'peaking'],
    ['lowShelf', 'highShelf', 'peaking', 'peaking'],
    ['lowShelf', 'highShelf', 'peaking', 'peaking', 'peaking'],
  ],
  post: [
    ['lowShelf', 'highShelf', 'peaking'],
    ['lowShelf', 'peaking', 'peaking'],
    ['lowShelf', 'highShelf', 'peaking', 'peaking'],
  ],
}

// [freqHz, width, gainDb] bounds per section type. Widths are octaves for the
// shelves (FFmpeg width_type=o, as elsewhere in this codebase) and Q for bells.
const BOUNDS = {
  lowShelf: [[40, 6000], [0.3, 8], [-16, 16]],
  highShelf: [[1500, 21000], [0.3, 8], [-16, 16]],
  peaking: [[40, 21000], [0.08, 4], [-12, 12]],
}

const SEED_POOL = {
  lowShelf: [400, 1.6, 5],
  highShelf: [8000, 1.5, -5],
  peaking: [2000, 0.7, 1],
}

function seedFor(types, stage) {
  return types.map((type, i) => {
    const base = SEED_POOL[type].slice()
    const sign = stage === 'pre' ? -1 : 1
    if (type === 'lowShelf') base[2] = 5 * sign
    if (type === 'highShelf') base[2] = -5 * sign
    if (type === 'peaking') base[0] = [8000, 2000, 500][i % 3]
    return base
  })
}

// ── curve data ──────────────────────────────────────────────────────────────

function readCurves(character) {
  const path = join(ROOT, 'data/pultec_curves', `scheps_${character}_curve_data.csv`)
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const freqs = []
  const pre = []
  const post = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const [f, a, b] = line.split(',').map(Number)
    freqs.push(f)
    pre.push(a)
    post.push(b)
  }
  return { freqs, pre, post }
}

// ── objective ───────────────────────────────────────────────────────────────

function sectionsFor(types, params, sampleRate) {
  return types.map((type, i) => {
    const [f, w, g] = params.slice(i * 3, i * 3 + 3)
    if (type === 'lowShelf') return lowShelf(sampleRate, f, w, g, 'octaves')
    if (type === 'highShelf') return highShelf(sampleRate, f, w, g, 'octaves')
    return peaking(sampleRate, f, w, g, 'q')
  })
}

function errorsAt(types, params, freqs, target, sampleRate) {
  const db = magnitudeResponseDb(sectionsFor(types, params, sampleRate), freqs, sampleRate)
  return target.map((t, i) => db[i] - t)
}

/**
 * Fourth-power mean over every fit rate — a smooth stand-in for minimax.
 *
 * Plain least squares happily trades a 0.3 dB spike at 16 kHz for a hundredth
 * of a dB everywhere else; the fourth power makes that trade unprofitable
 * without the flat regions a true minimax objective leaves for the simplex to
 * wander across.
 */
function cost(types, params, freqs, target) {
  for (let i = 0; i < types.length; i++) {
    const b = BOUNDS[types[i]]
    for (let k = 0; k < 3; k++) {
      const v = params[i * 3 + k]
      if (!(v >= b[k][0] && v <= b[k][1])) return Infinity
    }
  }
  let sum = 0
  let n = 0
  for (const sr of FIT_RATES) {
    // Points above Nyquist have no response to match; the CSV stops at 20 kHz
    // so this only ever bites at 44.1 kHz, and then only on the last point.
    for (const e of errorsAt(types, params, freqs, target, sr)) {
      sum += e ** 4
      n++
    }
  }
  return Math.pow(sum / n, 0.25)
}

// ── Nelder-Mead ─────────────────────────────────────────────────────────────

function nelderMead(f, x0, { steps, maxIter = 20000, tol = 1e-10 }) {
  const n = x0.length
  const simplex = [x0.slice()]
  for (let i = 0; i < n; i++) {
    const p = x0.slice()
    p[i] += steps[i]
    simplex.push(p)
  }
  let values = simplex.map(f)

  const centroid = (excl) => {
    const c = new Array(n).fill(0)
    for (let i = 0; i < simplex.length; i++) {
      if (i === excl) continue
      for (let k = 0; k < n; k++) c[k] += simplex[i][k]
    }
    return c.map(v => v / (simplex.length - 1))
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b])
    const sorted = order.map(i => simplex[i])
    const sortedV = order.map(i => values[i])
    for (let i = 0; i < simplex.length; i++) {
      simplex[i] = sorted[i]
      values[i] = sortedV[i]
    }
    if (Math.abs(values[n] - values[0]) < tol * (Math.abs(values[0]) + tol)) break

    const c = centroid(n)
    const worst = simplex[n]
    const reflect = c.map((v, k) => v + (v - worst[k]))
    const fr = f(reflect)

    if (fr < values[0]) {
      const expand = c.map((v, k) => v + 2 * (v - worst[k]))
      const fe = f(expand)
      if (fe < fr) { simplex[n] = expand; values[n] = fe } else { simplex[n] = reflect; values[n] = fr }
    } else if (fr < values[n - 1]) {
      simplex[n] = reflect
      values[n] = fr
    } else {
      const contract = c.map((v, k) => v + 0.5 * (worst[k] - v))
      const fc = f(contract)
      if (fc < values[n]) {
        simplex[n] = contract
        values[n] = fc
      } else {
        for (let i = 1; i < simplex.length; i++) {
          simplex[i] = simplex[i].map((v, k) => simplex[0][k] + 0.5 * (v - simplex[0][k]))
          values[i] = f(simplex[i])
        }
      }
    }
  }
  const best = values.indexOf(Math.min(...values))
  return { x: simplex[best], fx: values[best] }
}

function fitStage(types, seed, freqs, target, rng) {
  const f = p => cost(types, p, freqs, target)
  const flatSeed = seed.flat()
  const steps = types.flatMap((type, i) => [
    seed[i][0] * 0.25,
    Math.max(0.15, seed[i][1] * 0.3),
    Math.max(0.6, Math.abs(seed[i][2]) * 0.3 || 1),
  ])

  let best = nelderMead(f, flatSeed, { steps })
  // Restarts: the simplex collapses into a local minimum readily on this
  // objective, and a restart from the incumbent plus jitter is enough to walk
  // out of the shallow ones.
  for (let r = 0; r < 40; r++) {
    const start = best.x.map((v, k) => {
      const type = types[Math.floor(k / 3)]
      const [lo, hi] = BOUNDS[type][k % 3]
      const jitter = (rng() - 0.5) * 2 * (r < 30 ? 0.25 : 0.6)
      return Math.min(hi, Math.max(lo, v * (1 + jitter) + (k % 3 === 2 ? jitter : 0)))
    })
    const trial = nelderMead(f, start, { steps })
    if (trial.fx < best.fx) best = trial
  }
  return best
}

/** Deterministic RNG so a re-run reproduces the committed constants exactly. */
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

const results = {}
let worstOverall = 0

for (const character of CHARACTERS) {
  const { freqs, pre, post } = readCurves(character)
  results[character] = {}
  for (const stage of STAGES) {
    const target = stage === 'pre' ? pre : post

    let types = null
    let x = null
    let fx = Infinity
    for (const candidate of TOPOLOGIES[stage]) {
      const rng = mulberry32(0x5c4e95 + character.length * 977 + candidate.length * 31 + stage.length)
      const trial = fitStage(candidate, seedFor(candidate, stage), freqs, target, rng)
      // Prefer the simpler cascade unless a longer one earns its section: a
      // fourth biquad is a per-sample cost on every channel, and the curves are
      // 1/24-octave smoothed measurements, not something worth chasing to the
      // third decimal.
      if (trial.fx < fx * 0.85) {
        types = candidate
        x = trial.x
        fx = trial.fx
      }
    }

    const sections = types.map((type, i) => ({
      type,
      freqHz: x[i * 3],
      width: x[i * 3 + 1],
      gainDb: x[i * 3 + 2],
    }))
    results[character][stage] = sections

    const report = CHECK_RATES.map((sr) => {
      const errs = errorsAt(types, x, freqs, target, sr)
      const max = Math.max(...errs.map(Math.abs))
      const at = freqs[errs.findIndex(e => Math.abs(e) === max)]
      const rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length)
      return { sr, max, rms, at }
    })
    for (const r of report) if (FIT_RATES.includes(r.sr)) worstOverall = Math.max(worstOverall, r.max)

    console.log(`\n${character}/${stage}  objective ${fx.toFixed(4)} dB`)
    for (const s of sections) {
      console.log(
        `  ${s.type.padEnd(10)} f=${s.freqHz.toFixed(1).padStart(8)} Hz  ` +
        `${s.type === 'peaking' ? 'Q' : 'w'}=${s.width.toFixed(3)}  g=${s.gainDb >= 0 ? '+' : ''}${s.gainDb.toFixed(3)} dB`,
      )
    }
    for (const r of report) {
      console.log(
        `  @${r.sr}: max |err| ${r.max.toFixed(3)} dB @ ${r.at.toFixed(0)} Hz, rms ${r.rms.toFixed(3)} dB`,
      )
    }
  }
}

console.log(`\nworst max |err| across fit rates: ${worstOverall.toFixed(3)} dB`)

if (process.argv.includes('--write')) {
  const path = join(ROOT, 'src/audio/dsp/pultec.js')
  const src = readFileSync(path, 'utf8')
  const marker = '// ── fitted sections (generated) ─────────────────────────────────────────────'
  const idx = src.indexOf(marker)
  if (idx === -1) throw new Error('generated-section marker not found in src/audio/dsp/pultec.js')

  const fmt = s =>
    `    { type: '${s.type}', freqHz: ${s.freqHz.toFixed(4)}, ` +
    `width: ${s.width.toFixed(5)}, gainDb: ${s.gainDb.toFixed(4)} },`

  let body = `${marker}\n//\n// Regenerate with:  node scripts/fit-pultec-curves.mjs --write\n// Worst max |err| vs. the measured curves across ${FIT_RATES.join('/')} Hz:` +
    ` ${worstOverall.toFixed(3)} dB.\n\nexport const PULTEC_STAGES = {\n`
  for (const character of CHARACTERS) {
    body += `  ${character}: {\n`
    for (const stage of STAGES) {
      body += `    ${stage}: [\n${results[character][stage].map(s => '  ' + fmt(s)).join('\n')}\n    ],\n`
    }
    body += `  },\n`
  }
  body += `}\n`

  writeFileSync(path, src.slice(0, idx) + body)
  console.log(`\nwrote ${path}`)
}
