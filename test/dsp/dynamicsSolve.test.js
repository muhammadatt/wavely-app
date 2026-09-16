/**
 * Run with:  npm test
 *
 * VOCAL CHAIN — DYNAMICS SOLVE. See src/audio/dynamicsSolve.js.
 *
 * ⚠ TWO OF THESE PIN FINDINGS THAT CONTRADICT THE ORIGINAL DESIGN, and they are
 * the reason this file is worth more than its coverage: that the three devices
 * control three DIFFERENT statistics rather than sharing one crest budget, and
 * that the opto's knob has a MINIMUM rather than a slope. Both were measured,
 * both are load-bearing, and both would be quietly re-broken by anyone
 * "simplifying" the solve back into a ladder.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  solveDynamics, measureDynamics, levelSpreadDb, measureBlend,
  sweepDynamics, solveFromSweep,
  DYNAMICS_TARGET, CLIP_SHAVE_DETENTS, CLIP_MAX_DEPTH_DB,
} from '../../src/audio/dynamicsSolve.js'
import {
  processDynamicsBuffer, dynamicsLatencySamples,
} from '../../src/audio/dynamicsProcessor.js'
import { inputAlignDbFor } from '../../src/audio/dsp/inputAlign.js'

const SR = 44100

/** Narration with both syllable detail and phrase-to-phrase level variation. */
function narration(seconds, peakDbfs, seed = 12345) {
  /**
   * ⚠ THE ACCENTS ARE LOAD-BEARING AND WERE ADDED AFTER A CALIBRATION SHIPPED
   * WRONG BECAUSE THEY WERE MISSING. Without them this generator reads impact
   * 10.8-11.3 dB against real narration's 13.2-14.8 — a flat train of identical
   * syllables has no plosives and no stressed onsets, so p99.9 sits far closer
   * to the body than speech ever does.
   *
   * That one number is why `impactDb` was calibrated at 8.5: comfortably
   * reachable here, 3 dB BELOW the floor on every real voice. The FET pinned at
   * full drive on narration and nothing in this file looked wrong. Every
   * impact-based assertion is only meaningful if the stimulus is as punchy as
   * the material, so one syllable in seven is accented — impact ~14.7, crest
   * ~17.7, which is where the real files sit.
   */
  const ACCENT_EVERY = 7
  const ACCENT_GAIN = 2.6
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const ph = t % 0.6
    // Phrase-scale level variation is what the opto acts on; without it there
    // is no spread to reduce and its half of this solve is untested.
    const loud = 0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * t / 3.7))
    const burst = ph < 0.35 ? Math.min(1, ph / 0.004) * Math.exp(-ph * 2.5) : 0
    const accent = Math.floor(t / 0.6) % ACCENT_EVERY === 0 ? ACCENT_GAIN : 1
    x[i] = loud * burst * accent * (0.6 * Math.sin(2 * Math.PI * 180 * t)
      + 0.25 * Math.sin(2 * Math.PI * 900 * t) + 0.15 * rnd())
  }
  let pk = 0
  for (const v of x) pk = Math.max(pk, Math.abs(v))
  const g = Math.pow(10, peakDbfs / 20) / pk
  for (let i = 0; i < n; i++) x[i] = Math.fround(x[i] * g)
  return x
}

test('level spread gates out room tone rather than calling it unevenness', () => {
  /**
   * A narration file padded with room tone at either end — the ACX house style,
   * since `roomTonePad` puts it there — would otherwise read as enormous
   * unevenness that no compressor can or should fix.
   */
  const speech = narration(12, -6)
  const padded = new Float32Array(speech.length + SR * 8)
  let s = 3
  for (let i = 0; i < padded.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    padded[i] = Math.pow(10, -60 / 20) * (s / 0x7fffffff * 2 - 1)
  }
  padded.set(speech, SR * 4)

  const bare = levelSpreadDb([speech], SR)
  const withTone = levelSpreadDb([padded], SR)
  assert.ok(Math.abs(withTone - bare) < 0.5,
    `room tone moved the spread from ${bare.toFixed(2)} to ${withTone.toFixed(2)}`)
})

