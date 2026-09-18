/**
 * Run with:  npm run fet:static-fit        (add --selftest for the guards)
 *
 * FITS FET PUNCH'S STATIC CURVE TO FETish — the knee law and the four ratio
 * buttons — BY SIMULATE-AND-MATCH.
 *
 * ⚠⚠ THE NUMBERS THE STAIRS FITTER PRINTS ARE NOT THE NUMBERS TO INSTALL, and
 * this is the fifth constant in the FET re-tune where that is true (after the
 * release endpoints, the release depth slope, the attack ladder and the attack
 * schedule). `stairs.wav` measures the static law CONVOLVED WITH THE ATTACK: the
 * protocol demands the slowest attack, so the gain never quite reaches the
 * per-peak static target, and the fit comes back biased.
 *
 * ⚠ AND THE KNEE BIAS IS WIDTH-DEPENDENT, which is what makes installing the
 * printed number actively wrong rather than merely offset. Measured on our own
 * kernel at ratio 4, true knee -> fitted:
 *
 *     4 -> 5.92 (+1.92)    6 -> 7.90 (+1.90)    8 -> 9.53 (+1.53)
 *    10 -> 11.11 (+1.11)  12 -> 12.76 (+0.76)
 *
 * The bias SHRINKS as the knee widens, so it compresses the range: FETish's
 * fitted 5.85 -> 10.86 (5.01 dB of growth) is produced by a TRUE growth nearer
 * 5.8 dB. A fit that installed 0.2004/dB would under-deliver the law by ~16 %.
 *
 * ⚠ THE CORRESPONDENCE IS THE EFFECTIVE THRESHOLD, NOT THE REDUCTION, and an
 * earlier note in `fet1176Processor.js` had this wrong. `effThresholdDb` is
 * `threshold - drive` and is ABSOLUTE — dBFS, referenced to the same stimulus —
 * so both kernels report it in the same units and it says where the bend sits.
 * The knee is a width on that same input-level axis, so matching on it is exact
 * and needs nothing from the reduction. The earlier framing ("ours reaches the
 * same reduction in 20.07 dB where FETish spends 24.99") asked the wrong
 * question: FETish needs more drive for the same REDUCTION because its slope is
 * lower, but the bend still sits where the effective threshold says it does, and
 * that is what the knee is measured against. Anchored this way the two drive
 * axes coincide by construction and the 24 % ambiguity is not a property of the
 * data.
 *
 * WHAT IS SEARCHED. Four ratio values and the knee law's two parameters, by
 * coordinate descent, because the instrument fits (threshold, slope, knee)
 * JOINTLY and the two therefore interact: our fitted knee moves 0.32 dB across
 * the ratio buttons at one true knee, and our fitted slope moves with the knee
 * that sits under it.
 *
 * THE TARGET DATA is `data/fet1176/fetish_stairs_fits.json` — the stairs
 * fitter's own output, kept because the captures are licensed audio and cannot
 * be. See that file's header.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { PLANS, runKernel } from './fet-ballistics.mjs'
import { buildProbe } from './lib/probeStimulus.js'
import { fitStatic, stairCurve } from './fet-stairs.mjs'
import { inputDriveDbForKnob, KNEE_DRIVE_REF_DB } from '../src/audio/fet1176Processor.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGETS = join(HERE, '..', 'data', 'fet1176', 'fetish_stairs_fits.json')

/** `THRESHOLD_DBFS` — not exported, and pinned by a self-test guard below. */
const THRESHOLD_DBFS = -18

export function loadTargets(path = TARGETS) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * The Input knob that puts our detector at a given drive.
 *
 * ⚠ THE KNOB IS A TAPER, so a drive cannot be set by picking a percentage —
 * `inputDriveDbForKnob` is `MIN + SPAN * k^0.8`. Inverted by bisection rather
 * than algebraically so this keeps working if the taper's shape ever moves.
 */
