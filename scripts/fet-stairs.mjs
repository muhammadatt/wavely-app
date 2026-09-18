/**
 * Fit the STATIC side of a reference from `stairs.wav`: threshold, ratio and
 * knee, plus the two questions the sweeps exist to answer.
 *
 * ⚠⚠ THE THRESHOLD AND THE INPUT DRIVE ARE NOT SEPARABLE FROM ONE CAPTURE, AND
 * READING THE NUMBER THIS PRINTS AS `THRESHOLD_DBFS` IS THE MISTAKE THIS FILE
 * EXISTS TO PREVENT. The gain computer sees `over = levelDb + driveDb -
 * thresholdDb`; a capture only ever shows the SUM, so any threshold can be
 * traded against any Input position and fit the same curve exactly. What the
 * column below reports is the EFFECTIVE threshold, `thresholdDb - driveDb`, and
 * only DIFFERENCES between captures mean anything:
 *
 *   - same Input, ratio swept  -> does the threshold move with the ratio button?
 *     Our model says no; FETish's manual says yes. A moving threshold misfits as
 *     a knee if you assume it is fixed, which is why this is read first.
 *   - same ratio, Input swept  -> the Input taper, and the collapse test. If the
 *     curves lie on top of one another once shifted, drive and level add in dB
 *     as we model; the shifts ARE the taper.
 *
 * The SHAPE — slope and knee — is unaffected by the offset, so those two are
 * measured outright from a single capture.
 *
 * ⚠⚠ REPORT THE SLOPE, NOT THE RATIO, AND THE SELF-TEST IS WHY. With the slowest
 * attack the gain never reaches the per-peak static target — that is the price
 * of the smoothing the staircase needs to have a settled value at all — so what
 * this measures is the law CONVOLVED WITH THE ATTACK, biased a few percent high
 * in slope. Measured on our own kernel, where the law is known: 3.30 % at ratio
 * 4, 6.37 % at 8, 1.15 % at 12, 0.53 % at 20. Harmless in slope; catastrophic
 * once expressed as a ratio, because `1/(1-slope)` amplifies it — those same
 * errors read as 11 %, 80 %, 15 % and 11 % of the ratio. A first cut reported
 * ratio 8 as 14.44 and looked like a broken optimiser when the fit was good.
 *
 * So the ratio column is derived and advisory, and the comparison that matters
 * runs OUR kernel through the identical path at the same ratio button, where
 * the attack bias is common-mode and cancels.
 *
 *   node scripts/fet-stairs.mjs --selftest   recover a law the kernel was built with
 *   node scripts/fet-stairs.mjs              fit whatever stairs captures are present
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PLANS, analyseCapture, runKernel, CAP_DIR } from './fet-ballistics.mjs'
import { buildProbe } from './lib/probeStimulus.js'
import { inputDriveDbForKnob } from '../src/audio/fet1176Processor.js'
import { readCapture, preflight, alignByEnvelope, refineLagAtEdge } from './lib/probeCapture.js'

const DEFAULT_SR = 96000

/** Our kernel's own static law, so the fit is to the shape we actually ship. */
export function grForLevel(levelDb, { effThresholdDb, slope, kneeDb }) {
  const over = levelDb - effThresholdDb
  const half = kneeDb / 2
  if (over <= -half) return 0
  if (over >= half) return slope * over
  const t = over + half
  return slope * t * t / (2 * kneeDb)
}

/** Ratio implied by a slope. Advisory only — see the header. */
export const ratioForSlope = slope => (slope >= 1 ? Infinity : 1 / (1 - slope))

/** Settled reduction at each step of the staircase. */
export function stairCurve(y, plan, stim, sampleRate, lag) {
  return analyseCapture(y, plan, stim, sampleRate, lag)
    .filter(b => Number.isFinite(b.depthDb))
    .map(b => ({ levelDb: b.holdS === undefined ? null : null, tag: b.tag, grDb: b.depthDb }))
    .map((r, i) => ({ ...r, levelDb: plan.events[i].L }))
}

