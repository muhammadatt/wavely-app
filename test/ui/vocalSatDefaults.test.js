/**
 * The panel's shipping patch — the constraints that would SILENTLY disable part
 * of it if a later edit moved one value without the others.
 *
 * Run with:  npm test
 *
 * Every feature in this plugin that depends on another one fails quietly rather
 * than loudly: the kernel falls back, and the panel greys a knob. That is the
 * right runtime behaviour and the wrong thing to discover by ear, so the
 * couplings are asserted here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VOCAL_SAT_DEFAULTS, MODE_SERIES, CURVE_SHAPE, ASYM_MODE_SPLIT,
} from '../../src/audio/vocalSatParams.js'
import {
  HARDNESS_MIN, HARDNESS_MAX, VOCAL_SAT_KERNEL_DEFAULTS,
} from '../../src/audio/vocalSatProcessor.js'

test('the panel patch does not silently disable its own features', () => {
  const d = VOCAL_SAT_DEFAULTS

  // SPLIT needs the SHAPE curve — a cubic has one possible knee, so there is no
  // second one for the other polarity and the kernel falls back to OFFSET.
  if (d.asymMode === ASYM_MODE_SPLIT) {
    assert.equal(
      d.curve, CURVE_SHAPE,
      'the default asymmetry mode is SPLIT, which needs CURVE_SHAPE — on the '
      + 'cubic the kernel falls back to OFFSET and the default patch would '
      + 'quietly become a different effect',
    )
  }

  // Soften and Tame are series-only; the kernel ignores them in parallel.
  if (d.soften > 0 || d.tame > 0) {
    assert.equal(
      d.mode, MODE_SERIES,
      `the default patch sets soften ${d.soften} and tame ${d.tame}, both of `
      + 'which the kernel ignores outside SERIES',
    )
  }

  assert.ok(
    d.hardness >= HARDNESS_MIN && d.hardness <= HARDNESS_MAX,
    `default hardness ${d.hardness} is outside the measured-safe range — the `
    + 'kernel would clamp it and the knob could not return to its own default',
  )
})

test('every panel default is inside its control range', () => {
  // A default outside a knob's range renders a control that cannot be returned
  // to where it started.
  const ranges = {
    drive: [0, 5],
    wetDry: [0, 1],
    asymmetry: [0, 100],
    hardness: [HARDNESS_MIN, HARDNESS_MAX],
    emphasis: [0, 100],
    soften: [0, 100],
    tame: [0, 100],
    autoDrive: [0, 100],
    hfLoss: [0, 100],
    lowCrossover: [100, 2000],
    midCrossover: [1000, 8000],
    lowDriveMult: [0, 10],
    midDriveMult: [0, 10],
    highDriveMult: [0, 10],
  }
  for (const [name, [lo, hi]] of Object.entries(ranges)) {
    const v = VOCAL_SAT_DEFAULTS[name]
    assert.equal(typeof v, 'number', `${name} should be a number, got ${v}`)
    assert.ok(v >= lo && v <= hi, `${name} default ${v} is outside [${lo}, ${hi}]`)
  }
  assert.ok(
    VOCAL_SAT_DEFAULTS.lowCrossover < VOCAL_SAT_DEFAULTS.midCrossover,
    'the crossovers must not cross over each other',
  )
})

test('the panel patch and the kernel defaults are allowed to differ', () => {
  // ⚠ AND THEY DO, DELIBERATELY. VOCAL_SAT_KERNEL_DEFAULTS mirrors
  // vocal_saturation.py and is what processVocalSatBuffer runs with no
  // arguments, so the parity and bit-identity tests rest on it. The panel patch
  // is the sound the plugin opens with. This asserts the separation is real, so
  // that anyone "tidying up" the duplication has to read why first.
  assert.notDeepEqual(
    VOCAL_SAT_DEFAULTS.mode, VOCAL_SAT_KERNEL_DEFAULTS.mode,
    'if these have converged, check it was intended — the kernel defaults carry '
    + 'the Python parity claims and the panel patch does not',
  )
})
