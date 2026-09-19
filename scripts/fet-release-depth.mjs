/**
 * Fit the depth-scheduled release constant against a reference's measured
 * release times.
 *
 * ⚠ THIS IS A SIMULATE-AND-MATCH FIT AND A REGRESSION WOULD BE WRONG. The
 * reference numbers are measured t63 values. Once the release constant is
 * scheduled on the current reduction it changes DURING the recovery as that
 * reduction decays, so the trajectory is not an exponential and measured t63 is
 * no longer the constant behind it. Regressing `t63 = a·exp(k·D)` on the table
 * and installing that `k` would be the same class of error as dividing out the
 * release "bias" that turned out to be our own tail stage. So every candidate
 * `k` is rendered through the kernel and read by the SAME analysis that produced
 * the reference numbers, and the residual is measured where the reference is.
 *
 *   node scripts/fet-release-depth.mjs            fit against the FETish table
 *   node scripts/fet-release-depth.mjs --selftest recover a known k
 */
import { basename } from 'node:path'
import { analyseCapture } from './fet-ballistics.mjs'
import { buildProbe, snapToZeroCrossing } from './lib/probeStimulus.js'
import { FET1176Kernel } from '../src/audio/fet1176Processor.js'

const SR = 96000
const PROBE_HZ = 4000

/**
 * One burst, the shape of the real plan's longest hold.
 *
 * \u26a0 11 SECONDS, NOT THE FULL 83. The fit bisects on Input and then searches on
 * k, so the stimulus is rendered hundreds of times; the full burst plan made a
 * single self-test run past two minutes. Only the deepest hold's release is ever
 * read, and 3 s of hold at the same level reaches the same settled reduction \u2014
 * the same argument `inputForGr` already makes for its own depth solve.
 */
function shortPlan() {
  const up = snapToZeroCrossing(1.0, PROBE_HZ)
  const down = snapToZeroCrossing(up + 3.0, PROBE_HZ)
  return {
    events: [{ tag: 'depth', T: 3.0, freqHz: PROBE_HZ, hiDb: -12, up, down }],
    spans: [], seconds: down + 7.0, lowDb: -50,
  }
}

/**
 * FETish, `a121_r234`, four captures with the Input the only thing moving.
 * ⚠ THE DEEPEST TWO ARE PAST OUR INPUT RANGE (we top out near 16.3 dB), so the
 * fit reports them but cannot drive our kernel there. That is a finding about
 * IN_DRIVE_SPAN_DB, not a reason to weight them away.
 */
export const FETISH_DEPTH_TABLE = [
  { depthDb: 6.18, t63Ms: 30 },
  { depthDb: 13.96, t63Ms: 70 },
  { depthDb: 17.51, t63Ms: 93 },
  { depthDb: 21.86, t63Ms: 139 },
]

const plan = shortPlan()
let cachedStim = null
const stim = () => (cachedStim ||= buildProbe(plan, SR))

/**
 * Our kernel's settled reduction and measured release t63, driven by stimulus
 * level rather than by the Input knob.
 *
 * ⚠ THIS IS WHY THE FIT DOES NOT NEED `IN_DRIVE_SPAN_DB` WIDENED, and calling
 * that constant the blocker was wrong. The detector sees `level + inputDrive` in
 * dB and nothing else — the measurement path runs at `fetDrive: 0`, so the
 * saturator, the one stage that could tell the two apart, is bypassed. Verified
 * rather than assumed: Input 80 with the stimulus raised 6.540 dB (exactly the
 * knob's own 80-to-100 span) returns 16.484 dB of depth and 345.7 ms, which is
 * Input 100's answer to every digit printed.
 *
 * So the bench can drive past the knob's +16 dB ceiling and reach the
 * reference's 21.9 dB without touching a shipping constant, which would
 * otherwise have moved every existing knob position, preset and render to
 * unblock a measurement.
 */
