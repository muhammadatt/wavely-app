/**
 * Run with:  npm run fet:allshape -- --dir <captures>   (--selftest for guards)
 *
 * EXTRACTS THE ALL-BUTTONS SLOPE LAW WITHOUT ASSUMING ITS SHAPE.
 *
 * ⚠ WHY THIS AND NOT MORE FITTING. `fet-allbuttons-fit.mjs` asks how well the
 * shipping `MIN + SPAN*over/(over+HALF)` form fits, and answers 0.565 dB — a
 * residual larger than any of its parameters' sensitivity, so nothing inside the
 * form can be separated from the error in the form itself. Fitting it harder
 * cannot fix a wrong family. This asks the prior question: **what shape does the
 * data actually want?**
 *
 * WHAT IT MEASURES. The staircase gives reduction against level. Its LOCAL SLOPE
 * is the compression slope at that point, and the slope law is a function of
 * overshoot — so the four captures are four windows onto one curve, each shifted
 * horizontally by its own Input drive.
 *
 * ⚠⚠ THE X AXIS IS KNOWN ONLY UP TO ONE CONSTANT, AND THAT IS NOT A DEFECT HERE.
 * Overshoot is `level + drive - (THRESHOLD - drop)`, and drive and drop are
 * exactly degenerate — see `IDENTIFIABLE` in the fit. So absolute overshoot is
 * unrecoverable. The SHAPE is not: the true law is the same function for all
 * four captures, so the offsets that collapse them onto one curve are
 * recoverable even though their common origin is not. Everything below is
 * reported against a shifted axis with the first capture pinned at zero.
 *
 * ⚠ SLOPE IS READ BY LOCAL REGRESSION, NOT BY DIFFERENCING ADJACENT STEPS.
 * Plain differencing of 1 dB steps multiplies the capture noise by the step
 * size; measured on the parameter sensitivities it cost about 7x. A window of
 * `SLOPE_WINDOW_DB` fitted by least squares keeps the resolution the staircase
 * actually has without that.
 *
 * ⚠ AND IT READS THE LAW CONVOLVED WITH THE ATTACK, like every other staircase
 * measurement here. Our own kernel is run through the identical extractor and
 * printed beside the reference, so the comparison is like for like; the absolute
 * curve is not the static law and must not be quoted as one.
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PLANS, runKernel, CAP_DIR } from './fet-ballistics.mjs'
import { buildProbe } from './lib/probeStimulus.js'
import { stairCurve, knobsFromName } from './fet-stairs.mjs'
import { readCapture, preflight, alignByEnvelope, refineLagAtEdge } from './lib/probeCapture.js'
import { knobForDrive, SHIPPING_LAW } from './fet-allbuttons-fit.mjs'
import {
  ALL_INCR_AT_KNEE, ALL_INCR_FALL_PER_DB, ALL_INCR_FLOOR, ALL_KNEE_DB,
  allButtonsIncrSlope,
} from '../src/audio/fet1176Processor.js'

const DEFAULT_SR = 96000
const PLAN_NAME = 'stairs-fine.wav'

/** Regression window for the local slope, dB of level. */
export const SLOPE_WINDOW_DB = 5

/**
 * Reduction below which a point is inside the KNEE rather than on the ratio law.
 *
 * ⚠⚠ THE WHOLE REGRESSION WINDOW HAS TO CLEAR IT, NOT JUST THE POINT, and the
 * first version only checked the point. With a 5 dB window and a 16 dB knee, a
 * point sitting just above the guard still had half its window inside the bend,
 * so the fitted slope was a blend of the two — the self-test planted a family
 * spanning 0.750..0.950 and the extractor reported 0.272 at the low end, which
 * is knee, not law.
 *
 * ⚠ AND THE GUARD HAS TO BE HIGH ENOUGH FOR THE KNEE IN QUESTION. Ours is 16 dB
 * wide for all-buttons, so the bend reaches 8 dB above threshold and the ratio
 * law is only clean above roughly `slope * halfKnee` of reduction — about 7 dB.
 * A guard set for a 3 dB knee reads the bend and calls it the law.
 */
export const KNEE_GUARD_DB = 7

