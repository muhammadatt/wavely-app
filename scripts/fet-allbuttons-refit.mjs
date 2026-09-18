/**
 * Run with:  npm run fet:allrefit        (add --selftest for the guards)
 *
 * PINS THE ALL-BUTTONS KNEE, THRESHOLD DROP AND RATIO LAW FROM THE CAPTURES
 * ALREADY TAKEN. No new bounce, and none possible — this reads only the two
 * persisted reading files, and renders OUR kernel to compare against them.
 *
 * ⚠⚠ WHY THIS IS POSSIBLE NOW AND WAS NOT BEFORE. The blocker on the threshold
 * drop was never arithmetic, it was a CONVENTION: the drop is measured against a
 * normal button, our model held ONE threshold for all four of them, and CLA-76's
 * moved 4.5 dB across them — so "below ratio 4" and "below the mean of four" were
 * different numbers (0.54 / 2.65 / 3.24) with nothing to choose between them.
 * Shipping the moving threshold anchored at 4:1 settles it: our threshold family
 * IS CLA-76's family now, so the reference button is ratio 4 and the drop is one
 * number.
 *
 * ⚠ THE DROP IS DEGENERATE WITH THE INPUT DRIVE WITHIN ONE CAPTURE — the kernel
 * reads `over = level + drive - (THRESHOLD - drop)`, so the two enter as a sum.
 * It is recoverable only ACROSS buttons at one Input position, where the drive is
 * common and cancels in the difference. That is the whole measurement.
 *
 * ⚠⚠ AND IT RESTS ON THE INPUT KNOB NOT HAVING BEEN RE-DIALLED PER BUTTON. The
 * protocol sets the four Input positions once, on ratio 4, by their reduction —
 * so this has to be checked, not assumed. FETish's sixteen captures check it:
 * its effective threshold reads IDENTICALLY across its four buttons at every
 * position (0.00 dB of spread). Had the operator re-dialled for a target
 * reduction, ratio 20 would have needed far less drive than ratio 4 and the
 * spread could not be zero. Same operator, same session, same procedure for
 * CLA-76 — so its cross-button differences are threshold, not knob.
 *
 * WHAT IS FITTED, AND AGAINST WHAT:
 *
 *   ALL_KNEE_DB + the incremental ratio law  ->  the collapsed SHAPE
 *     (`cla76_allbuttons_shape.json`). The shape is invariant to the axis
 *     origin, which is the one thing a staircase cannot give, so this fit does
 *     not need the drop — and the rising left limb of the curve IS the bend,
 *     which is what makes the knee width readable at all.
 *
 *   ALL_THRESHOLD_DROP_DB  ->  the cross-button effective-threshold difference
 *     in the coarse matrix (`cla76_stairs_fits.json`). Position, not shape.
 *
 * The two targets are complementary rather than competing: one carries the
 * width and the law, the other the placement. They are still iterated, because
 * the instrument fits (threshold, slope, knee) JOINTLY and a knee that moves
 * drags the fitted threshold under it.
 *
 * HELD OUT: the coarse matrix's all-buttons SLOPE column. Nothing in the fit
 * sees it, so our readback against it is a real check and not a residual.
 *
 * ⚠ EVERYTHING HERE IS SIMULATE-AND-MATCH. The staircase reads the static law
 * convolved with the attack; ours is driven through the identical extractor and
 * the identical fitter, so the bias is common and cancels. No number the
 * reference printed is installed directly.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PLANS, runKernel, analyseCapture, inputForGr } from './fet-ballistics.mjs'
import { buildProbe } from './lib/probeStimulus.js'
import { fitStatic, stairCurve } from './fet-stairs.mjs'
import { collapse, shapeOf, slopeAt } from './fet-allbuttons-shape.mjs'
import {
  ALL_KNEE_DB, ALL_THRESHOLD_DROP_DB, ALL_INCR_AT_KNEE, ALL_INCR_FALL_PER_DB,
  ALL_INCR_FLOOR,
} from '../src/audio/fet1176Processor.js'
import { knobForDrive } from './fet-allbuttons-fit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data', 'fet1176')
const COARSE = join(DATA, 'cla76_stairs_fits.json')
const SHAPE = join(DATA, 'cla76_allbuttons_shape.json')

/** `THRESHOLD_DBFS` — not exported from the kernel; pinned by a self-test. */
const THRESHOLD_DBFS = -18

