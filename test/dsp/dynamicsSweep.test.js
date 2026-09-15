/**
 * Run with:  npm test
 *
 * THE DENSITY SWEEP — see `sweepDynamics` in src/audio/dynamicsSolve.js.
 *
 * ⚠ THESE PIN THE CONTRACT, NOT THE ACCURACY. The sweep's accuracy against the
 * bisect it replaces is a claim about real narration and is scored by
 * `npm run dynamics:sweep` on a corpus file; a synthetic stimulus would pin a
 * tolerance that means nothing (the last thing measured on this section, the
 * opto's "spread minimum", was a synthetic artifact that real speech
 * demolished). What is pinned here is what cannot be allowed to drift: that the
 * lookup costs no renders, that it agrees with the bisect on the quantities
 * that are COMPUTED rather than interpolated, and that both paths run the same
 * target arithmetic.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  sweepDynamics, solveFromSweep, solveDynamics, measureDynamics,
  clipShaveFor, fetTargetImpactFor, squashFor,
  effectiveTarget, BALANCE_IMPACT_DB, BALANCE_SQUASH_SCALE, MAX_SQUASH,
  DYNAMICS_TARGET, CLIP_SHAVE_DETENTS, DEFAULT_CLIP_SHAVE_DB, DEFAULT_MIX,
  makeupDbFor, MAKEUP_PEAK_MARGIN_DB, MAKEUP_TRIM_MARGIN_DB,
  maxDropFor, MAX_IMPACT_DROP_DB, FET_MAX_SOLVE_DRIVE,
  SWEEP_POINTS, OPTO_GRID_DRIVES, OPTO_GRID_SQUASH, CLIP_MAX_DEPTH_DB,
} from '../../src/audio/dynamicsSolve.js'
import {
  processDynamicsBuffer, clipParamsFor, DYNAMICS_KERNEL_DEFAULTS,
} from '../../src/audio/dynamicsProcessor.js'
import { SoftClipperKernel } from '../../src/audio/softClipperProcessor.js'
import { inputAlignDbFor } from '../../src/audio/dsp/inputAlign.js'

const SR = 44100
const ACCENT_EVERY = 7
const ACCENT_GAIN = 2.6

/**
 * ⚠ `accentGain` IS HOW THIS FILE GETS A LOW-IMPACT STIMULUS. Dropping it to 1
 * removes the stressed onsets and takes impact from ~14.9 to ~11.0 — below the
 * absolute target, which is the material the relative floor exists for. It is
 * the same generator, so nothing else about the signal moves with it.
 */
function narration(seconds, peakDbfs, seed = 4242, accentGain = ACCENT_GAIN) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1
  /**
   * ⚠ THE ACCENTS ARE LOAD-BEARING AND WERE ADDED AFTER A CALIBRATION SHIPPED
   * WRONG BECAUSE THEY WERE MISSING. Without them this generator reads impact
   * 10.8-11.3 dB against real narration's 13.2-14.8 — a flat train of identical
   * syllables has no plosives and no stressed onsets, so p99.9 sits much closer
   * to the body than speech ever does.
   *
   * That single number is why `impactDb` was calibrated at 8.5: reachable here,
   * 3 dB below the floor on every real voice, and the FET pinned at full drive
   * on narration for months without anything looking wrong. Every impact-based
   * assertion in this file is only meaningful if the stimulus is as punchy as
   * the material — so one syllable in seven is accented, which puts it at
   * impact ~14.7 / crest ~17.7.
   */
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const syl = t % 0.32
    const burst = syl < 0.2 ? Math.min(1, syl / 0.005) * Math.exp(-syl * 3.2) : 0
    // Phrase-level variation, so the macro has something to act on.
    const phrase = 0.45 + 0.55 * (Math.floor(t / 1.7) % 3) / 2
    const accent = Math.floor(t / 0.32) % ACCENT_EVERY === 0 ? accentGain : 1
    x[i] = burst * phrase * accent * (0.6 * Math.sin(2 * Math.PI * 165 * t)
      + 0.25 * Math.sin(2 * Math.PI * 880 * t) + 0.15 * rnd())
  }
  let pk = 0
  for (const v of x) pk = Math.max(pk, Math.abs(v))
  const g = Math.pow(10, peakDbfs / 20) / pk
  for (let i = 0; i < n; i++) x[i] = Math.fround(x[i] * g)
  return x
}