export function knobForDrive(driveDb) {
  let lo = 0
  let hi = 100
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (inputDriveDbForKnob(mid) < driveDb) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** The drive that puts OUR bend where the reference's capture had it. */
export function driveForEffThreshold(effThresholdDb) {
  return THRESHOLD_DBFS - effThresholdDb
}

const cache = new Map()

/** Our kernel through the reference's own instrument. */
export function measure(sampleRate, plan, stim, { ratioValue, driveDb, kneeAtRefDb, kneeDriveSlope }) {
  const key = `${ratioValue}:${driveDb.toFixed(4)}:${kneeAtRefDb.toFixed(4)}:${kneeDriveSlope.toFixed(5)}`
  if (!cache.has(key)) {
    const { y } = runKernel(stim.x, sampleRate, {
      inputDrive: knobForDrive(driveDb),
      // ⚠ THE BUTTON IS BYPASSED AND THE SLOPE SET DIRECTLY. `ratio` is a
      // four-position switch, so the search cannot move through it; `ratioValue`
      // is the continuous quantity underneath, which is what is being fitted.
      ratioValue,
      attack: 1,
      release: 7,
      fetDrive: 0,
      kneeAtRefDb,
      kneeDriveSlope,
    })
    cache.set(key, fitStatic(stairCurve(y, plan, stim, sampleRate, 0)))
  }
  return cache.get(key)
}

const rms = (xs) => Math.sqrt(xs.reduce((a, v) => a + v * v, 0) / xs.length)

/** Which button the knee is read off. See `fitLaw`. */
const KNEE_FIT_BUTTON = '4'

/** Golden-section-ish scan: a coarse grid, then a shrinking pattern search. */
function search1d(lo, hi, cost, steps = 8, rounds = 14) {
  let best = null
  for (let i = 0; i <= steps; i++) {
    const v = lo + (hi - lo) * (i / steps)
    const c = cost(v)
    if (!best || c < best.cost) best = { v, cost: c }
  }
  let step = (hi - lo) / steps
  for (let r = 0; r < rounds; r++) {
    let moved = false
    for (const dir of [-1, 1]) {
      const v = Math.min(hi, Math.max(lo, best.v + dir * step))
      const c = cost(v)
      if (c < best.cost) { best = { v, cost: c }; moved = true }
    }
    if (!moved) step /= 2
    if (step < 1e-5) break
  }
  return best
}

/**
 * Fit the law. `rows` are the reference's readings; `fitRows` may be a subset,
 * which is how the held-out validation works.
 */
export function fitLaw(rows, sampleRate, plan, stim, { fitRows = rows, rounds = 3, fitRatios = false } = {}) {
  const buttons = [...new Set(rows.map(r => r.ratio))]
  // Start from the button's nominal slope and the law as it currently ships.
  let ratioValues = Object.fromEntries(buttons.map(b => [b, Number(b)]))
  let kneeAtRefDb = 6
  let kneeDriveSlope = 0.2

  /**
   * ⚠ THE KNEE IS FITTED ON ONE BUTTON, NOT ALL FOUR, and that is not a corner
   * cut — it is the first finding. FETish's knee is identical across the four
   * buttons to 0.01 dB at every Input position, so the other three contribute
   * the same four numbers again and cost four times the renders to say it. The
   * ratio sweep earns its place in the SLOPE fit, where the buttons differ.
   */
  const kneeRows = fitRows.filter(r => r.ratio === KNEE_FIT_BUTTON)

  const kneeCost = (atRef, slope) => rms(kneeRows.map((r) => {
    const m = measure(sampleRate, plan, stim, {
      ratioValue: ratioValues[r.ratio],
      driveDb: driveForEffThreshold(r.effThresholdDb),
      kneeAtRefDb: atRef,
      kneeDriveSlope: slope,
    })
    return m.kneeDb - r.kneeDb
  }))

  const slopeCost = (button, ratioValue) => rms(fitRows.filter(r => r.ratio === button).map((r) => {
    const m = measure(sampleRate, plan, stim, {
      ratioValue,
      driveDb: driveForEffThreshold(r.effThresholdDb),
      kneeAtRefDb,
      kneeDriveSlope,
    })
    return m.slope - r.slope
  }))

  for (let round = 0; round < rounds; round++) {
    const a = search1d(2, 12, v => kneeCost(v, kneeDriveSlope))
    kneeAtRefDb = a.v
    const b = search1d(0.05, 0.45, v => kneeCost(kneeAtRefDb, v))
    kneeDriveSlope = b.v
    /**
     * ⚠⚠ THE RATIOS ARE HELD AT NOMINAL UNLESS ASKED FOR, AND THE KNEE MUST BE
     * FITTED THAT WAY. Fitting them jointly and then installing only the knee
     * would calibrate the knee against a kernel that is not the one shipping:
     * our fitted knee moves 0.32 dB across the ratio buttons, so a ratio the
     * product does not use drags the knee with it. The first run of this fitter
     * did exactly that — it returned KNEE_AT_REF_DB 4.7148 alongside ratios
     * 3.769 / 6.552 / 9.397 / 13.417, and those ratios are a DIAGNOSTIC that
     * the nominal check above says not to install.
     */
    if (!fitRatios) continue
    for (const button of buttons) {
      const r = search1d(2, 40, v => slopeCost(button, v), 12)
      ratioValues[button] = r.v
    }
  }
  return { kneeAtRefDb, kneeDriveSlope, ratioValues }
}

export function residuals(rows, sampleRate, plan, stim, law) {
  return rows.map((r) => {
    const m = measure(sampleRate, plan, stim, {
      ratioValue: law.ratioValues[r.ratio],
      driveDb: driveForEffThreshold(r.effThresholdDb),
      kneeAtRefDb: law.kneeAtRefDb,
      kneeDriveSlope: law.kneeDriveSlope,
    })
    return { ...r, ourSlope: m.slope, ourKnee: m.kneeDb, dSlope: m.slope - r.slope, dKnee: m.kneeDb - r.kneeDb }
  })
}

function report(sampleRate) {
  const data = loadTargets()
  const plan = PLANS['stairs.wav']()
  const stim = buildProbe(plan, sampleRate)
  const rows = data.captures

  console.log(`\nFET Punch static curve — simulate-and-match against ${data.reference}`)
  console.log(`${rows.length} readings, fitted at ${sampleRate} Hz\n`)

  const law = fitLaw(rows, sampleRate, plan, stim)   // nominal ratios — what ships
  const res = residuals(rows, sampleRate, plan, stim, law)

  console.log('  capture        ref slope    ours     d       ref knee    ours      d')
  for (const r of res) {
    console.log(`  r${r.ratio.padEnd(3)} I${r.input}      ${r.slope.toFixed(4)}  ${r.ourSlope.toFixed(4)}  ` +
      `${(r.dSlope >= 0 ? '+' : '') + r.dSlope.toFixed(4)}      ${r.kneeDb.toFixed(2).padStart(5)}  ` +
      `${r.ourKnee.toFixed(2).padStart(6)}  ${((r.dKnee >= 0 ? '+' : '') + r.dKnee.toFixed(2)).padStart(6)}`)
  }
  console.log(`\n  rms slope residual ${rms(res.map(r => r.dSlope)).toFixed(5)}` +
    `   rms knee residual ${rms(res.map(r => r.dKnee)).toFixed(3)} dB`)

  /**
   * ⚠⚠ THE SLOPE HALF IS A DIAGNOSTIC, NOT SOMETHING TO INSTALL, and this is the
   * check that says so. Printed before the fitted ratios so nobody reads them
   * first.
   */
  console.log('\n  IS THE REFERENCE OFF NOMINAL, OR ARE WE?')
  console.log('    button   nominal   ref mean      dev      ours      dev')
  for (const button of [...new Set(rows.map(r => r.ratio))].sort((a, b) => Number(a) - Number(b))) {
    const mine = rows.filter(r => r.ratio === button)
    const nominal = 1 - 1 / Number(button)
    const refMean = mine.reduce((a, r) => a + r.slope, 0) / mine.length
    const ours = measure(sampleRate, plan, stim, {
      ratioValue: Number(button),
      driveDb: driveForEffThreshold(mine[0].effThresholdDb),
      kneeAtRefDb: law.kneeAtRefDb,
      kneeDriveSlope: law.kneeDriveSlope,
    }).slope
    const pc = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
    console.log(`    ${button.padStart(6)}   ${nominal.toFixed(4)}    ${refMean.toFixed(4)}  ` +
      `${pc(refMean / nominal - 1).padStart(8)}    ${ours.toFixed(4)}  ${pc(ours / nominal - 1).padStart(8)}`)
  }
  console.log('    → if the reference sits ON nominal and we do not, the gap is OUR')
  console.log('      instrument bias and the ratio buttons need no change at all.')

  console.log('\n  THE LAW TO INSTALL')
  console.log(`    KNEE_AT_REF_DB    ${law.kneeAtRefDb.toFixed(4)}   (at drive ${KNEE_DRIVE_REF_DB} dB)`)
  console.log(`    KNEE_DRIVE_SLOPE  ${law.kneeDriveSlope.toFixed(5)}`)
  console.log('    RATIO_VALUES      unchanged at nominal — see the check above')

  /**
   * ⚠ HELD OUT, BECAUSE A FIT THAT REPRODUCES ITS OWN TARGETS HAS SHOWN NOTHING.
   * The knee law has two parameters and four positions, so fitting the ends and
   * predicting the middle is the test of the LINE — which is the whole claim
   * being made about the law's shape.
   */
  const ends = rows.filter(r => r.input === 1 || r.input === 4)
  const held = rows.filter(r => r.input === 2 || r.input === 3)
  const lawEnds = fitLaw(rows, sampleRate, plan, stim, { fitRows: ends })
  const heldRes = residuals(held, sampleRate, plan, stim, lawEnds)
  console.log('\n  HELD OUT — fitted on I1 and I4 only, predicting I2 and I3')
  console.log(`    KNEE_AT_REF_DB ${lawEnds.kneeAtRefDb.toFixed(4)}  KNEE_DRIVE_SLOPE ${lawEnds.kneeDriveSlope.toFixed(5)}`)
  for (const r of heldRes) {
    console.log(`    r${r.ratio.padEnd(3)} I${r.input}   knee want ${r.kneeDb.toFixed(2)}  got ${r.ourKnee.toFixed(2)}` +
      `   ${(r.dKnee >= 0 ? '+' : '') + r.dKnee.toFixed(2)} dB`)
  }
  console.log(`    rms knee residual on held-out points ${rms(heldRes.map(r => r.dKnee)).toFixed(3)} dB`)
}

function selftest(sampleRate) {
  console.log('\nStatic-curve fit self-test\n')
  let bad = 0

  /**
   * ⚠ `THRESHOLD_DBFS` IS COPIED INTO THIS FILE because the kernel does not
   * export it, and a copy that silently goes stale would move every drive this
   * fitter asks for — the whole correspondence. Recovered here from the kernel
   * instead of trusted.
   */
  const plan = PLANS['stairs.wav']()
  const stim = buildProbe(plan, sampleRate)
  const { y } = runKernel(stim.x, sampleRate,
    { inputDrive: knobForDrive(0), ratio: '4', attack: 1, release: 7, fetDrive: 0 })
  const got = fitStatic(stairCurve(y, plan, stim, sampleRate, 0)).effThresholdDb
  const ok = Math.abs(got - THRESHOLD_DBFS) < 1.5
  if (!ok) bad++
  console.log(`  THRESHOLD_DBFS copy: at drive 0 the bend reads ${got.toFixed(2)} dBFS ` +
    `against ${THRESHOLD_DBFS}  ${ok ? 'PASS' : '⚠ FAIL — the copy has gone stale'}`)

  // The knob inversion must round-trip through the taper.
  let worst = 0
  for (const d of [-20, -10, -2.71, 0, 4.09, 15.68, 22.28]) {
    worst = Math.max(worst, Math.abs(inputDriveDbForKnob(knobForDrive(d)) - d))
  }
  const invOk = worst < 1e-3
  if (!invOk) bad++
  console.log(`  knob inversion round-trips to ${worst.toExponential(1)} dB  ${invOk ? 'PASS' : '⚠ FAIL'}`)

  console.log(`\n  ${bad === 0 ? 'PASS' : `⚠ ${bad} FAILED`}`)
  return bad
}

if (basename(process.argv[1] ?? '') === 'fet-static-fit.mjs') {
  const sampleRate = 44100
  if (process.argv.includes('--selftest')) process.exit(selftest(sampleRate) === 0 ? 0 : 1)
  else report(sampleRate)
}
