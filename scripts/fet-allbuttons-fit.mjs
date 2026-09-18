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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLANS, runKernel, CAP_DIR } from './fet-ballistics.mjs'
import { buildProbe } from './lib/probeStimulus.js'
import { stairCurve, knobsFromName } from './fet-stairs.mjs'
import { readCapture, preflight, alignByEnvelope, refineLagAtEdge } from './lib/probeCapture.js'
import {
  ALL_KNEE_DB, ALL_THRESHOLD_DROP_DB, ALL_RATIO_MIN, ALL_RATIO_SPAN, ALL_RATIO_HALF_DB,
  inputDriveDbForKnob,
} from '../src/audio/fet1176Processor.js'

const HERE = dirname(fileURLToPath(import.meta.url))
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
 * The constants an all-buttons-only capture set determines.
 *
 * ⚠⚠ IT IS EMPTY, AND `allThresholdDropDb` WAS IN IT UNTIL THE DEGENERACY WAS
 * CHECKED RATHER THAN ASSUMED. The kernel computes
 * `over = level + drive - (THRESHOLD - drop)`, so **drive and drop enter as a
 * sum**: raise the drive 1 dB and lower the drop 1 dB and the curve is
 * bit-identical — measured at 0.0000 dB rms across a 4 dB range of the pair.
 * A capture at an unknown Input position therefore constrains `drive + drop`
 * and neither term alone.
 *
 * This tool reported a fitted 0.750 dB drop on real captures before that was
 * caught. The number was pure artefact: it was whatever made up the difference
 * against `estimateDrive`'s guess, which is itself quantised to the staircase's
 * 1 dB step and depends on the very law being fitted.
 *
 * ⚠ THE DROP IS MEASURABLE, JUST NOT HERE. It is defined against the NORMAL
 * buttons' threshold, so it needs all-buttons and a normal button at the SAME
 * Input knob position — which is exactly what the coarse `stairs.wav` matrix
 * already captures (five ratios at each of I1-I4). See `thresholdDropFromCoarse`.
 */
export const IDENTIFIABLE = []

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

/**
 * The all-buttons threshold drop, from the COARSE stairs matrix — the only
 * place it is measurable, because it needs all-buttons and a normal button at
 * the SAME Input knob position so the drive cancels between them.
 *
 * ⚠ THE CONVENTION IS IRREDUCIBLY AMBIGUOUS AND THAT IS A FINDING, NOT A GAP.
 * Our model holds ONE threshold for all four normal buttons; CLA-76's moves
 * with the button, by 4.5 dB end to end. So "how far below the normal
 * threshold" has no single answer — it depends which normal button you call
 * the reference, and the three defensible choices disagree by 2.7 dB. All three
 * are returned rather than one being picked silently.
 *
 * @param rows `{ ratio, input, effThresholdDb }` from a coarse stairs run
 */
export function thresholdDropFromCoarse(rows) {
  const byInput = new Map()
  for (const r of rows) {
    if (!byInput.has(r.input)) byInput.set(r.input, [])
    byInput.get(r.input).push(r)
  }
  const out = []
  for (const [input, group] of [...byInput].sort((a, b) => a[0] - b[0])) {
    const all = group.find(r => String(r.ratio).toLowerCase() === 'all')
    const normal = group.filter(r => String(r.ratio).toLowerCase() !== 'all')
    if (!all || normal.length < 2) continue
    const byRatio = Object.fromEntries(normal.map(r => [String(r.ratio), r.effThresholdDb]))
    const mean = normal.reduce((a, r) => a + r.effThresholdDb, 0) / normal.length
    out.push({
      input,
      vsLowestRatio: byRatio['4'] - all.effThresholdDb,
      vsMeanOfNormal: mean - all.effThresholdDb,
      vsRatio12: byRatio['12'] - all.effThresholdDb,
    })
  }
  return out
}

