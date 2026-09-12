/**
 * OptoSmooth's T4 cell modulation, fitted against a capture instead of a paper.
 *
 *   npm run la2a:cellmod            report the profile for every capture pair
 *   npm run la2a:cellmod:fit        also search for cellModMax / TauDb / Shape
 *   npm run la2a:cellmod:selftest   prove the fitter on our own kernel
 *
 * ⚠ WHAT THIS MEASURES IS A SHAPE, NOT A DEPTH, AND THAT IS THE POINT.
 * `CELL_MOD_MAX` is fitted to Moore JAES 74(1/2):61-72 and corroborated by the
 * H3-H2 relationship; nothing here is trying to relitigate it. What the paper
 * cannot say is how the cell's attenuation is DISTRIBUTED across the waveform,
 * because THD figures integrate over exactly that. The shipping law is linear
 * in `rect / env - 1`, which spreads the depth almost evenly over the top third
 * of the waveform. A capture can see that directly.
 *
 * THE METRIC. Inside a short enough window the compressor's gain is still, so
 * any departure from a straight line through the dry/wet pair is instantaneous
 * — a static nonlinearity, not ballistics. So: take the loudest 10 ms windows,
 * fit a local gain on the MID-amplitude samples (20-60 % of that window's peak,
 * where every candidate law is nearly linear), then measure how far the LOUD
 * samples fall below that fit. Three bands of the window's own peak.
 *
 * ⚠ IT IS BLIND TO EVERYTHING THE ARGUMENT IS NOT ABOUT, WHICH IS WHY IT IS
 * THIS AND NOT A THD NUMBER. The local gain fit divides out makeup gain, the
 * capture's monitoring level, any post-normalisation, and the whole gain
 * envelope — attack, release, the taper, the knob position. Two captures of the
 * same unit at different Peak Reduction settings land on the same profile if
 * the cell is the same. THD cannot separate those; this does.
 *
 * ⚠ A FLAT PROFILE IS A GAIN TRIM WEARING A NONLINEARITY'S CLOTHES. If the
 * three bands come back near-equal, the stage is shaving the body as hard as
 * the peak, which is a small broadband attenuation the makeup gain then undoes.
 * That costs crest factor and buys nothing. The hardware's profile steepens by
 * about 4x across the three bands; ours steepens by 1.3x.
 *
 * ── WHAT A CAPTURE CANNOT SETTLE ────────────────────────────────────────────
 *
 * ⚠ THE CAPTURE CHAIN IS INSIDE THE MEASUREMENT. Preamp, converters and
 * whatever the file passed through on the way out all contribute their own
 * static nonlinearity, and this metric cannot tell them from the T4. A profile
 * measured through an unknown chain bounds the cell's shape from ABOVE.
 *
 * ⚠ ONE UNIT AT ONE UNKNOWN KNOB POSITION IS NOT A FIT. `--fit` prints numbers
 * because the alternative is doing the arithmetic by hand; it does not make
 * them shippable. CELL_MOD_MAX took six units. Anything from here goes in the
 * ledger as "fitted to <capture>", with the chain named, or it does not go in.
 *
 * ⚠ AND THE REFERENCE PLUGINS CANNOT ARBITRATE THIS ONE. Waves CLA-2A measures
 * +0.009 / +0.002 / +0.010 on the same metric — no instantaneous nonlinearity
 * at all. Our release is fitted to that plugin and reproduces its transient
 * behaviour closely, so fitting the cell to it too would confirm a stage the
 * reference does not have. This is the axis where the plugin references are
 * silent and only hardware can speak.
 *
 * CAPTURES. `data/corpus/la2a-cellmod/`, named `<unit>.<knob>.dry.wav` and
 * `<unit>.<knob>.wet.wav`. `*.wav` is ignored repo-wide, so no capture reaches
 * a commit. Use `unknown` for the knob when the capture did not record it — the
 * script solves for the Peak Reduction that matches the capture's delivered
 * dynamic range rather than trusting the filename either way.
 */

import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

import { readWav } from '../test/voicerx/wav.js'
import {
  processLA2ABuffer, CELL_MOD_MAX, CELL_MOD_TAU_DB, CELL_MOD_SHAPE,
} from '../src/audio/la2aProcessor.js'