/**
 * Local slope of reduction against level, by least squares over a window.
 * Returns `{ levelDb, slope, grDb }` at every point with a full window.
 */
export function localSlopes(pts, windowDb = SLOPE_WINDOW_DB) {
  const out = []
  for (const p of pts) {
    const win = pts.filter(q => Math.abs(q.levelDb - p.levelDb) <= windowDb / 2
      && Number.isFinite(q.grDb))
    if (win.length < 3) continue
    const n = win.length
    const mx = win.reduce((a, q) => a + q.levelDb, 0) / n
    const my = win.reduce((a, q) => a + q.grDb, 0) / n
    let num = 0
    let den = 0
    for (const q of win) {
      num += (q.levelDb - mx) * (q.grDb - my)
      den += (q.levelDb - mx) ** 2
    }
    if (!(den > 0)) continue
    out.push({ levelDb: p.levelDb, slope: num / den, grDb: p.grDb })
  }
  return out
}

/** Linear interpolation of a slope curve at `x`, or null outside its span. */
export function slopeAt(curve, x) {
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]
    const b = curve[i]
    if (x >= a.levelDb && x <= b.levelDb) {
      const t = (x - a.levelDb) / (b.levelDb - a.levelDb || 1)
      return a.slope + t * (b.slope - a.slope)
    }
  }
  return null
}

/**
 * Shift every curve onto the first so they describe one function.
 *
 * ⚠ THE FIRST IS PINNED AT ZERO BECAUSE THE COMMON ORIGIN IS UNRECOVERABLE —
 * see the header. The offsets BETWEEN captures are real; their absolute value
 * is not, and nothing downstream may treat it as one.
 */
export function collapse(curves, span = 20) {
  const offsets = [0]
  for (let i = 1; i < curves.length; i++) {
    let best = null
    for (let d = -span; d <= span; d += 0.05) {
      let sum = 0
      let n = 0
      for (const p of curves[i]) {
        const other = slopeAt(curves[0], p.levelDb + d)
        if (other === null) continue
        sum += (p.slope - other) ** 2
        n++
      }
      if (n < 5) continue
      const rms = Math.sqrt(sum / n)
      if (!best || rms < best.rms) best = { d, rms, n }
    }
    offsets.push(best ? best.d : NaN)
  }
  return offsets
}

/** The shipping law's slope at an overshoot, for comparison. */
export function shippingSlope(overDb, law = SHIPPING_LAW) {
  return allButtonsIncrSlope(overDb, ALL_KNEE_DB / 2,
    law.allIncrAtKnee ?? ALL_INCR_AT_KNEE,
    law.allIncrFallPerDb ?? ALL_INCR_FALL_PER_DB,
    law.allIncrFloor ?? ALL_INCR_FLOOR)
}

function curveForFile(file, dir, sampleRate, plan, stim) {
  const { y } = readCapture(join(dir, file), sampleRate)
  const pre = preflight(file, y, plan, stim.env, sampleRate)
  for (const line of pre.lines) if (/⚠/.test(line)) console.log(`  ${file}: ${line.trim()}`)
  const coarse = alignByEnvelope(stim.env, y, sampleRate)
  const ref = refineLagAtEdge(y, stim.x, plan.events[0].up, sampleRate, coarse)
  return stairCurve(y, plan, stim, sampleRate, ref.lag)
}

/**
 * Slope curve for one capture.
 *
 * `minGrDb` drops the knee: a point survives only when EVERY member of its
 * regression window is above it — see `KNEE_GUARD_DB`. Pass 0 to keep the knee,
 * which is what the report does, because the bend's shape is part of what is
 * being looked at.
 */
export function shapeOf(pts, minGrDb = KNEE_GUARD_DB, windowDb = SLOPE_WINDOW_DB) {
  const slopes = localSlopes(pts, windowDb)
  return slopes.filter((p) => {
    const win = pts.filter(q => Math.abs(q.levelDb - p.levelDb) <= windowDb / 2
      && Number.isFinite(q.grDb))
    return win.length > 0 && Math.min(...win.map(q => q.grDb)) > minGrDb
  })
}