/** The button the drop is measured against. See the header. */
export const DROP_REFERENCE_BUTTON = '4'

const rms = (xs) => Math.sqrt(xs.reduce((a, v) => a + v * v, 0) / xs.length)
const mean = (xs) => xs.reduce((a, v) => a + v, 0) / xs.length

export const load = (p) => JSON.parse(readFileSync(p, 'utf8'))

/**
 * CLA-76's threshold drop, straight off the coarse matrix.
 *
 * Returns one entry per Input position: the all-buttons effective threshold
 * minus the reference button's at the SAME position, so the drive cancels. A
 * negative number means all-buttons starts compressing earlier.
 *
 * ⚠ THIS IS THE REFERENCE'S DROP AS ITS OWN INSTRUMENT READ IT, not the number
 * to install — the fitted threshold is entangled with the fitted knee, so the
 * value our kernel needs is whatever reproduces THIS through the same fitter.
 */
export function measuredDrop(coarse, button = DROP_REFERENCE_BUTTON) {
  const at = (ratio, input) => coarse.captures
    .find(c => c.ratio === ratio && c.input === input)?.effThresholdDb
  const rows = []
  for (const c of coarse.captures.filter(c => c.ratio === 'all')) {
    const ref = at(button, c.input)
    if (ref == null) continue
    rows.push({ input: c.input, all: c.effThresholdDb, ref, deltaDb: c.effThresholdDb - ref })
  }
  rows.sort((a, b) => a.input - b.input)
  return rows
}

const fineCache = new Map()

/** Our all-buttons shape, through the reference's own extractor. */
function ourShape(sampleRate, plan, stim, drives, law) {
  const key = JSON.stringify([drives, law])
  if (!fineCache.has(key)) {
    const curves = drives.map((driveDb) => {
      const { y } = runKernel(stim.x, sampleRate, {
        inputDrive: knobForDrive(driveDb), ratio: 'all', attack: 1, release: 7, fetDrive: 0, ...law,
      })
      return shapeOf(stairCurve(y, plan, stim, sampleRate, 0), 0)
    })
    const offsets = collapse(curves)
    fineCache.set(key, curves
      .flatMap((c, i) => c.map(p => ({ ...p, levelDb: p.levelDb + offsets[i] })))
      .sort((a, b) => a.levelDb - b.levelDb))
  }
  return fineCache.get(key)
}

/**
 * Distance between our shape and the reference's, minimised over a free shift.
 *
 * ⚠ THE SHIFT MUST BE FREE. Both axes have arbitrary origins — theirs because
 * the drop is unrecoverable from a staircase, ours because our own collapse
 * pins its first capture at zero. Holding the shift at zero would score the
 * placement, which this target cannot speak to, and call it shape error.
 *
 * ⚠⚠ AND EVERY REFERENCE POINT MUST BE COVERED, or the shift stops being a
 * nuisance parameter and becomes a way to cheat. Allowing a shift that drops
 * the points our span no longer reaches lets the search slide the reference's
 * falling tail off the end of our curve — the very part that discriminates the
 * law. Measured on the guard below, a FLAT curve scored 0.0121 that way against
 * 0.0304 scored honestly, which would have made a law with no fall at all look
 * two and a half times better than it is.
 */
export function shapeCost(ours, refCurve, span = 24) {
  let best = { rms: Infinity, shiftDb: NaN, n: 0 }
  for (let d = -span; d <= span; d += 0.25) {
    const errs = []
    for (const p of refCurve) {
      const v = slopeAt(ours, p.shiftedLevelDb + d)
      if (v === null) break
      errs.push(v - p.slope)
    }
    if (errs.length < refCurve.length) continue
    const e = rms(errs)
    if (e < best.rms) best = { rms: e, shiftDb: d, n: errs.length }
  }
  return best
}

const coarseCache = new Map()

