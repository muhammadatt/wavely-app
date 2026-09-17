/**
 * The stairs fitter: what it can recover from a staircase, and what it cannot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLANS, runKernel } from '../../scripts/fet-ballistics.mjs'
import { buildProbe } from '../../scripts/lib/probeStimulus.js'
import { inputDriveDbForKnob } from '../../src/audio/fet1176Processor.js'
import { fitStatic, stairCurve, grForLevel, ratioForSlope, knobsFromName, KNEE_MIN_DB } from '../../scripts/fet-stairs.mjs'

const SR = 96000
const plan = PLANS['stairs.wav']()
let cachedStim = null
const stim = () => (cachedStim ||= buildProbe(plan, SR))

const cache = new Map()
function fitFor(ratio, inputDrive = 50) {
  const key = `${ratio}:${inputDrive}`
  if (!cache.has(key)) {
    const { y } = runKernel(stim().x, SR, { inputDrive, ratio, attack: 1, release: 7, fetDrive: 0 })
    cache.set(key, fitStatic(stairCurve(y, plan, stim(), SR, 0)))
  }
  return cache.get(key)
}

test('the fit describes the curve it was given', () => {
  for (const ratio of ['4', '20']) {
    assert.ok(fitFor(ratio).rms < 0.15, `ratio ${ratio}: rms ${fitFor(ratio).rms}`)
  }
})

/**
 * ⚠ THE STAIRCASE DOES NOT MEASURE THE STATIC LAW, so this does NOT assert the
 * fitted slope equals the true one. At the slowest attack — which the protocol
 * requires, since a fast one leaves the gain tracking |sin| within the cycle
 * with no settled value at all — the gain never reaches the per-peak static
 * target, and the fitted slope comes back a few percent high by construction.
 * What makes the instrument usable anyway is that the bias is nearly CONSTANT:
 * +3.12 / +3.39 / +3.29 / +2.71 % across the four buttons. It therefore cancels
 * in comparisons, which is the only place absolute slope is ever used.
 */
test('the slope bias is real, consistent, and in one direction', () => {
  const rows = [['4', 4], ['8', 8], ['12', 12], ['20', 20]]
    .map(([k, r]) => ({ fitted: fitFor(k).slope, truth: 1 - 1 / r }))
  for (const { fitted, truth } of rows) {
    const bias = fitted / truth - 1
    assert.ok(bias > 0, 'the attack lag can only ever read the law short, never long')
    assert.ok(bias < 0.06, `bias ${(bias * 100).toFixed(2)} % is larger than the measured band`)
  }
  const biases = rows.map(r => r.fitted / r.truth - 1)
  assert.ok(Math.max(...biases) - Math.min(...biases) < 0.02,
    'the bias must stay near-constant, or it will not cancel in a comparison')
})

/**
 * ⚠ THIS IS THE PROPERTY EVERY COMPARISON RESTS ON, and it is why the fit is
 * parameterised on slope. On ratio the same captures came back 4.44 / 14.44 /
 * 13.74 / 20.0 — not monotone, because 1/(1-slope) amplifies a few percent of
 * slope into tens of percent of ratio and swamps the search resolution.
 */
test('the fitted slope is monotone in the true ratio', () => {
  const s = ['4', '8', '12', '20'].map(r => fitFor(r).slope)
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i] > s[i - 1], `not monotone at ${i}: ${s.map(v => v.toFixed(4)).join(' / ')}`)
  }
})

/**
 * ⚠ THRESHOLD AND DRIVE ARE NOT SEPARABLE, so only the DIFFERENCE is a
 * measurement. Two Input positions must move the effective threshold by exactly
 * the drive between them; the absolute value means nothing on its own.
 */
test('an Input change comes back as a threshold difference, exactly', () => {
  const got = fitFor('4', 40).effThresholdDb - fitFor('4', 70).effThresholdDb
  const want = inputDriveDbForKnob(70) - inputDriveDbForKnob(40)
  assert.ok(Math.abs(got - want) < 0.6, `recovered ${got.toFixed(2)} dB against ${want.toFixed(2)}`)
})

test('the law is evaluated with a knee, not a corner', () => {
  const law = { effThresholdDb: -20, slope: 0.75, kneeDb: 10 }
  assert.equal(grForLevel(-30, law), 0, 'well below the knee is untouched')
  assert.ok(grForLevel(-20, law) > 0 && grForLevel(-20, law) < 0.75 * 5,
    'at the threshold the knee is in force, so less than the full slope')
  assert.ok(Math.abs(grForLevel(0, law) - 0.75 * 20) < 1e-9, 'well above it is linear')
})