function printShape(label, merged) {
  console.log(`\n  ${label}`)
  console.log('    shifted level   slope    implied ratio')
  const step = Math.max(1, Math.round(merged.length / 14))
  for (let i = 0; i < merged.length; i += step) {
    const p = merged[i]
    const ratio = p.slope >= 1 ? Infinity : 1 / (1 - p.slope)
    console.log(`    ${p.levelDb.toFixed(1).padStart(12)}   ${p.slope.toFixed(4).padStart(6)}   ` +
      `${(Number.isFinite(ratio) ? ratio.toFixed(2) : 'inf').padStart(12)}`)
  }
}

function report(sampleRate, dir) {
  const plan = PLANS[PLAN_NAME]()
  const stim = buildProbe(plan, sampleRate)
  const files = existsSync(dir)
    ? readdirSync(dir).filter(f => /stairsfine|stairs-fine/i.test(f) && /\.wav$/i.test(f)).sort()
    : []
  const usable = files.filter(f => knobsFromName(f).ratio === 'all')
  if (!usable.length) {
    console.log(`\nNo all-buttons stairs-fine captures in ${dir}.`)
    console.log('Expected names like  cla76_stairsfine_rall_I1.wav\n')
    return
  }
  console.log(`\nFET Punch all-buttons SLOPE SHAPE — ${usable.length} capture(s) at ${sampleRate} Hz`)
  console.log(`Local slope by least squares over ${SLOPE_WINDOW_DB} dB; knee region (reduction`)
  console.log(`under ${KNEE_GUARD_DB} dB) dropped.\n`)

  const raw = usable.map(f => curveForFile(f, dir, sampleRate, plan, stim))
  // Knee kept for the printed shape — the bend is part of what is being read.
  const curves = raw.map(p => shapeOf(p, 0))
  const clean = raw.map(p => shapeOf(p, KNEE_GUARD_DB))
  const offsets = collapse(curves)
  console.log('  capture                          points   offset vs the first')
  usable.forEach((f, i) => {
    console.log(`  ${f.padEnd(32)} ${String(curves[i].length).padStart(6)}   ` +
      (i === 0 ? 'pinned at 0' : `${offsets[i] >= 0 ? '+' : ''}${offsets[i].toFixed(2)} dB`))
  })

  const merged = curves.flatMap((c, i) => c.map(p => ({ ...p, levelDb: p.levelDb + offsets[i] })))
    .sort((a, b) => a.levelDb - b.levelDb)
  printShape('THE SHAPE THE DATA WANTS (collapsed, axis origin arbitrary)', merged)

  /**
   * ⚠ THE COLLAPSE RESIDUAL IS THE FIRST THING TO READ. If four captures of one
   * law do not lie on one curve after a shift, the slope is not a function of
   * overshoot alone and no member of any family will fit them.
   */
  let sum = 0
  let n = 0
  for (let i = 1; i < curves.length; i++) {
    for (const p of curves[i]) {
      const other = slopeAt(curves[0], p.levelDb + offsets[i])
      if (other === null) continue
      sum += (p.slope - other) ** 2
      n++
    }
  }
  const collapseRms = n ? Math.sqrt(sum / n) : NaN
  console.log(`\n  COLLAPSE RESIDUAL: ${collapseRms.toFixed(4)} of slope over ${n} overlapping points`)
  console.log('    ⚠ Read this first. Four windows onto ONE law must lie on one curve after')
  console.log('      a shift. If they do not, slope is not a function of overshoot alone and')
  console.log('      no member of any family can fit them.')

  /**
   * ⚠ THE SPAN IS READ CLEAR OF THE KNEE, and the printed curve above is not.
   * A slope taken inside the bend is the bend, and comparing it against a ratio
   * family refutes the family for the wrong reason.
   */
  const cleanMerged = clean.flatMap((c, i) => c.map(p => ({ ...p, levelDb: p.levelDb + offsets[i] })))
  if (!cleanMerged.length) {
    console.log('\n  ⚠ NO POINT CLEARS THE KNEE GUARD — every capture is inside the bend, so')
    console.log('    these captures say nothing about the ratio law. Drive harder or extend')
    console.log('    the staircase upward.')
    console.log()
    return
  }
  const slopes = cleanMerged.map(p => p.slope)
  const lo = Math.min(...slopes)
  const hi = Math.max(...slopes)
  console.log(`\n  (span read from ${cleanMerged.length} points clear of the ${KNEE_GUARD_DB} dB knee guard)`)
  console.log(`\n  SLOPE RANGE: ${lo.toFixed(4)} to ${hi.toFixed(4)}` +
    `  (ratio ${(1 / (1 - lo)).toFixed(2)} to ${(1 / (1 - hi)).toFixed(2)})`)
  const ourHi = shippingSlope(ALL_KNEE_DB / 2)
  const ourLo = shippingSlope(1e6)
  console.log(`  OUR LAW spans ${ourLo.toFixed(4)} to ${ourHi.toFixed(4)}` +
    `  (ratio ${(1 / (1 - ourLo)).toFixed(1)} to ${(1 / (1 - ourHi)).toFixed(1)}, falling` +
    ` ${ALL_INCR_FALL_PER_DB} of slope per dB above the knee)`)
  console.log('    ⚠ If the measured range sits outside what the family can reach, the family')
  console.log('      is refuted whatever its parameters — which is the cheapest possible')
  console.log('      verdict and needs no fit at all.')

  /**
   * ⚠⚠ AND THIS IS WHY `allRatioMin` WAS NEVER FITTABLE. It is the slope as
   * overshoot goes to zero — and with a 16 dB knee, everything below +8 dB of
   * overshoot is bend. The guard that keeps the bend out of the slope reading
   * also removes the entire region that determines the ratio floor, so the
   * captures can only ever see the SATURATED end of the law.
   *
   * ⚠ WHICH MEANS THE KNEE AND THE RATIO LAW ARE ENTANGLED, not independent
   * unknowns: assuming a wide knee hides the evidence about the floor, and
   * CLA-76's coarse captures already say its knee is far narrower than our 16.
   * Fit the knee first and more of the law comes into view.
   */
  const kneeFraction = 1 - cleanMerged.length / merged.length
  console.log(`\n  ${(kneeFraction * 100).toFixed(0)} % of the measured curve is inside the knee guard.`)
  console.log('    ⚠ THIS IS WHY allRatioMin CANNOT BE FITTED. It is the slope at zero')
  console.log('      overshoot, and a 16 dB knee buries that whole region — the guard that')
  console.log('      keeps the bend out of the reading removes the evidence about the floor')
  console.log('      with it, leaving only the saturated end of the law visible. The knee and')
  console.log('      the ratio law are entangled, not independent: CLA-76\'s coarse captures')
  console.log('      already say its knee is far narrower than ours, and a narrower knee')
  console.log('      uncovers more of the law.')

  // Our own kernel through the identical extractor, at the same drives.
  const ourCurves = [0, 5, 10, 15].map((d) => {
    const { y } = runKernel(stim.x, sampleRate,
      { inputDrive: knobForDrive(d), ratio: 'all', attack: 7, release: 7, fetDrive: 0 })
    return shapeOf(stairCurve(y, plan, stim, sampleRate, 0))
  })
  const ourOffsets = collapse(ourCurves)
  const ourMerged = ourCurves.flatMap((c, i) => c.map(p => ({ ...p, levelDb: p.levelDb + ourOffsets[i] })))
    .sort((a, b) => a.levelDb - b.levelDb)
  printShape('OURS, through the identical extractor (the control)', ourMerged)
  const ourSlopes = ourMerged.map(p => p.slope)
  console.log(`\n  ours spans ${Math.min(...ourSlopes).toFixed(4)} to ${Math.max(...ourSlopes).toFixed(4)}`)
  console.log()
}

