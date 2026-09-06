/**
 * Run with:  npm test
 *
 * THE OPTOSMOOTH DISTORTION BENCH — the tuning constants made movable.
 *
 * ⚠ THE FIRST TEST IS THE ONE THAT MATTERS. The whole design rests on an
 * untouched bench being INVISIBLE: `la2aTuningOverrides()` emits only keys that
 * differ, so `toKernelParams` returns exactly what it returned before the bench
 * existed, and the shipping behaviour cannot drift because a panel was added.
 * If that stops holding, every other test in the suite is measuring a plugin
 * nobody asked for.
 *
 * ⚠ THE STORE IS MODULE STATE, so each test resets it. That is also the point
 * of it — the values deliberately do not live in the patch, so they cannot be
 * serialised into a preset or an undo entry.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LA2AKernel } from '../../src/audio/la2aProcessor.js'
import {
  LA2A_TUNING_DEFAULTS, getLA2ATuning, setLA2ATuning, resetLA2ATuning,
  isLA2ATuningDefault, la2aTuningOverrides,
} from '../../src/audio/effects/la2aTuning.js'
import { LA2A_DEFAULTS, toKernelParams } from '../../src/audio/effects/la2aParams.js'

const SR = 48000
/**
 * ⚠ 1 kHz, NOT THE 200 Hz `la2aTube.test.js` USES, AND THE DIFFERENCE IS NOT
 * COSMETIC. Below about 500 Hz a THIRD odd-order source dominates both of the
 * ones under test: the compressor's own gain ripple, the detector tracking
 * individual cycles of a long period. Measured at 200 Hz it puts H3 at
 * -58.3 dBc with the cell AND the valves both switched off, which is louder
 * than most of what these tests are trying to resolve. At 1 kHz that floor
 * drops to -85.0 and the mechanisms separate. 1000 divides 48000 exactly, so
 * the DFT still sums over whole cycles.
 */
const F = 1000
const CYCLE = SR / F

function run(x, params = {}) {
  const k = new LA2AKernel(SR)
  k.setParams({ mode: 'compress', peakReduction: 0, gainDb: 0, r37: 100, mix: 1, ...params })
  const n = x.length, o = new Float32Array(n)
  for (let f = 0; f < n; f += 128) {
    const l = Math.min(128, n - f)
    k.process([x.subarray(f, f + l)], [o.subarray(f, f + l)], l)
  }
  return o
}

function tone(seconds, amp) {
  const n = Math.round(SR * seconds), x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * F * i / SR)
  return x
}

/** Magnitude of the kth harmonic, over whole cycles taken past settling. */
function harmonic(y, k) {
  const off = 1000 + Math.round(SR * 0.3)
  const N = Math.floor((y.length - off - 1000) / CYCLE) * CYCLE
  let re = 0, im = 0
  for (let i = 0; i < N; i++) {
    const p = 2 * Math.PI * k * F * (off + i) / SR
    re += y[i + off] * Math.cos(p); im += y[i + off] * Math.sin(p)
  }
  return 2 * Math.hypot(re, im) / N
}

const dBc = (y, k) => 20 * Math.log10(Math.max(harmonic(y, k), 1e-30) / harmonic(y, 1))

test('an untouched bench emits no kernel params at all', () => {
  resetLA2ATuning()
  assert.ok(isLA2ATuningDefault())
  assert.deepEqual(la2aTuningOverrides(), {})

  // The exact shape `toKernelParams` returned before the bench existed.
  assert.deepEqual(toKernelParams(LA2A_DEFAULTS), {
    mode: 'compress',
    peakReduction: 50,
    gainDb: 0,
    r37: 100,
    lookaheadMs: 0,
  })
})

test('only the keys actually moved are emitted, and reset clears them', () => {
  resetLA2ATuning()
  setLA2ATuning({ rectLpMs: 2 })
  assert.deepEqual(la2aTuningOverrides(), { rectLpMs: 2 })
  assert.equal(toKernelParams(LA2A_DEFAULTS).rectLpMs, 2)
  assert.ok(!isLA2ATuningDefault())

  // Setting a value back by hand is the same state as never having moved it.
  setLA2ATuning({ rectLpMs: LA2A_TUNING_DEFAULTS.rectLpMs })
  assert.deepEqual(la2aTuningOverrides(), {})

  setLA2ATuning({ cellModMax: 0.3, tubeBias: 0.2 })
  resetLA2ATuning()
  assert.deepEqual(la2aTuningOverrides(), {})
  assert.deepEqual(getLA2ATuning(), { ...LA2A_TUNING_DEFAULTS })
})

test('unknown keys and non-numbers are ignored rather than stored', () => {
  resetLA2ATuning()
  setLA2ATuning({ notAKnob: 5, cellModMax: 'loud', tubeDriveLin: NaN })
  assert.deepEqual(la2aTuningOverrides(), {})
  assert.ok(!('notAKnob' in getLA2ATuning()))
})

/**
 * ⚠ THE CONSTANTS THE BENCH SHADOWS ARE THE KERNEL'S OWN. Passing the defaults
 * explicitly has to produce the same samples as passing nothing, or "at
 * defaults" and "as shipped" have quietly become two different plugins.
 */
test('passing the defaults explicitly is sample-identical to passing nothing', () => {
  const x = tone(0.8, 0.35)
  const bare = run(x, { peakReduction: 70 })
  const explicit = run(x, {
    peakReduction: 70,
    cellMod: LA2A_TUNING_DEFAULTS.cellMod,
    cellModMax: LA2A_TUNING_DEFAULTS.cellModMax,
    cellModTauDb: LA2A_TUNING_DEFAULTS.cellModTauDb,
    rectLpMs: LA2A_TUNING_DEFAULTS.rectLpMs,
    tubeDriveLin: LA2A_TUNING_DEFAULTS.tubeDriveLin,
    tubeBias: LA2A_TUNING_DEFAULTS.tubeBias,
  })
  for (let i = 0; i < bare.length; i++) {
    if (bare[i] !== explicit[i]) {
      assert.fail(`diverged at sample ${i}: ${bare[i]} vs ${explicit[i]}`)
    }
  }
})