test('a sweep is plain numbers, so it crosses the worker boundary', () => {
  const sweep = sweepDynamics([narration(8, -6)], SR)
  // structuredClone throws on anything that is not cloneable — a typed array
  // would survive, a kernel or a closure would not.
  const round = structuredClone(sweep)
  assert.equal(round.clip.thresholds.length, SWEEP_POINTS)
  assert.equal(round.fet.drives.length, SWEEP_POINTS)
  assert.equal(round.opto.drives.length, OPTO_GRID_DRIVES)
  assert.equal(round.opto.squash.length, OPTO_GRID_SQUASH)
  assert.equal(round.opto.peakDb.length, OPTO_GRID_DRIVES)
  assert.equal(round.opto.peakDb[0].length, OPTO_GRID_SQUASH)
  assert.equal(JSON.stringify(round.blend), JSON.stringify(sweep.blend))
})

test('⚠ a lookup does NO rendering — that is the entire point', () => {
  const x = [narration(10, -6)]
  const sweep = sweepDynamics(x, SR)

  // A render of this length cannot complete in single-digit milliseconds; the
  // bisect it replaces is seconds. This is a coarse guard on purpose — it is
  // pinning "no renders", not a performance budget.
  const t = performance.now()
  for (let d = 0; d <= 100; d += 5) solveFromSweep(sweep, { density: d })
  const ms = performance.now() - t
  assert.ok(ms < 50, `21 lookups took ${ms.toFixed(1)} ms — something is rendering`)
})

test('⚠ the COMPUTED params match the bisect exactly; only the searches differ', () => {
  /**
   * `squash` and the two alignments are not interpolated targets — squash is a
   * calibrated constant scaled by Density, and `fetAlignDb` is a measurement.
   * If either drifts from the bisect the two paths have stopped agreeing about
   * what the section IS, which is a different failure from an interpolation
   * being a little off.
   */
  const x = [narration(10, -6)]
  const sweep = sweepDynamics(x, SR)
  for (const density of [0, 25, 60, 100]) {
    const swept = solveFromSweep(sweep, { density })
    assert.equal(swept.params.squash, squashFor(DYNAMICS_TARGET.squash, density / 100),
      `@ ${density}: squash must be computed, not looked up`)
    assert.equal(swept.params.mix, DEFAULT_MIX)
  }
})

test('⚠ both paths run the SAME target arithmetic, not two copies of it', () => {
  /**
   * The sweep and the bisect differ only in how they find the knob that reaches
   * a target. If each spelled the target out for itself they would drift, and
   * the drift would read as an interpolation error rather than as a second copy
   * of a formula — which is exactly the kind of thing the bench would score as
   * noise. So the arithmetic is shared, and this pins that it is.
   */
  assert.equal(clipShaveFor(3, 1), Math.min(3, CLIP_MAX_DEPTH_DB))
  assert.equal(clipShaveFor(3, 0), 0)
  assert.equal(squashFor(DYNAMICS_TARGET.squash, 0.5), DYNAMICS_TARGET.squash * 0.5)
  // Density 0 asks for what the audio already is; Density 1 for the target.
  assert.equal(fetTargetImpactFor(DYNAMICS_TARGET.impactDb, 0, 12.34), 12.34)
  assert.equal(fetTargetImpactFor(DYNAMICS_TARGET.impactDb, 1, 12.34), DYNAMICS_TARGET.impactDb)
})

test('the clipper\'s hard cap survives the interpolation', () => {
  /**
   * ⚠ THE ONE THING THE FIRST SWEEP GOT WRONG. Its inversion solved only the
   * crest target and ignored the depth cap, so at high Density it ran off the
   * end of the sampled range and cost 1.32 dB of impact. The bisect satisfies
   * both constraints in one search; a lookup has to invert BOTH curves and take
   * the shallower threshold.
   */
  const x = [narration(10, -6)]
  const sweep = sweepDynamics(x, SR)
  for (const density of [60, 80, 100]) {
    const { params, report } = solveFromSweep(sweep, { density, clipShaveDb: 3 })
    assert.ok(Number.isFinite(report.clip.thresholdDb),
      `density ${density}: threshold ran off the sampled range`)
    /**
     * ⚠ MEASURED ON A RENDER, NOT READ OFF THE REPORT. The report's depth is
     * itself interpolated, so asserting on it only checks that the lookup is
     * self-consistent — it would pass while the clipper actually exceeded the
     * cap, which is exactly what a hard bound must not do. The depth curve is
     * convex, so linear interpolation UNDERSTATES it.
     */
    const k = new SoftClipperKernel(SR)
    k.setParams(clipParamsFor({ ...DYNAMICS_KERNEL_DEFAULTS, ...params }))
    const out = x.map(c => new Float32Array(c.length))
    for (let off = 0; off < x[0].length; off += 128) {
      const len = Math.min(128, x[0].length - off)
      k.process(x.map(c => c.subarray(off, off + len)),
        out.map(c => c.subarray(off, off + len)), len)
    }
    const real = k.getMetering().maxReductionDb
    assert.ok(real <= CLIP_MAX_DEPTH_DB + 0.35,
      `density ${density}: clipper really took ${real.toFixed(2)} dB against a `
      + `${CLIP_MAX_DEPTH_DB} dB cap (report said ${report.clip.depthDb.toFixed(2)})`)
  }
})

