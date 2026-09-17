/**
 * Run with:  npm test
 *
 * The ballistics fitter, against captures whose answers we chose.
 *
 * ⚠ A BALLISTICS FIT HAS TWO UNKNOWNS AND ONLY ONE OF THEM IS OBVIOUS. The dial
 * is what the fit is for; the capture's LATENCY is what silently ruins it. The
 * synthetic captures here trim the kernel's own `latencySamples` and inject an
 * arbitrary lag in its place, so a fitter that assumed a known latency fails
 * here and would have passed on a capture that happened to have none.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { tailTestHolds, declaredSeconds, labelRatio, PLANS, analyseCapture, transientVerdict } from '../../scripts/fet-ballistics.mjs'
import { buildProbe } from '../../scripts/lib/probeStimulus.js'
import { FET1176Kernel, releaseSecondsForDial } from '../../src/audio/fet1176Processor.js'

const SR = 96000

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const haveStimulus = existsSync(join(ROOT, 'data/corpus/fet1176/stimulus/thd.wav'))

let cached = null
function selftest() {
  if (cached === null) {
    const dir = mkdtempSync(join(tmpdir(), 'fet-bal-'))
    cached = execFileSync(process.execPath,
      [join(ROOT, 'scripts/fet-ballistics.mjs'), '--fit', '--selftest', '--dir', dir],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  }
  return cached
}

function section(out, name) {
  const i = out.indexOf(name)
  assert.ok(i > 0, `no section for ${name}`)
  const rest = out.slice(i + name.length)
  const j = rest.indexOf('synth_bursts_')
  return j < 0 ? rest : rest.slice(0, j)
}

const opts = { skip: !haveStimulus && 'run npm run fet:stimulus first' }

test('recovers an unknown capture latency to the sample', opts, () => {
  // ⚠ Envelope alignment lands within ~12 samples, which is half a period at
  // the 4 kHz probe — enough to lock onto the wrong cycle. The step edge is a
  // broadband amplitude discontinuity and is what disambiguates it.
  const out = selftest()
  assert.match(section(out, 'synth_bursts_r4_I3_a2_r4.wav'), /lag 131 samples/)
  assert.match(section(out, 'synth_bursts_r4_I3_a5_r6.wav'), /lag -77 samples/)
})

/** The continuous dial the fitter placed the reference at, for one sweep. */
function dialFor(text) {
  const m = text.match(/our dial (\d\.\d\d)/)
  assert.ok(m, 'no continuous dial in the verdict')
  return Number(m[1])
}

/**
 * ⚠ THE TWO TOLERANCES DIFFER BECAUSE THE ESTIMATOR'S RESOLUTION DOES, and that
 * is a finding rather than a fudge. Overshoot separates our slow dials by only
 * ~0.3 dB per step (8.1 / 7.8 / 7.2 at dial 1 / 2 / 3) against a measurement
 * precision of a few hundredths, so a dial near the slow end is resolvable to
 * about a fifth of a step and no better. At dial 5 the steps are 1.5 dB and it
 * places to a few hundredths of a dial.
 *
 * This is the third strike against overshoot as the attack estimator. It also
 * SATURATES near 16 dB of depth — FETish's three slowest settings all read
 * 15.6-16.1 dB and discriminate nothing — and it drifts slightly with the
 * release dial (12.07 to 11.75 dB across the full release range at a fixed
 * attack). Measured t63 does none of these. The attack fit should be read off
 * t63, and this test documents why rather than pretending the dial comes back
 * exactly.
 */
test('recovers the attack dial by matched measurement', opts, () => {
  // ⚠ NOT by converting t63 to a constant: measured t63 runs ~2.9x the constant
  // behind it, and the factor moves with Input, level and knee. Both sides go
  // through the same analysis so the bias cancels.
  const a = dialFor(section(selftest(), 'synth_bursts_r4_I3_a2_r4.wav'))
  const b = dialFor(section(selftest(), 'synth_bursts_r4_I3_a5_r6.wav'))
  assert.ok(Math.abs(a - 2) < 0.4, `attack placed at dial ${a}, expected 2`)
  assert.ok(Math.abs(b - 5) < 0.25, `attack placed at dial ${b}, expected 5`)
})

