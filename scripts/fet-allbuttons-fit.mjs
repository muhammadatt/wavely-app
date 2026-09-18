/**
 * Run with:  npm run fet:allbuttons -- --dir <captures>     (--selftest for guards)
 *
 * FITS THE ALL-BUTTONS STATIC LAW from `stairs-fine.wav` captures.
 *
 * ⚠⚠ ALL FIVE CONSTANTS IT FITS ARE CURRENTLY GUESSES. `ALL_KNEE_DB` (16),
 * `ALL_THRESHOLD_DROP_DB` (6) and the soft `ALL_RATIO_MIN` / `SPAN` / `HALF_DB`
 * triple were chosen to reproduce a DESCRIBED behaviour and have never been
 * measured. CLA-76's coarse stairs already say the first two are too big: its
 * all-buttons knee reads under the instrument's floor where ours reads 16, and
 * its threshold sits 0.54 / 2.65 / 3.24 dB below its own ratio 4 / the mean of
 * four / ratio 12 against our 6.
 *
 * ⚠ WHY THE COARSE STAIRS FITTER CANNOT DO THIS. `fet-stairs.mjs` fits three
 * parameters — threshold, ONE slope, knee — to a staircase. The all-buttons law
 * has no single slope: its effective ratio climbs with overshoot ALONG the
 * curve, which a single fitted slope averages away. So this fits the WHOLE
 * CURVE instead, point by point, and needs the 1 dB staircase's 34 samples
 * through the bend rather than the coarse plan's 15.
 *
 * ⚠ AND IT IS SIMULATE-AND-MATCH, like every other constant in this re-tune.
 * The staircase measures the law convolved with the attack, so the curve a
 * capture shows is not the law; our kernel is driven through the identical
 * analysis until it reproduces the reference's curve, and what is installed is
 * the law that did it.
 *
 * ⚠⚠ AND FOUR OF THE FIVE ARE NOT IDENTIFIABLE FROM THIS STIMULUS — which the
 * self-test found by planting a known law and failing to get it back. The fit
 * reproduced the CURVE to 0.207 dB while returning a knee of 2.33 for a planted
 * 6, a ratio floor of 2.56 for a planted 10, and a half-point pinned to its
 * bound. Measured sensitivity, perturbing the planted law one constant at a
 * time:
 *
 *   allThresholdDropDb  +/-1 dB  ->  0.78 dB of curve rms   <- determined
 *   allKneeDb           +/-3 dB  ->  0.09-0.11
 *   allRatioMin         +/-4     ->  0.07-0.20
 *   allRatioSpan        +/-6     ->  0.06-0.17
 *   allRatioHalfDb      +/-6     ->  0.03-0.07              <- nearly flat
 *
 * A constant whose whole plausible range moves the curve less than the fit's
 * own residual is not measured by the data, and printing a number for it would
 * be exactly the "dressing a guess as a fit" this file was written to avoid.
 * So the tool FITS the threshold drop, REPORTS the sensitivity of the rest, and
 * refuses to hand back values it cannot support.
 *
 * ⚠ THIS IS A PROPERTY OF THE STIMULUS, NOT OF THE SEARCH. A better optimiser
 * finds the same flat valley faster. Separating the ratio triple needs material
 * that sweeps overshoot independently of level — which the staircase, where the
 * two move together by construction, cannot do.
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PLANS, runKernel, CAP_DIR } from './fet-ballistics.mjs'
import { buildProbe } from './lib/probeStimulus.js'
import { stairCurve, knobsFromName } from './fet-stairs.mjs'
import { readCapture, preflight, alignByEnvelope, refineLagAtEdge } from './lib/probeCapture.js'
import {
  ALL_KNEE_DB, ALL_THRESHOLD_DROP_DB, ALL_RATIO_MIN, ALL_RATIO_SPAN, ALL_RATIO_HALF_DB,
  inputDriveDbForKnob,
} from '../src/audio/fet1176Processor.js'

const DEFAULT_SR = 96000
const PLAN_NAME = 'stairs-fine.wav'

export const SHIPPING_LAW = {
  allKneeDb: ALL_KNEE_DB,
  allThresholdDropDb: ALL_THRESHOLD_DROP_DB,
  allRatioMin: ALL_RATIO_MIN,
  allRatioSpan: ALL_RATIO_SPAN,
  allRatioHalfDb: ALL_RATIO_HALF_DB,
}

/**
 * The constants the curve actually determines. Everything else is reported with
 * its sensitivity and left alone — see the header.
 */
