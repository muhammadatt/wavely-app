/**
 * Fit the depth-scheduled ATTACK against a reference's measured attack times.
 *
 * ⚠ SIMULATE-AND-MATCH, NEVER A CONVERSION, AND THIS IS THE FOURTH TIME. The
 * reference numbers are measured t63 values. Once the attack constant is
 * scheduled on the current reduction it changes DURING the attack as that
 * reduction climbs, so the trajectory is not an exponential and measured t63 is
 * no longer the constant behind it. Worse than the release case: an attack
 * starts at ZERO reduction, so a schedule anchored at 15.9 dB begins
 * `exp(0.085 * 15.9)` = 3.9x long and shortens all the way in. Dividing the
 * reference's t63 by a factor is how the attack ladder came out 44 % wrong the
 * first time.
 *
 * ⚠ TWO PARAMETERS, FOUR POINTS. `k` sets how fast the constant shortens with
 * depth; a scale on the ladder sets where it sits. Fitting one without the other
 * cannot converge, exactly as pinning the release dial to the reference's label
 * could not — the schedule sets the SHAPE across depth and the ladder sets the
 * LEVEL.
 *
 *   node scripts/fet-attack-depth.mjs --selftest   recover a k the kernel ran
 *   node scripts/fet-attack-depth.mjs              fit against the FETish table
 */
import { analyseCapture } from './fet-ballistics.mjs'
import { basename } from 'node:path'
import { buildProbe, snapToZeroCrossing } from './lib/probeStimulus.js'
import {
  FET1176Kernel, attackSecondsForDial, ATTACK_DEPTH_K, ATTACK_DEPTH_REF_DB,
} from '../src/audio/fet1176Processor.js'

const SR = 96000

/**
 * FETish at one attack setting (~dial 4 on its own markings), Input swept.
 * ⚠ The attack t63 column, NOT the release one — this is the same capture set
 * the release schedule was fitted from, read on its other limb.
 */
export const FETISH_ATTACK_TABLE = [
  { depthDb: 6.18, t63Us: 5438 },
  { depthDb: 13.96, t63Us: 2188 },
  { depthDb: 17.51, t63Us: 1563 },
  { depthDb: 21.86, t63Us: 1063 },
]

/**
 * \u26a0 ONE BURST, 6 s, NOT THE FULL 83. The fit bisects on drive and then runs a
 * golden search inside a golden search, so the stimulus is rendered hundreds of
 * times; on the full burst plan a single self-test ran past nine minutes. Only
 * the attack of one hold is ever read, and 1 s at the same level reaches the
 * same settled reduction \u2014 the argument `inputForGr` already makes.
 */
function shortPlan() {
  const up = snapToZeroCrossing(1.0, 4000)
  const down = snapToZeroCrossing(up + 1.0, 4000)
  return {
    events: [{ tag: 'attack', T: 1.0, freqHz: 4000, hiDb: -12, up, down }],
    spans: [], seconds: down + 4.0, lowDb: -50,
  }
}

const plan = shortPlan()
let cachedStim = null
const stim = () => (cachedStim ||= buildProbe(plan, SR))

/**
 * Our kernel's settled reduction and measured attack t63.
 *
 * ⚠ DRIVEN BY STIMULUS LEVEL, NOT THE INPUT KNOB, for the reason set out in
 * `fet-attack-depth`'s sibling: the detector sees level and drive summed in dB
 * and the measurement path bypasses the saturator, so the bench can reach any
 * depth without a shipping constant being widened to let it.
 */