test('recovers the release dial too', opts, () => {
  const a = section(selftest(), 'synth_bursts_r4_I3_a2_r4.wav')
  const b = section(selftest(), 'synth_bursts_r4_I3_a5_r6.wav')
  const da = dialFor(a.slice(a.indexOf('release t63 (release)')))
  const db = dialFor(b.slice(b.indexOf('release t63 (release)')))
  assert.ok(Math.abs(da - 4) < 0.25, `release placed at dial ${da}, expected 4`)
  assert.ok(Math.abs(db - 6) < 0.25, `release placed at dial ${db}, expected 6`)
})

test('drives our kernel to the depth the reference actually reached', opts, () => {
  /**
   * ⚠ THE DIAL TABLE USED A HARDCODED `inputDrive: 55` AND THAT WAS A REAL BUG.
   * Overshoot runs 1.93 dB at 2.3 dB of reduction to 8.02 at 11.4 — a 6 dB
   * spread, WIDER THAN THE WHOLE DIAL RANGE (4.8 down to 1.0 at fixed Input).
   * A reference captured at ~12 dB against our kernel at ~4.9 would have landed
   * clean off the table and reported a finding about ATTACK_SLOWEST_S caused
   * entirely by a depth mismatch.
   */
  const out = selftest()
  const rows = [...out.matchAll(/reference settled at ([\d.]+) dB of reduction; our kernel reaches that at Input [\d.]+ \(([\d.]+) dB\)/g)]
  assert.ok(rows.length >= 2, `found ${rows.length} depth matches, expected 2`)
  for (const m of rows) {
    const [, ref, ours] = m
    assert.ok(Math.abs(Number(ref) - Number(ours)) < 0.1,
      `reference at ${ref} dB but our kernel driven to ${ours} dB`)
  }
})

test('the dial is reported continuously, with the time it corresponds to', opts, () => {
  /**
   * ⚠ THE FRACTIONAL DIAL IS THE ANSWER A CONTINUOUS CONTROL NEEDS, and it costs
   * nothing to produce: `dialToSeconds` already takes a float and interpolates
   * geometrically, so 3.4 is a real setting. A knob reading in microseconds is
   * the same law with the same endpoints, without detents — which is why making
   * the control continuous does not change the fitting METHOD at all.
   */
  const s = section(selftest(), 'synth_bursts_r4_I3_a2_r4.wav')
  assert.match(s, /our dial \d\.\d\d  \(between \d and \d\) = \d+ us/)
  assert.match(s, /our dial \d\.\d\d  \(between \d and \d\) = \d+ ms/)
})

test('finds the release tail on a kernel that has one', opts, () => {
  /**
   * ⚠ THIS REPORTED "NO TAIL" ON OUR OWN KERNEL AND THE BUG WAS THE ANALYSIS
   * WINDOW. The held level was read over a fixed 100 ms before the burst ended,
   * which is LONGER than the plan's shortest hold — so for the 50 ms burst it
   * reached back past the step and averaged the open gain in. That put its
   * release t63 at 606 ms against 326-389 for the longer holds: an outlier
   * pointing the wrong way, on a kernel whose tail is 22 % of the reduction on
   * a network 4x slower.
   */
  const out = selftest()
  assert.doesNotMatch(out, /NO STRETCH WITH EXPOSURE/)
  const hits = [...out.matchAll(/THE RELEASE STRETCHES WITH EXPOSURE/g)]
  assert.equal(hits.length, 2, `tail found in ${hits.length} of 2 captures`)
})