export const IDENTIFIABLE = ['allThresholdDropDb']

/** A perturbation big enough to matter musically, per constant. */
export const PROBE_DELTA = {
  allKneeDb: 3,
  allThresholdDropDb: 1,
  allRatioMin: 4,
  allRatioSpan: 6,
  allRatioHalfDb: 6,
}

/** Search bounds. Wide, because none of the five has a measurement behind it. */
export const BOUNDS = {
  allKneeDb: [0.5, 20],
  allThresholdDropDb: [-2, 12],
  allRatioMin: [2, 20],
  allRatioSpan: [0, 40],
  allRatioHalfDb: [1, 40],
}

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

/** Our all-buttons curve at a drive, through the capture's own analysis. */
export function ourCurve(sampleRate, plan, stim, driveDb, law) {
  const { y } = runKernel(stim.x, sampleRate, {
    inputDrive: knobForDrive(driveDb),
    ratio: 'all',
    attack: 7,
    release: 7,
    fetDrive: 0,
    ...law,
  })
  return stairCurve(y, plan, stim, sampleRate, 0)
}

/**
 * rms difference between two curves, in dB of gain reduction.
 *
 * ⚠ COMPARED POINT BY POINT ON LEVEL, NOT AS FITTED PARAMETERS. That is the
 * whole reason this file exists — see the header.
 */
export function curveRms(a, b) {
  const byLevel = new Map(b.map(p => [p.levelDb, p.grDb]))
  let sum = 0
  let n = 0
  for (const p of a) {
    const other = byLevel.get(p.levelDb)
    if (!Number.isFinite(p.grDb) || !Number.isFinite(other)) continue
    sum += (p.grDb - other) ** 2
    n++
  }
  return n ? Math.sqrt(sum / n) : Infinity
}

/**
 * Coordinate descent over the five, each on a shrinking bracket.
 *
 * ⚠ NOT A GRADIENT METHOD, AND NOT ONE PASS. `allRatioSpan` and
 * `allRatioHalfDb` trade against each other almost exactly — a wider span with
 * a later half-point is nearly the same curve — so a single sweep lands
 * wherever it started. Repeated passes with a shrinking step do not fix that
 * degeneracy, they just stop it mattering: the pair is reported together and
 * neither number means much alone.
 */
export function costOf(targets, sampleRate, plan, stim, candidate) {
  let sum = 0
  for (const t of targets) sum += curveRms(t.pts, ourCurve(sampleRate, plan, stim, t.driveDb, candidate)) ** 2
  return Math.sqrt(sum / targets.length)
}

/**
 * How much the curve moves when each constant is perturbed by `PROBE_DELTA`.
 * The output that decides whether any of them may be installed.
 */
export function sensitivity(targets, sampleRate, plan, stim, law) {
  const base = costOf(targets, sampleRate, plan, stim, law)
  const out = {}
  for (const [key, delta] of Object.entries(PROBE_DELTA)) {
    const [lo, hi] = BOUNDS[key]
    const worst = [-delta, delta].map((d) => {
      const v = Math.min(hi, Math.max(lo, law[key] + d))
      return Math.abs(costOf(targets, sampleRate, plan, stim, { ...law, [key]: v }) - base)
    })
    out[key] = Math.max(...worst)
  }
  return { base, moves: out }
}

export function fitLaw(targets, sampleRate, plan, stim, { rounds = 6, start = SHIPPING_LAW, keys = IDENTIFIABLE } = {}) {
  let law = { ...start }
  const cost = (candidate) => costOf(targets, sampleRate, plan, stim, candidate)
  let best = cost(law)
  let frac = 0.5
  for (let r = 0; r < rounds; r++) {
    for (const key of keys) {
      const [lo, hi] = BOUNDS[key]
      const step = (hi - lo) * frac
      for (const dir of [-1, 1]) {
        const v = Math.min(hi, Math.max(lo, law[key] + dir * step))
        if (v === law[key]) continue
        const c = cost({ ...law, [key]: v })
        if (c < best) { best = c; law = { ...law, [key]: v } }
      }
    }
    frac /= 2
  }
  return { law, rms: best }
}