/** One coarse-matrix reading of our kernel, through the reference's fitter. */
function ourCoarse(sampleRate, plan, stim, { ratio, driveDb, law }) {
  const key = JSON.stringify([ratio, driveDb.toFixed(4), law])
  if (!coarseCache.has(key)) {
    const { y } = runKernel(stim.x, sampleRate, {
      inputDrive: knobForDrive(driveDb), ratio, attack: 1, release: 7, fetDrive: 0, ...law,
    })
    coarseCache.set(key, fitStatic(stairCurve(y, plan, stim, sampleRate, 0)))
  }
  return coarseCache.get(key)
}

/**
 * Our cross-button threshold difference at one common drive, for a candidate
 * drop. The drive is the same for both renders BY CONSTRUCTION, which is what
 * makes this comparable to the reference's.
 */
export function ourDrop(sampleRate, plan, stim, { driveDb, law }) {
  const all = ourCoarse(sampleRate, plan, stim, { ratio: 'all', driveDb, law })
  const ref = ourCoarse(sampleRate, plan, stim,
    { ratio: DROP_REFERENCE_BUTTON, driveDb, law })
  return { deltaDb: all.effThresholdDb - ref.effThresholdDb, all, ref }
}

/** Coarse grid then a shrinking pattern search, as in `fet-static-fit`. */
export function search1d(lo, hi, cost, steps = 8, rounds = 12) {
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
    if (step < 1e-4) break
  }
  return best
}

/**
 * THE ALL-BUTTONS ATTACK LAG, FROM THE ONE BURSTS CAPTURE THAT EXISTS.
 *
 * ⚠⚠ ON ITS OWN THAT CAPTURE CANNOT MEASURE THE LAG, and reading it alone gives
 * the wrong answer with confidence. CLA-76's all-buttons burst at attack dial 4
 * reads t63 1938 us, which places it near OUR dial 2 — apparently a finding that
 * our all-buttons attack is far too fast. It is not: CLA-76 is slower than our
 * ladder at EVERY dial and on the numbered buttons too (its nominal 20 us reads
 * like our dial 2.3, its 800 us is slower than our dial 1). The reference's
 * ladder offset is confounded with the effect being looked for, and it is the
 * larger of the two.
 *
 * ⚠ THE CANCELLATION IS THE MEASUREMENT. `cla76_bursts_r4_I3_a4_r4.wav` is the
 * same reference, the same Input position and the SAME attack dial as
 * `cla76_bursts_rALL_I3_a4_r4.wav`, so the ladder offset is common to both and
 * divides out of their ratio. What survives is all-buttons against ratio 4, and
 * it runs the other way: 1938 us against 2688 us, i.e. all-buttons is FASTER.
 *
 * ⚠ THE DEPTHS ARE NOT EQUAL AND t63 DEPENDS ON DEPTH — 13.34 dB against 9.66,
 * and attack quickens with depth. That is why this matches through renders
 * rather than through the ratio of the two numbers: our kernel is driven to each
 * capture's own settled reduction, so our depth schedule answers for the gap and
 * only what it cannot explain reaches the lag.
 */
export const BURSTS = {
  all: { file: 'cla76_bursts_rALL_I3_a4_r4.wav', ratio: 'all', grDb: 13.34, attackT63Us: 1938 },
  ref: { file: 'cla76_bursts_r4_I3_a4_r4.wav', ratio: '4', grDb: 9.66, attackT63Us: 2688 },
  attackDial: 4,
  releaseDial: 4,
}

/**
 * The dial OUR side is probed at, which is NOT the reference's dial 4.
 *
 * ⚠⚠ t63 IS QUANTISED BY THE PROBE — 125 us at 4 kHz — AND OUR DIAL 4 IS TOO
 * FAST TO MEASURE. At dial 4 our t63 is 313 us, so the quantum is 40 % of the
 * reading and the cross-button ratio moves in steps of about 0.4; the first fit
 * run returned a residual of 0.121 on a target of 0.721, which is one quantum
 * and means nothing. The lag is a MULTIPLIER on the attack constant, so the
 * ratio it produces is dial-independent where the instrument can resolve it —
 * measured 2.391 / 2.385 / 2.429 at dials 1 / 2 / 3 for a lag of 2.5, and 1.800
 * at dial 4, which is the quantisation breaking, not the model. Dial 1 has the
 * longest t63 and therefore the finest relative resolution.
 */
