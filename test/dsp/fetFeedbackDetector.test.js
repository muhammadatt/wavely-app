/**
 * Run with:  npm test
 *
 * FET Punch's FEEDBACK detector — the prototype topology behind `detector`.
 *
 * What it must keep from feed-forward, exactly: the static curve, the release
 * once the signal drops away, the output-gain identity auto makeup solves
 * through, and the shipping default. What it must change: attack time with the
 * ratio button. The refit that calibrates it is `scripts/fet-feedback-refit.mjs`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FET1176Kernel, FET1176_KERNEL_DEFAULTS, FET_LEGACY_PATCH,
} from '../../src/audio/fet1176Processor.js'

const SR = 44100

/** A full-scale-alternating square: |x| is constant, so the detector is DC. */
function square(db, seconds, silentS = 0) {
  const a = Math.pow(10, db / 20)
  const n = Math.round(SR * seconds)
  const on = Math.round(SR * silentS)
  return Float32Array.from({ length: n }, (_, i) => (i < on ? 0 : (i % 2 ? a : -a)))
}

/** Render sample by sample, returning output and the GR trace. */
function render(params, x) {
  const k = new FET1176Kernel(SR)
  k.setParams({ oversample: false, fetDrive: 0, outputGainDb: 0, mix: 1, ...params })
  const y = new Float32Array(x.length)
  const gr = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    k.process([x.subarray(i, i + 1)], [y.subarray(i, i + 1)], 1)
    gr[i] = k.grDb
  }
  return { y, gr }
}

const RATIOS = ['4', '8', '12', '20', 'all']

test('feed-forward ships, and an absent value resolves to it', () => {
  assert.equal(FET1176_KERNEL_DEFAULTS.detector, 'feedforward')
  // ⚠ Not in FET_LEGACY_PATCH: the patch carries only keys that differ from the
  // shipping defaults (the bench sends diffs), and the old kernel was feed-forward.
  assert.ok(!('detector' in FET_LEGACY_PATCH))
  const x = square(-6, 0.2)
  const a = render({}, x).y
  const b = render({ detector: undefined }, x).y
  const c = render({ detector: 'feedforward' }, x).y
  assert.deepEqual(b, a)
  assert.deepEqual(c, a)
})

test('the static curve is identical: a held level settles on the same reduction', () => {
  // ⚠ The knee is where a sloppy re-parameterisation would show, so the levels
  // straddle it as well as sitting well above.
  for (const ratio of RATIOS) {
    for (const db of [-24, -20, -18, -16, -12, 0]) {
      const x = square(db, 1)
      const ff = render({ ratio, inputDrive: 60, release: 1 }, x).gr.at(-1)
      const fb = render({ ratio, inputDrive: 60, release: 1, detector: 'feedback' }, x).gr.at(-1)
      assert.ok(Math.abs(ff - fb) < 1e-9, `ratio ${ratio} at ${db} dBFS: ${ff} vs ${fb}`)
    }
  }
})

test('the release is identical once the signal drops below threshold', () => {
  // Same settled depth, then silence: the loop asks for nothing and is open.
  const hold = square(-6, 1)
  const x = new Float32Array(hold.length + SR / 2)
  x.set(hold)
  for (const ratio of ['4', '20', 'all']) {
    const ff = render({ ratio, inputDrive: 70, attack: 7, release: 3 }, x).gr
    const fb = render({ ratio, inputDrive: 70, attack: 7, release: 3, detector: 'feedback' }, x).gr
    let worst = 0
    for (let i = hold.length - 10; i < x.length; i++) worst = Math.max(worst, Math.abs(ff[i] - fb[i]))
    assert.ok(worst < 1e-9, `ratio ${ratio}: release differs by ${worst} dB`)
  }
})

test('the loop is stable at the fastest attack and the highest loop gain', () => {
  // ⚠ The case a one-sample-delay loop gets wrong: attack 7 (coefficient ~0.7)
  // against a loop gain of ~19. The zero-delay solve must settle, not ring.
  for (const ratio of ['20', 'all']) {
    const { y, gr } = render({ ratio, inputDrive: 100, attack: 7, release: 7, detector: 'feedback' },
      square(0, 0.5))
    assert.ok(y.every(Number.isFinite))
    let lo = Infinity, hi = -Infinity
    for (let i = gr.length - SR / 10; i < gr.length; i++) { lo = Math.min(lo, gr[i]); hi = Math.max(hi, gr[i]) }
    assert.ok(hi - lo < 1e-9, `ratio ${ratio}: GR wanders ${hi - lo} dB after settling`)
  }
})

