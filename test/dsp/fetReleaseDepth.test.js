/**
 * The depth-scheduled release: that it is inert when off, that it does what it
 * claims when on, and that its fitter can recover an answer it already knows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FET1176Kernel, FET1176_KERNEL_DEFAULTS } from '../../src/audio/fet1176Processor.js'
import { measureAt, fitK, curveFor, rmsResidual, FETISH_DEPTH_TABLE } from '../../scripts/fet-release-depth.mjs'

const SR = 96000

/**
 * ⚠ THIS ASSERTED 'none' UNTIL THE RELEASE WAS FITTED, AND THE INVERSION IS THE
 * POINT. The schedule is the limb FETish measurably has — flat on exposure, flat
 * on density, 4.6x across depth — so with the endpoints fitted it ships on. What
 * still has to hold is that the OTHER mode remains reachable and inert, which
 * the next test pins.
 */
test('the schedule ships on', () => {
  assert.equal(FET1176_KERNEL_DEFAULTS.releaseSchedule, 'depth')
  assert.ok(FET1176_KERNEL_DEFAULTS.releaseDepthK > 0)
})

test("'none' is inert, even with a slope set", () => {
  const render = params => {
    const k = new FET1176Kernel(SR)
    k.setParams({ outputGainDb: 0, mix: 1, oversample: false, inputDrive: 85, ...params })
    const x = new Float32Array(SR)
    for (let i = 0; i < x.length; i++) x[i] = (i < SR * 0.4 ? 0.25 : 0.001) * Math.sin(2 * Math.PI * 4000 * i / SR)
    const y = new Float32Array(x.length)
    for (let f = 0; f < x.length; f += 128) {
      const l = Math.min(128, x.length - f)
      k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
    }
    return y
  }
  const a = render({ releaseSchedule: 'none' })
  const b = render({ releaseSchedule: 'none', releaseDepthK: 0.25 })
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`sample ${i}: ${a[i]} vs ${b[i]} — a slope leaks through 'none'`)
  }
})

test('on, release t63 rises with depth; off, it does not move', () => {
  // measureAt drives by STIMULUS LEVEL in dB, not by the Input knob — see the
  // note on measureAt for why, and for the check that the two are equivalent.
  const drives = [-8, -2, 4]
  const on = drives.map(d => measureAt(d, { releaseSchedule: 'depth', releaseDepthK: 0.12, tailFraction: 0 }))
  const off = drives.map(d => measureAt(d, { releaseSchedule: 'none', tailFraction: 0 }))
  // ⚠ The control is 'none', not the default — the default IS the schedule now.

  // ⚠ The control is the point: a fixed exponential recovers 63 % of its
  // reduction in one constant HOWEVER deep the reduction was, so a flat reading
  // here is what proves the measurement is not inventing the effect.
  const offSpread = Math.max(...off.map(m => m.t63Ms)) - Math.min(...off.map(m => m.t63Ms))
  assert.ok(offSpread < 1, `a fixed release must read flat across depth; spread ${offSpread.toFixed(2)} ms`)

  assert.ok(on[0].t63Ms < on[1].t63Ms && on[1].t63Ms < on[2].t63Ms,
    `must rise with depth: ${on.map(m => m.t63Ms.toFixed(0)).join(' / ')}`)
  assert.ok(on[2].t63Ms / on[0].t63Ms > 1.5, 'and rise by more than measurement noise')
})

test('the fitter recovers a slope the kernel was rendered with', () => {
  const TRUE_K = 0.12
  const synth = curveFor({ releaseSchedule: 'depth', releaseDepthK: TRUE_K, release: 4, tailFraction: 0 },
    [{ depthDb: 6 }, { depthDb: 10 }, { depthDb: 14 }, { depthDb: 16 }])
    .filter(r => r.ourT63Ms !== null)
    .map(r => ({ depthDb: r.depthDb, t63Ms: r.ourT63Ms }))
  assert.ok(synth.length >= 3, 'the synthetic table must have more rows than free parameters')
  const got = fitK(synth)
  assert.ok(Math.abs(got.k - TRUE_K) < 0.01, `recovered ${got.k.toFixed(4)} against ${TRUE_K}`)
  assert.ok(got.rms < 0.02, `residual ${(got.rms * 100).toFixed(2)} %`)
})

