/**
 * The stairs fitter: what it can recover from a staircase, and what it cannot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLANS, runKernel } from '../../scripts/fet-ballistics.mjs'
import { buildProbe } from '../../scripts/lib/probeStimulus.js'
import { inputDriveDbForKnob } from '../../src/audio/fet1176Processor.js'
import { fitStatic, stairCurve, grForLevel, ratioForSlope, knobsFromName } from '../../scripts/fet-stairs.mjs'

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