const CAP_DIR = path.join(process.cwd(), 'data/corpus/la2a-cellmod')

const WINDOW_S = 0.010
const N_WINDOWS = 600          // loudest windows by dry RMS
/**
 * ⚠ THE FIT WINDOW MUST SIT BELOW EVERY MEASURED BAND, and the self-test found
 * this the hard way. At [0.20, 0.60] it overlapped the lowest bands, so the
 * local gain absorbed the very curvature those bands exist to measure and the
 * recovered shape came back compressed toward 1 — a planted 3.0 read as 2.6.
 * Down here the candidate laws are all still within ~0.02 dB of linear.
 */
const FIT_BAND = [0.08, 0.30]
/**
 * ⚠ FIVE BANDS, NOT THREE, AND THE SELF-TEST IS WHY. Three left the shape
 * under-determined against the depth: planting shape 3.0 came back as 2.6 with
 * the depth absorbing the difference. The bands below the fit window carry most
 * of the discrimination — a linear law and a cubic one differ far more at 55 %
 * of the local peak than at 98 %, where both are near their full depth.
 */
const BANDS = [
  [0.40, 0.55], [0.55, 0.68], [0.68, 0.80], [0.80, 0.90], [0.90, 1.00],
]
const MIN_SAMPLES_PER_BAND = 4

const db = x => 20 * Math.log10(Math.max(x, 1e-12))
const median = a => {
  if (!a.length) return NaN
  const s = [...a].sort((p, q) => p - q)
  return s[Math.floor(s.length / 2)]
}

/**
 * Linear resample. Only ever used to bring a dry capture onto its wet's rate,
 * where the two came off different converters; the metric reads amplitude
 * ratios inside a window, and interpolation error sits far below the 0.01 dB
 * the profile is quoted to.
 */
function resample(x, inRate, outRate, n) {
  if (inRate === outRate && x.length === n) return x
  const y = new Float32Array(n)
  const r = inRate / outRate
  for (let i = 0; i < n; i++) {
    const t = i * r
    const i0 = Math.floor(t)
    const f = t - i0
    y[i] = (x[i0] || 0) * (1 - f) + (x[i0 + 1] || 0) * f
  }
  return y
}

/**
 * Integer sample lag of `wet` behind `dry`.
 *
 * ⚠ WITHOUT THIS THE METRIC READS A LATENCY AS A NONLINEARITY, and it reads it
 * as a HUGE one — the first version of this scored our own kernel at +6 dB
 * because `processLA2ABuffer` returns its output delayed by the oversampler's
 * 50 samples. A misaligned pair compares a peak against a flank.
 */
function bestLag(dry, wet, maxLag = 512) {
  const lo = Math.floor(dry.length * 0.45)
  const hi = Math.min(lo + 120000, dry.length - maxLag - 1)
  let best = 0
  let bestScore = -Infinity
  for (let d = 0; d <= maxLag; d++) {
    let s = 0
    for (let i = lo; i < hi; i += 2) s += dry[i] * (wet[i + d] || 0)
    if (s > bestScore) { bestScore = s; best = d }
  }
  return best
}

/** Indices of the loudest `count` non-overlapping windows, by dry RMS. */
function loudestWindows(dry, W, count) {
  const n = Math.floor(dry.length / W)
  const rms = new Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = i * W; j < i * W + W; j++) s += dry[j] * dry[j]
    rms[i] = [Math.sqrt(s / W), i]
  }
  return rms.sort((a, b) => b[0] - a[0]).slice(0, count).map(p => p[1])
}

/**
 * The profile: median dB below the local linear fit, per amplitude band.
 * Negative is compressive. Returns one number per entry in BANDS.
 */