test('the release t63 grows monotonically with how long the burst was held', opts, () => {
  // The tail IS this: a single time constant recovers identically after every
  // hold length, and a two-stage network takes longer the longer it was lit.
  const s = section(selftest(), 'synth_bursts_r4_I3_a2_r4.wav')
  const rows = [...s.matchAll(/^\s+[\d.]+ s\s+[\d.]+\s+\d+ us\s+[\d.]+ dB\s+(\d+) ms/gm)]
    .map(m => Number(m[1]))
  assert.equal(rows.length, 4, `found ${rows.length} burst rows, expected 4`)
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i] >= rows[i - 1], `release t63 fell from ${rows[i - 1]} to ${rows[i]} ms`)
  }
  assert.ok(rows[3] > rows[0] * 1.05, `no stretch: ${rows[0]} -> ${rows[3]} ms`)
})

/**
 * The tail test is only meaningful if the long holds survive into it. These pin
 * the two shapes apart: a burst that was still settling is excluded, a reference
 * whose reduction sags under a sustained tone is not.
 */
const holds = [0.05, 0.2, 1.0, 3.0]
const asBursts = (grs) => grs.map((grDb, i) => ({ holdS: holds[i], grDb, releaseT63: 0.1 }))

test('a hold shallower than a LONGER hold is still settling and is excluded', () => {
  const { kept, dropped } = tailTestHolds(asBursts([5.0, 9.8, 10.0, 10.0]))
  assert.deepEqual(dropped.map(b => b.holdS), [0.05])
  assert.deepEqual(kept.map(b => b.holdS), [0.2, 1.0, 3.0])
  assert.equal(dropped[0].against, 10.0)
})

test('reduction that SAGS toward the long holds keeps every hold in the test', () => {
  // The CLA-76 a2 capture verbatim: the peak is the 0.2 s hold, not the 3 s one.
  const { kept, dropped, sag } = tailTestHolds(asBursts([10.00, 10.21, 9.68, 9.65]))
  assert.deepEqual(dropped, [])
  assert.deepEqual(kept.map(b => b.holdS), holds)
  assert.ok(Math.abs(sag - 0.56) < 1e-9, 'the 0.56 dB sag is reported, not used to exclude')
})

test('a sag past the tolerance is reported but still excludes nothing', () => {
  const { kept, dropped, sag } = tailTestHolds(asBursts([12.0, 12.0, 10.5, 10.0]))
  assert.deepEqual(dropped, [])
  assert.equal(kept.length, 4)
  assert.ok(Math.abs(sag - 2.0) < 1e-9)
})

test('the longest hold is never excluded, however shallow it reads', () => {
  const { kept, dropped } = tailTestHolds(asBursts([10.0, 10.0, 10.0, 1.0]))
  assert.deepEqual(dropped, [])
  assert.equal(kept.at(-1).grDb, 1.0)
})

test('bursts with no recovered release are left out of both lists', () => {
  const bursts = asBursts([10.0, 10.0, 10.0, 10.0])
  bursts[1].releaseT63 = null
  const { kept, dropped } = tailTestHolds(bursts)
  assert.equal(kept.length + dropped.length, 3)
})

test('a declared knob in us/ms converts; a dial has no time to compare', () => {
  assert.ok(Math.abs(declaredSeconds({ n: 800, unit: 'us' }) - 0.0008) < 1e-12)
  assert.ok(Math.abs(declaredSeconds({ n: 235, unit: 'ms' }) - 0.235) < 1e-12)
  assert.equal(declaredSeconds({ n: 4, unit: '' }), null, 'a dial position is not a time')
  assert.equal(declaredSeconds(null), null)
})

test('the label ratio is our constant over the declared one, and refuses nonsense', () => {
  assert.ok(Math.abs(labelRatio(0.00002, 0.0000534) - 2.67) < 0.01)
  assert.equal(labelRatio(0, 0.001), null)
  assert.equal(labelRatio(0.001, NaN), null)
})

/**
 * ⚠ THE RELEASE MEASUREMENT CARRIES NO BIAS AND THE ATTACK ONE DOES. Measured
 * attack t63 runs ~2.75x the constant behind it, because the detector is a bare
 * rectifier whose target clears threshold only near the waveform peaks. Release
 * has no such distortion: with the tail stage off, measured release t63 IS the
 * release constant. The ~1.5x our own captures show is entirely the tail.
 *
 * This matters beyond bookkeeping. Divide that 1.5x out of a reference that has
 * no tail — as FETish does not — and it reads 1.5x faster than it is; that error
 * turned a 2.75x label gap into a reported 4-5x one.
 */