export const LAG_PROBE_DIAL = 1

/**
 * Our attack t63 on the longest burst, driven to a capture's own depth.
 *
 * ⚠⚠ `attackSchedule: 'depth'` IS PASSED EXPLICITLY AND MUST BE. `runKernel`
 * deliberately pins the schedules off so the instrument cannot drift with
 * product decisions — but that pin would put the whole 13.34-vs-9.66 dB depth
 * difference into the lag. Measured: with the schedule off our cross-button
 * ratio is exactly 1.000 at every dial when the lag is 1, so the depth gap
 * contributes nothing and the lag would absorb all of it. With the schedule on
 * — which is what the product runs — the same configuration gives 0.721, which
 * is the reference's ratio exactly.
 */
export function ourAttackT63(sampleRate, plan, stim, { ratio, grDb, law }) {
  const params = {
    ratio,
    fetDrive: 0,
    attack: LAG_PROBE_DIAL,
    release: BURSTS.releaseDial,
    attackSchedule: 'depth',
    ...law,
  }
  const matched = inputForGr(grDb, params, sampleRate)
  const { y } = runKernel(stim.x, sampleRate, { ...params, inputDrive: matched.knob })
  const bursts = analyseCapture(y, plan, stim, sampleRate, 0)
  return { t63: bursts[bursts.length - 1]?.attackT63, knob: matched.knob }
}

/**
 * The lag that reproduces the reference's all-buttons / ratio-4 t63 RATIO.
 *
 * ⚠ THE RATIO, NOT THE MICROSECONDS. Matching our all-buttons t63 to 1938 us
 * directly would install CLA-76's whole ladder offset into a constant that is
 * supposed to describe one button.
 */
export function fitAttackLag(sampleRate, law, lo = 0.5, hi = 4) {
  const plan = PLANS['bursts.wav']()
  const stim = buildProbe(plan, sampleRate)
  const target = BURSTS.all.attackT63Us / BURSTS.ref.attackT63Us
  const ref = ourAttackT63(sampleRate, plan, stim,
    { ratio: BURSTS.ref.ratio, grDb: BURSTS.ref.grDb, law })
  const cost = (lag) => {
    const all = ourAttackT63(sampleRate, plan, stim,
      { ratio: BURSTS.all.ratio, grDb: BURSTS.all.grDb, law: { ...law, allAttackLag: lag } })
    if (!Number.isFinite(all.t63) || !Number.isFinite(ref.t63)) return Infinity
    return Math.abs(all.t63 / ref.t63 - target)
  }
  const best = search1d(lo, hi, cost, 14, 12)
  /**
   * ⚠ THE RESOLUTION IS REPORTED BECAUSE THE SEARCH CANNOT SEE IT. A quantised
   * cost is flat in patches, so the minimiser returns a point where an interval
   * is meant. `quantumLag` is how much the lag has to move to shift our t63 by
   * one probe quantum — anything inside that is one reading.
   */
  const quantumLag = ref.t63 > 0
    ? best.v * (1 / (BURSTS.all.attackT63Us / 1e6 / (1 / 8000))) : NaN
  return {
    lag: best.v, cost: best.cost, target, refT63: ref.t63, quantumLag,
  }
}

/** Extra drives, above the captured ones, that give the shift room to move. */
export const HEADROOM_DRIVES_DB = [16, 21, 26]

/** Plausible ranges — also the identifiability table's excursions. */
export const RANGES = {
  allKneeDb: [1, 20],
  allIncrAtKnee: [0.85, 0.99],
  allIncrFallPerDb: [0, 0.02],
  allIncrFloor: [0.70, 0.92],
}

