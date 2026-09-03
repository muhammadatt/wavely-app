#!/usr/bin/env node
/**
 * Analyse a LAEA tube-stage capture and, with --fit, refit TUBE_DRIVE_LIN /
 * TUBE_BIAS against it.
 *
 *   npm run la2a:tube:tones          # generate the stimulus first
 *   npm run la2a:tube:fit            # report: measured vs. the shipped model
 *   npm run la2a:tube:fit -- --fit   # also search for a better (d, b)
 *
 * See docs/la2a_tube_capture_protocol.md for what to capture and how. This
 * script only reads `data/corpus/la2a/tube_capture/captures/` (gitignored —
 * `*.wav` is ignored repo-wide, so nothing from a commercial plugin reaches
 * the repo) and reports.
 *
 * ⚠ THIS REPORTS; IT DOES NOT WRITE. Unlike `fit-pultec-curves.mjs --write`,
 * there is no `--write` here. The R37 taper and the tube calibration were both
 * hand-written into la2aProcessor.js with the reasoning attached, not
 * machine-applied — a constant that moves the sound of a shipped plugin is a
 * deliberate edit with its own justification, not something a script commits
 * on its own judgement. This produces the number; updating the source is a
 * separate, considered step.
 *
 * MEASUREMENT METHOD — same one `test/dsp/la2aTube.test.js` and
 * `scripts/la2a-dcblock-real.mjs` use: a DFT at exact harmonics of the probe
 * tone, not a difference against a bypassed signal. A difference signal is
 * dominated by whatever the plugin's own output filtering does to phase,
 * which — as this codebase has now measured three times on this one plugin —
 * reads as damage that is not there. Harmonic magnitude is immune to phase.
 *
 * WHAT GETS FITTED AND WHAT DOES NOT. Only the LEVEL SWEEP (1 kHz, Gain 0,
 * Peak Reduction 0) feeds the optimiser. The FREQUENCY SWEEP is reported
 * against the same model as a HOLD-OUT: our shaper is memoryless, so it
 * predicts identical harmonic ratios at every frequency for a given level,
 * and that is a claim the frequency sweep can falsify. Including it in the
 * fit would let the optimiser paper over a frequency dependence rather than
 * reveal one. The GAIN SWEEP is reported for its own sake — see the note in
 * `la2a-tube-capture-tones.mjs` on why its x-axis is not trusted numerically.
 */

import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readWav } from '../test/voicerx/wav.js'
import { LA2AKernel } from '../src/audio/la2aProcessor.js'
import {
  CAPTURES_DIR, NOISE_FLOOR_FILE, sweepEntries, toneFilename,
  LEVEL_SWEEP_FREQ_HZ, FREQ_SWEEP_DBFS,
  GAIN_SWEEP_FREQ_HZ, GAIN_SWEEP_DBFS,
  ANALYSIS_WINDOW_END_OFFSET_S, ANALYSIS_WINDOW_LENGTH_S,
} from './la2a-tube-capture-tones.mjs'

const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))
const lin = dbfs => Math.pow(10, dbfs / 20)

// How many harmonics to read and how many of them feed the fit objective.
// H2/H3 are what the code comments talk about (bias -> 2nd, tanh curvature ->
// 3rd); H4 is read and reported but only lightly weighted, since it is the
// first one a real plugin's own noise floor is likely to swallow.
const N_HARMONICS = 4
const FIT_WEIGHTS = [1, 1, 0.5] // for H2, H3, H4 — H1 is the reference, not an error term

// ── Harmonic extraction from a captured file ────────────────────────────────

/**
 * DFT magnitude at k * freqHz, over an integer number of cycles closest to
 * the requested window — the same no-window-function approach
 * `la2a-dcblock-real.mjs` and `test/dsp/la2aTube.test.js` use, which needs no
 * leakage correction because the window boundary sits on a full cycle.
 */