test('⚠ a non-monotonic crest curve does not send the clipper to the far end', () => {
  /**
   * ⚠ THE CLIPPER'S CREST CURVE TURNS AROUND, and the first lookup assumed it
   * could not. Measured over 24 dB of threshold on tight-crest material: crest
   * falls to a minimum and then RISES, because past that point deep clipping
   * pulls the BODY down faster than the peak. The endpoint shortcut in
   * `crossingOf` — "below the last sample means unreachable" — then fired on
   * the wrong end and returned the DEEPEST threshold sampled, 24 dB below peak.
   *
   * ⚠ AND THE REFERENCE NARRATION NEVER SHOWED IT. Its crest is 19.79 dB and
   * its curve does not turn inside the range, so the corpus bench scored 0.064
   * dB while this stimulus was 0.65 dB out. One file is not a bench.
   */
  const x = [narration(10, -6)]
  const sweep = sweepDynamics(x, SR)
  const deepest = sweep.clip.thresholds[0]
  for (const density of [20, 30, 50]) {
    const { params } = solveFromSweep(sweep, { density })
    assert.ok(params.clipThresholdDb > deepest + 6,
      `density ${density}: threshold ${params.clipThresholdDb.toFixed(2)} ran to the `
      + `bottom of the sampled range (${deepest.toFixed(2)})`)
  }
})

test('Density 0 leaves the section alone, and the clipper stays bypassed', () => {
  const x = [narration(8, -6)]
  const sweep = sweepDynamics(x, SR)
  const { params, report } = solveFromSweep(sweep, { density: 0 })
  assert.equal(params.clipThresholdDb, null, 'nothing to shave means no threshold')
  assert.equal(params.squash, 0)
  assert.equal(report.clip.depthDb, 0)
})

test('swept params render through the real kernel cleanly', () => {
  const x = [narration(10, -6)]
  const sweep = sweepDynamics(x, SR)
  for (const clipShaveDb of CLIP_SHAVE_DETENTS) {
    const { params } = solveFromSweep(sweep, { density: 80, clipShaveDb })
    const r = processDynamicsBuffer(x, SR, params)
    assert.ok(r.channelData[0].every(Number.isFinite), `clip ${clipShaveDb} produced non-finite output`)
    assert.equal(r.latencySamples, 150)
  }
})

test('⚠ the sweep and the bisect agree on what the head DELIVERS', () => {
  /**
   * ⚠ SCORED ON THE RESULT, NEVER ON THE KNOBS. Both curves are shallow near
   * the solution, so the two paths routinely disagree by up to 0.73 dB of
   * threshold and 0.7 of drive while delivering the same thing — on real
   * narration, 0.064 dB of impact. Scoring knob positions would reject a sweep
   * that is audibly identical.
   *
   * The tolerance here is loose on purpose: this stimulus is synthetic, and the
   * number that means something is the corpus one from `npm run dynamics:sweep`.
   * What this catches is a sweep that has stopped tracking the solve at all.
   */
  const x = [narration(12, -6)]
  const sweep = sweepDynamics(x, SR)
  for (const density of [30, 60, 100]) {
    const a = solveDynamics(x, SR, { density })
    const b = solveFromSweep(sweep, { density })
    const deliver = (params) => {
      const r = processDynamicsBuffer(x, SR, params)
      return measureDynamics([r.channelData[0].subarray(r.latencySamples)], SR)
    }
    const gap = Math.abs(deliver(a.params).impactDb - deliver(b.params).impactDb)
    assert.ok(gap < 0.5, `density ${density}: delivered impact differs by ${gap.toFixed(3)} dB`)
  }
})