export function fit(sampleRate, { coarse, shape, rounds = 2 } = {}) {
  const finePlan = PLANS['stairs-fine.wav']()
  const fineStim = buildProbe(finePlan, sampleRate)
  const coarsePlan = PLANS['stairs.wav']()
  const coarseStim = buildProbe(coarsePlan, sampleRate)

  /**
   * ⚠ THE BASE DRIVE IS A CONVENIENCE, NOT A MEASUREMENT. Only the spacing
   * between the four matters to the shape, and the absolute offset is taken out
   * again by `shapeCost`'s free shift. It is set from the coarse matrix purely
   * so the renders sample the same part of the law the captures did.
   */
  const byInput = new Map(shape.captures.map(c => [c.input, c.offsetDb]))
  const baseDrive = THRESHOLD_DBFS
    - coarse.captures.find(c => c.ratio === 'all' && c.input === 2).effThresholdDb
  /**
   * ⚠⚠ OUR SIDE IS RENDERED AT THREE DRIVES THE REFERENCE NEVER USED, AND THE
   * FIT IS WRONG WITHOUT THEM. `shapeCost` requires every reference point to be
   * covered, so the usable shift is bounded by where our curve ENDS — and with
   * only the four captured drives the optimum sat exactly on that bound (5.00 dB
   * of a 5.00 dB maximum), which means the search was reporting the edge of the
   * window rather than a minimum. Extending our own span moves the optimum off
   * the bound to 6.75 dB and drops the residual from 0.0315 to 0.0159.
   *
   * ⚠ IT IS LEGITIMATE BECAUSE OUR LAW IS A FUNCTION OF OVERSHOOT BY
   * CONSTRUCTION, so a drive we did not capture samples the same curve; these
   * renders add reach, not information. The four captured drives are still
   * there, and they are the ones whose SPACING has to match the reference's.
   */
  const fineDrives = [...byInput.keys()].sort((a, b) => a - b).map(i => baseDrive + byInput.get(i))
    .concat(HEADROOM_DRIVES_DB.map(d => baseDrive + d))

  const drop = measuredDrop(coarse)
  const coarseDrives = drop.map(r => ({ input: r.input, driveDb: THRESHOLD_DBFS - r.ref }))

  let law = {
    allKneeDb: ALL_KNEE_DB,
    allIncrAtKnee: ALL_INCR_AT_KNEE,
    allIncrFallPerDb: ALL_INCR_FALL_PER_DB,
    allIncrFloor: ALL_INCR_FLOOR,
  }
  let dropDb = ALL_THRESHOLD_DROP_DB

  const shapeCostOf = (cand) => shapeCost(
    ourShape(sampleRate, finePlan, fineStim, fineDrives, cand), shape.curve).rms

  const dropCostOf = (d) => rms(drop.map((r, i) => ourDrop(sampleRate, coarsePlan, coarseStim, {
    driveDb: coarseDrives[i].driveDb, law: { ...law, allThresholdDropDb: d },
  }).deltaDb - r.deltaDb))

  for (let round = 0; round < rounds; round++) {
    for (const key of Object.keys(RANGES)) {
      const [lo, hi] = RANGES[key]
      const best = search1d(lo, hi, v => shapeCostOf({ ...law, [key]: v }), 8, 8)
      law = { ...law, [key]: best.v }
    }
    dropDb = search1d(-2, 8, dropCostOf, 10, 10).v
  }
  return {
    law, dropDb, fineDrives, coarseDrives, drop,
    shape: shapeCost(ourShape(sampleRate, finePlan, fineStim, fineDrives, law), shape.curve),
    shapeCostOf,
    dropCostOf,
    context: { finePlan, fineStim, coarsePlan, coarseStim },
  }
}

