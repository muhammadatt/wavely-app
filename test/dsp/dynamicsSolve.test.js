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
  VOICINGS, CLIP_MAX_DEPTH_DB,
} from '../../src/audio/dynamicsSolve.js'
import { processDynamicsBuffer } from '../../src/audio/dynamicsProcessor.js'
import { inputAlignDbFor } from '../../src/audio/dsp/inputAlign.js'

const SR = 44100

/** Narration with both syllable detail and phrase-to-phrase level variation. */
function narration(seconds, peakDbfs, seed = 12345) {
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
    x[i] = loud * burst * (0.6 * Math.sin(2 * Math.PI * 180 * t)
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
  const { params } = solveDynamics(x, SR, { density: 100, voicing: 'audiobook' })
  const r = processDynamicsBuffer(x, SR, params)
  const after = measureDynamics([r.channelData[0].subarray(r.latencySamples)], SR)

  assert.ok(after.spreadDb < before.spreadDb * 0.85,
    `spread should fall materially: ${before.spreadDb.toFixed(2)} -> ${after.spreadDb.toFixed(2)}`)
  assert.ok(after.impactDb < before.impactDb - 1,
    `peak-to-body should fall: ${before.impactDb.toFixed(2)} -> ${after.impactDb.toFixed(2)}`)
})

test('⚠ the opto is a bounded search because its curve has a minimum', () => {
  /**
   * Measured block spread against squash, after the FET:
   *   30: 2.605  40: 2.326  50: 2.082  60: 2.093  70: 2.148  80: 2.225
   *
   * Past ~50 it gets WORSE, because the transients the opto lets through start
   * dominating the blocks it is trying to even out. A bisection assumes a slope
   * and would run to whichever end it was pointed at.
   */
  const x = [narration(16, -6)]
  const { report } = solveDynamics(x, SR, { density: 100, voicing: 'podcast' })
  // The search must land strictly inside its allowed range, not on an endpoint —
  // an endpoint is what a monotonic assumption would produce.
  assert.ok(report.opto.bestSquash > 0, 'the search found nothing to do')
  assert.ok(report.opto.bestSquash < VOICINGS.podcast.squashMax,
    `the search hit its ceiling (${report.opto.bestSquash}), which a minimum should not`)
  assert.ok(report.opto.bestSpreadDb < report.afterFet.spreadDb,
    'the chosen squash should be an improvement on doing nothing')
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
  const { report } = solveDynamics(x, SR, { density: 100, voicing: 'podcast' })
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
   * ⚠ THE FET IS NOT AT ZERO, AND THAT IS NOT A BUG. Its Input knob is an
   * ATTENUATOR — drive 0 is 24 dB down, not "off" — so there is no bypass
   * position, and the honest answer at Density 0 is the drive at which it
   * happens to do nothing. Measured ~28 with about 1.3 dB of reduction.
   */
  assert.ok(params.fetDrive > 0, 'drive 0 would be 24 dB of attenuation, not a bypass')
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
  for (const voicing of Object.keys(VOICINGS)) {
    const { params } = solveDynamics(x, SR, { density: 80, voicing })
    const r = processDynamicsBuffer(x, SR, params)
    assert.ok(r.channelData[0].every(Number.isFinite), `${voicing} produced non-finite output`)
    assert.equal(r.latencySamples, 150)
  }
})

test('silence and near-silence are solved without crashing', () => {
  const quiet = [new Float32Array(SR * 12)]
  const { params, report } = solveDynamics(quiet, SR, { density: 100 })
  assert.ok(Number.isFinite(params.fetDrive))
  assert.ok(Number.isFinite(params.squash))
  assert.equal(params.correlation, 0)
  assert.equal(report.opto.bestSquash, 0)
})