function deviationProfile(dry, wet, sampleRate) {
  const W = Math.round(WINDOW_S * sampleRate)
  const lag = bestLag(dry, wet)
  const w = wet.subarray(lag)
  const acc = BANDS.map(() => [])

  for (const i of loudestWindows(dry, W, N_WINDOWS)) {
    let peak = 0
    for (let j = i * W; j < i * W + W; j++) peak = Math.max(peak, Math.abs(dry[j]))
    if (peak <= 0) continue

    // Local gain from the mid-amplitude samples, by least squares through the
    // origin. Through the origin because a compressor has no offset and an
    // intercept term would soak up exactly the curvature being measured.
    let sxy = 0
    let sxx = 0
    for (let j = i * W; j < i * W + W; j++) {
      const a = Math.abs(dry[j])
      if (a > FIT_BAND[0] * peak && a < FIT_BAND[1] * peak) {
        sxy += dry[j] * (w[j] || 0)
        sxx += dry[j] * dry[j]
      }
    }
    if (sxx <= 0) continue
    const g = sxy / sxx
    if (!(g > 0)) continue

    BANDS.forEach((b, bi) => {
      let sw = 0
      let sd = 0
      let c = 0
      for (let j = i * W; j < i * W + W; j++) {
        const a = Math.abs(dry[j])
        if (a >= b[0] * peak && a <= b[1] * peak) {
          sw += (w[j] || 0) ** 2
          sd += (g * dry[j]) ** 2
          c++
        }
      }
      if (c > MIN_SAMPLES_PER_BAND) acc[bi].push(db(Math.sqrt(sw / c)) - db(Math.sqrt(sd / c)))
    })
  }
  return acc.map(median)
}

/**
 * Delivered dynamic range over speech: P95 - P25 of 50 ms block RMS, counting
 * only blocks the DRY signal puts within 35 dB of its loudest. Level-invariant
 * by construction (both percentiles move together), so a normalised capture
 * measures the same as an un-normalised one.
 */
function speechDynamicRange(dry, sig, sampleRate) {
  const W = Math.round(0.050 * sampleRate)
  const n = Math.floor(Math.min(dry.length, sig.length) / W)
  const blockRms = (x, i) => {
    let s = 0
    for (let j = i * W; j < i * W + W; j++) s += x[j] * x[j]
    return Math.sqrt(s / W)
  }
  const dryRms = []
  for (let i = 0; i < n; i++) dryRms.push(blockRms(dry, i))
  const ceiling = db(Math.max(...dryRms)) - 35
  const v = []
  for (let i = 0; i < n; i++) if (db(dryRms[i]) > ceiling) v.push(blockRms(sig, i))
  v.sort((a, b) => a - b)
  if (v.length < 20) return NaN
  return db(v[Math.floor(v.length * 0.95)]) - db(v[Math.floor(v.length * 0.25)])
}

/**
 * The Peak Reduction that puts our kernel on the capture's delivered dynamic
 * range.
 *
 * ⚠ SOLVED, NOT READ FROM THE FILENAME, AND NOT OPTIONAL. The cell's depth
 * scales with gain reduction (CELL_MOD_TAU_DB), so comparing profiles at the
 * wrong knob compares two different depths and calls the difference a shape.
 * A capture whose knob was never written down is still usable this way; one
 * whose knob WAS written down still goes through here, because the same
 * number on two units is not the same reduction.
 */
function matchPeakReduction(dry, wetDr, sampleRate) {
  let lo = 0
  let hi = 100
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    const y = processLA2ABuffer([dry], sampleRate, {
      peakReduction: mid, tube: false, lookaheadMs: 0, gainDb: 0,
    }).channelData[0]
    if (speechDynamicRange(dry, y, sampleRate) > wetDr) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Our kernel's profile at a given cell tuning. */
function ourProfile(dry, sampleRate, peakReduction, tuning) {
  const y = processLA2ABuffer([dry], sampleRate, {
    peakReduction, tube: false, lookaheadMs: 0, gainDb: 0, cellMod: 1, ...tuning,
  }).channelData[0]
  return deviationProfile(dry, y, sampleRate)
}

const fmtProfile = p => p.map(v => (Number.isFinite(v) ? v.toFixed(3) : '  n/a').padStart(10)).join('')
const bandHeader = BANDS.map(b => `${(b[0] * 100).toFixed(0)}-${(b[1] * 100).toFixed(0)}%`.padStart(10)).join('')

/** Sum of squared dB error across the bands. */
function profileError(a, b) {
  let e = 0
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return Infinity
    e += (a[i] - b[i]) ** 2
  }
  return e
}

