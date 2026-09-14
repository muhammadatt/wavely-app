/**
 * Run with:  npm test
 *
 * The static-curve fitter, against curves we chose ourselves.
 *
 * ⚠ A CURVE FIT IS EASY TO GET CONFIDENTLY WRONG. Three traps were found on
 * FETish's real capture, each of which produced a plausible-looking answer:
 *
 *   1. Fitting against the raw stimulus rather than the capture's own
 *      fundamental phase. A memoryless polynomial cannot express the capture's
 *      3-sample delay, so it absorbed it into the coefficients: residual
 *      −14.1 dB and a linear term of 0.980 on a plugin that is unity.
 *   2. Not mean-centring. An x⁴ term carries DC that the capture does not, so
 *      least squares traded fourth-order amplitude away to avoid adding it —
 *      c₄ came out 2.06× too small, with H2 and H4 low by exactly 6.3 dB at
 *      EVERY level.
 *   3. Fitting a memoryless curve to something that is not one. CLA-76's
 *      harmonics all rise together at ~1 dB/dB, which no polynomial produces;
 *      the fitter silently dropped them and reported a 257 dB error.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const STIM = join(ROOT, 'data/corpus/fet1176/stimulus/thd.wav')
const haveStimulus = existsSync(STIM)

let cached = null
function selftest() {
  if (cached === null) {
    cached = execFileSync(process.execPath,
      [join(ROOT, 'scripts/fet-static-curve.mjs'), '--selftest'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  }
  return cached
}

function section(out, name) {
  const i = out.indexOf(`SELF-TEST: ${name}`)
  assert.ok(i > 0, `no section for ${name}`)
  const rest = out.slice(i + 1)
  const j = rest.indexOf('SELF-TEST: ')
  return j < 0 ? rest : rest.slice(0, j)
}

/** Pull `c<n>` off the coefficient block. Line parsing, not a regex — the
 *  escaping in a template literal got it wrong twice. */
const coefOf = (s, n) => {
  for (const line of s.split('\n')) {
    const t = line.trim().split(/\s+/)
    if (t[0] === `c${n}` && t.length > 1) return Number(t[1])
  }
  return null
}

test('recovers a known 4th/5th-order curve', { skip: !haveStimulus && 'run npm run fet:stimulus first' }, () => {
  const s = section(selftest(), 'x - 0.01·x⁴ + 0.01·x⁵')
  assert.match(s, /basis chosen from the data: x\^\[1, 4, 5\]/,
    'the basis must be read from the harmonic slopes, not assumed')
  // ⚠ c4 is the one the DC trap halves. Anything near -0.005 means the fit
  // stopped mean-centring.
  assert.ok(Math.abs(coefOf(s, 4) - -0.01) < 1e-4, `c4 = ${coefOf(s, 4)}, expected -0.01`)
  assert.ok(Math.abs(coefOf(s, 5) - 0.01) < 1e-4, `c5 = ${coefOf(s, 5)}, expected 0.01`)
  assert.ok(Math.abs(coefOf(s, 1) - 1) < 1e-4, `c1 = ${coefOf(s, 1)}, expected 1`)
})

test('recovers a pure cubic exactly', { skip: !haveStimulus && 'run npm run fet:stimulus first' }, () => {
  const s = section(selftest(), 'pure cubic')
  assert.match(s, /basis chosen from the data: x\^\[1, 3\]/)
  assert.ok(Math.abs(coefOf(s, 3) - -0.2) < 1e-5, `c3 = ${coefOf(s, 3)}`)
  assert.match(s, /worst harmonic error over \d+ usable readings: 0\.00 dB/)
})

test('our own tanh reads as cubic-dominant, which is why it cannot reach FETish',
  { skip: !haveStimulus && 'run npm run fet:stimulus first' }, () => {
    // FETish measures an H2 slope of 3.0 (a 4th-order term). A tanh's leading
    // nonlinearity is cubic, giving H2 a slope near 1 — no drive value closes
    // that gap, which is the whole argument for replacing the curve.
    const s = section(selftest(), 'asymmetric tanh')
    assert.ok(Math.abs(coefOf(s, 3)) > Math.abs(coefOf(s, 4)),
      'the tanh must fit as cubic-dominant')
  })

test('every self-test curve extrapolates to a level it was not fitted on',
  { skip: !haveStimulus && 'run npm run fet:stimulus first' }, () => {
    // ⚠ The hold-out is what separates "a curve fits" from "a curve IS the
    // model". A level-dependent mechanism fits every level individually and
    // fails to predict one it never saw.
    const out = selftest()
    const holdouts = [...out.matchAll(/worst error there: (\d+\.\d+) dB/g)].map(m => Number(m[1]))
    assert.equal(holdouts.length, 3, `expected 3 hold-out results, got ${holdouts.length}`)
    for (const e of holdouts) assert.ok(e < 2, `hold-out error ${e} dB`)
  })