test('with the tail off, measured release t63 IS the release constant', () => {
  const plan = PLANS['bursts.wav']()
  const stim = buildProbe(plan, SR)
  const x = stim.x
  /**
   * ⚠ DERIVED FROM THE LAW, NOT HARDCODED. These read 50 and 234 ms until the
   * release endpoints were fitted to FETish, at which point the constants became
   * 18.3 and 85.8 and the test failed for being right. What it is checking is
   * the IDENTITY between the constant and the measurement, which holds whatever
   * the endpoints are.
   */
  for (const dial of [7, 4]) {
    const nominalMs = releaseSecondsForDial(dial) * 1e3
    const k = new FET1176Kernel(SR)
    k.setParams({ outputGainDb: 0, mix: 1, fetDrive: 0, oversample: false,
      inputDrive: 91, ratio: '4', attack: 4, release: dial })
    k.tailFraction = 0
    k.mainFraction = 1
    const y = new Float32Array(x.length)
    for (let f = 0; f < x.length; f += 128) {
      const l = Math.min(128, x.length - f)
      k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
    }
    const measuredMs = analyseCapture(y, plan, stim, SR, 0).at(-1).releaseT63 * 1e3
    assert.ok(Math.abs(measuredMs / nominalMs - 1) < 0.03,
      `dial ${dial}: measured ${measuredMs.toFixed(1)} ms against a ${nominalMs.toFixed(1)} ms constant`)
  }
})

/**
 * ⚠ A PLAN THAT CANNOT RESOLVE THE THING IT TESTS REPORTS "ABSENT" FOR EVERY
 * REFERENCE. Before the transient plan is allowed to say FETish has no program
 * dependence, it has to spread on a kernel that demonstrably does and go flat on
 * one that does not — same stimulus, same analysis, only the tail stage moving.
 */
