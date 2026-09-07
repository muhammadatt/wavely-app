/**
 * Run with:  npm test
 *
 * `regionPeakDb` — the region's true peak, for the makeup ceiling.
 *
 * ⚠ THE POINT OF THESE TESTS IS THE SPAN, NOT THE ARITHMETIC. Every other
 * measured parameter goes through `measureInWorker`, which caps its pass at
 * AUTO_MAKEUP_MAX_ANALYSIS_S anchored at the region's start. That cap is right
 * for a solve behind a knob drag and WRONG for a ceiling: a ceiling taken from
 * the first thirty seconds clamps everything after it, so the back half of a
 * long take gets limited to whatever level the front half happened to reach.
 * The test that matters here is the one with the peak deliberately parked
 * outside the analysis window.
 *
 * ⚠ AND IT LIVES IN analysisWindow.js RATHER THAN processing.js SO IT CAN BE
 * TESTED AT ALL. That file pulls Vite `?worker&url` specifiers, so nothing in
 * it is reachable from `node --test` — the same reason the window arithmetic
 * was split out here in the first place, and this is the same kind of
 * arithmetic: silently wrong, expensively.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { regionPeakDb, AUTO_MAKEUP_MAX_ANALYSIS_S } from '../../src/audio/analysisWindow.js'

const SR = 44100

/** A minimal stand-in for the AudioBuffer shape `regionPeakDb` reads. */
function buffer(channels) {
  return { getChannelData: ch => channels[ch] }
}

/**
 * One segment covering a source, laid down at `outputStart`.
 *
 * ⚠ AN AUDIO SEGMENT'S DURATION IS `sourceEnd - sourceStart`, NOT A `duration`
 * FIELD — only a SilenceSegment carries that. A first draft of these fakes set
 * `duration` and every test read -Infinity, because `getSegmentDuration` made
 * each segment zero-length and the region walk skipped all of them.
 */
function segment(samples, { outputStart = 0, sourceStart = 0 } = {}) {
  return {
    outputStart,
    sourceStart,
    sourceEnd: sourceStart + samples.length / SR,
    sourceBuffer: buffer([samples]),
  }
}

const ramp = (n, value) => { const x = new Float32Array(n); x.fill(value); return x }

/**
 * ⚠ TOLERANCE IS 1e-4 dB, NOT 1e-9, AND THE SAMPLES ARE WHY. Audio is
 * Float32Array, so 0.1 stored and read back is 0.100000001490116, and an exact
 * comparison against `20*log10(0.1)` fails by ~1e-7 dB — a first draft of these
 * tests failed on precisely that, which is a test measuring the storage format
 * rather than the function. A ten-thousandth of a dB is far below anything a
 * ceiling could care about and far above float32's noise.
 */
const closeDb = (got, want, what) => assert.ok(Math.abs(got - want) < 1e-4,
  `${what}: got ${got}, want ${want}`)

test('reads the peak of a simple region', () => {
  const x = ramp(SR, 0.25)
  x[SR / 2] = 0.5
  closeDb(regionPeakDb([segment(x)], 0, 1, SR, 1), 20 * Math.log10(0.5), 'simple region')
})

test('a silent or empty region reports -Infinity rather than 0 dBFS', () => {
  assert.equal(regionPeakDb([], 0, 1, SR, 1), -Infinity)
  const silence = { outputStart: 0, sourceStart: 0, duration: 1, sourceBuffer: null }
  assert.equal(regionPeakDb([silence], 0, 1, SR, 1), -Infinity)
})

test('ignores segments outside the region', () => {
  const quiet = ramp(SR, 0.1)
  const loud = ramp(SR, 0.9)
  const segs = [segment(quiet, { outputStart: 0 }), segment(loud, { outputStart: 1 })]
  closeDb(regionPeakDb(segs, 0, 1, SR, 1), 20 * Math.log10(0.1),
    'the loud segment starts at 1 s and must not count')
})

test('honours a region that starts partway into a segment', () => {
  const x = ramp(2 * SR, 0.2)
  x[Math.floor(0.25 * SR)] = 0.8   // before the region
  x[Math.floor(1.50 * SR)] = 0.6   // inside it
  closeDb(regionPeakDb([segment(x)], 1, 2, SR, 1), 20 * Math.log10(0.6),
    'only the in-region peak counts')
})

test('scans every channel', () => {
  const left = ramp(SR, 0.2)
  const right = ramp(SR, 0.7)
  const seg = {
    outputStart: 0, sourceStart: 0, sourceEnd: 1, sourceBuffer: buffer([left, right]),
  }
  closeDb(regionPeakDb([seg], 0, 1, SR, 2), 20 * Math.log10(0.7), 'stereo')
  closeDb(regionPeakDb([seg], 0, 1, SR, 1), 20 * Math.log10(0.2),
    'a mono read must not reach into the second channel')
})

test('negative peaks count', () => {
  const x = ramp(SR, 0.1)
  x[10] = -0.75
  closeDb(regionPeakDb([segment(x)], 0, 1, SR, 1), 20 * Math.log10(0.75), 'negative peak')
})

/**
 * The one that justifies the function existing. A worker measurement would see
 * only the first `AUTO_MAKEUP_MAX_ANALYSIS_S`, so a peak parked past it would
 * come back as the quiet level — and a ceiling set there would hold the whole
 * back half of the take down to it.
 */
test('sees a peak beyond the analysis-window cap', () => {
  const seconds = AUTO_MAKEUP_MAX_ANALYSIS_S + 10
  const x = ramp(Math.round(seconds * SR), 0.1)
  const latePeakAt = Math.round((AUTO_MAKEUP_MAX_ANALYSIS_S + 5) * SR)
  x[latePeakAt] = 0.95

  closeDb(regionPeakDb([segment(x)], 0, seconds, SR, 1), 20 * Math.log10(0.95),
    'the late peak must be found, not the 0.1 plateau')

  // And the excerpt a capped pass would have seen really does miss it, so the
  // test above is measuring the hazard rather than restating the obvious.
  closeDb(regionPeakDb([segment(x)], 0, AUTO_MAKEUP_MAX_ANALYSIS_S, SR, 1),
    20 * Math.log10(0.1), 'the capped span should miss it entirely')
})
