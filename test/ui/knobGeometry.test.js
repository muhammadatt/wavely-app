/**
 * A knob's arc: where a value sits on it, and where a bipolar fill starts.
 *
 * ⚠ TWO DIFFERENT QUANTITIES, AND CONFLATING THEM COST A ROUND TRIP. The FILL
 * ORIGIN is where the lit ring grows from; the POINTER ANGLE is `225 + pct *
 * 270` and depends on nothing but the range. `Knob.vue` hardcoded the fill
 * origin at the arc's MIDPOINT, which is right on every symmetric knob and was
 * right on every bipolar knob in the app when it was written — the soft
 * clipper's Output went ±6 → −12…+24 with auto makeup, whose midpoint is
 * +6 dB, so its ring filled outward from +6. But what was reported was the
 * POINTER sitting round at about 10 o'clock at 0 dB, and only the range moves
 * that. It is 0…+24 now.
 *
 * This suite cannot mount a component (see `travelSlide.test.js`), which is why
 * the geometry lives in a plain module: the numbers that decide what a knob is
 * SAYING are worth pinning without a DOM.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clamp01, valueToPct, pctToValue, bipolarOriginPct,
} from '../../src/components/knobs/knobGeometry.js'
import {
  SOFT_CLIPPER_MAKEUP_MIN_DB, SOFT_CLIPPER_MAKEUP_MAX_DB,
} from '../../src/audio/softClipperProcessor.js'

/**
 * The two asymmetric makeup knobs still shipping. Both are knobs AUTO writes a
 * measured makeup into, which is why they run far further up than down —
 * OptoSmooth's auto makeup clamps against the +24 top at deep LIMIT settings,
 * and FET Punch needs the wide bottom because Input drives the audio path as
 * well as the detector.
 *
 * The soft clipper's Output is no longer among them: it is unipolar 0..+24,
 * pinned below against the constants themselves rather than repeated here.
 */
const LA2A_GAIN = [-12, 24]
const FET_OUTPUT = [-36, 24]

/**
 * An asymmetric BIPOLAR range. Nothing ships one — every bipolar knob in the
 * app is symmetric — so this is the case the origin helper exists to keep
 * right if one ever appears, and the shape the soft clipper's Output had
 * before it went unipolar.
 */
const ASYMMETRIC_BIPOLAR = [-12, 24]

test('a bipolar fill starts where ZERO is, not at the middle of the arc', () => {
  // On -12..+24 the midpoint — what shipped — is +6 dB, so a knob at a genuine
  // 0 dB filled a third of its ring. That was the soft clipper's Output; it is
  // unipolar now, and this keeps the arithmetic right for the next one.
  assert.equal(bipolarOriginPct(...ASYMMETRIC_BIPOLAR), 1 / 3)
  assert.notEqual(bipolarOriginPct(...ASYMMETRIC_BIPOLAR), 0.5)

  // And the origin IS the fraction the value 0 maps to, which is the property
  // rather than the arithmetic — stated separately so a change to either one
  // has to keep them agreeing.
  assert.equal(
    bipolarOriginPct(...ASYMMETRIC_BIPOLAR),
    valueToPct(0, ...ASYMMETRIC_BIPOLAR))
})

test("the soft clipper's Output puts 0 dB at the counter-clockwise stop", () => {
  // ⚠ THE POINTER ANGLE IS THE RANGE, NOT THE FILL ORIGIN, and that is what
  // the report was about: `indicatorDeg = 225 + pct * 270`, so 0 dB on the old
  // -12..+24 sat at pct 1/3, i.e. 315° — about 10 o'clock, a third of the way
  // round from a stop it reads as the resting position of. No fill origin
  // moves a pointer. The travel is unipolar because nothing in the stage
  // raises the peak: the curve and the lookahead limiter both only reduce, so
  // the measured makeup is never negative and the -12 dB was unreachable.
  const range = [SOFT_CLIPPER_MAKEUP_MIN_DB, SOFT_CLIPPER_MAKEUP_MAX_DB]
  assert.equal(SOFT_CLIPPER_MAKEUP_MIN_DB, 0)
  assert.equal(valueToPct(0, ...range), 0)

  // Still reaches every ceiling preset's measured makeup — MEDIUM +9.9,
  // SQUASH +11.0 — which is why the top did not move with the bottom.
  assert.ok(SOFT_CLIPPER_MAKEUP_MAX_DB >= 12)
})