/** The sharpest knee the fit can express. Below this the law is a corner. */
export const KNEE_MIN_DB = 0.1

const rms = (pts, law) =>
  Math.sqrt(pts.reduce((a, p) => a + (grForLevel(p.levelDb, law) - p.grDb) ** 2, 0) / pts.length)

/**
 * Fit effective threshold, ratio and knee.
 *
 * ⚠ A GRID THEN A PATTERN SEARCH, NOT A GRADIENT STEP. The knee makes the
 * surface flat-bottomed in places and the three parameters trade against each
 * other — a threshold moved 1 dB is nearly a knee widened 2 — so a local method
 * started anywhere sensible still lands in a different valley depending on where
 * it began. The grid is coarse enough to be cheap and fine enough that the
 * polish only ever has to travel within one cell.
 */
export function fitStatic(pts) {
  let best = { rms: Infinity }
  for (let th = -42; th <= 6; th += 1) {
    for (let slope = 0.2; slope <= 0.99; slope += 0.01) {
      for (let knee = KNEE_MIN_DB; knee <= 24; knee += 1.5) {
        const law = { effThresholdDb: th, slope, kneeDb: knee }
        const e = rms(pts, law)
        if (e < best.rms) best = { ...law, rms: e }
      }
    }
  }
  let step = [1, 0.01, 1.5]
  for (let iter = 0; iter < 300 && Math.max(...step) > 1e-5; iter++) {
    let improved = false
    for (const [i, key] of ['effThresholdDb', 'slope', 'kneeDb'].entries()) {
      for (const dir of [1, -1]) {
        const cand = { ...best, [key]: best[key] + dir * step[i] }
        if (cand.kneeDb < KNEE_MIN_DB || cand.slope <= 0.05 || cand.slope >= 0.999) continue
        const e = rms(pts, cand)
        if (e < best.rms) { best = { ...cand, rms: e }; improved = true }
      }
    }
    if (!improved) step = step.map(v => v / 2)
  }
  /**
   * ⚠ A PARAMETER SITTING ON ITS BOUND IS NOT A MEASUREMENT, IT IS THE SEARCH
   * RUNNING OUT OF ROOM. Twelve of twenty CLA-76 captures came back with a knee
   * at or under the old 0.5 dB floor — several at exactly 0.50, two at 0.13 and
   * 0.17 where the polish had walked off the grid — and were printed as though
   * they were readings. They mean the curve wants a corner sharper than this
   * parameterisation has, which is a different statement and has to be flagged
   * as one.
   */
  const atBound = best.kneeDb <= KNEE_MIN_DB * 1.02
  return { ...best, kneeDb: Math.max(best.kneeDb, KNEE_MIN_DB), kneeAtBound: atBound,
    ratio: ratioForSlope(best.slope) }
}

/** `<ref>_stairs_r<ratio>_I<n>.wav` */
export function knobsFromName(file) {
  const m = file.match(/_r(4|8|12|20|all)_I(\d)\.wav$/i)
  if (!m) return { ratio: null, input: null, unparsed: true }
  return { ratio: m[1].toLowerCase(), input: Number(m[2]) }
}

function curveFor(file, dir, sampleRate, plan, stim) {
  const { y } = readCapture(join(dir, file), sampleRate)
  const pre = preflight(file, y, plan, stim.env, sampleRate)
  const coarse = alignByEnvelope(stim.env, y, sampleRate)
  const ref = refineLagAtEdge(y, stim.x, plan.events[0].up, sampleRate, coarse)
  return { pts: stairCurve(y, plan, stim, sampleRate, ref.lag), lines: pre.lines, lag: ref.lag }
}

/**
 * Our own kernel's curve, fitted the identical way.
 *
 * ⚠ THIS IS THE ONLY BIAS-CANCELLING COMPARISON HERE. The attack lag biases
 * the fitted slope a few percent high; running both sides through the same
 * analysis puts the same bias on both, where it cancels — the same argument the
 * ballistics fitter's `matchDial` rests on. The absolute numbers in the table
 * above are approximate; these differences are not.
 */
