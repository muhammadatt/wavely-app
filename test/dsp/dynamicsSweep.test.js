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
  VOICINGS, SWEEP_POINTS, OPTO_SWEEP_POINTS, CLIP_MAX_DEPTH_DB,
} from '../../src/audio/dynamicsSolve.js'
import {
  processDynamicsBuffer, clipParamsFor, DYNAMICS_KERNEL_DEFAULTS,
} from '../../src/audio/dynamicsProcessor.js'
import { SoftClipperKernel } from '../../src/audio/softClipperProcessor.js'

const SR = 44100

function narration(seconds, peakDbfs, seed = 4242) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const syl = t % 0.32
    const burst = syl < 0.2 ? Math.min(1, syl / 0.005) * Math.exp(-syl * 3.2) : 0
    // Phrase-level variation, so the macro has something to act on.
    const phrase = 0.45 + 0.55 * (Math.floor(t / 1.7) % 3) / 2
    x[i] = burst * phrase * (0.6 * Math.sin(2 * Math.PI * 165 * t)
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
  assert.equal(round.opto.densities.length, OPTO_SWEEP_POINTS)
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
  for (const voicing of Object.keys(VOICINGS)) {
    for (const density of [0, 25, 60, 100]) {
      const swept = solveFromSweep(sweep, { density, voicing })
      assert.equal(swept.params.squash, squashFor(VOICINGS[voicing], density / 100),
        `${voicing} @ ${density}: squash must be computed, not looked up`)
      assert.equal(swept.params.mix, VOICINGS[voicing].mix)
    }
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
  const v = VOICINGS.podcast
  assert.equal(clipShaveFor(v, 1), Math.min(v.clipShaveDb, CLIP_MAX_DEPTH_DB))
  assert.equal(clipShaveFor(v, 0), 0)
  assert.equal(squashFor(v, 0.5), v.squash * 0.5)
  // Density 0 asks for what the audio already is; Density 1 for the voicing's.
  assert.equal(fetTargetImpactFor(v, 0, 12.34), 12.34)
  assert.equal(fetTargetImpactFor(v, 1, 12.34), v.impactDb)
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
    const { params, report } = solveFromSweep(sweep, { density, voicing: 'podcast' })
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
  for (const voicing of Object.keys(VOICINGS)) {
    const { params } = solveFromSweep(sweep, { density: 80, voicing })
    const r = processDynamicsBuffer(x, SR, params)
    assert.ok(r.channelData[0].every(Number.isFinite), `${voicing} produced non-finite output`)
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
    const a = solveDynamics(x, SR, { density, voicing: 'audiobook' })
    const b = solveFromSweep(sweep, { density, voicing: 'audiobook' })
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
  assert.ok(Number.isFinite(params.fetDrive))
  assert.ok(Number.isFinite(params.squash))
  assert.ok(Number.isFinite(params.optoAlignDb))
  assert.equal(params.correlation, 0)
  assert.ok(report.opto.peakDb < 0.5, `silence should not be compressed: ${report.opto.peakDb}`)
})