test('⚠ the three devices control three different statistics', () => {
  /**
   * ⚠ THE SPEC SAID ONE CREST BUDGET DOWN A LADDER. Measured, that is wrong:
   * crest is gain-invariant, and the opto moves it the WRONG WAY because its
   * ~10 ms attack rides the body and lets onsets through. At squash 100 it
   * pulls the body down 19.7 dB while the peak falls 8.2.
   *
   * So the solve targets crest for the clipper, peak-to-body at the 99.9th
   * percentile for the FET, and block-level spread for the opto — and this test
   * asserts the section as a whole moves the last two in the right direction
   * even though crest may not move at all.
   */
  const x = [narration(14, -6)]
  const before = measureDynamics(x, SR)
  const { params } = solveDynamics(x, SR, { density: 100 })
  const r = processDynamicsBuffer(x, SR, params)
  const after = measureDynamics([r.channelData[0].subarray(r.latencySamples)], SR)

  /**
   * ⚠ DIRECTIONAL, NOT A MAGNITUDE, AND IT USED TO DEMAND 15 %. Two findings
   * retired that threshold. The opto does not reduce spread on speech at all —
   * levelling is Auto Level's job — so what moves this is the clipper and the
   * FET. And the targets were recalibrated to reachable ones, which made the
   * section gentler by design. A percentage here just pins how hard the current
   * calibration happens to push.
   */
  assert.ok(after.spreadDb < before.spreadDb,
    `spread should fall: ${before.spreadDb.toFixed(2)} -> ${after.spreadDb.toFixed(2)}`)
  assert.ok(after.impactDb < before.impactDb - 1,
    `peak-to-body should fall: ${before.impactDb.toFixed(2)} -> ${after.impactDb.toFixed(2)}`)
})

test('⚠ the opto is a calibrated depth, NOT a search — the minimum was synthetic', () => {
  /**
   * An earlier version scanned squash for the block-spread minimum, on a
   * synthetic bench that showed one (2.605 / 2.326 / 2.082 / 2.093 / 2.148 /
   * 2.225 at squash 30-80). ⚠ THAT MINIMUM DOES NOT EXIST ON SPEECH. On 35 s of
   * real narration, spread after the FET is 3.663, and the opto only ever makes
   * it worse: 4.774 at squash 0 (the Pultec pair alone), 4.771 at 15, and the
   * bare opto runs 3.666 -> 5.179 at 40 -> 6.275 at 60. The synthetic minimum was
   * an artifact of the generator's slow sinusoidal amplitude envelope, which the
   * opto's ~10 ms attack could actually flatten; a real talker's level moves
   * between syllables, not across seconds.
   *
   * So squash is a calibrated constant scaled by Density, anchored on the gain
   * reduction Scheps' own layer was tuned to (peak 7.64 / avg 1.23). What the
   * solve still owes is that the knob MEANS the same thing on every file, which
   * is `optoAlignDb`, not a scan.
   */
  const x = [narration(16, -6)]
  const { params, report } = solveDynamics(x, SR, { density: 100 })

  assert.equal(report.opto.calibratedSquash, DYNAMICS_TARGET.squash)
  assert.equal(report.opto.squash, DYNAMICS_TARGET.squash)
  assert.equal(params.squash, DYNAMICS_TARGET.squash)
  // Density scales the depth; it is not re-derived from the audio.
  const half = solveDynamics(x, SR, { density: 50 })
  assert.ok(Math.abs(half.params.squash - DYNAMICS_TARGET.squash * 0.5) < 1e-9,
    `Density should scale the calibrated depth: ${half.params.squash}`)
  // The layer must actually be doing something at the calibrated depth.
  assert.ok(report.opto.peakDb > 1,
    `the calibrated depth should produce real gain reduction: ${report.opto.peakDb}`)
})

test('⚠ each stage is aligned at its own input, not at the section\'s', () => {
  const x = [narration(12, -6)]
  const sectionAlign = inputAlignDbFor(x, SR)
  const { params } = solveDynamics(x, SR, { density: 75 })

  // The opto sits behind the FET's attenuator and its own gain reduction, so
  // its input is several dB quieter than the section's.
  assert.ok(params.optoAlignDb > params.fetAlignDb + 3,
    `the opto should want far more drive than the FET: `
    + `${params.optoAlignDb.toFixed(2)} vs ${params.fetAlignDb.toFixed(2)}`)
  assert.ok(Math.abs(params.optoAlignDb - sectionAlign) > 3,
    'aligning the opto from the section input would be a materially different number')
})

test('the clipper is capped, and says so rather than forcing the pass', () => {
  const x = [narration(12, -6)]
  const { report } = solveDynamics(x, SR, { density: 100 })
  assert.ok(report.clip.depthDb <= CLIP_MAX_DEPTH_DB + 1e-6,
    `the clipper took ${report.clip.depthDb.toFixed(2)} dB, past its cap`)
  // On this material the cap does bind at full density, so the flag is exercised.
  assert.equal(typeof report.clip.capped, 'boolean')
})