function report(sampleRate) {
  const coarse = load(COARSE)
  const shape = load(SHAPE)

  console.log(`\nFET Punch all-buttons — REFIT FROM EXISTING CAPTURES, ${sampleRate} Hz`)
  console.log('No new bounce. Targets are the two persisted reading files.\n')

  const drop = measuredDrop(coarse)
  console.log(`  THE THRESHOLD DROP AS MEASURED (all-buttons minus ratio ${DROP_REFERENCE_BUTTON},`)
  console.log('  same Input, so the drive cancels)')
  console.log('    Input    all      r4     delta')
  for (const r of drop) {
    console.log(`    I${r.input}    ${r.all.toFixed(2).padStart(7)} ${r.ref.toFixed(2).padStart(7)}` +
      `   ${r.deltaDb.toFixed(2).padStart(6)}`)
  }
  const dm = mean(drop.map(r => r.deltaDb))
  const dsd = Math.sqrt(mean(drop.map(r => (r.deltaDb - dm) ** 2)))
  console.log(`    mean ${dm.toFixed(3)} dB, spread ${dsd.toFixed(3)} dB over ${drop.length} positions`)
  console.log(`    ⚠ Ours ships ${ALL_THRESHOLD_DROP_DB} dB.`)

  const t0 = Date.now()
  const f = fit(sampleRate, { coarse, shape })
  console.log(`\n  (${((Date.now() - t0) / 1000).toFixed(0)} s of renders)`)

  console.log('\n  THE LAW TO INSTALL')
  console.log(`    ALL_KNEE_DB            ${f.law.allKneeDb.toFixed(3).padStart(8)}   ` +
    `(ships ${ALL_KNEE_DB})`)
  console.log(`    ALL_THRESHOLD_DROP_DB  ${f.dropDb.toFixed(3).padStart(8)}   ` +
    `(ships ${ALL_THRESHOLD_DROP_DB})`)
  console.log(`    ALL_INCR_AT_KNEE       ${f.law.allIncrAtKnee.toFixed(4).padStart(8)}   ` +
    `(ships ${ALL_INCR_AT_KNEE})`)
  console.log(`    ALL_INCR_FALL_PER_DB   ${f.law.allIncrFallPerDb.toFixed(5).padStart(8)}   ` +
    `(ships ${ALL_INCR_FALL_PER_DB})`)
  console.log(`    ALL_INCR_FLOOR         ${f.law.allIncrFloor.toFixed(4).padStart(8)}   ` +
    `(ships ${ALL_INCR_FLOOR.toFixed(4)})`)
  console.log(`\n    shape residual ${f.shape.rms.toFixed(4)} of slope over ${f.shape.n} points` +
    ` at a ${f.shape.shiftDb.toFixed(2)} dB shift`)
  console.log(`    collapse residual of the reference itself: ${shape.collapseResidual}`)
  console.log('    ⚠ A shape residual near the reference\'s own collapse residual is as good')
  console.log('      as the data gets. One far above it is a wrong family, not a loose fit.')

  /**
   * ⚠ IDENTIFIABILITY BEFORE INTERPRETATION. A parameter whose whole plausible
   * range moves the cost less than the fit's own residual is not measured by
   * this data, whatever number the search returned.
   */
  console.log('\n  IDENTIFIABILITY — cost at each end of the plausible range')
  console.log('    ⚠ READ THE TWO SIDES SEPARATELY. A parameter the data bounds from above')
  console.log('      and not from below is a BOUND, not a measurement, and reporting one')
  console.log('      verdict for both ends hides exactly that case.')
  console.log('    parameter                  lo    fitted        hi   bounded')
  for (const key of Object.keys(RANGES)) {
    const [lo, hi] = RANGES[key]
    const cl = f.shapeCostOf({ ...f.law, [key]: lo })
    const ch = f.shapeCostOf({ ...f.law, [key]: hi })
    // A side counts as bounded when walking to it at least doubles the residual.
    const side = (c) => (c > 2 * f.shape.rms ? 'yes' : '⚠ NO')
    console.log(`    ${key.padEnd(22)} ${cl.toFixed(4)}  ${f.shape.rms.toFixed(4)}  ` +
      `${ch.toFixed(4)}   below ${side(cl)}, above ${side(ch)}`)
  }

  console.log('\n  THE ATTACK LAG — cross-button, so CLA-76\'s ladder offset cancels')
  const lag = fitAttackLag(sampleRate, { ...f.law, allThresholdDropDb: f.dropDb })
  console.log(`    reference ratio (all / r4, both at attack dial ${BURSTS.attackDial})` +
    `   ${lag.target.toFixed(3)}`)
  console.log(`    ⚠ Below 1: all-buttons is FASTER, not later.`)
  console.log(`    ALL_ATTACK_LAG         ${lag.lag.toFixed(3).padStart(8)}   (ships 2.5)`)
  console.log(`    residual in the ratio  ${lag.cost.toFixed(4)}` +
    `   one probe quantum is about ${lag.quantumLag.toFixed(2)} of lag`)

  /**
   * HELD OUT. The coarse matrix's all-buttons slope column is not in either
   * cost, so this is a prediction.
   */
  console.log('\n  HELD OUT — the coarse matrix\'s all-buttons slope column')
  console.log('    Input     ref     ours       d')
  const errs = []
  for (const r of coarse.captures.filter(c => c.ratio === 'all').sort((a, b) => a.input - b.input)) {
    const m = ourDrop(sampleRate, f.context.coarsePlan, f.context.coarseStim, {
      driveDb: THRESHOLD_DBFS - drop.find(d => d.input === r.input).ref,
      law: { ...f.law, allThresholdDropDb: f.dropDb },
    }).all
    errs.push(m.slope - r.slope)
    console.log(`    I${r.input}    ${r.slope.toFixed(4)}   ${m.slope.toFixed(4)}  ` +
      `${(m.slope - r.slope >= 0 ? '+' : '')}${(m.slope - r.slope).toFixed(4)}`)
  }
  console.log(`    rms ${rms(errs).toFixed(4)} of slope`)
  console.log()
}