const ourCache = new Map()
export function ourFit(ratio, sampleRate, plan, stim, inputDrive = 50, extra = null) {
  const key = `${ratio}:${inputDrive}:${extra ? JSON.stringify(extra) : ''}`
  if (!ourCache.has(key)) {
    const { y } = runKernel(stim.x, sampleRate,
      { inputDrive, ratio: String(ratio), attack: 1, release: 7, fetDrive: 0, ...extra })
    ourCache.set(key, fitStatic(stairCurve(y, plan, stim, sampleRate, 0)))
  }
  return ourCache.get(key)
}

function report(rows, sampleRate, plan, stim) {
  console.log('\n  capture                        slope   (ratio)   knee dB   eff thr dB   rms dB')
  for (const r of rows) {
    console.log('  ' + r.file.padEnd(31) +
      r.fit.slope.toFixed(4).padStart(7) +
      ('~' + r.fit.ratio.toFixed(1)).padStart(9) + r.fit.kneeDb.toFixed(2).padStart(10) +
      r.fit.effThresholdDb.toFixed(2).padStart(13) + r.fit.rms.toFixed(3).padStart(9) +
      (r.fit.kneeAtBound ? '  ⚠ knee at bound' : ''))
  }

  // ⚠ The only comparison with the attack bias cancelled out of it.
  const cmp = rows.filter(r => !r.knobs.unparsed && r.knobs.ratio !== 'all')
  if (cmp.length) {
    console.log('\n  AGAINST OUR OWN KERNEL, same ratio button, same analysis:')
    console.log('    capture                        ref slope   ours    diff     ref knee   ours')
    for (const r of cmp) {
      const o = ourFit(r.knobs.ratio, sampleRate, plan, stim)
      console.log('    ' + r.file.padEnd(31) +
        r.fit.slope.toFixed(4).padStart(9) + o.slope.toFixed(4).padStart(8) +
        ((r.fit.slope - o.slope >= 0 ? '+' : '') + (r.fit.slope - o.slope).toFixed(4)).padStart(9) +
        r.fit.kneeDb.toFixed(2).padStart(12) + o.kneeDb.toFixed(2).padStart(7))
    }
    console.log('    ⚠ THE DIFF COLUMN CANCELS THE ATTACK BIAS ONLY IF BOTH SIDES SHARE AN')
    console.log('      ATTACK. Measured on our own kernel at ratio 4, the fitted slope runs')
    console.log('      0.7734 / 0.7636 / 0.7581 / 0.7582 across attack dials 1-4 — 0.015 of')
    console.log('      slope, nearly all of it between dials 1 and 2, because a slower attack')
    console.log('      lags further behind the per-peak target and reads the law steeper.')
    console.log('      ⚠ SO THIS IS SOUND FOR FETish, WHOSE SLOWEST ATTACK IS NEAR OURS, AND')
    console.log('      NOT FOR CLA-76, WHOSE DIAL 1 MEASURES ~5688 us AGAINST OUR ~2200 — it')
    console.log('      sits beyond our slowest, so its slope is inflated by an amount this')
    console.log('      subtraction does not remove. Read the SIGN of a large difference; treat')
    console.log('      the magnitude as an upper bound on how much the reference compresses.')
  }

  // ── Does the threshold move with the ratio button? ────────────────────────
  const byInput = new Map()
  for (const r of rows) {
    if (r.knobs.unparsed) continue
    if (!byInput.has(r.knobs.input)) byInput.set(r.knobs.input, [])
    byInput.get(r.knobs.input).push(r)
  }
  for (const [input, group] of [...byInput].sort((a, b) => a[0] - b[0])) {
    if (group.length < 2) continue
    console.log(`\n  DOES THE THRESHOLD MOVE WITH RATIO?  (Input I${input}, ${group.length} ratios)`)
    const base = group[0]
    for (const r of group) {
      console.log(`    ratio ${String(r.knobs.ratio).padEnd(4)} eff threshold ` +
        `${r.fit.effThresholdDb.toFixed(2).padStart(7)} dB   ` +
        `${(r.fit.effThresholdDb - base.fit.effThresholdDb >= 0 ? '+' : '')}` +
        `${(r.fit.effThresholdDb - base.fit.effThresholdDb).toFixed(2)} vs ratio ${base.knobs.ratio}`)
    }
    const spread = Math.max(...group.map(r => r.fit.effThresholdDb))
      - Math.min(...group.map(r => r.fit.effThresholdDb))
    console.log(spread > 1.0
      ? `    → ⚠ IT MOVES, by ${spread.toFixed(2)} dB. Our model holds it FIXED, so the\n` +
        '      ratio button would be doing something we do not implement. Read this\n' +
        '      before the knee — a moving threshold misfits as a knee.'
      : `    → fixed to within ${spread.toFixed(2)} dB, as we model.`)
  }

  // ── The Input taper, and whether the curves collapse ──────────────────────
  const byRatio = new Map()
  for (const r of rows) {
    if (r.knobs.unparsed) continue
    if (!byRatio.has(r.knobs.ratio)) byRatio.set(r.knobs.ratio, [])
    byRatio.get(r.knobs.ratio).push(r)
  }
  for (const [ratio, group] of byRatio) {
    if (group.length < 2) continue
    group.sort((a, b) => a.knobs.input - b.knobs.input)
    console.log(`\n  THE INPUT TAPER  (ratio ${ratio}, ${group.length} positions)`)
    const base = group[0]
    for (const r of group) {
      console.log(`    I${r.knobs.input}  eff threshold ${r.fit.effThresholdDb.toFixed(2).padStart(7)} dB` +
        `   drive vs I${base.knobs.input}: ` +
        `${(base.fit.effThresholdDb - r.fit.effThresholdDb).toFixed(2).padStart(6)} dB`)
    }
    /**
     * ⚠ THE COLLAPSE TEST IS THE POINT AND IT IS NOT THE SAME AS THE SHIFTS.
     * Any two curves can be shifted onto each other at one point; what says the
     * additive model holds is that the SHAPE does not change with Input. If the
     * ratio or the knee moves across the sweep, the Input knob is doing
     * something more than adding dB and no single shift will ever collapse them.
     */
    /**
     * ⚠ ON SLOPE, NOT RATIO — THIS TESTED RATIO AND THAT WAS THE SAME BUG THE
     * FIT ITSELF WAS REPARAMETERISED TO AVOID. A FETish ratio-20 sweep spread
     * 0.71 in "ratio" and was reported as a shape change; in slope it is 0.0018,
     * which is nothing. `1/(1-slope)` amplifies, so any threshold stated in
     * ratio is meaningless at the top of the range.
     *
     * ⚠ AND SLOPE AND KNEE ARE REPORTED SEPARATELY BECAUSE THEY SAY DIFFERENT
     * THINGS. Slope collapsing means drive and level add in dB for the part of
     * the law above the knee, which is the additive model. The knee is a
     * different claim and can fail on its own — on FETish it does.
     */
    const slopes = group.map(r => r.fit.slope)
    const knees = group.map(r => r.fit.kneeDb)
    const dS = Math.max(...slopes) - Math.min(...slopes)
    const dK = Math.max(...knees) - Math.min(...knees)
    console.log(`    slope spread ${dS.toFixed(4)} (ratio ${ratioForSlope(Math.min(...slopes)).toFixed(1)}` +
      `-${ratioForSlope(Math.max(...slopes)).toFixed(1)}), knee spread ${dK.toFixed(2)} dB`)
    console.log(dS < 0.01
      ? '    → THE SLOPE COLLAPSES. Above the knee, drive and level add in dB as we\n' +
        '      model, and the shifts above are the taper.'
      : '    → ⚠ THE SLOPE MOVES WITH INPUT. The knob is not a simple dB offset into\n' +
        '      the detector and the shifts are not a taper.')
    /**
     * ⚠ 0.5 dB, AND THE NUMBER IS A MEASUREMENT RATHER THAN A GUESS. Our own
     * kernel has a knee fixed by construction at 10 dB; run across these same
     * four drive offsets and fitted the same way it reads 10.95 / 11.13 / 11.09
     * / 10.91, a 0.22 dB spread. So anything past about half a dB is the
     * reference's knee moving, not this instrument wobbling.
     */
    console.log(dK < 0.5
      ? '    → AND THE KNEE HOLDS, as ours does.'
      : `    → ⚠ BUT THE KNEE WIDENS WITH DRIVE, by ${dK.toFixed(2)} dB. Ours is fixed per\n` +
        '      ratio button and reads flat to 0.22 dB under this same test, so this is\n' +
        '      the reference and not the instrument. This is the finding that replaced\n' +
        '      our per-button RATIO_KNEE_DB with a drive law — see kneeDbForDrive.')
  }
}