test('ratio is derived from slope and says so at the limit', () => {
  assert.ok(Math.abs(ratioForSlope(0.75) - 4) < 1e-9)
  assert.equal(ratioForSlope(1), Infinity)
})

test('the filename carries the ratio button and the Input position', () => {
  assert.deepEqual(knobsFromName('fetish_stairs_r4_I3.wav'), { ratio: '4', input: 3 })
  assert.deepEqual(knobsFromName('cla76_stairs_rall_I2.wav'), { ratio: 'all', input: 2 })
  assert.equal(knobsFromName('fetish_stairs.wav').unparsed, true)
})

/**
 * ⚠ THE CONTROL FOR THE COLLAPSE VERDICT, AND WITHOUT IT THAT VERDICT IS AN
 * OPINION. The fitter reported FETish's knee widening 5.01 dB across its four
 * Input positions and called it a property of the reference. That is only worth
 * saying if the instrument reads a KNOWN-fixed knee as fixed across the same
 * span — our own kernel's knee is nailed to RATIO_KNEE_DB by construction, so
 * this is the thing that licenses the claim.
 */
test('a knee that is fixed by construction reads as fixed across the Input range', () => {
  const knees = [30, 44.5, 71.5, 88].map(inputDrive => fitFor('4', inputDrive).kneeDb)
  const spread = Math.max(...knees) - Math.min(...knees)
  assert.ok(spread < 0.5,
    `our fixed knee wobbled ${spread.toFixed(2)} dB across a 25 dB drive span: ` +
    `${knees.map(k => k.toFixed(2)).join(' / ')} — the collapse verdict cannot be trusted`)
})

/**
 * ⚠ AND THE SLOPE MUST COLLAPSE, which is the additive model itself: above the
 * knee, drive and level add in dB, so a drive change moves the curve sideways
 * and does not tilt it.
 */
test('slope is invariant under Input, which is the additive model', () => {
  const slopes = [30, 44.5, 71.5, 88].map(inputDrive => fitFor('4', inputDrive).slope)
  const spread = Math.max(...slopes) - Math.min(...slopes)
  assert.ok(spread < 0.01, `slope moved ${spread.toFixed(4)} across the drive span`)
})

/**
 * ⚠ THE DIFF COLUMN ONLY CANCELS THE ATTACK BIAS IF BOTH SIDES SHARE AN ATTACK,
 * AND THIS IS THE MEASUREMENT THAT SAYS SO. The fitted static curve moves with
 * the attack dial, because a slower attack lags further behind the per-peak
 * target and reads the law steeper. FETish's slowest attack sits near ours so
 * the subtraction is sound there; CLA-76's dial 1 measures ~5688 us against our
 * ~2200, beyond our slowest, so its slope is inflated by an amount the
 * subtraction cannot remove.
 */
test('the fitted static curve depends on the attack dial', () => {
  const at = (attack) => {
    const { y } = runKernel(stim().x, SR, { inputDrive: 50, ratio: '4', attack, release: 7, fetDrive: 0 })
    return fitStatic(stairCurve(y, plan, stim(), SR, 0))
  }
  const slow = at(1).slope, fast = at(4).slope
  assert.ok(slow > fast, 'a slower attack must read the law steeper, not shallower')
  assert.ok(slow - fast > 0.005,
    `the dependence must stay visible; got ${(slow - fast).toFixed(4)} — if this ever` +
    ' goes to zero the diff column has become unconditionally safe and this comment is wrong')
})

/**
 * ⚠ A PARAMETER ON ITS BOUND IS NOT A READING. Twelve of twenty CLA-76 captures
 * returned a knee at or below the old 0.5 dB floor and were printed as though
 * they were measurements.
 */
test('a knee driven to the bound is flagged rather than reported', () => {
  // A hard corner: no knee at all, which the parameterisation cannot express.
  const pts = []
  for (let level = -45; level <= -3; level += 3) {
    pts.push({ levelDb: level, grDb: level > -20 ? 0.75 * (level + 20) : 0 })
  }
  const fit = fitStatic(pts)
  assert.equal(fit.kneeAtBound, true, 'a corner must be flagged, not returned as a narrow knee')
  assert.ok(fit.kneeDb >= KNEE_MIN_DB)
})
