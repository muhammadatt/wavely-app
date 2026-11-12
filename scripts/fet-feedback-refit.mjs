/**
 * Refit FET Punch's ballistics for the FEEDBACK detector topology.
 *
 *   npm run fet:fbrefit            refit against the reference tables
 *   npm run fet:fbrefit:selftest   recover a scale and k the kernel ran with
 *
 * ⚠ THE CAPTURES ARE NOT NEEDED, ONLY THE NUMBERS READ OFF THEM. Every target
 * here is a table already in the repo — FETish's attack-vs-depth sweep
 * (`FETISH_ATTACK_TABLE`), its release-vs-depth sweep (`FETISH_DEPTH_TABLE`),
 * its seven-dial release ladder and CLA-76's all-buttons-against-4:1 attack
 * ratio — and our side is rendered through the same probe and the same
 * `analyseCapture` that produced them. Simulate-and-match, as every other fit
 * in this family.
 *
 * WHAT THE TOPOLOGY CHANGES, AND THEREFORE WHAT IS FITTED
 *
 *   static curve   NOTHING. The feedback law is the feed-forward one
 *                  re-expressed on output overshoot (`_solveFeedback`), so a
 *                  held level settles identically. Not refitted.
 *   release        NOTHING THE CAPTURES CAN SEE. Every release probe drops to
 *                  −50 dBFS, below threshold, where the loop asks for zero and
 *                  is open. Checked, not assumed: the ladder and the depth
 *                  table render to the same t63 in both topologies.
 *   attack         EVERYTHING. Above threshold the loop multiplies the
 *                  effective rate by ~(1 + loop gain), so the same constant
 *                  attacks ~3.7x faster at 4:1. A ladder scale and the depth
 *                  slope are refitted together, as `fet-attack-depth` did.
 *   all-buttons    The lag, against CLA-76's 0.721.
 *
 * AND ONE HELD-OUT TEST, which nothing above was fitted to: CLA-76's attack at
 * 20:1 against 4:1, same Input, same dial (`CLA76_R20_OVER_R4`). It is the one
 * observable the two topologies disagree on by a factor of four.
 */
import { basename } from 'node:path'
import { analyseCapture, burstPlan } from './fet-ballistics.mjs'
import { buildProbe, snapToZeroCrossing } from './lib/probeStimulus.js'
import { FETISH_ATTACK_TABLE } from './fet-attack-depth.mjs'
import { FETISH_DEPTH_TABLE } from './fet-release-depth.mjs'
import {
  FET1176Kernel, attackSecondsForDial, ATTACK_DEPTH_K, ATTACK_DEPTH_REF_DB,
  FB_ATTACK_SCALE, FB_ATTACK_DEPTH_K, FB_ALL_ATTACK_LAG,
} from '../src/audio/fet1176Processor.js'

const SR = 96000
const PROBE_HZ = 4000

/** FETish's seven-dial release ladder at 12.5 dB (dev log, "release SHIPS"). */
export const FETISH_RELEASE_LADDER = [
  { dial: 7, t63Ms: 18 }, { dial: 6, t63Ms: 31 }, { dial: 5, t63Ms: 51 },
  { dial: 4, t63Ms: 86 }, { dial: 3, t63Ms: 145 }, { dial: 2, t63Ms: 242 },
  { dial: 1, t63Ms: 407 },
]

/**
 * CLA-76, same Input and same attack dial: all-buttons t63 over ratio-4 t63,
 * at the depths each capture settled on. The ladder offset cancels in the
 * ratio, which is the only reason it can be read at all.
 */
export const CLA76_ALL_OVER_4 = { ratio: 0.721, allDepthDb: 13.34, r4DepthDb: 9.66 }

/**
 * CLA-76, `cla76_bursts_r4_I3_a1_r3.wav` against `cla76_bursts_r20_I3_a1_r3.wav`
 * (October 2026): the same Input (I3), attack dial 1 and release dial 3, only the
 * ratio button moved. Read by `npm run fet:ballistics -- --rate 48000` — the
 * bounces are at 48 kHz, so t63 is quantised to ~125 us here, ~9 % of the 20:1
 * reading.
 *
 * ⚠⚠ THE TOPOLOGY VERDICT. 20:1 attacks 3.4x FASTER than 4:1 while settling
 * SHALLOWER (8.43 against 10.91 dB, the moving threshold). Feed-forward predicts
 * the opposite sign — its depth schedule makes a shallower reduction attack
 * slower, so it reads 1.24 — and the feedback loop predicts 0.27, having been
 * calibrated at 4:1 only. Unchanged with our release slowed to the reference's
 * ~1.75 s (1.24 / 0.26).
 *
 * The ladder offset cancels in the ratio (CLA-76 is slower than our dial 1 at
 * every setting, as the dev log records), which is why it is a ratio.
 */
