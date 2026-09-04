/**
 * OptoSmooth against real LA-2A dry/wet pairs.
 *
 *   npm run la2a:pairs
 *
 * Drop matched captures in `data/corpus/la2a-pairs/` as `<name>.dry.wav` and
 * `<name>.wet.wav` (gitignored — `*.wav` is ignored repo-wide, so nothing
 * licensed reaches the repo). Same source through the unit, no other
 * processing, no time offset introduced by the DAW.
 *
 * WHY THIS EXISTS. Until these captures arrived, every distortion and ballistic
 * constant in la2aProcessor.js was fitted to one of three things: a published
 * paper's summary statistics, a plugin emulation, or nothing. The ledger above
 * TUBE_DRIVE_LIN says so explicitly, and names "a bench capture of a real unit"
 * as the single thing that would unblock the most of it. This is the tooling
 * for that capture, and the first hardware-referenced measurement in the
 * project.
 *
 * ⚠ PROVENANCE IS PART OF THE MEASUREMENT. Label the pairs. The first two we
 * received looked like one dataset and were not: one was a UAD Anniversary
 * Edition plugin and one was an analog unit of unknown provenance, and they
 * disagree in exactly the place that matters (see PEAK ROUNDING below). A
 * plugin capture is a reference, not evidence about hardware.
 *
 * WHAT IT MEASURES, and why each one is separable from the others:
 *
 *  1. THE APPLIED GAIN ENVELOPE, recovered by least squares in short blocks:
 *     g[k] = <wet,dry> / <dry,dry>. This is the actual gain the unit applied,
 *     not an inference from a model — the pair makes it directly observable.
 *
 *  2. THE DYNAMIC SLOPE — how far that gain moves per dB of program level.
 *     Reported as an effective ratio. ⚠ IT IS NOT THE STATIC RATIO and must not
 *     be read as one: it is the static curve as the BALLISTICS actually deliver
 *     it on program, which is the thing a listener hears. Our own static curve
 *     measured 3.58:1 on a settled staircase while delivering 1.82:1 here.
 *
 *  3. CREST FACTOR, which is scale-invariant and therefore immune to whatever
 *     makeup was dialled in by hand. The most robust single number here.
 *
 *  4. PEAK ROUNDING — the transfer curve of the residual. ⚠ THE POINT OF THIS
 *     COLUMN IS THAT ANALYSIS 1 IS STRUCTURALLY BLIND TO IT. A linear
 *     time-varying gain cannot round a peak, so reconstructing dry*g and asking
 *     where the real output sits below it isolates the static nonlinearity from
 *     the compression exactly.
 */

import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { readWav } from '../test/voicerx/wav.js'
import { LA2AKernel } from '../src/audio/la2aProcessor.js'

const CORPUS = path.join(process.cwd(), 'data/corpus/la2a-pairs')
const SR = 44100
const B = 64                              // 1.45 ms analysis block
const GATE_DB = -45                       // a block must be signal, not room tone

const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))
const peak = y => { let m = 0; for (const v of y) m = Math.max(m, Math.abs(v)); return m }
const rms = y => { let s = 0; for (const v of y) s += v * v; return Math.sqrt(s / y.length) }
const crest = y => db(peak(y)) - db(rms(y))
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }

/**
 * Per-block least-squares gain. NOT a smoothed envelope ratio: a zero-phase
 * smoother would smear a gain step backwards in time and make a causal
 * compressor look like it had lookahead, which is the one artefact that would
 * fake the result this script exists to test.
 */
function blockGain(d, w) {
  const n = Math.floor(d.length / B)
  const g = new Float64Array(n).fill(NaN)
  const lvl = new Float64Array(n)
  const gate = Math.pow(10, GATE_DB / 20)
  for (let k = 0; k < n; k++) {
    let num = 0, den = 0
    for (let i = k * B; i < (k + 1) * B; i++) { num += w[i] * d[i]; den += d[i] * d[i] }
    const r = Math.sqrt(den / B)
    lvl[k] = r
    if (r > gate && den > 0) g[k] = num / den
  }
  return { g, lvl }
}

function gainStats(bg) {
  const v = [...bg.g].filter(x => Number.isFinite(x) && x > 0).map(db).sort((a, b) => a - b)
  const q = f => v[Math.floor(f * (v.length - 1))]
  // The p98 gain is the cell at its most open — i.e. the makeup. Reduction is
  // measured down from it, so the hand-tuned makeup cancels out.
  return { open: q(0.98), medGR: q(0.98) - q(0.50), deepGR: q(0.98) - q(0.02), n: v.length }
}

/** Slow program level per block, so the curve is read where the cell settled. */
function slowLevel(lvl) {
  const a = Math.exp(-B / (SR * 0.030))
  const f = new Float64Array(lvl.length)
  let s = 0
  for (let i = 0; i < lvl.length; i++) { s = a * s + (1 - a) * lvl[i]; f[i] = s }
  const o = new Float64Array(lvl.length)
  let b = 0
  for (let i = lvl.length - 1; i >= 0; i--) { b = a * b + (1 - a) * f[i]; o[i] = b }
  return o
}