test('every symmetric bipolar knob is untouched, to the last bit', () => {
  // Scheps Output, ResoTame Trim, the Inflator's two, the EQ gain knobs. These
  // were all correct under the hardcoded midpoint, so the fix is only allowed
  // to be a fix if they do not move at all.
  for (const [min, max] of [[-12, 12], [-6, 6], [-50, 50], [-24, 24]]) {
    assert.equal(bipolarOriginPct(min, max), 0.5)
  }
})

test('a bipolar range with no zero in it fills from its nearest end', () => {
  // Degenerate rather than wrong: a knob with no centre has nothing to fill
  // outward from, so it fills from the end nearest zero and reads as an
  // ordinary unipolar knob. Nothing ships like this; the clamp is what stops a
  // future one drawing an arc that starts off the end of its own track.
  assert.equal(bipolarOriginPct(6, 24), 0)
  assert.equal(bipolarOriginPct(-24, -6), 1)
})

test('the other two makeup knobs put 0 dB where their travel puts it', () => {
  // Neither is bipolar — both fill from the minimum — so this pins the reading
  // rather than a fill: 0 dB is a third of the way round OptoSmooth's Gain and
  // three fifths of the way round FET Punch's Output, and has been since each
  // panel was written. ⚠ Both DO use their negative travel — OptoSmooth's
  // makeup sits before the tube stage and FET Punch's Input drives the audio
  // path — so the soft clipper's move to a unipolar range does not transfer to
  // them, and neither is something to "fix" by symmetrising.
  assert.equal(valueToPct(0, ...LA2A_GAIN), 1 / 3)
  assert.equal(valueToPct(0, ...FET_OUTPUT), 0.6)
})

test('value and fraction are exact inverses inside the range, linear and log', () => {
  for (const [min, max, scale] of [
    [-12, 24, 'linear'], [0, 100, 'linear'], [20, 20000, 'log'],
  ]) {
    for (const p of [0, 0.25, 1 / 3, 0.5, 0.75, 1]) {
      const round = valueToPct(pctToValue(p, min, max, scale), min, max, scale)
      assert.ok(Math.abs(round - p) < 1e-12, `${scale} ${min}..${max} at ${p}`)
    }
  }
})

test('a log knob spreads travel per octave, not per unit', () => {
  // The reason the scale exists: linear over 20 Hz–20 kHz puts everything below
  // 200 Hz — where nearly every corrective move lives — in the first degree of
  // rotation. Log puts the geometric mean at the middle of the travel.
  assert.ok(Math.abs(valueToPct(Math.sqrt(20 * 20000), 20, 20000, 'log') - 0.5) < 1e-12)
  assert.ok(valueToPct(200, 20, 20000, 'linear') < 0.01)
})

test('log falls back to linear rather than producing a third behaviour', () => {
  // `min` must be positive for a logarithm, so a caller asking for log over a
  // range containing zero gets the linear mapping — the same rule the soft
  // clipper's `oversample` follows for an unrecognised value.
  assert.equal(valueToPct(0, -12, 24, 'log'), valueToPct(0, -12, 24, 'linear'))
})

test('out-of-range values clamp to the ends of the track', () => {
  assert.equal(valueToPct(-99, -12, 24), 0)
  assert.equal(valueToPct(99, -12, 24), 1)
  assert.equal(clamp01(-0.2), 0)
  assert.equal(clamp01(1.2), 1)
})