test('silence is swept and looked up without crashing', () => {
  const quiet = [new Float32Array(SR * 8)]
  const sweep = sweepDynamics(quiet, SR)
  const { params, report } = solveFromSweep(sweep, { density: 100 })
  // Nothing to reduce, so the FET bypasses rather than attenuating by 24 dB.
  assert.ok(params.fetDrive === null || Number.isFinite(params.fetDrive))
  assert.ok(Number.isFinite(params.squash))
  assert.ok(Number.isFinite(params.optoAlignDb))
  assert.equal(params.correlation, 0)
  assert.ok(report.opto.peakDb < 0.5, `silence should not be compressed: ${report.opto.peakDb}`)
})

test('⚠ Balance moves the two target numbers in OPPOSITE senses', () => {
  /**
   * ⚠ THE SIGNS ARE THE EASY THING TO GET BACKWARDS. A HIGHER `impactDb` is a
   * SLACKER target — it asks the FET to leave more peak-to-body alone — so
   * leaning toward the opto RAISES it. `squash` is a depth, so leaning toward
   * the opto raises that too. Both go up together; only one of them means
   * "do less". An inverted sign here would make Balance a second Density.
   */
  const v = DYNAMICS_TARGET
  const opto = effectiveTarget(1)
  const fet = effectiveTarget(-1)

  assert.equal(opto.impactDb, v.impactDb + BALANCE_IMPACT_DB)
  assert.equal(fet.impactDb, v.impactDb - BALANCE_IMPACT_DB)
  assert.ok(opto.squash > v.squash && fet.squash < v.squash)
  /**
   * ⚠ THE CLIPPER AND THE BLEND ARE NOT PART OF THE TRADE, and now they cannot
   * be by construction: `effectiveTarget` returns only the two numbers Balance
   * moves. They used to live in the same object and the test had to assert they
   * came back unchanged.
   */
  assert.deepEqual(Object.keys(opto).sort(), ['impactDb', 'squash'])
  // Centre is the target itself, untouched — not a rebuilt copy of it.
  assert.equal(effectiveTarget(0), v)
  // A stray percent pins rather than running away.
  assert.deepEqual(effectiveTarget(75), effectiveTarget(1))
  assert.deepEqual(effectiveTarget(NaN), v)
})

test('⚠ the opto grid reaches the deepest squash ANY voicing can ask for', () => {
  /**
   * The grid is what the reported opto reduction is read from. If its squash
   * axis stopped at the widest voicing, every leaned patch would land on the
   * clamp — reporting the same number for Balance +50 and +100. `MAX_SQUASH` is
   * derived from the target and the Balance range for exactly that reason.
   */
  assert.ok(effectiveTarget(1).squash <= MAX_SQUASH + 1e-9,
    `${DYNAMICS_TARGET.squash} leaned to ${effectiveTarget(1).squash} exceeds the grid`)
  assert.equal(MAX_SQUASH, DYNAMICS_TARGET.squash * (1 + BALANCE_SQUASH_SCALE))
})

test('Balance actually shifts the work between the two compressors', () => {
  const x = [narration(12, -6)]
  const sweep = sweepDynamics(x, SR)
  const at = (balance) => {
    const { params } = solveFromSweep(sweep, { density: 50, balance })
    const r = processDynamicsBuffer(x, SR, params)
    return { fet: r.metering.fet.peak, opto: r.metering.opto.peak }
  }
  const fetLean = at(-1)
  const even = at(0)
  const optoLean = at(1)

  assert.ok(optoLean.opto > even.opto && even.opto > fetLean.opto,
    `opto should deepen toward +1: ${fetLean.opto} / ${even.opto} / ${optoLean.opto}`)
  assert.ok(optoLean.fet < even.fet,
    `the FET should back off toward +1: ${even.fet} -> ${optoLean.fet}`)
})

