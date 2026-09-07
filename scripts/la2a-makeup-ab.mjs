/**
 * OptoSmooth's makeup reference, rendered both ways so it can be judged by ear.
 *
 *   npm run la2a:makeup                 render every file in the corpus
 *   npm run la2a:makeup -- --pr=40,60   at chosen Peak Reduction settings
 *   npm run la2a:makeup -- --in=x.wav   one file from anywhere
 *   npm run la2a:makeup -- --raw        skip the peak-match, keep true levels
 *
 * ⚠ THIS EXISTS BECAUSE THE FEATURE IS OFF BY DEFAULT AND NOT ON THE PANEL, so
 * without it the only way to hear percentile-referenced makeup is to write a
 * script. Reaching the panel means storing a ceiling in the saved patch, which
 * is a format change and would alter every existing render; that decision
 * should be made after listening, not in order to listen.
 *
 * WHAT IT RENDERS. For each Peak Reduction setting, the same region twice —
 * once through the shipping peak-referenced solve, once through
 * `computeAutoMakeupPlan(..., { reference: 'percentile' })` with the ceiling it
 * returns. Both are then peak-matched to -1 dBFS, which is the comparison that
 * means anything: the whole claim is about how loud the file lands ONCE
 * NORMALISED, so leaving them at their own levels would let the louder render
 * win on level alone. `--raw` turns that off for anyone checking the ceiling's
 * own behaviour rather than the delivered loudness.
 *
 * ⚠ AND IT RENDERS WITH THE CELL AND VALVE ON, WHICH THE AUDIT'S MEASUREMENTS
 * DID NOT. The measurement path turns them off to isolate the makeup; the
 * listening path should not, because nobody ships with them off. Expect the
 * printed rms to sit a little off the commit's table for that reason.
 *
 * CORPUS. `data/corpus/la2a-makeup/*.wav`, gitignored like every other corpus
 * here, so nothing anyone drops in reaches a commit. Renders are written beside
 * the source as `<name>.pr<NN>.<reference>.wav`.
 */

import fs from 'node:fs'
import path from 'node:path'

import { readWav } from '../test/voicerx/wav.js'
import { processLA2ABuffer, computeAutoMakeupPlan } from '../src/audio/la2aProcessor.js'

const CORPUS = path.join(process.cwd(), 'data/corpus/la2a-makeup')
const OUT = path.join(CORPUS, 'rendered')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const PRS = flag('pr', '50,60,70').split(',').map(Number).filter(Number.isFinite)
const ONE = flag('in', '')
const RAW = args.includes('--raw')

const db = x => 20 * Math.log10(Math.max(x, 1e-12))
const peakOf = (x) => { let p = 0; for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > p) p = a } return p }

function writeWav(file, channels, sampleRate) {
  const ch = channels.length
  const n = channels[0].length
  const b = Buffer.alloc(44 + n * ch * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * ch * 2, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(ch, 22); b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE(sampleRate * ch * 2, 28); b.writeUInt16LE(ch * 2, 32)
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * ch * 2, 40)
  let o = 44
  for (let s = 0; s < n; s++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][s]))
      b.writeInt16LE(Math.round(v * 32767), o)
      o += 2
    }
  }
  fs.writeFileSync(file, b)
}

/**
 * Delivered speech dynamic range: P95 - P25 of 50 ms block rms over blocks the
 * DRY signal puts within 35 dB of its loudest. Level-invariant, so it says
 * whether a render got louder by compressing harder or by spending headroom it
 * already had — which is the entire question this feature turns on.
 */
function speechDynamicRange(dry, y, sampleRate) {
  const W = Math.round(0.050 * sampleRate)
  const n = Math.floor(Math.min(dry.length, y.length) / W)
  const rms = (x, i) => { let s = 0; for (let j = i * W; j < i * W + W; j++) s += x[j] * x[j]; return Math.sqrt(s / W) }
  const dryRms = []
  for (let i = 0; i < n; i++) dryRms.push(rms(dry, i))
  const floor = db(Math.max(...dryRms)) - 35
  const v = []
  for (let i = 0; i < n; i++) if (db(dryRms[i]) > floor) v.push(rms(y, i))
  v.sort((a, b) => a - b)
  if (v.length < 20) return NaN
  return db(v[Math.floor(v.length * 0.95)]) - db(v[Math.floor(v.length * 0.25)])
}