/**
 * ⚠ THIS TEST USED TO ASSERT THE OPPOSITE, AND THAT IS THE POINT. Our Input knob
 * tops out near 16.3 dB against a reference reaching 21.9, so two of the four
 * rows were unreachable and the fit had two points against two free parameters —
 * an interpolation whose residual was zero by construction. The fix was NOT to
 * widen IN_DRIVE_SPAN_DB, which would have moved every shipping knob position to
 * unblock a measurement: the detector sees level and drive summed in dB, and the
 * measurement path bypasses the saturator, so the bench drives the stimulus
 * instead and reaches any depth it likes. This pins that all four rows stay
 * reachable, because losing one takes the fit back to meaningless.
 */
test('every reference row is reachable, so the fit is not an interpolation', () => {
  const rows = curveFor({ releaseSchedule: 'depth', releaseDepthK: 0.138, tailFraction: 0 })
  assert.equal(rows.length, FETISH_DEPTH_TABLE.length)
  const reachable = rows.filter(r => r.ourT63Ms !== null).length
  assert.equal(reachable, FETISH_DEPTH_TABLE.length,
    `only ${reachable} rows reachable — with 2 free parameters the fit needs more than 2`)
  // And the deepest row is past the Input knob's own ceiling, which is the whole
  // reason the bench drives by level.
  assert.ok(FETISH_DEPTH_TABLE.at(-1).depthDb > 16.5)
})

test('a fixed release with the dial free cannot match the reference shape', () => {
  // The honest null hypothesis: not the shipping dial, the BEST fixed dial.
  let best = Infinity
  for (let dial = 1; dial <= 7; dial += 0.25) {
    const r = rmsResidual(curveFor({ releaseSchedule: 'none', release: dial, tailFraction: 0 }))
    if (r.rms < best) best = r.rms
  }
  assert.ok(best > 0.2, `a fixed release got within ${(best * 100).toFixed(1)} % — the shape claim needs re-examining`)
})

/**
 * ⚠ THE SHIPPING COMBINATION IS A MATCHED PAIR AND TURNING THE SCHEDULE OFF
 * BREAKS IT, WHICH THE BENCH HAS TO SAY OUT LOUD. The release endpoints were
 * scaled 1.813x so they compose with the depth schedule — that is what makes the
 * shipping pair land within 1 % of the reference. They are constants, not
 * parameters, so the bench cannot switch them back: selecting FIXED leaves every
 * dial about 1.8x long.
 *
 * This is the same shape as the attack pair, where either half alone is ~36 %
 * out against 1.15 % for both. The difference is that the ATTACK ships as the
 * complete datasheet model — its ladder was never scaled for a schedule — so
 * 'datasheet' + 'none' is internally consistent, while release 'none' is not.
 */
test('turning the release schedule off breaks the endpoint calibration', () => {
  const t63 = (params) => {
    const k = new FET1176Kernel(SR)
    k.setParams({ outputGainDb: 0, mix: 1, fetDrive: 0, oversample: false,
      inputDrive: 67, ratio: '4', attack: 4, release: 4, ...params })
    k.tailFraction = 0
    k.mainFraction = 1
    const x = new Float32Array(SR * 2)
    for (let i = 0; i < x.length; i++) {
      x[i] = (i < SR ? 0.25 : 0.002) * Math.sin(2 * Math.PI * 4000 * i / SR)
    }
    const y = new Float32Array(x.length)
    for (let f = 0; f < x.length; f += 128) {
      const l = Math.min(128, x.length - f)
      k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
    }
    // Time for the gain to come most of the way back after the step.
    let i = SR
    const open = Math.abs(y[x.length - 100]) / 0.002
    while (i < x.length - 1 && Math.abs(y[i]) / 0.002 < open * 0.63) i++
    return (i - SR) / SR
  }
  const shipping = t63({})
  const fixed = t63({ releaseSchedule: 'none' })
  assert.ok(fixed > shipping * 1.4,
    `FIXED must be visibly slower than the calibrated pair; ${shipping.toFixed(4)} vs ${fixed.toFixed(4)} s`)
})