test('⚠ the FET BYPASSES when the target is met — drive 0 is a 24 dB attenuator', () => {
  /**
   * ⚠ THIS IS THE HAZARD THE RECALIBRATION EXPOSED, and it was latent for as
   * long as the targets were unreachable.
   *
   * `crossingOf` returns the FIRST sampled drive when the target is already
   * met, which is 0. Correct as a curve lookup, catastrophic as a setting: the
   * FET's Input knob attenuates the AUDIO PATH as well as the detector, exactly
   * as the hardware wires it, so drive 0 delivers 0.07 dB of gain reduction and
   * takes the signal down 24.00 dB. Measured.
   *
   * It never came up while every target sat below the floor. The moment the
   * targets became reachable, the gentlest voicing on the least punchy file
   * selected it.
   */
  const x = [narration(10, -6)]
  const sweep = sweepDynamics(x, SR)
  // A target far slacker than the material can possibly need.
  // A target far slacker than the material can possibly need. Balance is the
  // only way to move it now, and its range is not enough — so this asks the
  // solve directly, which is what the panel's detents cannot produce.
  const { params, report } = solveFromSweep(sweep, { density: 0.0001, clipShaveDb: 0 })

  assert.equal(params.fetDrive, null, 'an unneeded FET must bypass, never sit at drive 0')
  assert.equal(report.fet.peakDb, 0)

  /**
   * And a bypassed FET is a pass-through, not a 24 dB drop.
   *
   * ⚠ `makeupDb` GOES WITH THE OTHER TWO. This forces a configuration the solve
   * never produces — all three stages off — so the output gain the solve
   * computed for the opto block it DID expect no longer describes anything.
   * Leaving it in makes the render legitimately non-identical (measured 1.45 dB)
   * and says nothing about the kernel's bypass, which is what this pins.
   */
  const r = processDynamicsBuffer(x, SR, {
    ...params, squash: null, clipThresholdDb: null, makeupDb: 0,
  })
  const out = r.channelData[0]
  for (let i = 0; i < x[0].length - r.latencySamples; i++) {
    assert.equal(out[i + r.latencySamples], x[0][i], `not bit-exact at ${i}`)
  }
})

test('⚠ an unreachable impact target is REPORTED, not silently pinned', () => {
  /**
   * Impact has only ~3 dB of travel through this device on real narration — it
   * moves 3.3 dB across the whole drive range and plateaus at 60, because
   * compressing the loud parts pulls the body down with them. A target below
   * that floor pins the drive at 100 and, without this flag, looks exactly like
   * a target that was met. That silence is how 26 dB of gain reduction shipped.
   *
   * ⚠ THE CAP IS PROVOKED BY SHRINKING THE SWEEP'S OWN CURVE, not by an option
   * the solve would otherwise not have. A sweep is plain data by construction —
   * it crosses the worker boundary as a structured clone — so a test can hand it
   * a low-authority device directly. The alternative was a target override on
   * `solveFromSweep`, which would be a back door into the one thing the panel
   * deliberately no longer exposes.
   *
   * ⚠ AND THE SYNTHETIC STIMULUS CANNOT REACH IT UNAIDED, which is worth
   * recording: it has 5.37 dB of drop authority where real narration has 3.3, so
   * even Balance at full FET lean stays reachable on it. The generator is
   * unrepresentative in BOTH directions and has now been caught being so twice.
   */
  const x = [narration(10, -6)]
  const real = sweepDynamics(x, SR)
  assert.ok(Math.max(...real.fet.impactDrop) > 3,
    'the stimulus should have real FET authority before it is taken away')

  // Same sweep, with the FET able to remove almost nothing.
  const starved = {
    ...real,
    fet: { ...real.fet, impactDrop: real.fet.impactDrop.map(v => v * 0.05) },
  }
  const { params, report } = solveFromSweep(starved, { density: 100, balance: -1 })

  /**
   * ⚠ IT RUNS OUT AT THE PLATEAU, NOT AT 100. Past `FET_MAX_SOLVE_DRIVE` the
   * knob buys almost no further impact and costs enormous gain reduction, so
   * the solve stops there and reports the miss — measured, an uncapped rail
   * spent 20.49 dB of reduction to come 1.11 dB short. The cap changes where it
   * gives up, never whether it says so.
   */
  assert.equal(params.fetDrive, FET_MAX_SOLVE_DRIVE, 'the drive should stop at the plateau')
  assert.ok(report.fet.capped, 'an unreachable target must be flagged')
  assert.ok(report.fet.shortfallDb > 1,
    `the shortfall should be reported: ${report.fet.shortfallDb}`)

  // And the real device, which CAN reach its target, reports no shortfall.
  const ok = solveFromSweep(real, { density: 100 })
  assert.equal(ok.report.fet.capped, false)
  assert.equal(ok.report.fet.shortfallDb, 0)
})