function dftMag(y, offset, length, sampleRate, freqHz, k) {
  const cycleSamples = sampleRate / (k * freqHz)
  const cycles = Math.max(1, Math.round(length / cycleSamples))
  const n = Math.min(y.length - offset, Math.round(cycles * cycleSamples))
  let re = 0, im = 0
  for (let i = 0; i < n; i++) {
    const p = 2 * Math.PI * k * freqHz * i / sampleRate
    re += y[offset + i] * Math.cos(p)
    im += y[offset + i] * Math.sin(p)
  }
  return 2 * Math.hypot(re, im) / n
}

/**
 * Analyses the LAST `ANALYSIS_WINDOW_LENGTH_S` seconds ending
 * `ANALYSIS_WINDOW_END_OFFSET_S` before the end of the file — robust to
 * unknown head latency (DAW pre-roll, plugin lookahead) without needing to
 * know it, as long as the capture is at least that long. See the constant's
 * definition in la2a-tube-capture-tones.mjs.
 */
function analyzeCapture(path, freqHz) {
  const { mono, sampleRate, seconds } = readWav(path)
  const minSeconds = ANALYSIS_WINDOW_END_OFFSET_S + ANALYSIS_WINDOW_LENGTH_S + 0.1
  if (seconds < minSeconds) {
    throw new Error(`${path}: only ${seconds.toFixed(2)} s, need at least ${minSeconds.toFixed(2)} s — did the bounce get trimmed?`)
  }
  const end = mono.length - Math.round(ANALYSIS_WINDOW_END_OFFSET_S * sampleRate)
  const start = end - Math.round(ANALYSIS_WINDOW_LENGTH_S * sampleRate)

  const h = []
  for (let k = 1; k <= N_HARMONICS; k++) h.push(dftMag(mono, start, end - start, sampleRate, freqHz, k))

  // Sanity check: a sine's RMS is peak/sqrt(2). If the exact-frequency DFT
  // magnitude disagrees with that by more than a rounding error, the file is
  // probably not at freqHz any more — a sample-rate mismatch on export, or a
  // pitch-shifting plugin somewhere in the chain.
  let rms = 0
  for (let i = start; i < end; i++) rms += mono[i] * mono[i]
  rms = Math.sqrt(rms / (end - start))
  const impliedPeak = rms * Math.SQRT2
  const driftWarning = Math.abs(db(h[0]) - db(impliedPeak)) > 1.5
    ? `fundamental DFT reads ${db(h[0]).toFixed(1)} dBFS but broadband RMS implies ${db(impliedPeak).toFixed(1)} — check sample rate / pitch`
    : null

  return {
    sampleRate,
    fundamentalDbfs: db(h[0]),
    dBc: h.slice(1).map(v => db(v / h[0])), // [H2, H3, H4] relative to H1
    driftWarning,
  }
}

// ── The model — the same closed form the kernel evaluates ──────────────────

/**
 * `f(x) = (tanh(d*x + b) - tanh(b)) / (d*(1 - tanh(b)^2))` — unity small-signal
 * gain, by construction. Equivalent to running LA2AKernel with peakReduction 0
 * and the given gain for a steady tone (verified in test/dsp/la2aTube.test.js
 * and by direct comparison below); computed in closed form here because the
 * optimiser needs thousands of cheap evaluations.
 */
function shaper(d, b) {
  const tb = Math.tanh(b)
  const norm = d * (1 - tb * tb)
  return x => (Math.tanh(d * x + b) - tb) / norm
}

/**
 * Harmonic ratios (dBc, H2..H_N) the model predicts for a pure tone at
 * levelDbfs. `N` (samples per cycle) is 512, not because that is barely
 * enough but because it is nowhere near not-enough: checked against 4096
 * across the full drive range, including the deepest saturation this stage
 * ever sees (Peak Reduction 100 + Gain +24 dB), H2/H3/H4 agree to four
 * decimal places. A memoryless tanh's harmonics decay fast, so the folding
 * this DFT approach risks is negligible many harmonics past H4. Matters here
 * because the fit calls this thousands of times.
 */