/**
 * Nelder-Mead over (log depth, shape), from the best few points of a coarse grid.
 *
 * ⚠ `cellModTauDb` IS HELD AT THE SHIPPING VALUE AND IS NOT SEARCHED. It says
 * how the depth grows with GAIN REDUCTION, so constraining it needs captures at
 * several knob positions; one capture sits at one reduction, where every tau
 * that reaches the same depth there fits equally well. Freeing it did not make
 * the fit better, it made it meaningless — the self-test recovered a planted
 * (0.550, 8.00) as (0.202, 2.30), a 2.7x error in depth, because the two traded
 * off exactly. Two identifiable parameters beat three degenerate ones.
 *
 * ⚠ AND COORDINATE DESCENT CANNOT WALK THIS OBJECTIVE, WHICH COST TWO ROUNDS TO
 * ESTABLISH. Depth and shape trade off along a CURVED valley — raising the
 * exponent needs a compensating rise in depth to hold the same profile — so
 * every single-axis step from a point on the floor goes uphill and the search
 * stops early on a wall. It stopped confidently: a planted (0.550, 3.00) came
 * back as (0.379, 1.50) at a residual of 5.7e-2, against the ~1e-4 a real
 * optimum reaches. A simplex reflects along the valley instead of across it.
 * The residual is printed for exactly this reason — a fit that lands orders of
 * magnitude above its neighbours did not converge, whatever its numbers look
 * like.
 *
 * Depth is searched in log space so a step means the same fraction at 0.05 as
 * at 0.5; the tube stage is out of the search because it measures 0.02 dB on
 * this metric (its knee sits ~30 dB above program) and would be a parameter
 * spent on nothing.
 */
function fitCellMod(dry, sampleRate, peakReduction, target) {
  const tau = CELL_MOD_TAU_DB
  const evaluate = ([logMax, shape]) => {
    const max = Math.exp(logMax)
    if (!(max > 0) || max > 4 || shape <= 0.1 || shape > 8) return Infinity
    return profileError(ourProfile(dry, sampleRate, peakReduction, {
      cellModMax: max, cellModTauDb: tau, cellModShape: shape,
    }), target)
  }

  // Coarse grid, only to seed the simplex.
  const seeds = []
  for (let mi = 0; mi <= 6; mi++) {
    for (let si = 0; si <= 6; si++) {
      const pt = [Math.log(0.03 * Math.pow(2.4, mi * 0.72)), 0.7 + si * 0.72]
      seeds.push({ pt, err: evaluate(pt) })
    }
  }
  seeds.sort((a, b) => a.err - b.err)

  let best = null
  for (const seed of seeds.slice(0, 3)) {
    const got = nelderMead(evaluate, seed.pt, [0.35, 0.45])
    if (!best || got.err < best.err) best = got
  }
  return { max: Math.exp(best.pt[0]), tau, shape: best.pt[1], err: best.err }
}

/** Textbook Nelder-Mead in two dimensions. */
function nelderMead(f, start, step, maxIter = 90, tol = 1e-13) {
  let simplex = [start, [start[0] + step[0], start[1]], [start[0], start[1] + step[1]]]
    .map(pt => ({ pt, err: f(pt) }))
  const add = (a, b, t) => [a[0] + t * b[0], a[1] + t * b[1]]
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]

  for (let iter = 0; iter < maxIter; iter++) {
    simplex.sort((a, b) => a.err - b.err)
    const [bestPt, midPt, worstPt] = simplex
    if (Math.abs(worstPt.err - bestPt.err) < tol) break
    const centroid = [(bestPt.pt[0] + midPt.pt[0]) / 2, (bestPt.pt[1] + midPt.pt[1]) / 2]
    const dir = sub(centroid, worstPt.pt)

    const refl = add(centroid, dir, 1)
    const rErr = f(refl)
    if (rErr < bestPt.err) {
      const exp = add(centroid, dir, 2)
      const eErr = f(exp)
      simplex[2] = eErr < rErr ? { pt: exp, err: eErr } : { pt: refl, err: rErr }
    } else if (rErr < midPt.err) {
      simplex[2] = { pt: refl, err: rErr }
    } else {
      const con = add(centroid, dir, -0.5)
      const cErr = f(con)
      if (cErr < worstPt.err) simplex[2] = { pt: con, err: cErr }
      else {
        // Shrink toward the best vertex.
        simplex = simplex.map((v, i) => {
          if (i === 0) return v
          const pt = [(v.pt[0] + bestPt.pt[0]) / 2, (v.pt[1] + bestPt.pt[1]) / 2]
          return { pt, err: f(pt) }
        })
      }
    }
  }
  simplex.sort((a, b) => a.err - b.err)
  return simplex[0]
}