test('⚠ the section makes up the level the FET attenuator took', () => {
  /**
   * ⚠ IT SHIPPED WITHOUT MAKEUP AND CAME OUT 16 dB QUIET. The FET's Input knob
   * attenuates the AUDIO PATH as well as the detector, so every drive the solve
   * picks costs level — measured on narration at Density 70, the output peak sat
   * 15.86 dB below the input and the body 11.93 below, with the trim at 0.
   *
   * The zero was deliberate: the note said the level belonged to "the chain's
   * tone section and delivery solve" to give back. Those do not exist and this
   * section ships standalone, so the deferral left the plugin unusable.
   */
  const x = [narration(12, -6)]
  const before = measureDynamics(x, SR)
  const sweep = sweepDynamics(x, SR)

  for (const density of [40, 70, 100]) {
    const { params } = solveFromSweep(sweep, { density })
    assert.ok(params.makeupDb > 3,
      `density ${density}: the makeup should be substantial, got ${params.makeupDb}`)
    const r = processDynamicsBuffer(x, SR, params)
    const after = measureDynamics([r.channelData[0].subarray(r.latencySamples)], SR)
    assert.ok(after.gatedDb > before.gatedDb - 3,
      `density ${density}: body fell ${(before.gatedDb - after.gatedDb).toFixed(2)} dB — `
      + 'the section should not come out quiet')
  }
})

test('⚠ the makeup can never push the output past the input peak', () => {
  /**
   * The percentile reference is the house one — a peak reference lets a single
   * uncompressed onset pin the file — and the house rule is that it ships with a
   * ceiling because it can overshoot. This section deliberately holds no
   * ceiling, so the guarantee is arithmetic instead: the trim is capped by the
   * headroom, less a margin sized to the measured under-read of the peak lookup.
   *
   * ⚠ WITHOUT THE MARGIN 68 OF 240 MEASURED COMBINATIONS OVERSHOT, by up to 1.97
   * dB, because the PEAK does not interpolate the way level does.
   */
  const x = [narration(12, -6)]
  const before = measureDynamics(x, SR)
  const sweep = sweepDynamics(x, SR)
  for (const density of [5, 20, 60, 100]) {
    for (const mix of [0, 0.5, 1]) {
      const { params } = solveFromSweep(sweep, { density, mix })
      const r = processDynamicsBuffer(x, SR, params)
      const after = measureDynamics([r.channelData[0].subarray(r.latencySamples)], SR)
      assert.ok(after.peakDb <= before.peakDb + 0.01,
        `D${density} mix ${mix}: output peaked ${after.peakDb.toFixed(2)} against an input `
        + `peak of ${before.peakDb.toFixed(2)}`)
    }
  }
})

test('⚠ a bypassed FET is not the drive-0 attenuator — the makeup must know', () => {
  /**
   * ⚠ THE FOURTH TIME `fetDrive ?? 0` HAS BITTEN. Drive 0 is a 24 dB attenuator,
   * so reading the FET's level curve there told the makeup the output was 24 dB
   * down when the stage had simply been skipped. Measured: +24.16 dB over the
   * input peak. With the FET out, the dry path is the post-CLIP signal, which the
   * clipper's own curve carries.
   */
  const x = [narration(10, -6)]
  const before = measureDynamics(x, SR)
  const sweep = sweepDynamics(x, SR)
  // Density near zero leaves nothing for the FET to do, so it bypasses.
  const { params } = solveFromSweep(sweep, { density: 0.0001, clipShaveDb: 0 })
  assert.equal(params.fetDrive, null, 'this case is only interesting with the FET out')
  assert.ok(params.makeupDb < 1,
    `a bypassed FET took no level, so there is nothing to make up: ${params.makeupDb}`)

  const r = processDynamicsBuffer(x, SR, params)
  const after = measureDynamics([r.channelData[0].subarray(r.latencySamples)], SR)
  assert.ok(after.peakDb <= before.peakDb + 0.01,
    `output peaked ${after.peakDb.toFixed(2)} against ${before.peakDb.toFixed(2)}`)
})