function runTransients(tailFraction) {
  const plan = PLANS['transients.wav']()
  const stim = buildProbe(plan, SR)
  const k = new FET1176Kernel(SR)
  k.setParams({ outputGainDb: 0, mix: 1, fetDrive: 0, oversample: false,
    inputDrive: 91, ratio: '4', attack: 4, release: 4 })
  if (tailFraction !== undefined) { k.tailFraction = tailFraction; k.mainFraction = 1 - tailFraction }
  const y = new Float32Array(stim.x.length)
  for (let f = 0; f < stim.x.length; f += 128) {
    const l = Math.min(128, stim.x.length - f)
    k.process([stim.x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
  }
  return analyseCapture(y, plan, stim, SR, 0)
}

test('the transient conditions land at a matched depth', () => {
  // ⚠ depthDb, not grDb — inside a train grDb is the incremental step at the
  // edge (0.80 dB at a matched 14.31) and reads as a wrecked experiment.
  const rows = runTransients()
  assert.equal(rows.length, 1 + 4)
  const depths = rows.map(r => r.depthDb)
  assert.ok(Math.max(...depths) - Math.min(...depths) < 0.1,
    `depths ${depths.map(d => d.toFixed(2)).join(' / ')}`)
})

test('the density contrast resolves program dependence, and its absence', () => {
  // ⚠ TRAIN AGAINST TRAIN. The sustained row moves the elapsed window as well as
  // the duty, so including it measures the exposure limb — that leak is what
  // made a 3.8 % density response look like a validated 19 %.
  const withTail = transientVerdict(runTransients())
  assert.ok(withTail.ok, withTail.reason)
  assert.ok(withTail.keyed, `a kernel with a tail must spread; got ${(withTail.spread * 100).toFixed(1)} %`)

  const noTail = transientVerdict(runTransients(0))
  assert.ok(noTail.ok, noTail.reason)
  assert.equal(noTail.keyed, false, 'a kernel without a tail must read flat')
  assert.ok(noTail.spread < 0.01)
})

test('the sustained row is reported as exposure, never folded into density', () => {
  const v = transientVerdict(runTransients())
  assert.ok(v.exposure, 'the sustained reading must still be surfaced')
  assert.ok(v.exposure.sustainedT63 < v.exposure.trainMinT63,
    'sustained runs in half the window, so it recovers sooner than any train')
  // The density spread must be the trains' own range, never the full range that
  // the sustained row widens — that conflation is the bug this guards.
  const trainRange = v.exposure.trainMaxT63 - v.exposure.trainMinT63
  assert.ok(Math.abs(v.absSpread - trainRange) < 1e-9, 'absSpread must be the train range')
  const fullRange = v.exposure.trainMaxT63 - Math.min(v.exposure.sustainedT63, v.exposure.trainMinT63)
  assert.ok(v.absSpread < fullRange, 'and must be strictly narrower than the range including sustained')
})

test('one train condition cannot support a density verdict', () => {
  const v = transientVerdict([
    { tag: 'sustained', depthDb: 14, releaseT63: 0.35 },
    { tag: '5 Hz train', depthDb: 14, releaseT63: 0.40 },
  ])
  assert.equal(v.ok, false)
  assert.match(v.reason, /edge count was never varied/)
})

test('mismatched depths refuse a verdict rather than comparing the times', () => {
  const v = transientVerdict([
    // Both clear the depth floor, so it is the MISMATCH that must stop this.
    { tag: '2 Hz train', depthDb: 14.0, releaseT63: 0.2 },
    { tag: '100 Hz train', depthDb: 10.0, releaseT63: 0.4 },
  ])
  assert.equal(v.ok, false)
  assert.match(v.reason, /matched depth/)
})

/**
 * ⚠ BOTH OF THESE FIRED ON REAL CAPTURES AND BOTH PRODUCED A CONFIDENT WRONG
 * FINDING. A CLA-76 capture that never compressed (−0.01 dB) was reported as
 * "does not model program dependence on either limb"; a FETish capture reading
 * 23 / 23 / 24 ms was reported as keyed on transient density, on one millisecond
 * of rounding at 23 ms.
 */
test('a capture that never compressed refuses a verdict', () => {
  const v = transientVerdict([
    { tag: '2 Hz train', depthDb: -0.01, releaseT63: 0 },
    { tag: '5 Hz train', depthDb: -0.01, releaseT63: 0 },
    { tag: '100 Hz train', depthDb: -0.01, releaseT63: 0 },
  ])
  assert.equal(v.ok, false)
  assert.match(v.reason, /did not compress at all/)
})

test('a capture too shallow to have been validated refuses a verdict', () => {
  const v = transientVerdict([
    { tag: '2 Hz train', depthDb: 4.93, releaseT63: 0.023 },
    { tag: '100 Hz train', depthDb: 4.69, releaseT63: 0.024 },
  ])
  assert.equal(v.ok, false)
  assert.match(v.reason, /under the 6 dB/)
})

test('a millisecond of rounding at 23 ms is not a density finding', () => {
  const v = transientVerdict([
    { tag: '2 Hz train', depthDb: 14.0, releaseT63: 0.023 },
    { tag: '5 Hz train', depthDb: 14.0, releaseT63: 0.023 },
    { tag: '25 Hz train', depthDb: 14.0, releaseT63: 0.024 },
  ])
  assert.equal(v.ok, true)
  assert.equal(v.keyed, false, '4.3 % on a 1 ms step must not read as keyed')
})

test('a spread large in percent but tiny in absolute terms is not enough either', () => {
  const v = transientVerdict([
    { tag: '2 Hz train', depthDb: 14.0, releaseT63: 0.010 },
    { tag: '100 Hz train', depthDb: 14.0, releaseT63: 0.014 },
  ])
  assert.equal(v.keyed, false, '40 % but only 4 ms — under the floor')
})