/**
 * How wide the ridge is, in shape.
 *
 * ⚠ THIS IS NOT THE FITTER BEING WEAK — IT RECOVERS A PLANTED SHAPE TO 1 %.
 * The valley is a property of the OBJECTIVE: raising the exponent and raising
 * the depth to compensate lands within hundredths of a dB of the same profile.
 * When the target is something the model can reproduce exactly, as in the
 * self-test, the valley still has a distinct floor and the simplex finds it.
 *
 * ⚠ IT IS A HARDWARE TARGET THAT MAKES THE WIDTH BITE. Our law cannot reproduce
 * the capture's profile exactly — that is the finding — so the objective never
 * reaches zero, and every point whose residual sits inside the metric's own
 * noise is as good an answer as the printed one. That band is what this
 * reports, and it is the honest error bar on a fit to real audio.
 *
 * It is still enough for the question this exists to answer. "Is the exponent
 * 1, or is it nearer 2-3" is a 2-3x effect and clears the ridge width with room
 * to spare. "Is it 2.4 or 2.7" does not, and this tool cannot be made to say.
 */
function shapeRidge(dry, sampleRate, peakReduction, target, best, tolDb = 0.010) {
  const tau = CELL_MOD_TAU_DB
  const rms = err => Math.sqrt(err / BANDS.length)
  const limit = rms(best.err) + tolDb
  const within = []
  for (let shape = 0.6; shape <= 6.001; shape += 0.4) {
    // Best depth for this shape, from the ridge point so the 1-D search starts near.
    let max = best.max
    let err = profileError(ourProfile(dry, sampleRate, peakReduction,
      { cellModMax: max, cellModTauDb: tau, cellModShape: shape }), target)
    for (const step of [0.05, 0.015, 0.005]) {
      let improved = true
      let guard = 0
      while (improved && guard++ < 60) {
        improved = false
        for (const dir of [1, -1]) {
          const cand = max + dir * step
          if (cand <= 0 || cand > 4) continue
          const e = profileError(ourProfile(dry, sampleRate, peakReduction,
            { cellModMax: cand, cellModTauDb: tau, cellModShape: shape }), target)
          if (e < err - 1e-12) { err = e; max = cand; improved = true }
        }
      }
    }
    if (rms(err) <= limit) within.push(shape)
  }
  return within.length ? [within[0], within[within.length - 1]] : null
}

// ── Capture discovery ───────────────────────────────────────────────────────

function findPairs() {
  if (!existsSync(CAP_DIR)) return []
  const files = readdirSync(CAP_DIR).filter(f => f.endsWith('.wav'))
  const pairs = []
  for (const f of files) {
    if (!f.endsWith('.dry.wav')) continue
    const stem = f.slice(0, -'.dry.wav'.length)
    const wet = `${stem}.wet.wav`
    if (files.includes(wet)) pairs.push({ stem, dry: f, wet })
    else console.log(`⚠ ${f} has no ${wet}`)
  }
  return pairs
}

function loadPair(pair) {
  const d = readWav(path.join(CAP_DIR, pair.dry))
  const w = readWav(path.join(CAP_DIR, pair.wet))
  // Onto the wet's rate: the wet is what the unit actually produced, and
  // resampling it would put interpolation error on the side being measured.
  const dry = resample(d.mono, d.sampleRate, w.sampleRate,
    Math.round(d.mono.length * (w.sampleRate / d.sampleRate)))
  const n = Math.min(dry.length, w.mono.length)
  return { dry: dry.subarray(0, n), wet: w.mono.subarray(0, n), sampleRate: w.sampleRate }
}