export const CLA76_R20_OVER_R4 = {
  ratio: 0.291, perHold: [0.307, 0.264, 0.291, 0.291],
  r4: { depthDb: 10.91, t63Us: 4938 }, r20: { depthDb: 8.43, t63Us: 1438 },
  attack: 1, sampleRate: 48000,
}

/**
 * Our 20:1-over-4:1 attack ratio, the reference's construction: one Input, set
 * where 4:1 settles at the reference's 4:1 depth, both buttons through it.
 *
 * ⚠ The REAL burst plan, at the capture's rate, through `analyseCapture` — the
 * instrument that read the reference. A shortened plan would change the hold the
 * t63 is read on. `plan`/`sampleRate` are overridable for the test only.
 */
export function r20OverR4(detector, { sampleRate = CLA76_R20_OVER_R4.sampleRate, plan: pl = burstPlan(), iters = 14 } = {}) {
  const stim = buildProbe(pl, sampleRate)
  const run = p => {
    const k = new FET1176Kernel(sampleRate)
    k.setParams({ outputGainDb: 0, mix: 1, fetDrive: 0, oversample: false,
      attack: CLA76_R20_OVER_R4.attack, release: 1, detector, ...p })
    const y = new Float32Array(stim.x.length)
    for (let f = 0; f < y.length; f += 128) {
      const l = Math.min(128, y.length - f)
      k.process([stim.x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
    }
    return analyseCapture(y, pl, stim, sampleRate, 0).at(-1)
  }
  let lo = 0, hi = 100
  for (let i = 0; i < iters; i++) {
    const m = (lo + hi) / 2
    if (run({ ratio: '4', inputDrive: m }).grDb < CLA76_R20_OVER_R4.r4.depthDb) lo = m; else hi = m
  }
  const inputDrive = (lo + hi) / 2
  const r4 = run({ ratio: '4', inputDrive })
  const r20 = run({ ratio: '20', inputDrive })
  return { inputDrive, ratio: r20.attackT63 / r4.attackT63,
    r4: { depthDb: r4.grDb, t63Us: r4.attackT63 * 1e6 }, r20: { depthDb: r20.grDb, t63Us: r20.attackT63 * 1e6 } }
}

function plan(holdS) {
  const up = snapToZeroCrossing(1.0, PROBE_HZ)
  const down = snapToZeroCrossing(up + holdS, PROBE_HZ)
  return {
    events: [{ tag: 'probe', T: holdS, freqHz: PROBE_HZ, hiDb: -12, up, down }],
    spans: [], seconds: down + (holdS > 1 ? 7.0 : 4.0), lowDb: -50,
  }
}
// The two plans `fet-attack-depth` and `fet-release-depth` read, kept apart so
// each limb is measured on the hold it was fitted on.
const ATTACK_PLAN = plan(1.0)
const RELEASE_PLAN = plan(3.0)
const stimCache = new Map()
const stimFor = p => {
  if (!stimCache.has(p)) stimCache.set(p, buildProbe(p, SR))
  return stimCache.get(p)
}

/**
 * Render the probe and read settled depth, attack t63 and release t63.
 *
 * ⚠ `attackScale` / `attackDepthK` ARE POKED, NOT PASSED, for the reason
 * `fet-attack-depth` gives: they are the unknowns, and the bench tool should not
 * promote them to kernel params before the answer is in. The poke REPLACES the
 * kernel's own coefficient, so the scale it is given is absolute — relative to
 * the bare ladder, not on top of whatever `FB_ATTACK_SCALE` ships.
 */
export function measure(stimGainDb, params, { release = false } = {}) {
  const pl = release ? RELEASE_PLAN : ATTACK_PLAN
  const k = new FET1176Kernel(SR)
  const { attackScale, attackDepthK, ...kp } = params
  k.setParams({ outputGainDb: 0, mix: 1, fetDrive: 0, oversample: false,
    inputDrive: 100, ratio: '4', attack: 4, release: 4, ...kp })
  if (attackScale !== undefined || attackDepthK !== undefined) {
    let tau = attackSecondsForDial(kp.attack ?? 4, kp.attackRange) * (attackScale ?? 1)
    if (String(kp.ratio) === 'all') tau *= k.allAttackLag
    k.attackCoef = 1 - Math.exp(-1 / (SR * tau))
    if (k.attackScheduled) {
      const ka = attackDepthK ?? ATTACK_DEPTH_K
      for (let i = 0; i < k.attackLut.length; i++) {
        k.attackLut[i] = 1 - Math.exp(-1 / (SR * tau * Math.exp(ka * (i * 0.25 - ATTACK_DEPTH_REF_DB))))
      }
    }
  }
  const g = Math.pow(10, stimGainDb / 20)
  const base = stimFor(pl)
  const x = new Float32Array(base.x.length)
  for (let i = 0; i < x.length; i++) x[i] = base.x[i] * g
  const y = new Float32Array(x.length)
  for (let f = 0; f < x.length; f += 128) {
    const l = Math.min(128, x.length - f)
    k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
  }
  const b = analyseCapture(y, pl, { x, env: base.env.map(v => v * g) }, SR, 0).at(-1)
  return { depthDb: b.grDb, attackUs: b.attackT63 * 1e6, releaseMs: b.releaseT63 * 1e3 }
}

/**
 * Stimulus gain for a settled depth. ⚠ Solved PER TOPOLOGY: the static curve is
 * identical on a constant |x|, but a 4 kHz probe ripples inside the cycle and
 * the feedback loop evens that out, so the same gain settles ~0.1 dB apart.
 * The ballistics do not move the settled depth, so the solve ignores them.
 */
const driveCache = new Map()
export function driveFor(targetDb, { detector, ratio = '4', release = false }) {
  const key = `${targetDb}|${detector}|${ratio}|${release}`
  if (driveCache.has(key)) return driveCache.get(key)
  let lo = -40, hi = 30
  const at = v => measure(v, { detector, ratio, attackSchedule: 'none' }, { release }).depthDb
  let v = null
  if (at(hi) >= targetDb - 0.05) {
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2
      if (at(mid) < targetDb) lo = mid; else hi = mid
    }
    v = (lo + hi) / 2
  }
  driveCache.set(key, v)
  return v
}

const rel = (ours, ref) => (ours - ref) / ref
const rmsOf = errs => Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length)

