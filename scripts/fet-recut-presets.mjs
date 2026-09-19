/**
 * Run with:  npm run fet:recut        (add --selftest for the guards)
 *
 * RE-DERIVES THE FET PUNCH FACTORY PRESETS AGAINST THE CURRENT KERNEL.
 *
 * ⚠ THE TARGET IS WHAT EACH PRESET DID WHEN IT WAS CUT, NOT WHAT SOUNDS GOOD.
 * Choosing new voicings is a listening decision and this script does not make
 * one; it restores the behaviour the stored dials used to produce, so that the
 * re-tune is not silently a re-voicing of every patch as well. Anyone who wants
 * a preset to do something DIFFERENT should change it on purpose, afterwards.
 *
 * WHAT MOVED UNDER THEM. Five changes, none reachable from a patch:
 *   1. `IN_DRIVE_SPAN_DB` 40 -> 48, so every Input position means more drive
 *   2. release endpoints 1.1 / 0.05 s -> 0.7288 / 0.03318, every dial 1.51x faster
 *   3. `releaseSchedule: 'depth'`, so the constant now scales with reduction
 *   4. `attackSchedule: 'depth'`, likewise on the attack
 *   5. the knee: four per-button constants -> one drive law
 * `TAIL_FRACTION` also went 0.22 -> 0, which is why release is matched on a
 * MEASURED t63 rather than on the constant: the old release was two-stage and
 * the new one is not, so there is no constant to copy across.
 *
 * ⚠ THE MAKEUP IS NOT IN HERE AND MUST NOT BE. `output` is canonicalised to 0
 * while AUTO is on and solved per file, so the percentile/ceiling change needs
 * no preset edit at all — see `normalize` in `pluginPresets/fetPunch.js`.
 *
 * ⚠ THE DIALS ARE INTEGERS 1-7 AND THE SOLVE IS CONTINUOUS, so attack and
 * release land on the nearest position and the residual is printed rather than
 * hidden. A preset whose ideal lands between two dials is reported as such.
 *
 * ⚠ ALL-BUTTONS IS DELIBERATELY ABSENT. `factory:all-buttons-in` sits on a law
 * with no captures behind it from either reference (`ALL_KNEE_DB`,
 * `ALL_THRESHOLD_DROP_DB`, the soft `ALL_RATIO_*` triple, `ALL_TAIL_*`), and
 * re-cutting a preset against an unmeasured law would dress a guess as a fit.
 * It keeps its original dials until CLA-76 supplies the captures.
 */
import { basename } from 'node:path'
import * as NEW from '../src/audio/fet1176Processor.js'

const SR = 44100

/**
 * The kernel as it stood when the presets were cut (commit 57e1877), reachable
 * because the constants that moved are module-level and a patch cannot express
 * them. Loaded lazily and from a path the caller supplies, so the repo does not
 * have to carry a second copy of the processor.
 */
export async function loadAsCutKernel(path) {
  return import(path)
}

/** The stored dials, exactly as `pluginPresets/fetPunch.js` has them today. */
export const AS_CUT = [
  { id: 'vocal-punch', inputDrive: 55, attack: 4, release: 5, ratio: '4', fetDrive: 0.35, scHpfHz: 0, mix: 1 },
  { id: 'consonant-control', inputDrive: 60, attack: 6, release: 5, ratio: '8', fetDrive: 0.3, scHpfHz: 120, mix: 1 },
  { id: 'gentle-ride', inputDrive: 40, attack: 2, release: 3, ratio: '4', fetDrive: 0.2, scHpfHz: 80, mix: 1 },
  { id: 'parallel-thickener', inputDrive: 75, attack: 7, release: 7, ratio: '12', fetDrive: 0.5, scHpfHz: 100, mix: 0.4 },
  /**
   * ⚠ ALL-BUTTONS JOINED LATE, AND ITS AS-CUT DIALS ARE THE ORIGINALS. It was
   * held out while its law had no captures behind it; `fet:allrefit` has now
   * fitted the knee, the threshold drop, the slope triple and the attack lag
   * against CLA-76, so re-cutting it against that law is a fit rather than a
   * guess dressed as one. Its target is the same as every other preset's: what
   * it DID when it was cut.
   */
  { id: 'all-buttons-in', inputDrive: 70, attack: 7, release: 7, ratio: 'all', fetDrive: 0.6, scHpfHz: 0, mix: 0.5 },
]

/**
 * Syllabic narration with a plosive at the end of a pause — the fixture the
 * makeup work settled on, and the right one here for the same reason: a preset
 * is judged on speech, and the transient that survives the attack is where the
 * ballistics show up.
 */