function loadTargets(dir, sampleRate, plan, stim) {
  const files = existsSync(dir)
    ? readdirSync(dir).filter(f => /stairsfine|stairs-fine/i.test(f) && /\.wav$/i.test(f)).sort()
    : []
  const targets = []
  for (const file of files) {
    const knobs = knobsFromName(file)
    if (knobs.unparsed || knobs.ratio !== 'all') continue
    const { y } = readCapture(join(dir, file), sampleRate)
    const pre = preflight(file, y, plan, stim.env, sampleRate)
    for (const line of pre.lines) if (/⚠/.test(line)) console.log(`  ${file}: ${line.trim()}`)
    const coarse = alignByEnvelope(stim.env, y, sampleRate)
    const ref = refineLagAtEdge(y, stim.x, plan.events[0].up, sampleRate, coarse)
    targets.push({ file, input: knobs.input, pts: stairCurve(y, plan, stim, sampleRate, ref.lag) })
  }
  return targets
}

/**
 * ⚠ THE DRIVE IS RECOVERED FROM THE CAPTURE, NOT ASSUMED FROM THE KNOB. The
 * reference's Input positions are its own; what puts the two kernels in
 * correspondence is where the bend sits, which is an absolute level. Estimated
 * here as the lowest step showing measurable reduction, refined by the fit.
 */
export function estimateDrive(pts, thresholdDbfs = -18) {
  const first = pts.find(p => Number.isFinite(p.grDb) && p.grDb > 0.5)
  return first ? thresholdDbfs - first.levelDb : 0
}

function report(sampleRate, dir) {
  const plan = PLANS[PLAN_NAME]()
  const stim = buildProbe(plan, sampleRate)
  const targets = loadTargets(dir, sampleRate, plan, stim)
  if (!targets.length) {
    console.log(`\nNo all-buttons stairs-fine captures in ${dir}.`)
    console.log('Expected names like  cla76_stairsfine_rall_I1.wav')
    console.log('Generate the stimulus with  npm run fet:stimulus\n')
    return
  }
  for (const t of targets) t.driveDb = estimateDrive(t.pts)

  console.log(`\nFET Punch all-buttons static law — ${targets.length} capture(s) at ${sampleRate} Hz\n`)
  console.log('  capture                          est drive   points')
  for (const t of targets) {
    console.log(`  ${t.file.padEnd(32)} ${t.driveDb.toFixed(2).padStart(9)}   ${t.pts.length}`)
  }

  const sens = sensitivity(targets, sampleRate, plan, stim, SHIPPING_LAW)
  const { law, rms } = fitLaw(targets, sampleRate, plan, stim)

  console.log(`\n  curve rms against the SHIPPING law : ${sens.base.toFixed(3)} dB`)
  console.log(`  curve rms after fitting ${IDENTIFIABLE.join(', ')} : ${rms.toFixed(3)} dB`)

  /**
   * ⚠ THE SENSITIVITY TABLE IS THE POINT, NOT THE FITTED NUMBERS. A constant
   * whose whole plausible range moves the curve less than the residual the fit
   * settles at is not determined by this data, and a number for it would be a
   * guess with a decimal point on it.
   */
  console.log('\n  WHAT THIS DATA CAN AND CANNOT DETERMINE')
  console.log('  constant                probe   curve moves   verdict')
  for (const key of Object.keys(BOUNDS)) {
    const move = sens.moves[key]
    const determined = move > Math.max(rms, 0.1) * 3
    console.log(`  ${key.padEnd(22)} +/-${String(PROBE_DELTA[key]).padEnd(4)} ${move.toFixed(3).padStart(10)} dB   ` +
      (determined ? 'determined' : '⚠ NOT determined by this stimulus'))
  }

  console.log('\n  constant                shipping      fitted')
  for (const key of Object.keys(BOUNDS)) {
    const fitted = IDENTIFIABLE.includes(key) ? law[key].toFixed(3) : '— held'
    console.log(`  ${key.padEnd(22)} ${String(SHIPPING_LAW[key]).padStart(8)}  ${String(fitted).padStart(10)}`)
  }
  console.log('\n  ⚠ ONLY THE "determined" ROWS MAY BE INSTALLED. The rest are held at their')
  console.log('    shipping values because the curve does not distinguish them — separating')
  console.log('    the ratio triple needs material that sweeps overshoot independently of')
  console.log('    level, which a staircase cannot do.')

  if (targets.length >= 3) {
    const held = targets[Math.floor(targets.length / 2)]
    const rest = targets.filter(t => t !== held)
    const { law: lawH } = fitLaw(rest, sampleRate, plan, stim)
    const heldRms = curveRms(held.pts, ourCurve(sampleRate, plan, stim, held.driveDb, lawH))
    console.log(`\n  HELD OUT — fitted without ${held.file}`)
    console.log(`    ${IDENTIFIABLE[0]} ${lawH[IDENTIFIABLE[0]].toFixed(3)} against ${law[IDENTIFIABLE[0]].toFixed(3)} on everything`)
    console.log(`    its curve rms under that law: ${heldRms.toFixed(3)} dB`)
  } else {
    console.log('\n  ⚠ TOO FEW CAPTURES TO HOLD ONE OUT.')
  }
  console.log()
}