function predictDbc(d, b, levelDbfs, harmonics = N_HARMONICS) {
  const f = shaper(d, b)
  const N = 512
  const amp = lin(levelDbfs)
  const y = new Float64Array(N)
  for (let i = 0; i < N; i++) y[i] = f(amp * Math.sin(2 * Math.PI * i / N))
  const mags = []
  for (let k = 1; k <= harmonics; k++) {
    let re = 0, im = 0
    for (let i = 0; i < N; i++) { const p = 2 * Math.PI * k * i / N; re += y[i] * Math.cos(p); im += y[i] * Math.sin(p) }
    mags.push(2 * Math.hypot(re, im) / N)
  }
  return mags.slice(1).map(v => db(v / mags[0]))
}

/**
 * Confirms `predictDbc`'s closed form actually matches what LA2AKernel does,
 * rather than leaving that as an assertion in a comment. Runs the real kernel
 * — oversampled, through the DC blocker, the lot — at a few (level, gain)
 * points and requires agreement to within 0.05 dB. This is what lets the fit
 * loop use the cheap closed form for thousands of evaluations instead of
 * spinning up a kernel per candidate: if this check ever fails, the two have
 * drifted apart and the fit below is no longer trustworthy.
 */
function selfCheckAgainstKernel() {
  const SR = 48000, CYCLE_HZ = 1000
  const cases = [[-24, 0], [-18, 0], [-6, 0], [-18, 12], [-12, 18]]
  for (const [levelDbfs, gainDb] of cases) {
    const k = new LA2AKernel(SR)
    k.setParams({ mode: 'compress', peakReduction: 0, gainDb, r37: 100, mix: 1 })
    const seconds = 0.6, n = Math.round(SR * seconds)
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = lin(levelDbfs) * Math.sin(2 * Math.PI * CYCLE_HZ * i / SR)
    const y = new Float32Array(n)
    for (let off = 0; off < n; off += 128) {
      const len = Math.min(128, n - off)
      k.process([x.subarray(off, off + len)], [y.subarray(off, off + len)], len)
    }
    // Inline DFT rather than analyzeCapture: this is a synthetic buffer, not a file.
    const start = Math.round(0.3 * SR), end = n - Math.round(0.05 * SR)
    const h = []
    for (let kHarm = 1; kHarm <= 3; kHarm++) h.push(dftMag(y, start, end - start, SR, CYCLE_HZ, kHarm))
    const kernelDbc = h.slice(1).map(v => db(v / h[0]))
    const modelDbc = predictDbc(0.7, 0.06, levelDbfs + gainDb, 3)
    for (let i = 0; i < 2; i++) {
      const err = Math.abs(kernelDbc[i] - modelDbc[i])
      if (err > 0.05) {
        throw new Error(
          `self-check failed: closed-form predictDbc disagrees with LA2AKernel by ${err.toFixed(3)} dB `
          + `at ${levelDbfs} dBFS / gain ${gainDb} dB (H${i + 2}: kernel ${kernelDbc[i].toFixed(2)}, model ${modelDbc[i].toFixed(2)}). `
          + `The kernel and this script's copy of the curve have drifted apart — fix predictDbc before trusting anything below.`
        )
      }
    }
  }
}

// ── Nelder-Mead — same routine fit-pultec-curves.mjs uses ──────────────────

