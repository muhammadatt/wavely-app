/**
 * Regression guard on the VoiceRx scorecard.
 *
 * Run with:  npm test
 * Full corpus and human-readable output:  npm run scorecard
 *
 * WHAT THIS IS NOT. It is not a quality gate. Several of these numbers are bad
 * — half the planted defects go unrecovered, a clean 9 kHz-bandwidth voice gets
 * an invented cut, an 800 Hz notch produces two phantom cuts totalling 11 dB —
 * and the test passes anyway. Asserting the numbers are GOOD would mean
 * deleting the test today, which would throw away the only thing that can tell
 * us whether a redesign is actually an improvement.
 *
 * So it asserts they are UNCHANGED. The baseline is a photograph of how the
 * detector behaves right now, and this fails when the photograph stops
 * matching, in either direction. A change that improves a number is meant to
 * fail here: read the new scorecard, satisfy yourself the movement is the one
 * you intended, and re-record it with
 *
 *   node scripts/voicerx-scorecard.mjs --smoke --write-baseline
 *
 * Six cases, about six seconds. The full fifty-eight-case corpus takes a minute
 * and lives in the CLI, which is where an occasional deep check belongs — but
 * these six carry the behaviours worth waking up for. See SMOKE_CASES.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runScorecard } from './harness.js'
import { SMOKE_CASES } from './cases.js'
import { DETECTORS } from './detectors.js'

const baseline = JSON.parse(
  readFileSync(new URL('./baseline-smoke.json', import.meta.url), 'utf8'),
)

/**
 * Floats get a tolerance, counts do not.
 *
 * The corpus and the analysis are both deterministic, so in principle every
 * number is exact. In practice Math.sin and Math.log2 are permitted to differ
 * in the last bits between platforms and engine versions, and a recovery
 * fraction that lands on 0.4999 rather than 0.5001 should not fail a build.
 * Counts are integers derived from threshold comparisons; if one of those moves
 * the behaviour really did change and it should be looked at.
 */
const TOLERANCE = 0.05

function compare(actual, expected, path, failures) {
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key]
    const where = path ? `${path}.${key}` : key

    if (want === null || typeof want === 'number') {
      if (want === null || got === null) {
        if (want !== got) failures.push(`${where}: expected ${want}, got ${got}`)
      } else if (Number.isInteger(want) && Number.isInteger(got)) {
        if (want !== got) failures.push(`${where}: expected ${want}, got ${got}`)
      } else if (Math.abs(got - want) > TOLERANCE) {
        failures.push(`${where}: expected ${want}, got ${got}`)
      }
    } else if (Array.isArray(want)) {
      const a = JSON.stringify(got)
      const b = JSON.stringify(want)
      if (a !== b) failures.push(`${where}:\n    expected ${b}\n    got      ${a}`)
    } else if (want && typeof want === 'object') {
      compare(got ?? {}, want, where, failures)
    }
  }
}

for (const [name, want] of Object.entries(baseline.detectors)) {
  test(`the ${name} detector matches its recorded baseline`, () => {
    const detector = DETECTORS[name]
    assert.ok(detector, `baseline names a detector that no longer exists: ${name}`)

    const card = runScorecard(detector, SMOKE_CASES)
    const failures = []
    compare(card.overall, want.overall, 'overall', failures)
    for (const [family, w] of Object.entries(want.families)) {
      compare(card.families[family] ?? {}, w, family, failures)
    }

    assert.equal(
      failures.length, 0,
      `"${name}" changed against test/voicerx/baseline-smoke.json:\n  ${
        failures.join('\n  ')
      }\n\nIf this is the change you meant to make, re-record it:\n`
      + '  node scripts/voicerx-scorecard.mjs --smoke --write-baseline\n',
    )
  })
}

/**
 * The corpus has to be able to fail, or the scorecard measures nothing.
 *
 * A generator quietly producing silence, or a scorer counting every band as a
 * hit, would give a clean-looking scorecard forever. These pin the two ends:
 * something that should be found is found, and something that should not be
 * reported is not.
 */
test('the corpus can distinguish a working detector from a broken one', () => {
  const cases = SMOKE_CASES.filter(c => c.name === 'resonance 700Hz +12dB')

  const silent = runScorecard(() => ({ ok: true, bands: [] }), cases)
  assert.equal(silent.overall.detectionRate, 0, 'a detector that finds nothing scored above zero')

  const shotgun = runScorecard(() => ({
    ok: true,
    bands: Array.from({ length: 12 }, (_, i) => ({ freqHz: 100 * 2 ** (i / 2), gainDb: -4, q: 2 })),
  }), cases)
  assert.ok(
    shotgun.overall.spuriousBands >= 10,
    'a detector emitting bands everywhere was not penalised for the ones that missed',
  )

  const exact = runScorecard(() => ({
    ok: true, bands: [{ freqHz: 700, gainDb: -12, q: 3 }],
  }), cases)
  assert.equal(exact.overall.detectionRate, 1)
  assert.equal(exact.overall.recovery.median, 1, 'an exact inverse did not score as full recovery')
  assert.equal(exact.overall.spuriousBands, 0)
})