/** Our attack t63 at each table depth, for one candidate. */
export function attackCurve(detector, scale, k, table = FETISH_ATTACK_TABLE, extra = {}) {
  return table.map(row => {
    const d = driveFor(row.depthDb, { detector })
    if (d === null) return { ...row, ourUs: null }
    const p = { detector, attackSchedule: 'depth', attackScale: scale, attackDepthK: k, ...extra }
    return { ...row, ourUs: measure(d, p).attackUs }
  })
}
const attackRms = rows => rmsOf(rows.filter(r => r.ourUs !== null).map(r => rel(r.ourUs, r.t63Us)))

/**
 * Joint fit of the ladder scale and the depth slope, ON A GRID.
 *
 * ⚠⚠ NOT A GOLDEN SEARCH, WHICH THIS FIRST USED AND WHICH STALLED. Measured
 * t63 is quantised (~62-125 us at the 4 kHz probe), so the objective is a
 * staircase and a bracketing search stops on whichever tread it lands on: it
 * returned 3.45 % for feed-forward where a grid finds 2.30 %, at the shipping
 * constants. A coarse grid in log(scale) × k, then a fine one around the best.
 *
 * ⚠ The base ladder is 'fetish' because that is the ladder the reference fit
 * was made on; the shipped scale is expressed against it and applied to
 * whichever ladder is selected.
 */
export function fitAttack(detector, table = FETISH_ATTACK_TABLE, extra = { attackRange: 'fetish' }) {
  const score = (s, k) => attackRms(attackCurve(detector, s, k, table, extra))
  const grid = (sLo, sHi, nS, kLo, kHi, nK) => {
    let best = { rms: Infinity }
    for (let i = 0; i <= nS; i++) {
      for (let j = 0; j <= nK; j++) {
        const s = sLo * Math.pow(sHi / sLo, i / nS)
        const k = kLo + (kHi - kLo) * j / nK
        const rms = score(s, k)
        if (rms < best.rms) best = { s, k, rms }
      }
    }
    return best
  }
  const coarse = grid(0.25, 16, 18, -0.20, 0.0, 8)
  const fine = grid(coarse.s / 1.25, coarse.s * 1.25, 16, coarse.k - 0.025, coarse.k + 0.025, 10)
  const rows = attackCurve(detector, fine.s, fine.k, table, extra)
  return { k: fine.k, scale: fine.s, rms: fine.rms, rows }
}

