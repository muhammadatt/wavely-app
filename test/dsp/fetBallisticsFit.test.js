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

import { tailTestHolds, declaredSeconds, labelRatio } from '../../scripts/fet-ballistics.mjs'

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

test('recovers the attack dial by matched measurement', opts, () => {
  // ⚠ NOT by converting t63 to a constant: measured t63 runs ~2.9x the constant
  // behind it, and the factor moves with Input, level and knee. Both sides go
  // through the same analysis so the bias cancels.
  const a = dialFor(section(selftest(), 'synth_bursts_r4_I3_a2_r4.wav'))
  const b = dialFor(section(selftest(), 'synth_bursts_r4_I3_a5_r6.wav'))
  assert.ok(Math.abs(a - 2) < 0.25, `attack placed at dial ${a}, expected 2`)
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
