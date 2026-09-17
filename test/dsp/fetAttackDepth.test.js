/**
 * The depth-scheduled attack: inert when off, the right shape when on, and a
 * fitter that reports what the data can actually support.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FET1176Kernel, FET1176_KERNEL_DEFAULTS } from '../../src/audio/fet1176Processor.js'

const SR = 96000

function render(params) {
  const k = new FET1176Kernel(SR)
  k.setParams({ outputGainDb: 0, mix: 1, oversample: false, inputDrive: 85, ...params })
  const x = new Float32Array(SR)
  for (let i = 0; i < x.length; i++) {
    x[i] = (i < SR * 0.5 ? 0.3 : 0.002) * Math.sin(2 * Math.PI * 4000 * i / SR)
  }
  const y = new Float32Array(x.length)
  for (let f = 0; f < x.length; f += 128) {
    const l = Math.min(128, x.length - f)
    k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
  }
  return y
}

/**
 * ⚠ IT MUST SHIP OFF. A single exponential in depth fits FETish's attack at
 * 14.2 % rms with structured residuals (−25 / −6 / 0 / +12 % across the four
 * depths) against 36.4 % for a fixed attack. Better, and not good enough to be
 * the default — unlike the release schedule, which fitted at 4.2 %.
 */
test('the attack schedule ships off', () => {
  assert.equal(FET1176_KERNEL_DEFAULTS.attackSchedule, 'none')
  assert.ok(FET1176_KERNEL_DEFAULTS.attackDepthK < 0,
    'the reference attacks FASTER as it compresses harder, so the slope is negative')
})

test('off is bit-identical, even with a slope set', () => {
  const a = render({ attackSchedule: 'none' })
  const b = render({ attackSchedule: 'none', attackDepthK: -0.2 })
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`sample ${i}: a slope leaks through 'none'`)
  }
})

/**
 * ⚠ THE SIGN IS THE CLAIM AND IT IS OPPOSITE TO THE RELEASE'S. FETish grabs
 * faster and lets go slower the harder it works; a schedule that lengthened the
 * attack with depth would be modelling the wrong limb with the right machinery.
 */
test('on, a deeper reduction attacks faster; off, it barely moves', () => {
  const grOf = (params, drive) => {
    const k = new FET1176Kernel(SR)
    k.setParams({ outputGainDb: 0, mix: 1, oversample: false, inputDrive: drive,
      ratio: '4', attack: 1, release: 4, fetDrive: 0, ...params })
    const x = new Float32Array(SR / 2)
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 4000 * i / SR)
    const y = new Float32Array(x.length)
    // Energy in the first 20 ms: a faster attack lets less through.
    for (let f = 0; f < x.length; f += 128) {
      const l = Math.min(128, x.length - f)
      k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
    }
    let e = 0
    for (let i = 0; i < SR * 0.02; i++) e += y[i] * y[i]
    return Math.sqrt(e / (SR * 0.02))
  }
  const on = { attackSchedule: 'depth', attackDepthK: -0.12 }
  // Normalised against the shallow case, so the comparison is about SHAPE.
  const shallowOn = grOf(on, 60), deepOn = grOf(on, 100)
  const shallowOff = grOf({}, 60), deepOff = grOf({}, 100)
  assert.ok(deepOn / shallowOn < deepOff / shallowOff,
    'with the schedule on, the deep case must grab relatively harder than it does off')
})

/**
 * ⚠ THE LADDER AND THE SCHEDULE ARE ONE MODEL AND EITHER HALF ALONE IS WORSE
 * THAN USEFUL. Against the four FETish captures: the pair is 1.15 % rms, the
 * ladder alone 36.5 %, the schedule alone 36.4 %, the shipping datasheet ladder
 * 87.7 %. An earlier ladder fitted WITHOUT the schedule then paired with it gave
 * 13.87 % — two separately-correct fits that do not compose, the same trap the
 * release endpoints hit. This pins that they are still a matched pair.
 */
test('the FETish ladder is calibrated for the schedule, not without it', async () => {
  const { curveFor, rmsResidual } = await import('../../scripts/fet-attack-depth.mjs')
  const rms = p => rmsResidual(curveFor(p)).rms
  const pair = rms({ attackRange: 'fetish', attackSchedule: 'depth' })
  const ladderOnly = rms({ attackRange: 'fetish', attackSchedule: 'none' })
  const scheduleOnly = rms({ attackSchedule: 'depth' })
  assert.ok(pair < 0.05, `the pair must reproduce the reference; got ${(pair * 100).toFixed(2)} %`)
  assert.ok(ladderOnly > pair * 5, 'the ladder alone must be visibly worse than the pair')
  assert.ok(scheduleOnly > pair * 5, 'and so must the schedule alone')
})

test('an unrecognised schedule falls back to off, not on', () => {
  const a = render({ attackSchedule: 'nonsense', attackDepthK: -0.2 })
  const b = render({ attackSchedule: 'none' })
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`sample ${i}: a typo selected the schedule`)
  }
})