function nelderMead(f, x0, { steps, maxIter = 4000, tol = 1e-10 }) {
  const n = x0.length
  const simplex = [x0.slice()]
  for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += steps[i]; simplex.push(p) }
  let values = simplex.map(f)
  const centroid = excl => {
    const c = new Array(n).fill(0)
    for (let i = 0; i < simplex.length; i++) { if (i === excl) continue; for (let k = 0; k < n; k++) c[k] += simplex[i][k] }
    return c.map(v => v / (simplex.length - 1))
  }
  for (let iter = 0; iter < maxIter; iter++) {
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b])
    const sorted = order.map(i => simplex[i]), sortedV = order.map(i => values[i])
    for (let i = 0; i < simplex.length; i++) { simplex[i] = sorted[i]; values[i] = sortedV[i] }
    if (Math.abs(values[n] - values[0]) < tol * (Math.abs(values[0]) + tol)) break
    const c = centroid(n), worst = simplex[n]
    const reflect = c.map((v, k) => v + (v - worst[k])), fr = f(reflect)
    if (fr < values[0]) {
      const expand = c.map((v, k) => v + 2 * (v - worst[k])), fe = f(expand)
      if (fe < fr) { simplex[n] = expand; values[n] = fe } else { simplex[n] = reflect; values[n] = fr }
    } else if (fr < values[n - 1]) { simplex[n] = reflect; values[n] = fr }
    else {
      const contract = c.map((v, k) => v + 0.5 * (worst[k] - v)), fc = f(contract)
      if (fc < values[n]) { simplex[n] = contract; values[n] = fc }
      else for (let i = 1; i < simplex.length; i++) { simplex[i] = simplex[i].map((v, k) => simplex[0][k] + 0.5 * (v - simplex[0][k])); values[i] = f(simplex[i]) }
    }
  }
  // `indexOf` uses strict equality, and NaN !== NaN, so `values.indexOf(NaN)`
  // never matches — a silent -1 that turns into "best is undefined" three
  // calls later with no clue why. An objective that ever returns NaN (a
  // mismatched array length between prediction and target did, once, while
  // writing this) fails loudly here instead.
  const finite = values.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v))
  if (finite.length === 0) throw new Error('nelderMead: every candidate evaluated to a non-finite objective — check the objective function')
  const [bestFx, best] = finite.reduce((a, b) => (b[0] < a[0] ? b : a))
  return { x: simplex[best], fx: bestFx }
}

// ── Main ─────────────────────────────────────────────────────────────────

function captureFor(file) {
  const p = join(CAPTURES_DIR, file)
  return existsSync(p) ? p : null
}

/** True if a harmonic's absolute level sits within `marginDb` of the measured noise floor. */
function nearFloor(fundamentalDbfs, dBc, floorDbfs, marginDb = 6) {
  return floorDbfs !== null && (fundamentalDbfs + dBc) < floorDbfs + marginDb
}