export function measureAt(stimGainDb, params) {
  const k = new FET1176Kernel(SR)
  const { tailFraction, ...kernelParams } = params
  k.setParams({ outputGainDb: 0, mix: 1, fetDrive: 0, oversample: false,
    inputDrive: 100, ratio: '4', attack: 4, release: 4, ...kernelParams })
  /**
   * \u26a0 THE TAIL HAS TO COME OFF FOR A FETish FIT AND THAT IS NOT A DETAIL. The
   * two mechanisms fight: the tail lengthens recovery with EXPOSURE, which
   * FETish measurably does not do, and at shallow depths it dominates the
   * schedule outright \u2014 a synthetic table rendered at k = 0.12 comes back
   * non-monotone (271 / 262 / 301 / 333 ms) purely because of it. It is poked
   * rather than passed because it is derived from the ratio button, and making
   * it a parameter is a shipping decision this bench tool should not take.
   */
  if (tailFraction !== undefined) { k.tailFraction = tailFraction; k.mainFraction = 1 - tailFraction }

  const g = Math.pow(10, stimGainDb / 20)
  const base = stim()
  const x = new Float32Array(base.x.length)
  for (let i = 0; i < x.length; i++) x[i] = base.x[i] * g
  const y = new Float32Array(x.length)
  for (let f = 0; f < x.length; f += 128) {
    const l = Math.min(128, x.length - f)
    k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
  }
  /**
   * \u26a0 THE REFERENCE ENVELOPE IS SCALED TOO. `traceGain` divides the capture by
   * this envelope, so leaving it at the unscaled amplitude would read the
   * stimulus gain itself as compressor gain and report the drive as reduction.
   */
  const scaled = { x, env: base.env.map(v => v * g) }
  const b = analyseCapture(y, plan, scaled, SR, 0).at(-1)
  return { depthDb: b.grDb, t63Ms: b.releaseT63 * 1e3 }
}

/**
 * The stimulus level that puts our kernel at a given reduction.
 *
 * ⚠ IT STILL REPORTS WHEN IT CANNOT GET THERE. The ceiling is far higher now,
 * but a target past it must still be named rather than silently clamped — that
 * is how a row lands in the residual as though it had been matched.
 */
export function inputForDepth(targetDb, params) {
  let lo = -40, hi = 24
  const seen = new Map()
  const at = v => {
    if (!seen.has(v)) seen.set(v, measureAt(v, params).depthDb)
    return seen.get(v)
  }
  if (at(hi) < targetDb - 0.05) return { knob: hi, clipped: 'high', depthDb: at(hi) }
  if (at(lo) > targetDb + 0.05) return { knob: lo, clipped: 'low', depthDb: at(lo) }
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2
    if (at(mid) < targetDb) lo = mid; else hi = mid
  }
  const knob = (lo + hi) / 2
  return { knob, clipped: null, depthDb: at(knob) }
}

/**
 * ⚠ THE INPUT SOLVE IS HOISTED OUT OF THE SEARCH, and it has to be. Settled
 * reduction is a property of the static curve at that level; the release
 * schedule moves how the cell RECOVERS, not where it sits under a held tone. So
 * the Input for each reference depth is solved once with the schedule off and
 * reused for every candidate, which turns a bisection-inside-two-golden-searches
 * into one render per row per candidate. The achieved depth is carried through
 * and printed, so any drift this assumption hides stays visible.
 */
const inputCache = new Map()
function inputForRow(row) {
  if (!inputCache.has(row.depthDb)) inputCache.set(row.depthDb, inputForDepth(row.depthDb, { tailFraction: 0 }))
  return inputCache.get(row.depthDb)
}

/** Measured t63 at each reachable reference depth, for one candidate schedule. */
export function curveFor(params, table = FETISH_DEPTH_TABLE) {
  return table.map(row => {
    const inp = inputForRow(row)
    if (inp.clipped) return { ...row, clipped: inp.clipped, ourT63Ms: null }
    const m = measureAt(inp.knob, params)
    return { ...row, clipped: null, knob: inp.knob, ourDepthDb: m.depthDb, ourT63Ms: m.t63Ms }
  })
}