function selftest(sampleRate) {
  console.log('\nAll-buttons shape extractor self-test\n')
  let bad = 0
  const ok = (label, cond) => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : '⚠ FAIL'}  ${label}`) }
  const plan = PLANS[PLAN_NAME]()
  const stim = buildProbe(plan, sampleRate)

  // A straight line has one slope everywhere, whatever the window.
  const line = Array.from({ length: 30 }, (_, i) => ({ levelDb: -30 + i, grDb: 0.8 * (-30 + i) }))
  const ls = localSlopes(line)
  ok('a straight line reads one slope everywhere',
    ls.every(p => Math.abs(p.slope - 0.8) < 1e-9))

  /**
   * ⚠ THE REAL TEST: plant a law, extract, and see the shape come back. The
   * extractor reads the law convolved with the attack, so this checks the SHAPE
   * and its span rather than demanding the static law exactly.
   */
  const law = { ...SHIPPING_LAW, allIncrAtKnee: 0.95, allIncrFallPerDb: 0.008, allIncrFloor: 0.75 }
  const curves = [0, 5, 10, 15].map((d) => {
    const { y } = runKernel(stim.x, sampleRate,
      { inputDrive: knobForDrive(d), ratio: 'all', attack: 7, release: 7, fetDrive: 0, ...law })
    return shapeOf(stairCurve(y, plan, stim, sampleRate, 0))
  })
  ok('every capture yields a usable slope curve', curves.every(c => c.length > 8))

  const offsets = collapse(curves)
  /**
   * ⚠ THE SIGN IS POSITIVE AND THE FIRST VERSION OF THIS TEST EXPECTED NEGATIVE.
   * More drive puts the same overshoot at a LOWER level, so mapping a
   * higher-drive capture onto the first shifts its level axis UP by the drive
   * difference. The magnitudes were right the whole time; the expectation was
   * not, which is exactly the sort of thing this file exists to keep honest.
   */
  console.log(`  recovered offsets: ${offsets.map(o => o.toFixed(2)).join(' / ')}  (true 0 / +5 / +10 / +15)`)
  ok('the drive offsets are recovered from the shape alone',
    offsets.slice(1).every((o, i) => Math.abs(o - 5 * (i + 1)) < 1.5))

  let sum = 0
  let n = 0
  for (let i = 1; i < curves.length; i++) {
    for (const p of curves[i]) {
      const other = slopeAt(curves[0], p.levelDb + offsets[i])
      if (other === null) continue
      sum += (p.slope - other) ** 2
      n++
    }
  }
  const rms = Math.sqrt(sum / n)
  console.log(`  collapse residual on a law that IS one function of overshoot: ${rms.toFixed(4)}`)
  ok('a true single law collapses tightly', rms < 0.02)

  const merged = curves.flatMap((c, i) => c.map(p => ({ ...p, levelDb: p.levelDb + offsets[i] })))
  ok('points clear of the knee guard survive at all', merged.length > 8)
  const lo = Math.min(...merged.map(p => p.slope))
  const hi = Math.max(...merged.map(p => p.slope))
  console.log(`  slope span recovered ${lo.toFixed(4)}..${hi.toFixed(4)}` +
    `, planted family spans ${shippingSlope(0.001, law).toFixed(4)}..${shippingSlope(1e6, law).toFixed(4)}`)
  ok('the recovered span sits inside the planted law, as it must',
    lo > law.allIncrFloor - 0.02 && hi < law.allIncrAtKnee + 0.02)
  /**
   * ⚠ AND IT MUST COME BACK FALLING. The whole reason the law was replaced is
   * that the old one climbed with overshoot and the reference does the
   * opposite; an extractor that cannot see the direction would not have caught
   * it, and would not catch a regression back to a climbing law either.
   */
  const first = merged.slice(0, 4).reduce((a, p) => a + p.slope, 0) / 4
  const last = merged.slice(-4).reduce((a, p) => a + p.slope, 0) / 4
  console.log(`  slope over the sweep: ${first.toFixed(4)} -> ${last.toFixed(4)}`)
  ok('a planted FALLING law is recovered as falling', last < first - 0.01)

  console.log(`\n  ${bad === 0 ? 'PASS' : `⚠ ${bad} FAILED`}\n`)
  return bad
}

if (basename(process.argv[1] ?? '') === 'fet-allbuttons-shape.mjs') {
  const args = process.argv.slice(2)
  const rateArg = args.indexOf('--rate')
  const sr = rateArg >= 0 && args[rateArg + 1] ? Number(args[rateArg + 1]) : DEFAULT_SR
  const dirArg = args.indexOf('--dir')
  const dir = dirArg >= 0 && args[dirArg + 1] ? args[dirArg + 1] : CAP_DIR
  if (args.includes('--selftest')) process.exit(selftest(44100) === 0 ? 0 : 1)
  else report(sr, dir)
}