export function narration(seconds = 6, amp = 0.42) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    phase += (2 * Math.PI * 130) / SR
    let s = 0
    for (let h = 1; h <= 10; h++) s += Math.sin(phase * h) / (h * h)
    const voiced = t < 2 || t > 3.5
    x[i] = voiced ? amp * s * Math.max(0, Math.sin(2 * Math.PI * 3 * t)) ** 2 : 0.0004 * s
  }
  const at = Math.round(SR * 3.45)
  for (let i = 0; i < 24; i++) x[at + i] += 0.8 * Math.exp(-i / 6)
  return x
}

/** Peak and average gain reduction a patch produces on `x`. */
export function meterGr(mod, params, x) {
  const k = new mod.FET1176Kernel(SR)
  k.setParams({ ...params, outputGainDb: 0, oversample: false })
  k.process([x], [new Float32Array(x.length)], x.length)
  const m = k.getMetering()
  return { peak: m.maxGainReductionDb, avg: m.avgGainReductionDb }
}

/**
 * The Input knob that makes the new kernel work as hard as the old one did.
 *
 * ⚠ MATCHED ON AVERAGE REDUCTION, NOT PEAK. The average is how much work the
 * compressor is doing over the passage, which is what "this preset compresses
 * about this hard" means; the peak is a property of one transient and of the
 * attack that caught it, so matching on it would fold a ballistics change into
 * the Input knob.
 */
