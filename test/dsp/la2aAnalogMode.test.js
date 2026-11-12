/**
 * Analog mode — the product-facing opt-out from the plugin's nonlinearity.
 *
 * ⚠ THE LOAD-BEARING CLAIM IS THAT IT IS NOT A BYPASS. The whole feature rests
 * on turning it off leaving the COMPRESSOR alone: same detector, same taper,
 * same ballistics, same gain envelope, and only the curve removed. If gain
 * reduction ever moves with this switch, the control has stopped meaning what
 * the UI says it means and every preset's character has quietly shifted too.
 *
 * ⚠ AND THE DEFAULT-ON RULE IS A COMPATIBILITY GUARANTEE, not a preference.
 * Every patch, preset and saved file predating this control was auditioned WITH
 * the nonlinearity, so an absent key must read as ON. The mirror of the rule
 * `lookahead` follows for the same reason in the other direction.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { processLA2ABuffer, CELL_CURVE_GAINMOD } from '../../src/audio/la2aProcessor.js'
import { LA2A_DEFAULTS, toKernelParams } from '../../src/audio/effects/la2aParams.js'

const SR = 44100

function passage(seconds = 1.5) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    x[i] = 0.45 * Math.sin(2 * Math.PI * 160 * t) * (0.4 + 0.6 * Math.abs(Math.sin(2 * Math.PI * 2.1 * t)))
      + 0.12 * Math.sin(2 * Math.PI * 4200 * t)
  }
  return x
}
const render = (x, p) => processLA2ABuffer([x], SR, {
  mode: 'compress', gainDb: 0, r37: 100, mix: 1, ...p,
})
const maxDiff = (a, b) => {
  let d = 0
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]))
  return d
}

test('analog off leaves gain reduction bit-identical — it is not a bypass', () => {
  const x = passage()
  for (const pr of [0, 30, 50, 70, 90]) {
    const on = render(x, { peakReduction: pr }).metering
    const off = render(x, { peakReduction: pr, analog: false }).metering
    assert.equal(on.avgGainReductionDb, off.avgGainReductionDb,
      `avg GR moved with analog at PR ${pr} — the switch is touching the detector`)
    assert.equal(on.maxGainReductionDb, off.maxGainReductionDb,
      `max GR moved with analog at PR ${pr}`)
  }
})

test('analog off silences every mechanism, not just the selected one', () => {
  /**
   * ⚠ THE CURVE SELECTORS ARE ALTERNATIVES, so gating whichever one happens to
   * be chosen is not the same as gating "the distortion". Off must render the
   * same audio whatever the cell and valve are set to, or the bench could put
   * colour back into a patch the user switched clean.
   */
  const x = passage()
  const base = { peakReduction: 70, analog: false }
  const ref = render(x, base).channelData[0]
  for (const patch of [
    { cellCurve: CELL_CURVE_GAINMOD }, { cellCurve: 'vocalsat' }, { tubeCurve: 'vocalsat' },
    { tubeCurve: 'tanh' }, { cellCurveDriveMax: 24 }, { emphasis: 100 },
  ]) {
    assert.equal(maxDiff(ref, render(x, { ...base, ...patch }).channelData[0]), 0,
      `analog off is not curve-independent: ${JSON.stringify(patch)} changed the render`)
  }
})

test('analog on is the default and an absent key means on', () => {
  const x = passage(0.6)
  const explicit = render(x, { peakReduction: 60, analog: true }).channelData[0]
  const absent = render(x, { peakReduction: 60 }).channelData[0]
  assert.equal(maxDiff(explicit, absent), 0, 'an absent analog key did not default to on')
  assert.equal(LA2A_DEFAULTS.analog, true)
  // And the patch layer must carry it, or the UI toggle reaches nothing.
  assert.equal(toKernelParams({ ...LA2A_DEFAULTS, analog: false }).analog, false)
  assert.equal(toKernelParams({ ...LA2A_DEFAULTS }).analog, true)
  assert.equal(toKernelParams({ mode: 'compress' }).analog, true,
    'a patch with no analog key must reach the kernel as on')
})

test('analog off actually removes the distortion', () => {
  /**
   * The complement of the bypass test: having proved it does not touch the
   * compressor, prove it does touch the thing it claims to. Harmonics of a tone
   * through the full kernel, on against off.
   */
  const n = 1 << 15
  const f = SR * 150 / n
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = Math.pow(10, -6 / 20) * Math.sin(2 * Math.PI * f * i / SR)
  const thd = (p) => {
    const y = render(x, { peakReduction: 60, ...p }).channelData[0]
    const mag = (k) => {
      let re = 0; let im = 0
      for (let i = 0; i < n; i++) {
        const t = 2 * Math.PI * k * f * i / SR
        re += y[i] * Math.cos(t); im -= y[i] * Math.sin(t)
      }
      return 2 * Math.hypot(re, im) / n
    }
    let sq = 0
    for (let k = 2; k <= 10; k++) sq += mag(k) ** 2
    return 100 * Math.sqrt(sq) / mag(1)
  }
  /**
   * ⚠ MEASURED WITH OVERSAMPLING OFF, AND THE FIRST VERSION OF THIS TEST WAS NOT.
   * The 4x path has a harmonic floor of its own: at Peak Reduction 0, where the
   * gain is constant and nothing can distort, it still reads 0.204 % THD with the
   * nonlinearity OFF and 0.210 % with it ON. That floor is a property of the
   * resampling filters, is present either way, and is not something an Analog
   * switch should or does remove — but it swamps the comparison. With
   * `oversample: false` the same path reads H2 at -223 dBc, so the measurement
   * sees the curve and nothing else.
   */
  const on = thd({ oversample: false })
  const off = thd({ analog: false, oversample: false })
  assert.ok(on > 1, `analog on should distort audibly, measured ${on.toFixed(3)}%`)
  assert.ok(off < on / 10,
    `analog off should be far cleaner: ${off.toFixed(4)}% against ${on.toFixed(3)}%`)

  /**
   * ⚠ AND WHAT SURVIVES IS THE COMPRESSOR, WHICH IS WHY THE RATIO ABOVE IS 10
   * AND NOT 1000. With the curve gone and the cell working, ~0.30 % remains: the
   * detector ripples at 2f on a steady tone, and a carrier multiplied by a 2f
   * ripple puts sidebands at f and 3f. That is gain modulation by the ENVELOPE,
   * not a saturator — the same mechanism the LAEA capture measured at ~0.06 %
   * odd content on a reference with no output stage at all.
   *
   * Pinned by its signature: with the gain held STILL (Peak Reduction 0) the
   * residual has to vanish, because a constant gain cannot modulate anything. If
   * this ever stops being ~0, something nonlinear has survived the switch.
   */
  const stillGain = thd({ analog: false, oversample: false, peakReduction: 0 })
  assert.ok(stillGain < 0.01,
    `with the gain constant and analog off the path must be linear, measured ${stillGain.toFixed(5)}%`)
  assert.ok(off > stillGain * 5,
    'the residual should scale with compression — if it does not, it is not the envelope')
})