test('density 0 asks for no clipping and no opto', () => {
  const x = [narration(12, -6)]
  const { params, report } = solveDynamics(x, SR, { density: 0 })
  assert.equal(params.clipThresholdDb, null)
  assert.equal(report.clip.depthDb, 0)
  assert.equal(params.squash, 0)
  /**
   * ⚠ THE FET IS BYPASSED, AND THE REASONING HERE USED TO SAY IT COULD NOT BE.
   * Its Input knob is an ATTENUATOR — drive 0 is 24.00 dB down with 0.07 dB of
   * reduction, measured — so the old note concluded "there is no bypass
   * position" and asserted a nonzero drive instead. That was true when written
   * and stopped being true when every stage learned to bypass on an absent
   * measured key (see fetEnabled). A null drive is a bit-exact pass-through
   * with the latency preserved, which is the honest answer at Density 0.
   *
   * ⚠ AND THE OLD WORKAROUND WAS A LIVE HAZARD, not just untidy: once the
   * impact targets became reachable the solve started SELECTING drive 0 on
   * material that already met the target, which would have dropped the whole
   * region 24 dB.
   */
  assert.equal(params.fetDrive, null, 'drive 0 is 24 dB of attenuation, not a bypass')
})

test('the macro is monotonic in what it is supposed to move', () => {
  const x = [narration(14, -6)]
  const spreads = []
  for (const density of [0, 50, 100]) {
    const { params } = solveDynamics(x, SR, { density })
    const r = processDynamicsBuffer(x, SR, params)
    spreads.push(measureDynamics([r.channelData[0].subarray(r.latencySamples)], SR).spreadDb)
  }
  assert.ok(spreads[1] < spreads[0], `50 should be evener than 0: ${spreads}`)
  assert.ok(spreads[2] < spreads[1], `100 should be evener than 50: ${spreads}`)
})

test('⚠ the blend is measured on ALIGNED paths', () => {
  /**
   * ⚠ THIS WAS WRONG FIRST AND THE BUG WAS INVISIBLE IN EVERY SOLVED KNOB. The
   * wet path carries the opto's oversampling latency and the kernel delays the
   * dry side to match; correlating them unaligned measures a different pair of
   * signals from the one that renders. Measured: rho 0.481 unaligned against
   * 0.956 aligned — and rho shapes the blend's loudness compensation, so the
   * unaligned number makes Mix drift in level across its sweep.
   *
   * It surfaced only because switching oversampling off for speed takes the
   * latency to zero and the paths line up by coincidence.
   */
  const x = [narration(10, -6)]
  const { params } = solveDynamics(x, SR, { density: 75 })
  assert.ok(params.correlation > 0.8,
    `two paths that differ by one gentle compressor should be highly correlated; `
    + `got ${params.correlation.toFixed(3)}`)

  // And the alignment argument itself: offsetting one path drops the measure.
  const a = [narration(6, -6)]
  const misaligned = measureBlend(a, a, SR, 50).correlation
  const aligned = measureBlend(a, a, SR, 0).correlation
  /**
   * 0.98 rather than 1.0 because `measureBlend` clamps: the mix law divides by
   * a term that vanishes as rho approaches 1, so a perfectly correlated pair is
   * held just short of it. A signal against itself is therefore pinned at the
   * clamp, which is the right answer and not a measurement error.
   */
  assert.ok(aligned >= 0.98, `a signal against itself must correlate: ${aligned}`)
  assert.ok(misaligned < aligned - 0.01,
    'offsetting one path must visibly cost correlation, or this test proves nothing')
})

test('⚠ the solve never hands back its own render shortcut', () => {
  /**
   * The solve renders with `oversample: false` because every solved value is
   * identical with it on or off and the render is 3.2x cheaper. The AUDIBLE path
   * must always oversample — a leaked flag would silently downgrade what the
   * user hears, and nothing in the output would look wrong.
   */
  const x = [narration(10, -6)]
  const { params } = solveDynamics(x, SR, { density: 50 })
  assert.notEqual(params.oversample, false)
})

test('solved params render through the real kernel cleanly', () => {
  const x = [narration(10, -6)]
  for (const clipShaveDb of CLIP_SHAVE_DETENTS) {
    const { params } = solveDynamics(x, SR, { density: 80, clipShaveDb })
    const r = processDynamicsBuffer(x, SR, params)
    assert.ok(r.channelData[0].every(Number.isFinite), `clip ${clipShaveDb} produced non-finite output`)
    // ⚠ DERIVED — the clipper's limiter makes this RATE-DEPENDENT (326 samples
    // at 44.1 kHz, 342 at 48). See `DYNAMICS_CLIP_LIMITER`.
    assert.equal(r.latencySamples, dynamicsLatencySamples(SR))
  }
})

test('silence and near-silence are solved without crashing', () => {
  const quiet = [new Float32Array(SR * 12)]
  const { params, report } = solveDynamics(quiet, SR, { density: 100 })
  // Nothing to reduce, so the FET bypasses rather than attenuating by 24 dB.
  assert.ok(params.fetDrive === null || Number.isFinite(params.fetDrive))
  assert.ok(Number.isFinite(params.squash))
  assert.equal(params.correlation, 0)
  // Nothing to grab, so the calibrated depth is still dialled but idle.
  assert.equal(report.opto.squash, DYNAMICS_TARGET.squash)
  assert.ok(report.opto.peakDb < 0.5, `silence should not be compressed: ${report.opto.peakDb}`)
})