function curvePoints(bg) {
  const { open } = gainStats(bg)
  const sl = slowLevel(bg.lvl)
  const bins = new Map()
  for (let k = 0; k < bg.g.length; k++) {
    if (!Number.isFinite(bg.g[k]) || bg.g[k] <= 0) continue
    const L = db(sl[k])
    if (L < -50 || L > 0) continue
    const b = Math.round(L / 2) * 2
    if (!bins.has(b)) bins.set(b, [])
    bins.get(b).push(open - db(bg.g[k]))
  }
  const pts = []
  for (const [L, a] of bins) if (a.length >= 300) pts.push([L, median(a), a.length])
  return pts.sort((a, b) => a[0] - b[0])
}

/**
 * Slope of gain reduction against level, where the unit is actually working.
 * ⚠ THE `minGR` FLOOR IS LOAD-BEARING. Fitting across the below-threshold
 * region averages a flat stretch in with the compressing one and reports a
 * ratio the unit never applies — measured, 1.34:1 against a true 2.87:1.
 */
function workingSlope(pts, minGR = 2) {
  const w = pts.filter(p => p[1] >= minGR)
  if (w.length < 3) return { m: NaN, lo: NaN, hi: NaN, bins: w.length }
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const [x, y, n] of w) { sw += n; sx += n * x; sy += n * y; sxx += n * x * x; sxy += n * x * y }
  return { m: (sw * sxy - sx * sy) / (sw * sxx - sx * sx), lo: w[0][0], hi: w[w.length - 1][0], bins: w.length }
}

/** Our kernel over the same dry, delay-compensated so blocks line up. */
function runModel(d, params) {
  const k = new LA2AKernel(SR)
  k.setParams({ mode: 'compress', gainDb: 0, r37: 100, mix: 1, ...params })
  const o = new Float32Array(d.length)
  for (let f = 0; f < d.length; f += 128) {
    const l = Math.min(128, d.length - f)
    k.process([d.subarray(f, f + l)], [o.subarray(f, f + l)], l)
  }
  // ⚠ WITHOUT THIS THE WHOLE SCRIPT IS NOISE. The oversampler holds output back
  // by latencySamples; 50 samples against 64-sample blocks destroys the
  // least-squares estimate outright — it reported 11.6 dB of gain reduction at
  // Peak Reduction 0 before this line existed.
  const L = k.latencySamples
  const a = new Float32Array(d.length)
  a.set(o.subarray(L), 0)
  return a
}