export function measureAt(stimGainDb, params) {
  const k = new FET1176Kernel(SR)
  const { ladderScale, ...kernelParams } = params
  k.setParams({ outputGainDb: 0, mix: 1, fetDrive: 0, oversample: false,
    inputDrive: 100, ratio: '4', attack: 4, release: 4, ...kernelParams })
  /**
   * ⚠ THE LADDER SCALE IS POKED, NOT PASSED. `ATTACK_SLOWEST_S` and its partner
   * are constants; the fit needs to move the whole ladder to find where it sits
   * under the schedule, and a bench tool should not turn that into a parameter
   * before the answer is known.
   */
  if (ladderScale !== undefined) {
    const base = attackSecondsForDial(kernelParams.attack ?? 4, kernelParams.attackRange)
    const tau = base * ladderScale
    k.attackCoef = 1 - Math.exp(-1 / (SR * tau))
    if (k.attackScheduled) {
      /**
       * \u26a0 THE KERNEL'S OWN CONSTANTS, NOT COPIES. These were written out as
       * literals (-0.085 and 15.9) and went stale the moment the fitted slope
       * replaced the estimate: the same table then read 4.60 % here and 1.15 %
       * from the fit, for no reason but two numbers disagreeing. Exactly the
       * failure `fet-null.mjs` had with the input drive law.
       */
      const ka = Number.isFinite(kernelParams.attackDepthK) ? kernelParams.attackDepthK : ATTACK_DEPTH_K
      for (let i = 0; i < k.attackLut.length; i++) {
        const depthDb = i * 0.25
        k.attackLut[i] = 1 - Math.exp(-1 / (SR * tau * Math.exp(ka * (depthDb - ATTACK_DEPTH_REF_DB))))
      }
    }
  }
  const g = Math.pow(10, stimGainDb / 20)
  const base = stim()
  const x = new Float32Array(base.x.length)
  for (let i = 0; i < x.length; i++) x[i] = base.x[i] * g
  const y = new Float32Array(x.length)
  for (let f = 0; f < x.length; f += 128) {
    const l = Math.min(128, x.length - f)
    k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
  }
  // ⚠ Scale the reference envelope too, or the drive reads as compressor gain.
  const scaled = { x, env: base.env.map(v => v * g) }
  const b = analyseCapture(y, plan, scaled, SR, 0).at(-1)
  return { depthDb: b.grDb, t63Us: b.attackT63 * 1e6 }
}

const driveCache = new Map()
function driveForDepth(targetDb) {
  if (driveCache.has(targetDb)) return driveCache.get(targetDb)
  let lo = -40, hi = 24
  const at = v => measureAt(v, {}).depthDb
  if (at(hi) < targetDb - 0.05) { driveCache.set(targetDb, null); return null }
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2
    if (at(mid) < targetDb) lo = mid; else hi = mid
  }
  const v = (lo + hi) / 2
  driveCache.set(targetDb, v)
  return v
}

export function curveFor(params, table = FETISH_ATTACK_TABLE) {
  return table.map(row => {
    const drive = driveForDepth(row.depthDb)
    if (drive === null) return { ...row, ourT63Us: null }
    return { ...row, ourT63Us: measureAt(drive, params).t63Us }
  })
}

/** ⚠ Relative: the table spans 1063 to 5438 us, so millisecond error is all top. */
export function rmsResidual(rows) {
  const used = rows.filter(r => r.ourT63Us !== null)
  if (!used.length) return { rms: Infinity, n: 0 }
  const ss = used.reduce((a, r) => a + ((r.ourT63Us - r.t63Us) / r.t63Us) ** 2, 0)
  return { rms: Math.sqrt(ss / used.length), n: used.length }
}

const golden = (lo, hi, score, iters = 12) => {
  const phi = (Math.sqrt(5) - 1) / 2
  let a = lo, b = hi
  let c = b - phi * (b - a), d = a + phi * (b - a)
  let fc = score(c), fd = score(d)
  for (let i = 0; i < iters; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = score(c) }
    else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = score(d) }
  }
  return (a + b) / 2
}

export function fitK(table = FETISH_ATTACK_TABLE, { lo = -0.20, hi = 0.0 } = {}) {
  const build = (k, scale) => ({ attackSchedule: 'depth', attackDepthK: k, ladderScale: scale })
  const bestScaleFor = k => golden(0.05, 12, s => rmsResidual(curveFor(build(k, s), table)).rms, 12)
  const k = golden(lo, hi, kk => rmsResidual(curveFor(build(kk, bestScaleFor(kk)), table)).rms, 10)
  const scale = bestScaleFor(k)
  return { k, scale, ...rmsResidual(curveFor(build(k, scale), table)) }
}