test('⚠ a bypassed FET is not the drive-0 attenuator — the OPTO must know either', () => {
  /**
   * ⚠ THE FIFTH TIME, AND THE FIRST THAT WAS AUDIBLE. The makeup learned that a
   * null drive is not drive 0; `optoAlignDb` did not, and read the FET's
   * alignment curve unconditionally. At drive 0 that curve describes a signal
   * 24 dB down, so a bypassed FET handed the opto a +25 dB side-chain offset
   * for a signal nothing had attenuated.
   *
   * Measured on a file whose impact already meets the target, so the FET
   * bypasses at every Density: align 25.43 against a true 1.37, and the opto
   * did 10.29 dB of gain reduction at Density 30 where its calibration asks for
   * about one. The panel reported 0.00 throughout, because the report grid
   * clamped the same null to its own drive-0 row.
   *
   * With the FET out the opto's input IS the post-clip signal, whose alignment
   * the clip sweep now carries.
   */
  const x = [narration(10, -6)]
  const sweep = sweepDynamics(x, SR)
  const { params } = solveFromSweep(sweep, { density: 0.0001, clipShaveDb: 0 })
  assert.equal(params.fetDrive, null, 'this case is only interesting with the FET out')

  // The clipper is out too, so the opto's input is the section's input.
  const truth = inputAlignDbFor(x, SR)
  assert.ok(Math.abs(params.optoAlignDb - truth) < 0.5,
    `opto aligned to ${params.optoAlignDb.toFixed(2)} for a signal at ${truth.toFixed(2)}`)
  assert.ok(params.optoAlignDb < sweep.fet.outAlignDb[0] - 10,
    'the drive-0 row is the attenuator and must not be what the opto reads')
})

test('⚠ the bisect renders a bypassed FET as a bypass, not as drive 50', () => {
  /**
   * `fetParamsFor` reads a missing `fetDrive` as the kernel default, so the
   * solve's own `renderFet` used to hand back a drive-50 render for a stage
   * that had been skipped — and the opto's alignment, the blend and the makeup
   * were all measured from that phantom signal. Only `solveFromSweep` ships,
   * but the bisect is what the sweep is scored against.
   */
  const x = [narration(10, -6)]
  const { params, report } = solveDynamics(x, SR, { density: 0.0001, clipShaveDb: 0 })
  assert.equal(params.fetDrive, null)
  assert.equal(report.fet.peakDb, 0, 'a bypassed stage reduces nothing')
  assert.ok(Math.abs(params.optoAlignDb - inputAlignDbFor(x, SR)) < 0.5,
    `opto aligned to ${params.optoAlignDb.toFixed(2)} off a render that never happens`)
})

test('⚠ the makeup TRIMS when the section is predicted over the input peak', () => {
  /**
   * ⚠ `Math.max(0, …)` IS RIGHT ABOUT MAKEUP AND WRONG AS THE ONLY THING
   * HOLDING THE PEAK. "Never louder than the source" was enforced by withholding
   * makeup — which works only while there is makeup to withhold. On material
   * whose impact already meets the target every stage bypasses, the makeup is
   * zero, and the opto block's Pultec gain still reaches the blend: measured
   * 2.31 dB past the input peak at Mix 1.
   */
  // Predicted output already 2 dB over the input peak, and no makeup wanted.
  const over = makeupDbFor(-20, -6, -20, -4)
  assert.ok(over < 0, `a section predicted over the peak must trim, got ${over}`)
  assert.equal(over, -2 - MAKEUP_TRIM_MARGIN_DB)

  // And a section predicted UNDER the peak is untouched — every case that was
  // already legal must stay bit-for-bit what it was.
  assert.equal(makeupDbFor(-20, -6, -20, -20), Math.min(0, 14 - MAKEUP_PEAK_MARGIN_DB))
  // And the percentile target still binds ahead of the peak bound when it is
  // the smaller of the two.
  assert.equal(makeupDbFor(-10, -6, -20, -20), Math.min(10, 14 - MAKEUP_PEAK_MARGIN_DB))
  assert.equal(makeupDbFor(-4, -6, -20, -20), 14 - MAKEUP_PEAK_MARGIN_DB)
})