function selftest() {
  let failed = 0
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
    if (!ok) failed++
  }
  console.log('\nfet-allbuttons-refit self-test\n')

  const coarse = load(COARSE)
  const shape = load(SHAPE)

  // The threshold constant this script assumes, pinned against the kernel.
  const probe = runKernel(new Float32Array(16), 48000, { ratio: '4', inputDrive: 0 })
  check('kernel still reachable', probe.y.length === 16)

  const drop = measuredDrop(coarse)
  check('the drop is read at every Input position', drop.length === 4, `got ${drop.length}`)
  check('every delta is negative (all-buttons compresses earlier)',
    drop.every(r => r.deltaDb < 0))
  const dm = mean(drop.map(r => r.deltaDb))
  check('the four positions agree to 0.1 dB',
    Math.max(...drop.map(r => Math.abs(r.deltaDb - dm))) < 0.1,
    `mean ${dm.toFixed(3)}`)

  /**
   * ⚠ THE GUARD THAT MATTERS: a free shift must not be able to absorb a real
   * shape difference. A curve tilted against itself has to score badly at EVERY
   * shift, or the cost is measuring nothing.
   */
  const flat = shape.curve.map(p => ({ levelDb: p.shiftedLevelDb, slope: 0.93 }))
  const same = shape.curve.map(p => ({ levelDb: p.shiftedLevelDb, slope: p.slope }))
  const cSame = shapeCost(same, shape.curve)
  const cFlat = shapeCost(flat, shape.curve)
  check('a curve matches itself at zero shift', cSame.rms < 1e-6 && Math.abs(cSame.shiftDb) < 1e-6,
    `rms ${cSame.rms.toFixed(6)} shift ${cSame.shiftDb}`)
  check('a flat curve cannot be shifted into agreement', cFlat.rms > 0.025,
    `rms ${cFlat.rms.toFixed(4)}`)
  check('a shift that would drop reference points is refused',
    shapeCost(same.slice(0, 6), shape.curve).rms === Infinity)

  // A pure translation of the reference must be recovered as exactly that.
  const moved = shape.curve.map(p => ({ levelDb: p.shiftedLevelDb + 3, slope: p.slope }))
  const cMoved = shapeCost(moved, shape.curve)
  check('a translated curve is recovered as a translation',
    cMoved.rms < 1e-6 && Math.abs(cMoved.shiftDb - 3) < 0.26,
    `rms ${cMoved.rms.toFixed(6)} shift ${cMoved.shiftDb.toFixed(2)}`)

  console.log(`\n  ${failed ? `${failed} FAILED` : 'all passed'}\n`)
  return failed
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const sr = Number(process.argv.find(a => /^--sr=/.test(a))?.slice(5)) || 96000
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0)
  else report(sr)
}
