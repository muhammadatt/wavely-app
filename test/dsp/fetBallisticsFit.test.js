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

test('recovers the attack dial by matched measurement', opts, () => {
  // ⚠ NOT by converting t63 to a constant: measured t63 runs ~2.9x the constant
  // behind it, and the factor moves with Input, level and knee. Both sides go
  // through the same analysis so the bias cancels.
  assert.match(section(selftest(), 'synth_bursts_r4_I3_a2_r4.wav'), /our dial 2\.0\d/)
  assert.match(section(selftest(), 'synth_bursts_r4_I3_a5_r6.wav'), /our dial 5\.0\d/)
})

test('recovers the release dial too', opts, () => {
  const a = section(selftest(), 'synth_bursts_r4_I3_a2_r4.wav')
  const b = section(selftest(), 'synth_bursts_r4_I3_a5_r6.wav')
  assert.match(a.slice(a.indexOf('release t63 (release)')), /our dial 4\.0\d/)
  assert.match(b.slice(b.indexOf('release t63 (release)')), /our dial (5\.9\d|6\.0\d)/)
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