function selftest(sampleRate) {
  console.log('\nStairs fitter self-test — what the staircase can and cannot recover\n')
  const plan = PLANS['stairs.wav']()
  const stim = buildProbe(plan, sampleRate)
  /**
   * ⚠ THE KNEES HERE ARE SET BY THIS TEST, NOT READ OFF THE KERNEL, and that
   * changed when the per-button `RATIO_KNEE_DB` became a drive law. These four
   * values are the old constants, kept because a self-test needs a known law
   * with FOUR DISTINCT knees to show the fitter can tell them apart — which is
   * a property of the instrument and has nothing to do with what we ship. The
   * kernel is pinned to each via `kneeAtRefDb` + `kneeDriveSlope: 0`.
   */
  const EXPECT = { 4: { ratio: 4, knee: 10 }, 8: { ratio: 8, knee: 8 }, 12: { ratio: 12, knee: 6 }, 20: { ratio: 20, knee: 3 } }
  const pinKnee = (knee) => ({ kneeAtRefDb: knee, kneeDriveSlope: 0 })
  let bad = 0

  /**
   * ⚠⚠ THIS USED TO ASSERT THE FITTED RATIO EQUALLED THE TRUE ONE, AND THAT WAS
   * THE WRONG THING TO DEMAND. The staircase does not measure the static law: at
   * the slowest attack — which the protocol requires, because a fast one leaves
   * the gain tracking |sin| within the cycle with no settled value to read at
   * all — the gain never reaches the per-peak static target. What it measures is
   * the law CONVOLVED WITH THE ATTACK, biased a few percent high in slope, and
   * no amount of fitting undoes a bias that is in the observable.
   *
   * So what is asserted is what a biased-but-honest instrument owes:
   *   - it describes the curve it was given (rms)
   *   - the fitted slope is MONOTONE in the true ratio, so comparisons between
   *     captures are valid even though the absolute value is not
   *   - the knee ordering survives
   *   - the bias is printed, every run, rather than asserted away
   *
   * ⚠ AND MONOTONICITY IS NOT FREE — IT IS WHY THIS FITS SLOPE AND NOT RATIO.
   * Parameterised on ratio the fit came back 4.44 / 14.44 / 13.74 / 20.0 for the
   * four buttons: NOT monotone, because `1/(1-slope)` amplifies a 6 % slope error
   * into 80 % of a ratio and the search resolution with it. On slope the same
   * captures give 0.7732 / 0.9047 / 0.9468 / 0.9758, monotone and smooth.
   */
  console.log('  button   true slope   fitted   bias       knee true / fitted    rms dB')
  const slopes = []
  for (const ratio of ['4', '8', '12', '20']) {
    const want = EXPECT[ratio]
    const fit = ourFit(ratio, sampleRate, plan, stim, 50, pinKnee(want.knee))
    const trueSlope = 1 - 1 / want.ratio
    slopes.push(fit.slope)
    const ok = fit.rms < 0.15
    if (!ok) bad++
    console.log(`  ${ratio.padStart(6)} ${trueSlope.toFixed(4).padStart(12)} ${fit.slope.toFixed(4).padStart(8)}` +
      ` ${((fit.slope / trueSlope - 1 >= 0 ? '+' : '') + ((fit.slope / trueSlope - 1) * 100).toFixed(2) + '%').padStart(8)}` +
      `   ${String(want.knee).padStart(7)} / ${fit.kneeDb.toFixed(2).padStart(5)} ${fit.rms.toFixed(3).padStart(10)}  ${ok ? '' : '⚠ rms'}`)
  }
  const mono = slopes.every((v, i) => i === 0 || v > slopes[i - 1])
  if (!mono) bad++
  console.log(`\n  fitted slope monotone in the true ratio: ${mono ? 'yes' : '⚠ NO'}` +
    ' — without this, no comparison between captures is valid')

  /**
   * ⚠ AND THE OFFSET MUST COME BACK AS A DIFFERENCE, NEVER AS A THRESHOLD. Two
   * Input positions 12 dB apart must move the EFFECTIVE threshold by 12 dB; the
   * absolute value is meaningless on its own and this proves the fitter is being
   * read the way the header says.
   */
  const a = ourFit('4', sampleRate, plan, stim, 40)
  const b = ourFit('4', sampleRate, plan, stim, 70)
  const wantShift = inputDriveDbForKnob(70) - inputDriveDbForKnob(40)
  const gotShift = a.effThresholdDb - b.effThresholdDb
  const shiftOk = Math.abs(gotShift - wantShift) < 0.6
  if (!shiftOk) bad++
  console.log(`\n  Input 40 -> 70 moves the effective threshold ${gotShift.toFixed(2)} dB, ` +
    `against ${wantShift.toFixed(2)} of drive  ${shiftOk ? 'PASS' : '⚠ FAIL'}`)
  console.log(bad ? '\n  ⚠ FAIL — the fitter cannot recover its own answer.\n' : '\n  PASS\n')
  if (bad) process.exitCode = 1
}