/**
 * The release dial `fet-release-depth` fitted the depth table at (dev log:
 * "re-fits to k = 0.1389 at release dial 4.82"). FETish's knob label is not our
 * dial, so the table is only meaningful there.
 */
const RELEASE_DEPTH_FIT_DIAL = 4.82

/** The release limb in both topologies: the ladder at 12.5 dB and the depth table. */
export function releaseCheck() {
  const out = { ladder: [], depth: [] }
  for (const detector of ['feedforward', 'feedback']) {
    const d = driveFor(12.5, { detector, release: true })
    for (const r of FETISH_RELEASE_LADDER) {
      out.ladder.push({ detector, ...r, ourMs: measure(d, { detector, release: r.dial }, { release: true }).releaseMs })
    }
    for (const r of FETISH_DEPTH_TABLE) {
      const dd = driveFor(r.depthDb, { detector, release: true })
      out.depth.push({ detector, ...r,
        ourMs: dd === null ? null : measure(dd, { detector, release: RELEASE_DEPTH_FIT_DIAL }, { release: true }).releaseMs })
    }
  }
  return out
}

/**
 * All-buttons over 4:1 at the SAME stimulus gain and the same dial — the
 * reference's construction. Probed at dial 1, where t63 resolves (see the
 * all-buttons lag notes in the kernel).
 */
export function allOverFour(detector, attack, lag) {
  const g = driveFor(CLA76_ALL_OVER_4.allDepthDb, { detector, ratio: 'all' })
  const common = { detector, attack: 1, attackSchedule: 'depth', attackScale: attack.scale, attackDepthK: attack.k }
  const all = measure(g, { ...common, ratio: 'all', allAttackLag: lag })
  const four = measure(g, { ...common, ratio: '4' })
  return { ratio: all.attackUs / four.attackUs, allDepthDb: all.depthDb, r4DepthDb: four.depthDb }
}