test('cellModMax scales the cell distortion, and zero removes it', () => {
  const x = tone(0.8, 0.35)
  const shipping = dBc(run(x, { peakReduction: 70, tube: false }), 3)
  const half = dBc(run(x, { peakReduction: 70, tube: false, cellModMax: LA2A_TUNING_DEFAULTS.cellModMax / 2 }), 3)
  const none = dBc(run(x, { peakReduction: 70, tube: false, cellModMax: 0 }), 3)

  // Halving the depth halves the modulation, i.e. about 6 dB of H3.
  assert.ok(Math.abs((shipping - half) - 6) < 1.5, `H3 moved ${(shipping - half).toFixed(2)} dB, expected ~6`)
  /**
   * ⚠ NOT AN ABSOLUTE FLOOR, BECAUSE ZERO DEPTH DOES NOT MEAN SILENCE. What is
   * left at -85 dBc is the compressor's own gain ripple (see the note on F),
   * which neither the cell nor the valves produce and neither can remove. The
   * claim under test is that the cell's contribution is gone, so it is stated
   * relative to the cell's own level: measured, 53.9 dB of it disappears.
   */
  assert.ok(none < shipping - 40, `cell off should drop H3 far below ${shipping.toFixed(1)}, got ${none.toFixed(1)} dBc`)
})

/**
 * The measured claim the control exists for: a pole on the rectifier changes
 * the SHAPE of the cell's harmonic series, which no other constant does — the
 * high odd orders fall away faster than H3 does. `CELL_MOD_MAX` only scales
 * the whole series, so it cannot do this.
 */
test('the rectifier pole widens the H3-to-H9 spread; cellModMax cannot', () => {
  const x = tone(0.8, 0.35)
  const spread = (p) => {
    const y = run(x, { peakReduction: 70, tube: false, ...p })
    return dBc(y, 3) - dBc(y, 9)
  }
  const off = spread({})
  const poled = spread({ rectLpMs: 2 })
  const quieter = spread({ cellModMax: LA2A_TUNING_DEFAULTS.cellModMax / 4 })

  assert.ok(poled > off + 5, `pole should open the spread; ${off.toFixed(1)} -> ${poled.toFixed(1)} dB`)
  assert.ok(Math.abs(quieter - off) < 1.5,
    `scaling depth must not tilt the profile; ${off.toFixed(1)} -> ${quieter.toFixed(1)} dB`)
})

/**
 * ⚠ THE HOLE AT THE DETECTOR'S OWN TIME CONSTANT IS REAL AND IS NOT A BUG.
 * `rel` is `rect / env - 1`; smoothing the numerator to the denominator's
 * 0.5 ms sends it to zero. Pinned so nobody "fixes" the panel's warning away.
 */
test('a rectifier pole at the detector time constant nulls the modulation', () => {
  const x = tone(0.8, 0.35)
  const off = dBc(run(x, { peakReduction: 70, tube: false }), 3)
  const nulled = dBc(run(x, { peakReduction: 70, tube: false, rectLpMs: 0.5 }), 3)
  assert.ok(nulled < off - 30, `expected a null, got ${off.toFixed(1)} -> ${nulled.toFixed(1)} dBc`)
})

/**
 * ⚠ THE SHAPER HAS AN INVERSE AND IT IS EASY TO LEAVE BEHIND. `liveAutoMakeupDb`
 * inverts the tube curve with `atanh` using the SAME constants; if the bench
 * moved the forward curve and not the inverse, auto-makeup would silently
 * solve for a shaper the audio no longer goes through, and the failure would be
 * a wrong export level rather than anything audible while tuning.
 *
 * ⚠ THE MAKEUP RISES WITH DRIVE, WHICH IS THE OPPOSITE OF WHAT IT SOUNDS LIKE
 * IT SHOULD DO — I asserted it the wrong way round first. The shaper is
 * normalised to unity small-signal gain, so more drive does not make the stage
 * louder; it makes it saturate sooner, which flattens the PEAK and leaves more
 * room under the same ceiling. Monotonicity across three drives is the property
 * that actually pins the inverse to the forward curve.
 */
test('moving the valve constants moves the makeup inverse with them', () => {
  const mk = (p) => {
    const k = new LA2AKernel(SR)
    k.setParams({ mode: 'compress', peakReduction: 0, gainDb: 0, r37: 100, mix: 1, ...p })
    const x = tone(1.2, 0.35), o = new Float32Array(x.length)
    for (let f = 0; f < x.length; f += 128) {
      const l = Math.min(128, x.length - f)
      k.process([x.subarray(f, f + l)], [o.subarray(f, f + l)], l)
    }
    return k.liveAutoMakeupDb()
  }
  const D = LA2A_TUNING_DEFAULTS.tubeDriveLin
  const got = [D, D * 3, D * 6].map(d => mk({ tubeDriveLin: d }))
  assert.ok(got.every(Number.isFinite), `makeup unresolved: ${got}`)
  assert.ok(got[0] < got[1] && got[1] < got[2],
    `inverse did not follow the forward curve: ${got.map(v => v.toFixed(3)).join(' -> ')}`)
  assert.ok(got[2] - got[0] > 0.3, `barely moved: ${(got[2] - got[0]).toFixed(3)} dB`)
})
