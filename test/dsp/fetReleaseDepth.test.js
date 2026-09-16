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
 * ⚠ THE DEFAULT MUST STAY 'none'. This is a topology change, not a retune —
 * every FET Punch render ever made used a fixed release, and the five factory
 * presets are calibrated against it. The Scheps inheritance bug, which shipped
 * 4x the intended gain reduction, is the precedent for what a silently changed
 * default costs here.
 */
test('the schedule ships off', () => {
  assert.equal(FET1176_KERNEL_DEFAULTS.releaseSchedule, 'none')
})

test('off is bit-identical, even with a slope set', () => {
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
  const a = render({})
  const b = render({ releaseSchedule: 'none', releaseDepthK: 0.25 })
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`sample ${i}: ${a[i]} vs ${b[i]} — 'none' is not a way back`)
  }
})

test('on, release t63 rises with depth; off, it does not move', () => {
  const on = [6, 10, 14].map(d => measureAt(
    { 6: 62, 10: 73, 14: 89 }[d], { releaseSchedule: 'depth', releaseDepthK: 0.12, tailFraction: 0 }))
  const off = [62, 73, 89].map(i => measureAt(i, { releaseSchedule: 'none', tailFraction: 0 }))

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
 * ⚠ THE FETish FIT IS UNDERDETERMINED AND MUST STAY VISIBLY SO. Our Input runs
 * out near 16.3 dB against a reference that reaches 21.9, leaving two reachable
 * rows against two free parameters — k and the release dial. Any two rows can
 * then be hit exactly, so a near-zero residual is arithmetic, not evidence. If
 * this test ever starts failing because more rows are reachable, that is the
 * signal the fit has become worth believing.
 */
test('the FETish fit is underdetermined until the Input range widens', () => {
  const rows = curveFor({ releaseSchedule: 'depth', releaseDepthK: 0.12, tailFraction: 0 })
  const reachable = rows.filter(r => r.ourT63Ms !== null).length
  assert.ok(reachable <= 2,
    `${reachable} rows now reachable — the fit may no longer be underdetermined, so re-read it`)
  assert.equal(rows.length, FETISH_DEPTH_TABLE.length)
  assert.ok(rows.filter(r => r.clipped === 'high').length >= 2)
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