// ── Modes ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const doFit = args.includes('--fit')
const doSelftest = args.includes('--selftest')
const only = (args.find(a => a.startsWith('--only=')) || '').slice('--only='.length)

/**
 * ⚠ THE FITTER HAS TO BE PROVEN BEFORE ITS OUTPUT MEANS ANYTHING. Render our
 * own kernel at a KNOWN shape, hand the pair back as if it were a capture, and
 * see whether the numbers come home. If this does not recover the planted
 * values, a disagreement with hardware is the metric's and not the model's.
 */
function selftest() {
  const sampleRate = 44100
  const n = sampleRate * 14
  const dry = new Float32Array(n)
  // Voice-like: a decaying-harmonic buzz gated into syllables, with silences
  // long enough that the cell is dark at some onsets and lit at others.
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const f0 = 110 + 25 * Math.sin(2 * Math.PI * 0.7 * t)
    phase += (2 * Math.PI * f0) / sampleRate
    let s = 0
    for (let h = 1; h <= 12; h++) s += Math.sin(phase * h) / (h * h)
    const syl = Math.max(0, Math.sin(2 * Math.PI * 2.6 * t)) ** 2
    const gate = (t % 3) < 2.2 ? 1 : 0.002
    dry[i] = 0.55 * s * syl * gate
  }
  console.log('Fitter self-test — planted shape recovered from our own kernel.\n')
  console.log(`  ${'planted'.padEnd(34)}${'recovered'}`)
  console.log(`  ${'max      tau    shape'.padEnd(34)}max      tau    shape     err`)
  let worst = 0
  const recovered = []
  for (const planted of [
    { cellModMax: CELL_MOD_MAX, cellModTauDb: CELL_MOD_TAU_DB, cellModShape: 1.0 },
    { cellModMax: 0.30, cellModTauDb: CELL_MOD_TAU_DB, cellModShape: 2.2 },
    { cellModMax: 0.55, cellModTauDb: CELL_MOD_TAU_DB, cellModShape: 3.0 },

  ]) {
    const wet = processLA2ABuffer([dry], sampleRate, {
      peakReduction: 60, tube: false, lookaheadMs: 0, gainDb: 0, cellMod: 1, ...planted,
    }).channelData[0]
    const target = deviationProfile(dry, wet, sampleRate)
    const pr = matchPeakReduction(dry, speechDynamicRange(dry, wet, sampleRate), sampleRate)
    const got = fitCellMod(dry, sampleRate, pr, target)
    worst = Math.max(worst, Math.abs(got.shape / planted.cellModShape - 1))
    recovered.push(got.shape)
    console.log(`  ${planted.cellModMax.toFixed(3)}  ${planted.cellModTauDb.toFixed(2).padStart(6)}   ${planted.cellModShape.toFixed(2)}     `
      + `  ${got.max.toFixed(3)}  ${got.tau.toFixed(2).padStart(6)}   ${got.shape.toFixed(2)}   ${got.err.toExponential(1)}`)
  }
  const ranked = recovered.every((v, i) => i === 0 || v > recovered[i - 1])
  console.log(`\n  worst shape error: ${(worst * 100).toFixed(0)} % relative;`
    + ` ordering ${ranked ? 'preserved' : 'BROKEN'}`)
  /**
   * ⚠ RELATIVE, AND IT CHECKS THE ORDERING SEPARATELY. Against a target the
   * model can reproduce, the simplex lands within 1 %, so 10 % is slack rather
   * than a bar set to what a weak fitter could clear — an earlier
   * coordinate-descent version missed by 53 % and the gate is what caught it.
   * The ordering check is not redundant: a tool that got the ORDER wrong could
   * not tell a linear cell from a cubic one, which is the only claim anyone
   * should be taking from a single capture anyway.
   */
  console.log(ranked && worst < 0.10
    ? '  PASS — resolves the exponent to within the ridge, and orders correctly.'
    : '  FAIL — do not read a hardware disagreement as the model\'s until this passes.')
}