/** Peak of each 10 ms block, so "how far the loudest moment stands above the body". */
function peakOverBody(y, sampleRate) {
  const W = Math.round(0.010 * sampleRate)
  const n = Math.floor(y.length / W)
  const bp = []
  for (let i = 0; i < n; i++) {
    let m = 0
    for (let j = i * W; j < i * W + W; j++) { const a = Math.abs(y[j]); if (a > m) m = a }
    bp.push(m)
  }
  bp.sort((a, b) => b - a)
  return db(bp[0]) - db(bp[Math.floor(n * 0.01)])
}

function render(dry, sampleRate, pr, reference) {
  const params = { peakReduction: pr, lookaheadMs: 0 }
  const plan = computeAutoMakeupPlan([dry], sampleRate, params, { reference })
  const y = processLA2ABuffer([dry], sampleRate, {
    ...params, gainDb: plan.makeupDb, ceilingDb: plan.ceilingDb,
  }).channelData[0]
  const outPeak = peakOf(y)
  const matched = RAW || !(outPeak > 0)
    ? y
    : Float32Array.from(y, v => v * (Math.pow(10, -1 / 20) / outPeak))
  let s = 0
  for (let i = 0; i < matched.length; i++) s += matched[i] * matched[i]
  const rms = db(Math.sqrt(s / matched.length))
  return {
    y: matched,
    makeupDb: plan.makeupDb,
    ceilingDb: plan.ceilingDb,
    outPeakDb: db(outPeak),
    rms,
    crest: db(peakOf(matched)) - rms,
    over: peakOverBody(matched, sampleRate),
    dr: speechDynamicRange(dry, matched, sampleRate),
  }
}

const files = ONE
  ? [ONE]
  : (fs.existsSync(CORPUS)
    ? fs.readdirSync(CORPUS).filter(f => f.toLowerCase().endsWith('.wav')).map(f => path.join(CORPUS, f))
    : [])

if (!files.length) {
  console.log(`No .wav files in ${CORPUS}.`)
  console.log('\nDrop a dry vocal in — the rawer the better, and ideally one with a hard')
  console.log('onset out of a pause, since that is the shape the peak-referenced solve')
  console.log('spends its headroom on. Or point at one directly:')
  console.log('\n  npm run la2a:makeup -- --in=/path/to/vocal.wav')
  console.log('\n`data/corpus/` is gitignored, so nothing dropped in reaches a commit.')
  process.exit(0)
}

fs.mkdirSync(OUT, { recursive: true })
console.log(RAW
  ? 'Rendered at true level (--raw): the ceiling\'s own behaviour, not delivered loudness.\n'
  : 'Both renders peak-matched to -1 dBFS — the comparison the claim is about.\n')

for (const file of files) {
  const { mono, sampleRate } = readWav(file)
  const name = path.basename(file).replace(/\.wav$/i, '')
  console.log(`── ${name}   ${sampleRate} Hz, ${(mono.length / sampleRate).toFixed(1)} s, peak ${db(peakOf(mono)).toFixed(2)} dBFS`)
  console.log('   PR  reference    makeup   ceiling   out peak      rms   crest   peak/body   speechDR')
  for (const pr of PRS) {
    for (const reference of ['peak', 'percentile']) {
      const r = render(mono, sampleRate, pr, reference)
      const out = path.join(OUT, `${name}.pr${pr}.${reference}.wav`)
      writeWav(out, [r.y], sampleRate)
      console.log(`   ${String(pr).padStart(2)}  ${reference.padEnd(11)}${r.makeupDb.toFixed(2).padStart(6)}   `
        + `${(r.ceilingDb === null ? 'none' : r.ceilingDb.toFixed(2)).padStart(7)}   ${r.outPeakDb.toFixed(2).padStart(8)}  `
        + `${r.rms.toFixed(2).padStart(7)} ${r.crest.toFixed(2).padStart(7)}   ${r.over.toFixed(2).padStart(9)}   ${r.dr.toFixed(2).padStart(8)}`)
    }
  }
  console.log()
}
console.log(`Renders in ${OUT}`)
console.log('\nWhat to listen for: the two files at a given PR are the SAME compression —')
console.log('speech DR should match to a decimal. What differs is how much of the file')
console.log('sits under the ceiling, and whether the transient the peak solve was')
console.log('protecting sounds shaved once it no longer sets the reference.')