/** Samples from onset to 63 % of the settled reduction. */
function attackT63(params) {
  const { gr } = render({ inputDrive: 70, ...params }, square(-12, 0.5, 0.1))
  const on = Math.round(SR * 0.1)
  const fin = gr.at(-1)
  let j = on
  while (gr[j] < 0.632 * fin) j++
  return j - on
}

test('feedback attack shortens with the ratio button, feed-forward does not', () => {
  const ff = ['4', '8', '20'].map(ratio => attackT63({ ratio, attack: 1 }))
  const fb = ['4', '8', '20'].map(ratio => attackT63({ ratio, attack: 1, detector: 'feedback' }))
  // Feed-forward: one time for every button, to the knee's few percent.
  assert.ok(Math.max(...ff) / Math.min(...ff) < 1.1, `ff ${ff}`)
  // Feedback: ~2x at 8:1 and ~5x at 20:1 against 4:1 (measured 0.49 / 0.20).
  assert.ok(fb[1] / fb[0] < 0.6 && fb[1] / fb[0] > 0.4, `fb 8:1 / 4:1 ${fb[1] / fb[0]}`)
  assert.ok(fb[2] / fb[0] < 0.3 && fb[2] / fb[0] > 0.12, `fb 20:1 / 4:1 ${fb[2] / fb[0]}`)
})

test('the refitted ladder lands 4:1 where feed-forward attacks', () => {
  // ⚠ Without FB_ATTACK_SCALE the loop makes 4:1 ~3.7x fast. The scale was fitted
  // to FETish, not to this; agreement here is the calibration composing.
  for (const attack of [1, 4]) {
    const ff = attackT63({ ratio: '4', attack })
    const fb = attackT63({ ratio: '4', attack, detector: 'feedback' })
    assert.ok(Math.abs(fb / ff - 1) < 0.25, `dial ${attack}: fb ${fb} vs ff ${ff} samples`)
  }
})

test('Output stays outside the loop, so auto makeup keeps out = a + b·g', () => {
  const x = Float32Array.from({ length: SR / 2 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 220 * i / SR) * (i % 9000 < 4500 ? 1 : 0.2))
  const p = { detector: 'feedback', inputDrive: 80, attack: 6, fetDrive: 0.5, oversample: true }
  const a = render({ ...p, outputGainDb: 0 }, x).y
  const b = render({ ...p, outputGainDb: 6 }, x).y
  const g = Math.pow(10, 6 / 20)
  // The Output smoother seeds on its target, so from sample 0 the two renders
  // differ by exactly g — or the gain reached the detector.
  let worst = 0
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(b[i] - g * a[i]))
  assert.ok(worst < 1e-5, `Output reached the detector: worst ${worst}`)
})

test('the bench accepts the detector and refuses anything else', async () => {
  const t = await import('../../src/audio/effects/fet1176Tuning.js')
  t.resetFET1176Tuning()
  assert.equal(t.getFET1176Tuning().detector, 'feedforward')
  assert.equal(t.setFET1176Tuning({ detector: 'sideways' }), false)
  assert.equal(t.setFET1176Tuning({ detector: 'feedback' }), true)
  assert.deepEqual(t.fet1176TuningOverrides(), { detector: 'feedback' })
  t.resetFET1176Tuning()
  assert.deepEqual(t.fet1176TuningOverrides(), {})
})

test('CLA-76 20:1 vs 4:1: feedback predicts the held-out ratio, feed-forward the wrong sign', async () => {
  // ⚠ A ONE-BURST plan at the capture's rate, so the suite stays fast; the full
  // burst plan is what `npm run fet:fbrefit` reports (0.27 / 1.24 against 0.29).
  // The attack is read on the same 1 s settle either way.
  const { r20OverR4, CLA76_R20_OVER_R4 } = await import('../../scripts/fet-feedback-refit.mjs')
  const { snapToZeroCrossing } = await import('../../scripts/lib/probeStimulus.js')
  const up = snapToZeroCrossing(1.0, 4000)
  const down = snapToZeroCrossing(up + 1.0, 4000)
  const plan = { events: [{ tag: 'b', T: 1.0, freqHz: 4000, hiDb: -12, up, down }], spans: [], seconds: down + 3, lowDb: -50 }
  const ff = r20OverR4('feedforward', { plan, iters: 10 })
  const fb = r20OverR4('feedback', { plan, iters: 10 })
  assert.ok(ff.ratio > 1, `feed-forward ${ff.ratio}: 20:1 should read SLOWER, the wrong sign`)
  assert.ok(Math.abs(fb.ratio - CLA76_R20_OVER_R4.ratio) < 0.08,
    `feedback ${fb.ratio} against CLA-76 ${CLA76_R20_OVER_R4.ratio}`)
})