function report() {
  const pairs = findPairs().filter(p => !only || p.stem.includes(only))
  if (!pairs.length) {
    console.log(`No capture pairs in ${CAP_DIR}.`)
    console.log('\nDrop a matched pair in as <unit>.<knob>.dry.wav / <unit>.<knob>.wet.wav —')
    console.log('the same performance in and out of the unit, no plugins, no normalisation')
    console.log('needed (the metric divides out level). Use `unknown` for the knob if the')
    console.log('capture did not record it; the Peak Reduction is solved either way.')
    console.log('\n  e.g.  data/corpus/la2a-cellmod/hardware.unknown.dry.wav')
    console.log('        data/corpus/la2a-cellmod/hardware.unknown.wet.wav')
    console.log('\n`*.wav` is gitignored repo-wide, so captures never reach a commit.')
    console.log('\nRun `npm run la2a:cellmod:selftest` to exercise the fitter with no capture.')
    return
  }

  console.log('dB below a local linear fit, by band of each window\'s own peak.')
  console.log('Negative is compressive. A FLAT row is a gain trim, not a peak shaver.\n')

  for (const pair of pairs) {
    const { dry, wet, sampleRate } = loadPair(pair)
    const target = deviationProfile(dry, wet, sampleRate)
    const wetDr = speechDynamicRange(dry, wet, sampleRate)
    const pr = matchPeakReduction(dry, wetDr, sampleRate)

    console.log(`── ${pair.stem}   ${sampleRate} Hz, ${(dry.length / sampleRate).toFixed(1)} s`)
    console.log(`   capture delivers ${wetDr.toFixed(2)} dB speech DR; our PR ${pr.toFixed(1)} matches it\n`)
    console.log(`   ${'                '}${bandHeader}   steepening`)
    const steep = p => (Number.isFinite(p[0]) && p[0] !== 0
      ? `${(p[2] / p[0]).toFixed(1)}x` : 'n/a').padStart(12)
    console.log(`   ${'capture'.padEnd(16)}${fmtProfile(target)}${steep(target)}`)
    const shipped = ourProfile(dry, sampleRate, pr, {})
    console.log(`   ${'ours, as shipped'.padEnd(16)}${fmtProfile(shipped)}${steep(shipped)}`)
    console.log(`   ${'ours, cell off'.padEnd(16)}${fmtProfile(ourProfile(dry, sampleRate, pr, { cellMod: 0 }))}`)

    if (doFit) {
      const got = fitCellMod(dry, sampleRate, pr, target)
      const fitted = ourProfile(dry, sampleRate, pr, {
        cellModMax: got.max, cellModTauDb: got.tau, cellModShape: got.shape,
      })
      console.log(`   ${'ours, fitted'.padEnd(16)}${fmtProfile(fitted)}${steep(fitted)}`)
      console.log('\n   fitted   cellModMax %s   cellModTauDb %s   cellModShape %s',
        got.max.toFixed(4), got.tau.toFixed(3), got.shape.toFixed(3))
      console.log('   shipped  cellModMax %s   cellModTauDb %s   cellModShape %s',
        CELL_MOD_MAX.toFixed(4), CELL_MOD_TAU_DB.toFixed(3), CELL_MOD_SHAPE.toFixed(3))
      console.log(`   residual ${Math.sqrt(got.err / BANDS.length).toFixed(4)} dB rms across the bands`)
      const ridge = shapeRidge(dry, sampleRate, pr, target, got)
      console.log(ridge
        ? `   ridge    every shape in ${ridge[0].toFixed(1)}-${ridge[1].toFixed(1)} fits within 0.010 dB once depth re-solves`
        : '   ridge    could not be traced')
      console.log('\n   ⚠ ONE CAPTURE, ONE UNIT, AND THE CAPTURE CHAIN IS INSIDE THE NUMBER.')
      console.log('     This bounds the cell\'s shape from above. It is not a shippable fit —')
      console.log('     see the header, and CELL_MOD_MAX\'s note on what six units bought.')
    }
    console.log()
  }
  if (!doFit) console.log('(run `npm run la2a:cellmod:fit` to search for a better cell tuning)')
}

if (doSelftest) selftest()
else report()