/** The knob at which our median gain reduction matches the reference's. */
function matchKnob(dry, targetMedGR, params = {}) {
  let lo = 0, hi = 100
  for (let i = 0; i < 11; i++) {
    const mid = (lo + hi) / 2
    const s = gainStats(blockGain(dry, runModel(dry, { peakReduction: mid, ...params })))
    if (s.medGR < targetMedGR) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * Transfer curve of what the gain model cannot explain. Reconstruct dry*g and
 * bin by the reconstruction's amplitude; a pure gain gives 0 dB at every level,
 * and a stage that rounds peaks bends negative at the top.
 */
function peakRounding(d, w) {
  const n = Math.floor(d.length / B)
  const { g } = blockGain(d, w)
  let last = 1
  for (let k = 0; k < n; k++) { if (Number.isFinite(g[k])) last = g[k]; else g[k] = last }
  const bins = new Map()
  for (let k = 0; k < n - 1; k++) {
    const a = g[k], b = g[k + 1]
    for (let j = 0; j < B; j++) {
      const i = k * B + j
      const p = Math.abs(d[i] * (a + (b - a) * j / B))
      if (p < 1e-4) continue
      const bin = Math.round(db(p) / 2) * 2
      if (!bins.has(bin)) bins.set(bin, [])
      bins.get(bin).push(Math.abs(w[i]))
    }
  }
  const out = []
  for (const [L, a] of bins) if (a.length >= 400) out.push([L, db(median(a)) - L, a.length])
  return out.sort((a, b) => a[0] - b[0])
}

// ── Report ──────────────────────────────────────────────────────────────────

function analyse(name, dryPath, wetPath) {
  const dry = readWav(dryPath).mono
  const wet = readWav(wetPath).mono
  if (dry.length !== wet.length) {
    console.log(`\n⚠ ${name}: dry and wet differ in length; align them first.\n`)
    return
  }
  const REF = blockGain(dry, wet)
  const rs = gainStats(REF)
  const rslope = workingSlope(curvePoints(REF))

  const pr = matchKnob(dry, rs.medGR)
  // ⚠ OUR OUTPUT CARRIES THE REFERENCE'S MAKEUP, and it has to. The peak
  // rounding below is a function of the level arriving at the output stage, and
  // makeup sits BEFORE that stage on the hardware and here — so comparing our
  // unity-gain output against a reference with makeup baked in reads the two
  // curves at different levels and is not a comparison at all. It also keeps
  // the crest and slope figures unchanged, both being scale-invariant.
  const ours = runModel(dry, { peakReduction: pr, gainDb: rs.open })
  const OURS = blockGain(dry, ours)
  const oslope = workingSlope(curvePoints(OURS))

  console.log(`\n══════ ${name} ══════`)
  console.log(`  reference: median GR ${rs.medGR.toFixed(2)} dB, deepest ${rs.deepGR.toFixed(2)} dB, makeup ${rs.open.toFixed(2)} dB`)
  console.log(`  ours matched at Peak Reduction ${pr.toFixed(1)}\n`)

  console.log('  CREST FACTOR (scale-invariant, so the hand-tuned makeup cannot affect it)')
  console.log(`    dry ${crest(dry).toFixed(2)} dB   reference ${crest(wet).toFixed(2)} dB   ours ${crest(ours).toFixed(2)} dB`)
  const dRef = crest(wet) - crest(dry), dOurs = crest(ours) - crest(dry)
  console.log(`    reference ${dRef >= 0 ? '+' : ''}${dRef.toFixed(2)} dB vs dry;  ours ${dOurs >= 0 ? '+' : ''}${dOurs.toFixed(2)} dB`)
  if (dOurs > 0 && dRef < 0) console.log('    ⚠ WE ARE EXPANDING CREST WHERE THE REFERENCE COMPRESSES IT.')

  console.log('\n  DYNAMIC SLOPE (the static curve as the ballistics actually deliver it)')
  console.log(`    reference ${rslope.m.toFixed(3)} dB/dB -> ${(1 / (1 - rslope.m)).toFixed(2)}:1   over ${rslope.lo}..${rslope.hi} dBFS`)
  console.log(`    ours      ${oslope.m.toFixed(3)} dB/dB -> ${(1 / (1 - oslope.m)).toFixed(2)}:1   over ${oslope.lo}..${oslope.hi} dBFS`)

  console.log('\n  CREST vs COMPRESSION DEPTH — the acceptance criterion')
  console.log('    A compressor must not raise peak-to-rms. Ours does, and the error')
  console.log('    grows with depth, which is why one matched operating point hides it.')
  console.log('    depth (median GR)   our crest change vs dry')
  for (const target of [2, 4, 6, 8]) {
    const knob = matchKnob(dry, target)
    const o = runModel(dry, { peakReduction: knob })
    const got = gainStats(blockGain(dry, o)).medGR
    if (got < target - 0.5) continue          // the knob cannot reach this depth here
    const dc = crest(o) - crest(dry)
    console.log(`      ${target} dB   (knob ${knob.toFixed(1)})      ${dc >= 0 ? '+' : ''}${dc.toFixed(2)} dB   ${dc > 0.15 ? '<-- EXPANDING' : ''}`)
  }
  console.log(`    reference, for scale: ${dRef.toFixed(2)} dB at ${rs.medGR.toFixed(2)} dB median GR`)

  console.log('\n  PEAK ROUNDING (the residual a time-varying gain cannot explain)')
  console.log('    level      reference     ours')
  const rr = new Map(peakRounding(dry, wet).map(p => [p[0], p[1]]))
  const orr = new Map(peakRounding(dry, ours).map(p => [p[0], p[1]]))
  for (const L of [-14, -12, -10, -8, -6, -4, -2]) {
    if (!rr.has(L) && !orr.has(L)) continue
    const f = v => (v === undefined ? '     -' : v.toFixed(2).padStart(6))
    console.log(`    ${String(L).padStart(3)} dBFS   ${f(rr.get(L))} dB   ${f(orr.get(L))} dB`)
  }
  console.log('    ⚠ positive values near the noise floor are the analog noise itself')
  console.log('      raising a median of |x|, not gain. Read the loud rows only.')
  const noTube = runModel(dry, { peakReduction: pr, gainDb: rs.open, tube: false, cellMod: 0 })
  console.log(`\n  TUBE STAGE'S SHARE OF THE CREST: ${(crest(ours) - crest(noTube)).toFixed(2)} dB`)
  console.log('    Measured, not assumed — the output stage is repeatedly suspected of')
  console.log('    this and repeatedly is not it. Under a tenth of a dB is the usual answer.')

  console.log('\n  (peak-rounding caveats)')
  console.log('    ⚠ a few tenths is the estimator\'s own floor: the gain is linearly')
  console.log('      interpolated across each block, so fast envelope motion leaves a')
  console.log('      residual that reads as rounding. Only the trend with level is real.')
}

if (!existsSync(CORPUS)) {
  console.log(`No capture folder at ${CORPUS}.`)
  console.log('Create it and add matched pairs as <name>.dry.wav / <name>.wet.wav.')
  process.exit(0)
}
const names = [...new Set(readdirSync(CORPUS)
  .filter(f => f.endsWith('.dry.wav'))
  .map(f => f.replace(/\.dry\.wav$/, '')))].sort()
if (names.length === 0) {
  console.log(`No <name>.dry.wav / <name>.wet.wav pairs found in ${CORPUS}.`)
  process.exit(0)
}
for (const n of names) {
  const d = path.join(CORPUS, `${n}.dry.wav`)
  const w = path.join(CORPUS, `${n}.wet.wav`)
  if (existsSync(w)) analyse(n, d, w)
  else console.log(`\n⚠ ${n}: no matching ${n}.wet.wav`)
}