function main() {
  const doFit = process.argv.includes('--fit')
  selfCheckAgainstKernel() // fail loudly here rather than let a silent drift produce a bogus fit
  const entries = sweepEntries()

  // Noise floor, if captured. Optional — reported as "unknown" rather than
  // required, but every dBc figure near it gets flagged rather than trusted.
  let floorDbfs = null
  const floorPath = captureFor(NOISE_FLOOR_FILE)
  if (floorPath) {
    const { mono, sampleRate } = readWav(floorPath)
    const start = mono.length - Math.round((ANALYSIS_WINDOW_END_OFFSET_S + ANALYSIS_WINDOW_LENGTH_S) * sampleRate)
    const end = mono.length - Math.round(ANALYSIS_WINDOW_END_OFFSET_S * sampleRate)
    let rms = 0
    for (let i = Math.max(0, start); i < end; i++) rms += mono[i] * mono[i]
    floorDbfs = db(Math.sqrt(rms / (end - Math.max(0, start))))
    console.log(`Noise floor (${NOISE_FLOOR_FILE}): ${floorDbfs.toFixed(1)} dBFS RMS\n`)
  } else {
    console.log(`⚠ No ${NOISE_FLOOR_FILE} capture found — harmonics near the noise floor will not be flagged.\n`)
  }

  // ── Level sweep ──────────────────────────────────────────────────────────
  console.log(`=== LEVEL SWEEP (${LEVEL_SWEEP_FREQ_HZ} Hz, Gain 0, Peak Reduction 0) ===`)
  console.log('level      H2 meas   H2 model    H3 meas   H3 model    H4 meas   H4 model   fund gain')
  const levelPoints = [] // for the fit and for the low-level PR sanity check
  let firstFundGain = null
  for (const e of entries.filter(e => e.kind === 'level')) {
    const dbfs = e.levelDbfs
    const path = captureFor(e.file)
    if (!path) { console.log(`  ${String(dbfs).padStart(4)} dBFS   -- no capture (${e.file}) --`); continue }
    const m = analyzeCapture(path, LEVEL_SWEEP_FREQ_HZ)
    if (m.driftWarning) console.log(`  ⚠ ${e.file}: ${m.driftWarning}`)
    const model = predictDbc(0.7, 0.06, dbfs) // current shipped constants
    const fundGain = m.fundamentalDbfs - dbfs
    if (firstFundGain === null) firstFundGain = fundGain

    const cells = m.dBc.slice(0, 3).map((v, i) => {
      const flag = nearFloor(m.fundamentalDbfs, v, floorDbfs) ? '*' : ' '
      return `${v.toFixed(1).padStart(7)}${flag}  ${model[i].toFixed(1).padStart(8)}`
    })
    console.log(`  ${String(dbfs).padStart(4)} dBFS   ${cells.join('   ')}   ${fundGain >= 0 ? '+' : ''}${fundGain.toFixed(2)} dB`)

    levelPoints.push({ dbfs, measured: m.dBc, fundamentalDbfs: m.fundamentalDbfs })
  }
  console.log('  (* = within 6 dB of the measured noise floor — excluded from the fit)')
  if (firstFundGain !== null && levelPoints.length >= 2) {
    const spread = Math.max(...levelPoints.slice(0, 2).map(p => Math.abs(p.fundamentalDbfs - p.dbfs - firstFundGain)))
    if (spread > 0.5) {
      console.log(`\n  ⚠ Fundamental gain varies by ${spread.toFixed(2)} dB across the two quietest levels.`)
      console.log(`    The tube itself should not touch the fundamental down there — this usually means`)
      console.log(`    Peak Reduction was not fully disengaged. Check the plugin's GR meter reads 0 throughout.`)
    }
  }

  // ── Frequency sweep — hold-out ──────────────────────────────────────────
  console.log(`\n=== FREQUENCY SWEEP (${FREQ_SWEEP_DBFS} dBFS, hold-out — not fit) ===`)
  console.log('freq        H2 meas   H2 @1kHz    H3 meas   H3 @1kHz')
  const modelAt1kHz = predictDbc(0.7, 0.06, FREQ_SWEEP_DBFS)
  const level1kHzCapture = levelPoints.find(p => p.dbfs === FREQ_SWEEP_DBFS)
  for (const e of entries.filter(e => e.kind === 'freq')) {
    const path = captureFor(e.file)
    if (!path) { console.log(`  ${String(e.freqHz).padStart(5)} Hz   -- no capture (${e.file}) --`); continue }
    const m = analyzeCapture(path, e.freqHz)
    if (m.driftWarning) console.log(`  ⚠ ${e.file}: ${m.driftWarning}`)
    // Compare against the 1 kHz LEVEL-SWEEP capture at the same dBFS if we have
    // one (the real reference), falling back to the model's own prediction.
    const ref = level1kHzCapture ? level1kHzCapture.measured : modelAt1kHz
    const refLabel = level1kHzCapture ? '@1kHz*' : '@1kHz(model)'
    console.log(`  ${String(e.freqHz).padStart(5)} Hz   ${m.dBc[0].toFixed(1).padStart(7)}   ${ref[0].toFixed(1).padStart(8)}   ${m.dBc[1].toFixed(1).padStart(7)}   ${ref[1].toFixed(1).padStart(8)}   ${refLabel}`)
  }
  console.log(`  If these disagree with the 1 kHz column by more than the level sweep's own scatter,`)
  console.log(`  the memoryless-curve model is wrong for this stage — no refit of TUBE_DRIVE_LIN /`)
  console.log(`  TUBE_BIAS can fix a frequency dependence, because neither constant has one.`)

  // ── Gain sweep — qualitative ─────────────────────────────────────────────
  // The base tone's own filename, with an operator-chosen `_g<label>` suffix
  // appended before bouncing — see the protocol for the exact naming. The
  // suffix is matched generically (any label, not assumed numeric or in dB)
  // so a plugin whose Gain knob has no dB readout still works: the label is
  // just an x-axis tag, and the report says so.
  console.log(`\n=== GAIN SWEEP (${GAIN_SWEEP_FREQ_HZ} Hz @ ${GAIN_SWEEP_DBFS} dBFS tone, knob label from filename, qualitative) ===`)
  const gainBase = toneFilename('gain', GAIN_SWEEP_FREQ_HZ, GAIN_SWEEP_DBFS).replace(/\.wav$/, '')
  const gainFilePattern = new RegExp(`^${gainBase}_g(.+)\\.wav$`)
  const gainFiles = existsSync(CAPTURES_DIR)
    ? readdirSync(CAPTURES_DIR).filter(f => gainFilePattern.test(f)).sort()
    : []
  if (gainFiles.length === 0) {
    console.log(`  -- no gain-sweep captures found (expected ${gainBase}_g<label>.wav) --`)
  } else {
    console.log('  knob label     H2 meas    H3 meas    H2-H4 THD %')
    for (const f of gainFiles) {
      const label = f.match(gainFilePattern)[1]
      const m = analyzeCapture(join(CAPTURES_DIR, f), GAIN_SWEEP_FREQ_HZ)
      const thd = Math.sqrt(m.dBc.reduce((sum, v) => sum + Math.pow(10, v / 10), 0)) * 100
      console.log(`  ${label.padEnd(12)}   ${m.dBc[0].toFixed(1).padStart(7)}    ${m.dBc[1].toFixed(1).padStart(7)}    ${thd.toFixed(3)}`)
    }
    console.log('  Expect monotone rising THD. A knob label is NOT assumed to read in dB — see the')
    console.log('  protocol for the calibration check that would let it be used quantitatively.')
  }

  // ── Fit ──────────────────────────────────────────────────────────────────
  const fitData = levelPoints.filter(p => !p.measured.some((v, i) => nearFloor(p.fundamentalDbfs, v, floorDbfs)))
  if (doFit) {
    console.log(`\n=== FIT (${fitData.length}/${levelPoints.length} level-sweep points, floor-contaminated points excluded) ===`)
    if (fitData.length < 3) {
      console.log('  Not enough clean points to fit — capture more of the level sweep, or a quieter noise floor.')
    } else {
      const objective = ([d, b]) => {
        if (d <= 0.01 || b < 0) return 1e9
        let e = 0
        for (const p of fitData) {
          const pred = predictDbc(d, b, p.dbfs) // default harmonics = N_HARMONICS, i.e. [H2, H3, H4] — must match p.measured's length
          for (let i = 0; i < pred.length; i++) e += FIT_WEIGHTS[i] * Math.pow(pred[i] - p.measured[i], 2)
        }
        return e
      }
      const starts = [[0.3, 0.02], [0.7, 0.06], [1.2, 0.1], [1.75, 0.2], [2.5, 0.3]]
      let best = null
      for (const s of starts) {
        const r = nelderMead(objective, s, { steps: [0.1, 0.02] })
        if (!best || r.fx < best.fx) best = r
      }
      const [d, b] = best.x
      const currentResidual = objective([0.7, 0.06])
      console.log(`  current TUBE_DRIVE_LIN=0.700, TUBE_BIAS=0.060 — objective ${currentResidual.toFixed(3)}`)
      console.log(`  best fit TUBE_DRIVE_LIN=${d.toFixed(3)}, TUBE_BIAS=${b.toFixed(3)} — objective ${best.fx.toFixed(3)}`)
      console.log(`\n  This is a candidate, not a rewrite. Update TUBE_DRIVE_LIN / TUBE_BIAS in`)
      console.log(`  la2aProcessor.js by hand if the fit is trusted, with the capture's own evidence`)
      console.log(`  recorded in the comment next to it — same as every other constant in that file.`)
    }
  } else {
    console.log('\n(run with --fit to search for TUBE_DRIVE_LIN / TUBE_BIAS)')
  }
}

main()
