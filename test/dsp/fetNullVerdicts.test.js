/**
 * Run with:  npm test
 *
 * The null-test reader's VERDICTS, against synthetic captures whose answers are
 * known.
 *
 * ⚠ THE VERDICTS ARE THE PRODUCT, NOT THE ARITHMETIC. Every line
 * `scripts/fet-null.mjs` prints is a claim about a plugin — "Output drives a
 * stage", "the Input is compensated", "this reference models no output stage" —
 * and each one decides whether thirty-five more bounces get spent. A verdict
 * that comes out backwards on a capture whose answer is known is the only way
 * to catch it before it happens on one whose answer is not.
 *
 * Writing this test found two wrong verdicts on the first run:
 *
 *   1. GAIN REDUCTION WAS COMPUTED ACROSS TWO CAPTURES rather than within one,
 *      so it carried the insertion gain: it reported −22.63 dB of reduction on
 *      a reference whose real reduction was 11.0 dB.
 *   2. A COMPRESSOR WITH NO SATURATOR WAS CALLED A SATURATOR. Our kernel at
 *      `fetDrive: 0` still reads 0.020 % THD at 11 dB of reduction — the
 *      unsmoothed detector modulating the gain at 2f, which puts sidebands at f
 *      and 3f. It is odd-order only (H3 84 dB over the strongest even), and
 *      fitting `fetDrive` to it would put a saturator where a ripple is.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const STIM = join(ROOT, 'data/corpus/fet1176/stimulus/thd.wav')

/**
 * ⚠ RUN ONCE AND SHARE. The self-test renders eleven captures through the
 * kernel at 96 kHz; calling it per test took the suite past its timeout. The
 * output is deterministic, so one run serves every assertion below.
 */
let cached = null
function runSelftest() {
  if (cached === null) {
    const dir = mkdtempSync(join(tmpdir(), 'fet-null-'))
    cached = execFileSync(process.execPath,
      [join(ROOT, 'scripts/fet-null.mjs'), '--selftest', '--dir', dir],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  }
  return cached
}

/** The slice of the report for one synthetic reference. */
function section(out, ref) {
  const i = out.indexOf(`REFERENCE: ${ref}`)
  assert.ok(i > 0, `no section for ${ref}`)
  const rest = out.slice(i + 1)
  const j = rest.indexOf('REFERENCE: ')
  return j < 0 ? rest : rest.slice(0, j)
}

// ⚠ The stimulus is gitignored, so a fresh clone has to build it first. Skipping
// beats failing for a missing artefact that `npm run fet:stimulus` regenerates.
const haveStimulus = existsSync(STIM)

test('null reader: a compensated, saturator-free reference', { skip: !haveStimulus && 'run npm run fet:stimulus first' }, () => {
  const s = section(runSelftest(), 'synthclean')

  assert.match(s, /the no-compression GAIN is LINEAR/)
  assert.match(s, /at the stimulus floor at every level/, 'should find nothing static to measure')
  assert.match(s, /Output is a clean multiply/)

  // ⚠ THE ONE THAT WAS WRONG. fetDrive is 0 here: there is no saturator.
  assert.match(s, /ODD-ORDER DOMINATED/,
    'a detector ripple must not be reported as a saturator')
  assert.doesNotMatch(s, /DISTORTION RISES WITH COMPRESSION/,
    'fetDrive 0 has no gain-cell saturation to find')

  assert.match(s, /INPUT IS COMPENSATED/)
  assert.match(s, /output level moved \+?-?0\.00 dB/)
})

test('null reader: a true-input-gain reference with a saturator', { skip: !haveStimulus && 'run npm run fet:stimulus first' }, () => {
  const s = section(runSelftest(), 'synthdirty')

  assert.match(s, /the no-compression GAIN is LINEAR/)
  assert.match(s, /A STATIC SATURATOR IS IN CIRCUIT/,
    'fetDrive is level-driven and distorts with no reduction at all')
  assert.match(s, /Even order present/, 'our shaper is asymmetric')
  assert.match(s, /DISTORTION RISES WITH COMPRESSION/)
  assert.match(s, /INPUT IS A REAL GAIN/)
})

test('gain reduction is measured within one capture, not across two', { skip: !haveStimulus && 'run npm run fet:stimulus first' }, () => {
  const s = section(runSelftest(), 'synthdirty')
  // ⚠ The regression: comparing null3's mean gain to null1's carried the
  // insertion gain and reported −22.63 dB where the truth is ~11.
  const m = s.match(/to \d+\.\d+ % at (\d+\.\d) dB/)
  assert.ok(m, 'no GR figure in the distortion verdict')
  const grDb = Number(m[1])
  assert.ok(grDb > 8 && grDb < 14, `reduction read as ${grDb} dB, expected ~11`)
})

test('a bypassed capture is caught, and a transparent one is not mistaken for it', { skip: !haveStimulus && 'run npm run fet:stimulus first' }, () => {
  const out = runSelftest()

  // synthbypass's null4 IS the raw stimulus.
  assert.match(section(out, 'synthbypass'), /BIT-IDENTICAL TO THE STIMULUS/)

  // ⚠ synthclean's null1 is ALSO bit-identical — legitimately, because a
  // compensated input at zero GR with no output stage returns its input. null4
  // shows the same "plugin" compressing, which is what tells the two apart.
  const clean = section(out, 'synthclean')
  assert.match(clean, /is BIT-IDENTICAL to the stimulus — but null4 shows the plugin/)
  assert.doesNotMatch(clean, /⚠⚠ .*IS BIT-IDENTICAL/,
    'a transparent setting must not be reported as a bypassed plugin')
})