/** The coarse stairs fits, if they have been kept. */
export function loadCoarse(path = null) {
  const file = path ?? join(HERE, '..', 'data', 'fet1176', 'cla76_stairs_fits.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
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
 * ⚠ A ROUGH DRIVE ESTIMATE, AND IT CANNOT BE REFINED AWAY. The lowest step
 * showing measurable reduction, so it is quantised to the staircase's step
 * (1 dB) and depends on the knee it is trying to help measure. That is
 * tolerable for POSITIONING the curves and fatal for anything that trades
 * against it — see `IDENTIFIABLE` for why the threshold drop is no longer
 * fitted here.
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
  console.log(`\n  curve rms against the SHIPPING law : ${sens.base.toFixed(3)} dB`)

  console.log('\n  WHAT THESE CAPTURES CAN DETERMINE')
  console.log('  constant                probe   curve moves')
  for (const key of Object.keys(BOUNDS)) {
    console.log(`  ${key.padEnd(22)} +/-${String(PROBE_DELTA[key]).padEnd(4)} ${sens.moves[key].toFixed(3).padStart(10)} dB`)
  }

  /**
   * ⚠⚠ NOTHING IS FITTED FROM THESE, AND THE TOOL USED TO FIT ONE THING FROM
   * THEM. See `IDENTIFIABLE`: drive and threshold drop enter the law as a sum,
   * so an all-buttons capture at an unknown Input constrains only their total.
   * The 0.750 dB drop an earlier version reported here was whatever made up the
   * difference against a 1 dB-quantised drive guess.
   */
  console.log('\n  ⚠ NOTHING IS INSTALLABLE FROM THESE CAPTURES.')
  console.log('    allThresholdDropDb is DEGENERATE with the Input drive — the kernel reads')
  console.log('    `over = level + drive - (THRESHOLD - drop)`, so raising the drive 1 dB and')
  console.log('    lowering the drop 1 dB is bit-identical (0.0000 dB rms, measured). An')
  console.log('    all-buttons capture at an unknown Input pins only `drive + drop`.')
  console.log('    The other four barely move the curve at all — see the table above.')

  const coarse = loadCoarse()
  if (coarse) {
    console.log('\n  THE DROP, FROM THE COARSE MATRIX — where all-buttons and the normal')
    console.log('  buttons share an Input position, so the drive cancels between them:')
    console.log('    Input   vs ratio 4   vs mean of four   vs ratio 12')
    for (const r of thresholdDropFromCoarse(coarse.captures)) {
      console.log(`     I${r.input}   ${r.vsLowestRatio.toFixed(2).padStart(9)}` +
        `${r.vsMeanOfNormal.toFixed(2).padStart(18)}${r.vsRatio12.toFixed(2).padStart(14)}`)
    }
    console.log(`    ours: ${SHIPPING_LAW.allThresholdDropDb.toFixed(2)} dB — larger than every convention.`)
    console.log('    ⚠ THE CONVENTION IS IRREDUCIBLY AMBIGUOUS. Our model holds ONE threshold')
    console.log('      for all four normal buttons and CLA-76\'s moves with the button by 4.5 dB,')
    console.log('      so the three columns disagree by 2.7 dB and none is more correct.')
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

  /**
   * ⚠⚠ THE DEGENERACY IS THE HEADLINE ASSERTION. Drive and threshold drop enter
   * the law as a sum, so moving one up and the other down by the same amount is
   * the SAME CURVE. This is what stopped the tool fitting a drop it could not
   * measure; if the kernel ever separates them, this fails and the tool can
   * start fitting it again.
   */
  const ref = ourCurve(sampleRate, plan, stim, 4, SHIPPING_LAW)
  const oneAloneProbe = curveRms(ref, ourCurve(sampleRate, plan, stim, 5, SHIPPING_LAW))
  let worstTied = 0
  for (const d of [-2, -1, 1, 2]) {
    const moved = ourCurve(sampleRate, plan, stim, 4 + d,
      { ...SHIPPING_LAW, allThresholdDropDb: SHIPPING_LAW.allThresholdDropDb - d })
    worstTied = Math.max(worstTied, curveRms(ref, moved))
  }
  /**
   * ⚠ NOT `=== 0`, AND THE FIRST VERSION WAS. `knobForDrive` bisects, so the
   * drive it lands on is within ~1e-15 of the one asked for rather than exactly
   * it, and the curve carries that through — measured, 3.65e-7 dB. The bar is
   * set six orders of magnitude under the 0.797 dB that moving EITHER ALONE
   * produces, so it still cannot pass by accident; the claim is that the pair is
   * degenerate, not that floating point is exact.
   */
  console.log(`\n  drive/drop tied, worst curve rms: ${worstTied.toExponential(2)} dB` +
    `  (moving one alone: ${oneAloneProbe.toFixed(3)} dB)`)
  ok('drive and threshold drop are the SAME knob to this curve', worstTied < 1e-5)
  ok('...while moving either alone does change it', oneAloneProbe > 0.5)
  ok('so nothing is declared identifiable from these captures', IDENTIFIABLE.length === 0)

  const sens = sensitivity(targets, sampleRate, plan, stim, truth)
  console.log('\n  constant                probe   curve moves')
  for (const key of Object.keys(BOUNDS)) {
    console.log(`  ${key.padEnd(22)} +/-${String(PROBE_DELTA[key]).padEnd(4)} ${sens.moves[key].toFixed(3).padStart(10)} dB`)
  }
  ok('the ratio triple and the knee stay far less sensitive than the drop',
    Math.max(sens.moves.allKneeDb, sens.moves.allRatioSpan, sens.moves.allRatioHalfDb)
      < sens.moves.allThresholdDropDb)

  // The coarse path is the one that CAN answer, so it must stay wired up.
  const coarse = loadCoarse()
  ok('the coarse stairs fits are kept in the repo', coarse !== null)
  if (coarse) {
    const drops = thresholdDropFromCoarse(coarse.captures)
    ok('the drop is recoverable from them at every Input position', drops.length === 4)
    ok('and is far below our 6 dB under every convention',
      drops.every(d => d.vsRatio12 < 4 && d.vsLowestRatio < 1))
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