function selftest(sampleRate) {
  console.log('\nAll-buttons fit self-test\n')
  let bad = 0
  const ok = (label, cond) => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : '⚠ FAIL'}  ${label}`) }
  const plan = PLANS[PLAN_NAME]()
  const stim = buildProbe(plan, sampleRate)

  ok('the fine plan is the 1 dB one', plan.stepDb === 1 && plan.events.length > 30)

  // Recover a known law from our own kernel — the only ground truth available.
  const truth = { ...SHIPPING_LAW, allKneeDb: 6, allThresholdDropDb: 3, allRatioMin: 10 }
  const targets = [-2, 6, 14].map(driveDb => ({
    driveDb, pts: ourCurve(sampleRate, plan, stim, driveDb, truth),
  }))
  const selfRms = curveRms(targets[0].pts, ourCurve(sampleRate, plan, stim, -2, truth))
  ok('a curve compared with itself is exactly zero', selfRms === 0)

  const { law, rms } = fitLaw(targets, sampleRate, plan, stim, { rounds: 5 })
  const shippingRms = costOf(targets, sampleRate, plan, stim, SHIPPING_LAW)
  console.log(`\n  planted law recovered to ${rms.toFixed(3)} dB rms, from ${shippingRms.toFixed(3)} at the start`)
  ok('the fit improves on the starting law', rms < shippingRms)
  ok('it recovers the planted threshold drop', Math.abs(law.allThresholdDropDb - truth.allThresholdDropDb) < 1)

  /**
   * ⚠⚠ THE NON-IDENTIFIABILITY IS ASSERTED, NOT WORKED AROUND. This is the
   * finding: four of the five constants barely move the curve, so the tool must
   * keep refusing to report them. If a future stimulus DOES determine them this
   * test fails — which is the right way to find that out.
   */
  const sens = sensitivity(targets, sampleRate, plan, stim, truth)
  console.log('\n  constant                probe   curve moves')
  for (const key of Object.keys(BOUNDS)) {
    console.log(`  ${key.padEnd(22)} +/-${String(PROBE_DELTA[key]).padEnd(4)} ${sens.moves[key].toFixed(3).padStart(10)} dB`)
  }
  ok('the threshold drop is the one the curve is sensitive to',
    sens.moves.allThresholdDropDb > 0.4)
  for (const key of ['allKneeDb', 'allRatioMin', 'allRatioSpan', 'allRatioHalfDb']) {
    ok(`${key} is NOT determined by this stimulus`, sens.moves[key] < 0.25)
  }
  console.log(`\n  ${bad === 0 ? 'PASS' : `⚠ ${bad} FAILED`}\n`)
  return bad
}

if (basename(process.argv[1] ?? '') === 'fet-allbuttons-fit.mjs') {
  const args = process.argv.slice(2)
  const rateArg = args.indexOf('--rate')
  const sr = rateArg >= 0 && args[rateArg + 1] ? Number(args[rateArg + 1]) : DEFAULT_SR
  const dirArg = args.indexOf('--dir')
  const dir = dirArg >= 0 && args[dirArg + 1] ? args[dirArg + 1] : CAP_DIR
  if (args.includes('--selftest')) process.exit(selftest(44100) === 0 ? 0 : 1)
  else report(sr, dir)
}