/**
 * ⚠ RELATIVE, NOT ABSOLUTE. The reference spans 30 to 139 ms, so a residual in
 * milliseconds is dominated by the deepest row and a fit can be "good" while
 * being 3x wrong at the shallow end. The shape is the claim being tested.
 */
export function rmsResidual(rows) {
  const used = rows.filter(r => r.ourT63Ms !== null)
  if (!used.length) return { rms: Infinity, rmsMs: Infinity, n: 0 }
  const ss = used.reduce((a, r) => a + ((r.ourT63Ms - r.t63Ms) / r.t63Ms) ** 2, 0)
  const ssMs = used.reduce((a, r) => a + (r.ourT63Ms - r.t63Ms) ** 2, 0)
  return { rms: Math.sqrt(ss / used.length), rmsMs: Math.sqrt(ssMs / used.length), n: used.length }
}

const golden = (lo, hi, score, iters = 14) => {
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

/**
 * Fit the schedule slope AND the release dial together.
 *
 * ⚠ PINNING THE DIAL AT 4 BECAUSE THE REFERENCE KNOB SAID 234 ms WAS WRONG, and
 * it produced a 207 ms residual that looked like the model failing. FETish's
 * release knob reads about 2.75x longer than the constant it produces — already
 * measured, twice — so its "234 ms" is not our dial 4. The schedule sets the
 * SHAPE and the dial sets the LEVEL; fitting one with the other pinned to a
 * label neither side shares cannot converge on anything.
 */
export function fitK(table = FETISH_DEPTH_TABLE, { lo = 0.0, hi = 0.30, tailFraction = 0 } = {}) {
  const build = (k, dial) => ({ releaseSchedule: 'depth', releaseDepthK: k, release: dial, tailFraction })
  const bestDialFor = k => golden(1, 7, dial => rmsResidual(curveFor(build(k, dial), table)).rms, 12)
  const k = golden(lo, hi, kk => rmsResidual(curveFor(build(kk, bestDialFor(kk)), table)).rms, 10)
  const dial = bestDialFor(k)
  return { k, dial, tailFraction, ...rmsResidual(curveFor(build(k, dial), table)) }
}

function selftest() {
  console.log('\nRelease-depth fitter self-test — recover a k the kernel was rendered with\n')
  const TRUE_K = 0.12
  const synth = curveFor({ releaseSchedule: 'depth', releaseDepthK: TRUE_K, release: 4, tailFraction: 0 },
    [{ depthDb: 6 }, { depthDb: 10 }, { depthDb: 14 }, { depthDb: 16 }])
    .filter(r => r.ourT63Ms !== null)
    .map(r => ({ depthDb: r.depthDb, t63Ms: r.ourT63Ms }))
  console.log('  synthetic table (k = ' + TRUE_K + '):')
  for (const r of synth) console.log(`    ${r.depthDb.toFixed(2)} dB -> ${r.t63Ms.toFixed(1)} ms`)
  const got = fitK(synth)
  console.log(`\n  recovered k = ${got.k.toFixed(4)} against ${TRUE_K} at dial ${got.dial.toFixed(2)}, ` +
    `residual ${(got.rms * 100).toFixed(2)} % / ${got.rmsMs.toFixed(2)} ms over ${got.n} points`)
  const ok = Math.abs(got.k - TRUE_K) < 0.01 && got.rms < 0.02
  console.log(ok ? '  PASS' : '  ⚠ FAIL — the fitter cannot recover its own answer, so it cannot be trusted on a reference')
  if (!ok) process.exitCode = 1

  // ⚠ And the schedule must be INERT when off, or "off" is not a way back.
  const a = measureAt(91, {})
  const b = measureAt(91, { releaseSchedule: 'none', releaseDepthK: 0.2 })
  console.log(`\n  schedule off: ${a.t63Ms.toFixed(1)} vs ${b.t63Ms.toFixed(1)} ms with k set — ` +
    (Math.abs(a.t63Ms - b.t63Ms) < 1e-9 ? 'inert, as it must be' : '⚠ NOT INERT'))
}

function fit() {
  console.log('\nDepth-scheduled release — fit against FETish (a121_r234, Input swept)\n')
  const best = fitK()
  const rows = curveFor({ releaseSchedule: 'depth', releaseDepthK: best.k,
    release: best.dial, tailFraction: best.tailFraction })
  console.log('  reference depth   reference t63   our t63    error')
  for (const r of rows) {
    if (r.clipped) {
      console.log(`  ${r.depthDb.toFixed(2).padStart(13)} dB ${String(r.t63Ms).padStart(14)} ms` +
        `     ⚠ past our drive range — not in the fit`)
      continue
    }
    console.log(`  ${r.depthDb.toFixed(2).padStart(13)} dB ${String(r.t63Ms).padStart(14)} ms ` +
      `${r.ourT63Ms.toFixed(1).padStart(9)} ${(100 * (r.ourT63Ms - r.t63Ms) / r.t63Ms).toFixed(1).padStart(8)} %`)
  }
  console.log(`\n  best k = ${best.k.toFixed(4)} dB^-1 at release dial ${best.dial.toFixed(2)}, tail off`)
  console.log(`  rms error ${(best.rms * 100).toFixed(2)} % (${best.rmsMs.toFixed(1)} ms) over ${best.n} points`)

  /**
   * \u26a0 TWO FREE PARAMETERS AND TWO POINTS IS NOT A FIT, IT IS AN INTERPOLATION.
   * k and the release dial are both free, so any two reachable rows can be hit
   * exactly and the residual is zero BY CONSTRUCTION, whatever the model. A
   * small number here would be the most misleading output this tool could
   * produce, so it is named rather than printed and left to speak for itself.
   */
  const FREE_PARAMS = 2
  if (best.n <= FREE_PARAMS) {
    console.log(`\n  \u26a0\u26a0 ${best.n} POINTS AGAINST ${FREE_PARAMS} FREE PARAMETERS — THIS RESIDUAL IS MEANINGLESS.`)
    console.log('     k and the dial can hit any two rows exactly, so the error above is zero by')
    console.log('     construction and says nothing about whether a depth schedule is the right')
    console.log('     model. NOTHING SHOULD BE FITTED FROM THIS until more rows are reachable.')
  }

  const flatDial = golden(1, 7, d => rmsResidual(curveFor({ releaseSchedule: 'none', release: d, tailFraction: 0 })).rms, 12)
  const flat = rmsResidual(curveFor({ releaseSchedule: 'none', release: flatDial, tailFraction: 0 }))
  console.log(`\n  the SAME fit with the schedule off, dial free: ${(flat.rms * 100).toFixed(2)} % ` +
    `at dial ${flatDial.toFixed(2)}`)
  console.log('  ⚠ That is the comparison that matters. A fixed release with the dial free is')
  console.log('    the null hypothesis; beating the SHIPPING dial proves nothing, since the')
  console.log('    shipping dial was never chosen to match this reference.')

  if (best.n < FETISH_DEPTH_TABLE.length) {
    console.log(`\n  ⚠ only ${best.n} of ${FETISH_DEPTH_TABLE.length} reference rows were reachable.`)
  }
  console.log()
}

/**
 * ⚠ ENTRY-POINT GUARDED, AND IT WAS NOT. `fetReleaseDepth.test.js` imports
 * `measureAt` / `fitK` / `curveFor` from this module, and an unconditional
 * dispatch runs the whole nested fit during module initialisation — before a
 * single assertion, on every `npm test`. The same defect was found and fixed in
 * `fet-stairs.mjs`; a module that exports helpers must not also run a report
 * just because something imported it.
 */
if (basename(process.argv[1] ?? '') === 'fet-release-depth.mjs') {
  const args = process.argv.slice(2)
  if (args.includes('--selftest')) selftest()
  else fit()
}