export function solveInputDrive(mod, params, x, targetAvgGr) {
  let lo = 0
  let hi = 100
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (meterGr(mod, { ...params, inputDrive: mid }, x).avg < targetAvgGr) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * The effective attack/release constant a dial produces at a given reduction
 * depth, with the schedules in force. The ladders are unchanged from the as-cut
 * kernel on the attack side; on the release side both the ladder and the
 * schedule moved.
 */
export function effectiveAttackS(dial, depthDb) {
  return NEW.attackSecondsForDial(dial, 'datasheet')
    * Math.exp(NEW.ATTACK_DEPTH_K * (depthDb - NEW.ATTACK_DEPTH_REF_DB))
}

export function effectiveReleaseS(dial, depthDb) {
  return NEW.releaseSecondsForDial(dial)
    * Math.exp(NEW.RELEASE_DEPTH_K * (depthDb - NEW.RELEASE_DEPTH_REF_DB))
}

/** The dial whose effective constant lands nearest `targetS` at `depthDb`. */
export function nearestDial(targetS, depthDb, effective) {
  let best = null
  for (let dial = 1; dial <= 7; dial++) {
    const err = Math.abs(Math.log(effective(dial, depthDb) / targetS))
    if (!best || err < best.err) best = { dial, err, seconds: effective(dial, depthDb) }
  }
  return best
}

/**
 * Re-derive one preset. Iterated, because the three answers interact: a changed
 * Input moves the depth the schedules are read at, and changed ballistics move
 * the reduction the Input was solved for.
 */
export function recut(OLD, preset, x, rounds = 3) {
  const target = meterGr(OLD, preset, x)
  const targetAttackS = OLD.attackSecondsForDial(preset.attack)
  const targetReleaseS = OLD.releaseSecondsForDial(preset.release)

  let inputDrive = preset.inputDrive
  let attack = preset.attack
  let release = preset.release
  /**
   * ⚠ ITERATED TO A FIXED POINT ON THE ROUNDED PATCH, NOT FOR A SET NUMBER OF
   * ROUNDS. The first version solved the Input, read the depth, picked the
   * dials, and stopped — so the dials were chosen at one depth and the residual
   * was then PRINTED at another, because rounding the Input moves the depth
   * again. That reads as a bad dial choice when it is really two different
   * questions answered at two different operating points. Converging on the
   * rounded patch makes the printed residual the one the preset actually has.
   */
  let converged = false
  for (let r = 0; r < rounds * 4 && !converged; r++) {
    inputDrive = solveInputDrive(NEW, { ...preset, attack, release }, x, target.avg)
    const rounded = Math.round(inputDrive)
    const depth = meterGr(NEW, { ...preset, inputDrive: rounded, attack, release }, x).peak
    const a = nearestDial(targetAttackS, depth, effectiveAttackS).dial
    const rel = nearestDial(targetReleaseS, depth, effectiveReleaseS).dial
    converged = a === attack && rel === release
    attack = a
    release = rel
  }
  /**
   * ⚠⚠ THE LOOP LIMIT-CYCLES AND CHASING THE FIXED POINT DOES NOT END IT. Moving
   * a dial moves the depth, the depth picks the dial, and the dials are
   * integers — so a preset whose ideal sits on a boundary flips between two
   * positions forever. Two earlier versions of this ended by taking whatever
   * the last iteration happened to hold, which is an arbitrary tie-break
   * dressed as a solve, and reported a residual measured at a depth the chosen
   * dials do not produce.
   *
   * Ended properly instead: take the small neighbourhood around where the loop
   * was circling, SETTLE THE INPUT SEPARATELY FOR EACH CANDIDATE, and keep the
   * one whose ballistics land closest at its own operating point. Nine patches,
   * each fully solved, and the winner is self-consistent by construction
   * because its residual was measured on itself.
   */
  const near = (d) => [d - 1, d, d + 1].filter(v => v >= 1 && v <= 7)
  let best = null
  for (const a of near(attack)) {
    for (const rel of near(release)) {
      const drive = solveInputDrive(NEW, { ...preset, attack: a, release: rel }, x, target.avg)
      const cand = { ...preset, inputDrive: Math.round(drive), attack: a, release: rel }
      const m = meterGr(NEW, cand, x)
      const dA = Math.log(effectiveAttackS(a, m.peak) / targetAttackS)
      const dR = Math.log(effectiveReleaseS(rel, m.peak) / targetReleaseS)
      const score = Math.hypot(dA, dR)
      if (!best || score < best.score) best = { a, rel, drive, cand, m, score }
    }
  }
  attack = best.a
  release = best.rel
  inputDrive = best.drive
  const rounded = Math.round(inputDrive)
  const final = best.cand
  const got = best.m
  const depth = got.peak
  /**
   * The dial this patch's OWN depth asks for. Equal to the chosen one whenever
   * the neighbourhood search found a self-consistent answer; when it is not,
   * the ideal sits on a boundary and no integer dial is stable there — which is
   * a property of the control, printed rather than smoothed over.
   */
  const attackIdeal = nearestDial(targetAttackS, depth, effectiveAttackS).dial
  const releaseIdeal = nearestDial(targetReleaseS, depth, effectiveReleaseS).dial
  converged = attackIdeal === attack && releaseIdeal === release
  return {
    preset, final, target, got, converged, attackIdeal, releaseIdeal,
    atTravelEnd: {
      attack: (attack === 1 || attack === 7) && Math.abs(Math.log(effectiveAttackS(attack, depth) / targetAttackS)) > 0.1,
      release: (release === 1 || release === 7) && Math.abs(Math.log(effectiveReleaseS(release, depth) / targetReleaseS)) > 0.1,
    },
    inputDriveExact: inputDrive,
    attackTargetS: targetAttackS,
    attackGotS: effectiveAttackS(attack, depth),
    releaseTargetS: targetReleaseS,
    releaseGotS: effectiveReleaseS(release, depth),
  }
}

async function report(legacyPath) {
  const OLD = await loadAsCutKernel(legacyPath)
  const x = narration()
  console.log('\nFET Punch factory presets — re-derived against the current kernel')
  console.log('Target: what each preset DID when it was cut.\n')
  const rows = AS_CUT.map(p => recut(OLD, p, x))

  console.log('  preset                dials as cut -> re-cut        avg GR as cut / now')
  for (const r of rows) {
    const a = r.preset
    const b = r.final
    console.log(`  ${a.id.padEnd(20)} in ${String(a.inputDrive).padStart(3)}->${String(b.inputDrive).padStart(3)}` +
      `  atk ${a.attack}->${b.attack}  rel ${a.release}->${b.release}` +
      `        ${r.target.avg.toFixed(2).padStart(5)} / ${r.got.avg.toFixed(2).padStart(5)} dB`)
  }

  console.log('\n  BALLISTICS, effective at each preset\'s own working depth (ms)')
  console.log('  preset                attack want / got        release want / got')
  for (const r of rows) {
    const pc = (got, want) => `${((got / want - 1) * 100 >= 0 ? '+' : '')}${((got / want - 1) * 100).toFixed(0)}%`
    console.log(`  ${r.preset.id.padEnd(20)} ${(r.attackTargetS * 1e3).toFixed(3).padStart(7)} / ` +
      `${(r.attackGotS * 1e3).toFixed(3).padStart(7)} ${pc(r.attackGotS, r.attackTargetS).padStart(6)}` +
      `    ${(r.releaseTargetS * 1e3).toFixed(1).padStart(7)} / ${(r.releaseGotS * 1e3).toFixed(1).padStart(7)} ` +
      `${pc(r.releaseGotS, r.releaseTargetS).padStart(6)}`)
  }
  console.log('\n  ⚠ Percentages are the cost of the dials being integers. A preset whose')
  console.log('    ideal lands between two positions cannot be matched exactly and the')
  console.log('    residual belongs in the record rather than in a rounded-away claim.')
  for (const r of rows) {
    if (!r.converged) {
      /**
       * ⚠ NOT A FAILURE, AND AN EARLIER VERSION OF THIS PRINTED IT AS ONE. The
       * search keeps the pair with the best COMBINED residual at its own
       * operating point; `nearestDial` answers each axis on its own. The two
       * differ when the dials trade against each other through the depth, which
       * is the normal case and worth seeing rather than suppressing.
       */
      console.log(`  · ${r.preset.id}: joint optimum differs from the per-axis ideal` +
        ` (alone, attack wants ${r.attackIdeal}, release wants ${r.releaseIdeal}) —` +
        ' the two trade through the working depth')
    }
    if (r.atTravelEnd.attack) {
      console.log(`  ⚠ ${r.preset.id}: ATTACK IS AT THE END OF ITS TRAVEL (dial ${r.final.attack}).` +
        ' The old voicing is not reachable; the residual above is a floor, not a rounding.')
    }
    if (r.atTravelEnd.release) {
      console.log(`  ⚠ ${r.preset.id}: RELEASE IS AT THE END OF ITS TRAVEL (dial ${r.final.release}).` +
        ' The old voicing is not reachable; the residual above is a floor, not a rounding.')
    }
  }
  /**
   * ⚠ WHERE THE TARGET IS STRADDLED, THE CHOICE IS A JUDGEMENT AND BELONGS TO
   * WHOEVER VOICES THE PRESET. Two adjacent dials can sit either side of the old
   * constant with comparable error, and the combined score picks one on
   * arithmetic that knows nothing about what the preset is FOR — "onsets pass"
   * argues for the slower side whatever the residual says.
   */
  console.log('\n  ATTACK: the two nearest dials, so a straddle is visible')
  console.log('  preset                chosen            the other side')
  for (const r of rows) {
    const depth = r.got.peak
    const alt = [r.final.attack - 1, r.final.attack + 1].filter(d => d >= 1 && d <= 7)
      .map(d => ({ d, s: effectiveAttackS(d, depth) }))
      .sort((a, b) => Math.abs(Math.log(a.s / r.attackTargetS)) - Math.abs(Math.log(b.s / r.attackTargetS)))[0]
    const pc = (s2) => `${((s2 / r.attackTargetS - 1) * 100 >= 0 ? '+' : '')}${((s2 / r.attackTargetS - 1) * 100).toFixed(0)}%`
    console.log(`  ${r.preset.id.padEnd(20)} dial ${r.final.attack}  ${(r.attackGotS * 1e3).toFixed(3)} ms ${pc(r.attackGotS).padStart(6)}` +
      `     dial ${alt.d}  ${(alt.s * 1e3).toFixed(3)} ms ${pc(alt.s).padStart(6)}`)
  }

  console.log('\n  ⚠ factory:all-buttons-in is NOT re-cut — its law is unmeasured. See the header.\n')
  return rows
}

function selftest() {
  console.log('\nPreset re-cut self-test\n')
  let bad = 0
  const x = narration()
  const ok = (label, cond) => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : '⚠ FAIL'}  ${label}`) }

  ok('the fixture is speech-shaped, not a tone', x.some(v => Math.abs(v) > 0.3) && x.some(v => Math.abs(v) < 1e-3))
  // The schedules must actually bite, or matching on them is theatre.
  ok('the attack schedule moves the constant with depth',
    Math.abs(effectiveAttackS(4, 6) / effectiveAttackS(4, 18) - 1) > 0.5)
  ok('the release schedule moves the constant with depth',
    Math.abs(effectiveReleaseS(4, 6) / effectiveReleaseS(4, 18) - 1) > 0.5)
  // A dial search that cannot return the ends is not a search.
  ok('nearestDial reaches both ends of the travel',
    nearestDial(1e-9, 12, effectiveAttackS).dial === 7 && nearestDial(1, 12, effectiveAttackS).dial === 1)
  console.log(`\n  ${bad === 0 ? 'PASS' : `⚠ ${bad} FAILED`}\n`)
  return bad
}

if (basename(process.argv[1] ?? '') === 'fet-recut-presets.mjs') {
  if (process.argv.includes('--selftest')) process.exit(selftest() === 0 ? 0 : 1)
  else {
    const i = process.argv.indexOf('--as-cut')
    if (i < 0 || !process.argv[i + 1]) {
      console.log('\nUsage: node scripts/fet-recut-presets.mjs --as-cut <path to the 57e1877 processor>')
      console.log('  git show 57e1877:src/audio/fet1176Processor.js > /tmp/as-cut.mjs\n')
      process.exit(1)
    }
    await report(process.argv[i + 1])
  }
}
