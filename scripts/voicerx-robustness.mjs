#!/usr/bin/env node
/**
 * Three ground-truth-free checks over every detector.
 *
 *   npm run robustness                            synthetic corpus
 *   npm run robustness:real                       real corpus, if present
 *   node scripts/voicerx-robustness.mjs --real --json
 *
 * `npm run robustness -- --real` also works on most shells, but not all of
 * them — it silently ran the synthetic set on Windows/PowerShell, which looks
 * exactly like a successful run and is worth nobody's afternoon. Hence the
 * dedicated `robustness:real` script, the npm_config fallback below, and the
 * banner naming which corpus actually ran.
 *
 * Everything here works on audio nobody has annotated, which is the point: the
 * synthetic corpus needs a planted defect and the real corpus needs a finished
 * master, and the product receives neither. See test/voicerx/robustness.js for
 * what each check can and cannot tell you.
 */

import { renderCase, SR } from '../test/voicerx/signals.js'
import { CASES } from '../test/voicerx/cases.js'
import { DETECTORS } from '../test/voicerx/detectors.js'
import { listCorpus, excerpts, CORPUS_DIR } from '../test/voicerx/realCorpus.js'
import { invariance, convergence, directionStats } from '../test/voicerx/robustness.js'

const argv = process.argv.slice(2)
// npm turns an unforwarded `--real` into npm_config_real rather than dropping
// it, so honour both spellings and the run mode stops depending on the shell.
const has = f => argv.includes(f) || process.env[`npm_config_${f.replace(/^--/, '')}`] === 'true'
const opt = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : (process.env[`npm_config_${name}`] || fallback)
}
const dir = opt('dir', CORPUS_DIR)
const real = has('--real')

/**
 * A spread of material rather than the whole corpus. Each check runs the
 * detector five or six times, so the full 58 cases across three detectors would
 * be a thousand analyses; these are chosen to span clean, defective, notched
 * and band-limited.
 */
const SYNTHETIC_SUBSET = [
  'clean male', 'clean female', 'clean noisy room',
  'resonance 700Hz +12dB', 'resonance 3000Hz +12dB', 'resonance 1000Hz +9dB Q5',
  'deficiency 900Hz -6dB', 'notch 5000Hz -20dB', 'notch 800Hz -20dB',
  'bandwidth 9000Hz', 'bandwidth 14000Hz', 'combined boxy + harsh',
]

function loadSamples() {
  if (!real) {
    return CASES.filter(c => SYNTHETIC_SUBSET.includes(c.name))
      .map(c => ({ name: c.name, audio: renderCase(c), sampleRate: SR }))
  }

  const corpus = listCorpus(dir)
  if (corpus.length === 0) return []
  return corpus.map((file) => {
    const { audio, windows } = excerpts(file, { seconds: 45, windows: 1 })
    return { name: file.name, audio: windows[0].audio, sampleRate: audio.sampleRate }
  })
}

const samples = loadSamples()
if (samples.length === 0) {
  console.log(`\nNo real corpus in ${dir} — drop finished recordings there,`)
  console.log('or run without --real for the synthetic subset.\n')
  process.exit(0)
}

const started = Date.now()
const results = {}
for (const [name, detector] of Object.entries(DETECTORS)) {
  const rows = samples.map((s) => {
    const base = detector(s.audio, s.sampleRate)
    return {
      sample: s.name,
      invariance: invariance(detector, s.audio, s.sampleRate),
      convergence: convergence(detector, s.audio, s.sampleRate),
      direction: base.ok ? directionStats(base.bands) : null,
    }
  })
  results[name] = rows
}
const elapsed = ((Date.now() - started) / 1000).toFixed(0)

if (has('--json')) {
  console.log(JSON.stringify({ samples: samples.map(s => s.name), results }, null, 2))
  process.exit(0)
}

const pct = v => (v === null || v === undefined ? '   -' : `${(v * 100).toFixed(0).padStart(3)}%`)
const num = (v, p = 2) => (Number.isFinite(v) ? v.toFixed(p).padStart(6) : '   inf')

console.log(`\nVoiceRx robustness — ${samples.length} ${real ? `real samples from ${dir}` : 'SYNTHETIC samples'}`
  + `, ${elapsed}s`)
if (!real) console.log('  (synthetic corpus — run `npm run robustness:real` for the real one)')
console.log()

console.log('INVARIANCE — the same audio, trivially transformed, must diagnose the same')
console.log('  exact   = gain and polarity, which CANNOT legitimately change anything')
console.log('  framing = window shifts, where some disagreement is honest\n')
console.log('detector     exact (min / mean)     framing (min / mean)')
for (const [name, rows] of Object.entries(results)) {
  const inv = rows.map(r => r.invariance).filter(Boolean)
  const exact = inv.map(i => i.exact)
  const framing = inv.map(i => i.framing)
  console.log(
    name.padEnd(12),
    `${pct(Math.min(...exact))} / ${pct(mean(exact))}`.padStart(18),
    `${pct(Math.min(...framing))} / ${pct(mean(framing))}`.padStart(24),
  )
}

const offenders = Object.entries(results).flatMap(([name, rows]) => rows
  .filter(r => r.invariance && r.invariance.exact < 0.999)
  .map(r => `  ${name.padEnd(10)} ${r.sample.padEnd(26)} exact agreement ${pct(r.invariance.exact)}`))
if (offenders.length) {
  console.log('\n  NOT INVARIANT TO GAIN OR POLARITY — every one of these is a bug:')
  for (const o of offenders.slice(0, 12)) console.log(o)
}

console.log('\nCONVERGENCE — apply its own corrections, ask again')
console.log('  residual = second-pass gain over first-pass. 0 settled, 1 no progress.\n')
console.log('detector     median residual   worst   samples that grew')
for (const [name, rows] of Object.entries(results)) {
  const conv = rows.map(r => r.convergence).filter(Boolean)
  const res = conv.map(c => c.residualFraction).filter(Number.isFinite)
  console.log(
    name.padEnd(12),
    num(median(res)).padStart(14),
    num(res.length ? Math.max(...res) : NaN).padStart(8),
    String(conv.filter(c => c.residualFraction > 1).length).padStart(18),
  )
}

console.log('\nDIRECTION — boosts above 3 kHz, where a lift adds the very defects')
console.log('  users bring the tool to remove\n')
console.log('detector     bands   boosts   boosts >3 kHz   their total gain')
for (const [name, rows] of Object.entries(results)) {
  const d = rows.map(r => r.direction).filter(Boolean)
  const sum = k => d.reduce((a, x) => a + x[k], 0)
  console.log(
    name.padEnd(12),
    String(sum('bands')).padStart(5),
    String(sum('boosts')).padStart(8),
    String(sum('riskyBoosts')).padStart(15),
    `${sum('riskyBoostGainDb').toFixed(1)} dB`.padStart(18),
  )
}
console.log()

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}
function median(xs) {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