test('⚠ with the FET out, the wet path is not the dry path', () => {
  /**
   * The wet side is still Pultec pre -> opto -> Pultec post, which has gain of
   * its own. Modelling it as equal to dry made the predicted peak under-read by
   * ~2.5 dB at Mix 1, which is what let the overshoot through.
   *
   * The grid cannot be read for LEVEL at drive 0 — its rows carry the
   * attenuator's 24 dB — so the wet path is read as a GAIN off that row.
   */
  const x = [narration(10, -6)]
  const before = measureDynamics(x, SR)
  const sweep = sweepDynamics(x, SR)
  const { params, report } = solveFromSweep(sweep, { density: 0.0001, clipShaveDb: 0, mix: 1 })
  assert.equal(params.fetDrive, null, 'this case is only interesting with the FET out')

  const r = processDynamicsBuffer(x, SR, params)
  const after = measureDynamics([r.channelData[0].subarray(r.latencySamples)], SR)
  // The prediction is of the output BEFORE the makeup, so add it back.
  assert.ok(Math.abs(report.makeup.outPeakDb + params.makeupDb - after.peakDb) < 0.5,
    `predicted ${(report.makeup.outPeakDb + params.makeupDb).toFixed(2)} `
    + `against ${after.peakDb.toFixed(2)}`)
  assert.ok(after.peakDb <= before.peakDb + 0.01,
    `output peaked ${after.peakDb.toFixed(2)} against ${before.peakDb.toFixed(2)}`)
})

test('⚠ the relative floor gives Density a meaning the file cannot take away', () => {
  /**
   * ⚠ THE ABSOLUTE TARGET MADE DENSITY MEAN "DISTANCE TO 12.2", which is a
   * property of the FILE. A recording arriving at impact 10.98 has no room at
   * all, so the FET bypassed at EVERY Density and the knob bought nothing from
   * that stage. Measured: drive null from Density 10 to 100.
   */
  const flat = [narration(10, -6, 4242, 1.0)]
  assert.ok(measureDynamics(flat, SR).impactDb < DYNAMICS_TARGET.impactDb,
    'this case needs a stimulus with no room under the absolute target')
  const sweep = sweepDynamics(flat, SR)

  for (const density of [30, 70, 100]) {
    const off = solveFromSweep(sweep, { density, relativeTarget: false })
    assert.equal(off.params.fetDrive, null,
      `@ ${density}: the absolute target has nothing to ask for here`)

    const on = solveFromSweep(sweep, { density })
    assert.ok(on.params.fetDrive > 0, `@ ${density}: the floor must reach the stage`)
    assert.ok(on.report.fet.targetImpactDb < off.report.fet.targetImpactDb,
      `@ ${density}: the floor must ask for MORE, not less`)
  }
})

test('⚠ the relative floor never asks for LESS than the absolute target', () => {
  /**
   * Both forms agree exactly at Density 0, and the absolute still binds as a
   * floor so a punchy file is not driven past the house sound. The floor may
   * only ever deepen the ask — `Math.min`, on a metric where lower means more
   * processed.
   */
  for (const afterClip of [10.5, 12.2, 14.9, 18.0]) {
    for (const density of [0, 0.5, 1]) {
      const abs = fetTargetImpactFor(DYNAMICS_TARGET.impactDb, density, afterClip)
      const rel = fetTargetImpactFor(
        DYNAMICS_TARGET.impactDb, density, afterClip, MAX_IMPACT_DROP_DB,
      )
      assert.ok(rel <= abs + 1e-9, `${afterClip} @ ${density}: ${rel} > ${abs}`)
      if (density === 0) assert.equal(rel, afterClip)
    }
  }
  // And the flag is what selects between them, for both solve paths.
  assert.equal(maxDropFor({ relativeTarget: false }), null)
  assert.equal(maxDropFor({}), MAX_IMPACT_DROP_DB)
  assert.equal(maxDropFor({ maxImpactDropDb: 4 }), 4)
})

test('⚠ an unreachable floor caps the drive instead of railing it', () => {
  /**
   * ⚠ IMPACT DROP AGAINST DRIVE PLATEAUS AROUND 60 and the solve does not know
   * it — past that the knob buys almost no further impact and costs enormous
   * gain reduction. Asking the flat stimulus for 3 dB took the drive to 100 and
   * **20.49 dB of gain reduction** to come 1.11 dB short, which is the same
   * silent rail this section shipped once already.
   *
   * The cap is not a way to hide the miss: the shortfall is reported, and
   * reported LARGER because of it.
   */
  const flat = [narration(10, -6, 4242, 1.0)]
  const sweep = sweepDynamics(flat, SR)
  const { params, report } = solveFromSweep(sweep, {
    density: 100, relativeTarget: true, maxImpactDropDb: 6,
  })
  assert.ok(params.fetDrive <= FET_MAX_SOLVE_DRIVE,
    `drive ran to ${params.fetDrive} past the plateau`)
  assert.ok(report.fet.shortfallDb > 0.05, 'an unreachable target must still report')
  assert.equal(report.fet.capped, true)
})