function fit(sampleRate, dir) {
  const plan = PLANS['stairs.wav']()
  const stim = buildProbe(plan, sampleRate)
  const files = existsSync(dir) ? readdirSync(dir).filter(f => /stairs.*\.wav$/i.test(f)).sort() : []
  if (!files.length) {
    console.log(`\nNo stairs captures in ${dir}.`)
    console.log('Expected names like  fetish_stairs_r4_I3.wav  /  cla76_stairs_rall_I2.wav')
    console.log('See docs/fet1176_capture_protocol.md, "stairs.wav — static curve".\n')
    return
  }
  console.log(`\nFET Punch static curve — ${files.length} capture(s) at ${sampleRate} Hz`)
  const rows = []
  for (const file of files) {
    let c
    try { c = curveFor(file, dir, sampleRate, plan, stim) }
    catch (e) { console.log(`\n  ⚠ ${file}: ${e.message}`); continue }
    for (const line of c.lines) if (/⚠/.test(line)) console.log(`  ${file}: ${line.trim()}`)
    rows.push({ file, knobs: knobsFromName(file), fit: fitStatic(c.pts) })
  }
  if (!rows.length) { console.log('  no readable captures\n'); return }
  report(rows, sampleRate, plan, stim)
  console.log('\n  ⚠ "eff thr" IS `threshold - drive` AND IS NOT `THRESHOLD_DBFS`. A capture')
  console.log('    only ever shows the sum, so only differences between captures mean')
  console.log('    anything. See the header of this file.\n')
}

const args = process.argv.slice(2)
const rateArg = args.indexOf('--rate')
const sr = rateArg >= 0 && args[rateArg + 1] ? Number(args[rateArg + 1]) : DEFAULT_SR
const dirArg = args.indexOf('--dir')
const dir = dirArg >= 0 && args[dirArg + 1] ? args[dirArg + 1] : CAP_DIR
if (args.includes('--selftest')) selftest(sr)
else fit(sr, dir)