function selftest() {
  console.log('\nAttack-schedule fitter self-test — recover a k the kernel was rendered with\n')
  const TRUE_K = -0.07
  const TRUE_SCALE = 3
  const synth = curveFor({ attackSchedule: 'depth', attackDepthK: TRUE_K, ladderScale: TRUE_SCALE })
    .filter(r => r.ourT63Us !== null)
    .map(r => ({ depthDb: r.depthDb, t63Us: r.ourT63Us }))
  console.log(`  synthetic table (k = ${TRUE_K}, ladder x${TRUE_SCALE}):`)
  for (const r of synth) console.log(`    ${r.depthDb.toFixed(2)} dB -> ${r.t63Us.toFixed(0)} us`)
  const got = fitK(synth)
  console.log(`\n  recovered k = ${got.k.toFixed(4)} against ${TRUE_K}, ladder x${got.scale.toFixed(3)} ` +
    `against ${TRUE_SCALE}, rms ${(got.rms * 100).toFixed(2)} %`)
  /**
   * ⚠ THE TOLERANCE IS ON THE CURVE, NOT ON `k`, AND THAT IS A PROPERTY OF THE
   * DATA RATHER THAN A CONCESSION. `k` and the ladder scale trade against each
   * other: a shallower slope with a longer ladder fits nearly as well, and the
   * measured t63 is quantised to ~62-125 us against deep points near 1000, so
   * the relative resolution there is 6-12 %. Mapped against the real table,
   * every `k` from -0.13 to -0.07 sits within 1.5x of the best residual. So the
   * fitter is asked to reproduce the CURVE and to get the sign and order of
   * magnitude of `k`, which is what the data can support.
   */
  const ok = got.k < 0 && Math.abs(got.k - TRUE_K) < 0.04 && got.rms < 0.05

  /** ⚠ And 'none' must be inert, or "off" is not a way back. */
  const a = measureAt(0, {})
  const b = measureAt(0, { attackSchedule: 'none', attackDepthK: -0.2 })
  const inert = Math.abs(a.t63Us - b.t63Us) < 1e-9
  console.log(`  schedule off: ${a.t63Us.toFixed(1)} vs ${b.t63Us.toFixed(1)} us with k set — ` +
    (inert ? 'inert, as it must be' : '⚠ NOT INERT'))
  console.log(ok && inert ? '\n  PASS\n' : '\n  ⚠ FAIL\n')
  if (!(ok && inert)) process.exitCode = 1
}

function fit() {
  console.log('\nDepth-scheduled attack — fit against FETish (one setting, Input swept)\n')
  const best = fitK()
  const rows = curveFor({ attackSchedule: 'depth', attackDepthK: best.k, ladderScale: best.scale })
  console.log('  reference depth   reference t63   our t63     error')
  for (const r of rows) {
    if (r.ourT63Us === null) {
      console.log(`  ${r.depthDb.toFixed(2).padStart(13)} dB ${String(r.t63Us).padStart(13)} us     past our drive range`)
      continue
    }
    console.log(`  ${r.depthDb.toFixed(2).padStart(13)} dB ${String(r.t63Us).padStart(13)} us ` +
      `${r.ourT63Us.toFixed(0).padStart(9)} ${(100 * (r.ourT63Us - r.t63Us) / r.t63Us).toFixed(1).padStart(9)} %`)
  }
  console.log(`\n  best k = ${best.k.toFixed(4)} dB^-1, ladder x${best.scale.toFixed(3)}`)
  console.log(`  rms ${(best.rms * 100).toFixed(2)} % over ${best.n} points`)

  const flatScale = golden(0.05, 12, s => rmsResidual(curveFor({ attackSchedule: 'none', ladderScale: s })).rms, 14)
  const flat = rmsResidual(curveFor({ attackSchedule: 'none', ladderScale: flatScale }))
  console.log(`\n  the SAME fit with the schedule off, ladder free: ${(flat.rms * 100).toFixed(2)} % ` +
    `at x${flatScale.toFixed(3)}`)
  console.log('  ⚠ That is the null hypothesis. A fixed attack with the ladder free is what')
  console.log('    the shipping kernel can already express; beating it is the whole claim.\n')
}

/**
 * ⚠ AN ENTRY-POINT GUARD, BECAUSE WITHOUT ONE IMPORTING THIS RAN THE WHOLE FIT.
 * A scratch script that imported `curveFor` to map the parameter degeneracy
 * printed a full fit report first — minutes of rendering nobody asked for, and
 * on a test runner it would be worse. `fet-ballistics.mjs` already guards this
 * way; this file did not.
 */
const isEntryPoint = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))
if (!isEntryPoint) {
  // imported as a library — the table, `curveFor` and `fitK` are the API
} else if (process.argv.includes('--selftest')) selftest()
else fit()