function fit() {
  console.log('\nFET Punch — ballistics refit for the FEEDBACK detector\n')

  console.log('Release limb (FETish), both topologies:')
  const rc = releaseCheck()
  for (const det of ['feedforward', 'feedback']) {
    const lad = rc.ladder.filter(r => r.detector === det)
    const dep = rc.depth.filter(r => r.detector === det && r.ourMs !== null)
    console.log(`  ${det.padEnd(12)} ladder rms ${(100 * rmsOf(lad.map(r => rel(r.ourMs, r.t63Ms)))).toFixed(2)} %` +
      `   depth table rms ${(100 * rmsOf(dep.map(r => rel(r.ourMs, r.t63Ms)))).toFixed(2)} % (${dep.length} rows)`)
  }
  const ff = rc.ladder.filter(r => r.detector === 'feedforward')
  const fb = rc.ladder.filter(r => r.detector === 'feedback')
  const worst = Math.max(...ff.map((r, i) => Math.abs(fb[i].ourMs / r.ourMs - 1)))
  console.log(`  worst feedback/feed-forward ladder difference ${(100 * worst).toFixed(2)} % — the constants carry over\n`)

  console.log('Attack limb (FETish, Input swept), ladder scale and depth slope fitted jointly:')
  const results = {}
  for (const det of ['feedforward', 'feedback']) {
    const r = fitAttack(det)
    results[det] = r
    console.log(`  ${det.padEnd(12)} scale x${r.scale.toFixed(3)}  k ${r.k.toFixed(4)}  rms ${(100 * r.rms).toFixed(2)} %`)
    for (const row of r.rows) {
      console.log(`      ${row.depthDb.toFixed(2).padStart(6)} dB  ref ${String(row.t63Us).padStart(5)} us` +
        `  ours ${row.ourUs === null ? '  —  ' : row.ourUs.toFixed(0).padStart(5)} us`)
    }
  }
  const shipped = attackRms(attackCurve('feedback', FB_ATTACK_SCALE, FB_ATTACK_DEPTH_K, FETISH_ATTACK_TABLE, { attackRange: 'fetish' }))
  console.log(`  installed FB_ATTACK_SCALE ${FB_ATTACK_SCALE} / FB_ATTACK_DEPTH_K ${FB_ATTACK_DEPTH_K}: rms ${(100 * shipped).toFixed(2)} %`)
  const noSched = { attackRange: 'fetish', attackSchedule: 'none' }
  let nullFb = 1, nullRms = Infinity
  for (let i = 0; i <= 60; i++) {
    const sc = 0.2 * Math.pow(100, i / 60)
    const r = attackRms(attackCurve('feedback', sc, 0, FETISH_ATTACK_TABLE, noSched))
    if (r < nullRms) { nullRms = r; nullFb = sc }
  }
  console.log(`  null hypothesis, feedback with NO depth schedule, scale free: rms ${(100 * nullRms).toFixed(2)} % at x${nullFb.toFixed(3)}`)
  console.log('  ⚠ That is the test of "the loop explains the depth dependence by itself".\n')

  console.log(`All-buttons over 4:1 (CLA-76 ${CLA76_ALL_OVER_4.ratio}), each topology at its own fitted attack:`)
  for (const det of ['feedforward', 'feedback']) {
    const a = det === 'feedback' ? { scale: FB_ATTACK_SCALE, k: FB_ATTACK_DEPTH_K } : { scale: 1, k: ATTACK_DEPTH_K }
    const at1 = allOverFour(det, a, 1)
    // ⚠ A SCAN, NOT A SEARCH: the ratio moves in t63 quanta (~0.047 here), so
    // a bracketing search lands on whichever step it meets first.
    let lag = 1, bestErr = Infinity
    for (let l = 0.5; l <= 3.0001; l += 0.05) {
      const e = Math.abs(allOverFour(det, a, l).ratio - CLA76_ALL_OVER_4.ratio)
      if (e < bestErr - 1e-9) { bestErr = e; lag = l }
    }
    console.log(`  ${det.padEnd(12)} at lag 1: ${at1.ratio.toFixed(3)} (depths ${at1.allDepthDb.toFixed(2)} / ${at1.r4DepthDb.toFixed(2)} dB)` +
      `   lag that reproduces ${CLA76_ALL_OVER_4.ratio}: ${lag.toFixed(3)}`)
  }
  const inst = allOverFour('feedback', { scale: FB_ATTACK_SCALE, k: FB_ATTACK_DEPTH_K }, FB_ALL_ATTACK_LAG)
  console.log(`  installed FB_ALL_ATTACK_LAG ${FB_ALL_ATTACK_LAG}: ${inst.ratio.toFixed(3)}`)

  const R = CLA76_R20_OVER_R4
  console.log(`\nHELD OUT — 20:1 over 4:1 attack, same Input (CLA-76 ${R.ratio}, ` +
    `${R.r4.depthDb} / ${R.r20.depthDb} dB; per hold ${R.perHold.join(' / ')}):`)
  for (const det of ['feedforward', 'feedback']) {
    const r = r20OverR4(det)
    console.log(`  ${det.padEnd(12)} ${r.ratio.toFixed(3)}   (Input ${r.inputDrive.toFixed(1)}: ` +
      `4:1 ${r.r4.depthDb.toFixed(2)} dB ${r.r4.t63Us.toFixed(0)} us, 20:1 ${r.r20.depthDb.toFixed(2)} dB ${r.r20.t63Us.toFixed(0)} us)`)
  }
  console.log('  ⚠ Nothing above was fitted to this. Feed-forward gets the SIGN wrong.')
  console.log()
}

function selftest() {
  console.log('\nFeedback refit self-test — recover a scale and k the feedback kernel ran with\n')
  const TRUE = { scale: 2.5, k: -0.06 }
  const synth = attackCurve('feedback', TRUE.scale, TRUE.k, FETISH_ATTACK_TABLE.map(r => ({ depthDb: r.depthDb })),
    { attackRange: 'fetish' })
    .filter(r => r.ourUs !== null).map(r => ({ depthDb: r.depthDb, t63Us: r.ourUs }))
  const got = fitAttack('feedback', synth)
  console.log(`  recovered scale x${got.scale.toFixed(3)} (true ${TRUE.scale}), k ${got.k.toFixed(4)} (true ${TRUE.k}),` +
    ` rms ${(100 * got.rms).toFixed(2)} %`)
  // ⚠ Tolerance on the curve and the sign of k, for the reason fet-attack-depth
  // gives: t63 is quantised and k trades against the scale.
  const ok = got.rms < 0.05 && got.k < 0 && Math.abs(Math.log(got.scale / TRUE.scale)) < Math.log(1.5)
  console.log(ok ? '  PASS\n' : '  ⚠ FAIL\n')
  if (!ok) process.exitCode = 1
}

if (basename(process.argv[1] ?? '') === 'fet-feedback-refit.mjs') {
  if (process.argv.includes('--selftest')) selftest()
  else fit()
}
