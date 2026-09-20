/**
 * Run with:  npm test
 *
 * Covers what the Punch Chain adds beyond its two parts. The FET and the opto
 * cell each have their own suites; nothing here re-tests either kernel's DSP.
 * What is new is the composition:
 *
 *   - the chain IS the two kernels in series, sample for sample, so a re-fit on
 *     either side reaches it and nothing here silently forks a third model
 *   - the makeup and the ceiling are at the COMPOSITE's output, not inside
 *     either kernel, which is the rule `makeupReference.js` states and the one
 *     Scheps had to be corrected on
 *   - the Opto's side-chain alignment follows the FET's dial, which is the one
 *     thing that makes two dials on one plate behave like two dials
 *   - the panel defaults round-trip to the kernel defaults, which is the
 *     inheritance trap Scheps fell into twice
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoSignal } from '../helpers/memoSignal.js'
import {
  PunchChainKernel,
  processPunchChainBuffer,
  computePunchChainPlan,
  PUNCH_CHAIN_KERNEL_DEFAULTS,
} from '../../src/audio/punchChainProcessor.js'
import { processFET1176Buffer } from '../../src/audio/fet1176Processor.js'
import { processLA2ABuffer } from '../../src/audio/la2aProcessor.js'
import { OVERSAMPLE_LATENCY_SAMPLES } from '../../src/audio/dsp/oversample.js'
import {
  percentileOfChannels, peakOfChannels, MAKEUP_PERCENTILE, CEILING_KNEE_DB,
  solveMakeupPlan, peakRestoreTrimDb, restorePeakToCeiling,
} from '../../src/audio/dsp/makeupReference.js'
import { gatedRmsOfChannels, inputAlignDbFor } from '../../src/audio/dsp/inputAlign.js'
import {
  detectPhrases, measureDensityDb, measureSpreadDb,
} from '../../src/audio/dsp/densityMetrics.js'
import {
  PUNCH_CHAIN_DEFAULTS, PUNCH_CHAIN_LATENCY_SAMPLES, PUNCH_CHAIN_MEASURED_KEYS,
  toKernelParams,
} from '../../src/audio/effects/punchChainParams.js'
import { withMeasuredClears } from '../../src/audio/effects/measuredKeys.js'

const SR = 44100

const db = (x) => 20 * Math.log10(Math.max(x, 1e-12))

/**
 * A stand-in for a voice, with the two features this plugin is measured
 * against: formants where speech has them, and syllables at different LEVELS
 * so that phrase-level spread is a real quantity rather than a constant.
 *
 * ⚠ THE LEVEL VARIATION IS NOT DECORATION. Spread is the Opto's whole job here,
 * and on a probe whose syllables are all the same loudness it is zero before
 * anything is done and cannot move — which would make the levelling assertions
 * below pass on a plugin that does nothing at all.
 */
function voiceLike(seconds) {
  return memoSignal(`punchVoice|${seconds}`, () => {
    const n = Math.round(seconds * SR)
    const out = new Float32Array(n)
    let seed = 7
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    let t = 0.15
    while (t < seconds - 0.4) {
      const dur = 0.16 + rand() * 0.22
      // 14 dB of syllable-to-syllable range, which is roughly what an unlevelled
      // narration take has.
      const amp = 0.05 * Math.pow(10, (-11 + rand() * 14) / 20)
      const f0 = 115 + rand() * 35
      const from = Math.round(t * SR)
      const to = Math.min(n, Math.round((t + dur) * SR))
      for (let i = from; i < to; i++) {
        const u = (i - from) / (to - from)
        const env = u < 0.015 ? u / 0.015 : Math.sin(Math.PI * (0.5 + (u - 0.015) / 2)) ** 1.2
        const tt = i / SR
        let s = 0
        for (let h = 1; h <= 40; h++) {
          const f = f0 * h
          if (f > SR / 2) break
          let a = 1 / h
          for (const F of [600, 1800, 2800]) {
            a += 0.9 * Math.exp(-Math.pow((f - F) / 260, 2)) / Math.sqrt(h)
          }
          s += a * Math.sin(2 * Math.PI * f * tt + h)
        }
        out[i] += amp * env * (s + (rand() - 0.5) * 0.35)
      }
      t += dur + 0.06 + rand() * 0.2
    }
    return out
  })
}

const signal = () => [Float32Array.from(voiceLike(6))]

// ── Composition ─────────────────────────────────────────────────────────────

test('the chain is FET then opto, sample for sample', () => {
  const src = signal()
  const drive = 35
  const peakReduction = 55
  const fetAlignDb = 4
  const optoAlignDb = 9

  const staged = processLA2ABuffer(
    processFET1176Buffer(src, SR, {
      inputDrive: drive, inputAlignDb: fetAlignDb,
      outputGainDb: 0, ceilingDb: null,
    }).channelData,
    SR,
    {
      peakReduction, inputAlignDb: optoAlignDb, mode: 'compress', mix: 1,
      lookaheadMs: 0, gainDb: 0, ceilingDb: null,
    },
  ).channelData

  const composed = processPunchChainBuffer(src, SR, {
    drive, peakReduction, fetAlignDb, optoAlignDb,
  }).channelData

  let maxDiff = 0
  for (let i = 0; i < staged[0].length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(staged[0][i] - composed[0][i]))
  }
  /**
   * ⚠ BIT-EXACT, NOT "CLOSE". The point of holding both kernels rather than
   * re-implementing either is that there is one model, so any difference at all
   * means this chain has forked one of them.
   */
  assert.equal(maxDiff, 0, `chain diverged from its own parts by ${maxDiff}`)
})

test('latency is both kernels summed, and matches the constant the apply path trims', () => {
  const kernel = new PunchChainKernel(SR)
  assert.equal(kernel.latencySamples, OVERSAMPLE_LATENCY_SAMPLES * 2)
  assert.equal(kernel.latencySamples, PUNCH_CHAIN_LATENCY_SAMPLES)
})

test('neither embedded kernel gets a makeup or a ceiling of its own', () => {
  const kernel = new PunchChainKernel(SR)
  kernel.setParams({ makeupDb: 6, ceilingDb: -3, ceilingKneeDb: 1 })
  /**
   * ⚠ A CEILING INSIDE EITHER STAGE WOULD BE UNDONE BY WHAT FOLLOWS IT, and a
   * makeup inside the FET would be re-compressed by the opto behind it. This is
   * the rule makeupReference.js states and the one Scheps was corrected on, so
   * it is asserted on the kernels themselves rather than inferred from output.
   */
  assert.equal(kernel.fet.params.ceilingDb ?? null, null)
  assert.equal(kernel.fet.params.outputGainDb, 0)
  assert.equal(kernel.la2a.params.ceilingDb ?? null, null)
  assert.equal(kernel.la2a.params.gainDb, 0)
})

// ── The measured plan ───────────────────────────────────────────────────────

test('the plan keeps the output under the source peak', () => {
  const src = signal()
  const plan = computePunchChainPlan(src, SR, {})
  assert.ok(Number.isFinite(plan.makeupDb))
  assert.ok(Number.isFinite(plan.ceilingDb))

  const out = processPunchChainBuffer(src, SR, {
    ...PUNCH_CHAIN_KERNEL_DEFAULTS,
    fetAlignDb: plan.fetAlignDb,
    optoAlignDb: plan.optoAlignDb,
    makeupDb: plan.makeupDb,
    ceilingDb: plan.ceilingDb,
    ceilingKneeDb: plan.ceilingKneeDb,
  }).channelData

  const inPeak = db(peakOfChannels(src))
  const outPeak = db(peakOfChannels(out))
  assert.ok(
    outPeak <= inPeak + 1e-6,
    `output peak ${outPeak.toFixed(3)} exceeded source ${inPeak.toFixed(3)}`,
  )
})

test('the plan level-matches on the percentile, not the peak', () => {
  const src = signal()
  const plan = computePunchChainPlan(src, SR, {})
  const out = processPunchChainBuffer(src, SR, {
    ...PUNCH_CHAIN_KERNEL_DEFAULTS,
    fetAlignDb: plan.fetAlignDb,
    optoAlignDb: plan.optoAlignDb,
    makeupDb: plan.makeupDb,
    ceilingDb: plan.ceilingDb,
    ceilingKneeDb: plan.ceilingKneeDb,
  }).channelData

  const inRef = db(percentileOfChannels(src, MAKEUP_PERCENTILE))
  const outRef = db(percentileOfChannels(out, MAKEUP_PERCENTILE))
  // The ceiling can only take the top off, so the match is one-sided: the
  // reference must not land ABOVE the source's, and must not fall far below.
  assert.ok(
    Math.abs(outRef - inRef) < 1.0,
    `percentile ${outRef.toFixed(2)} vs source ${inRef.toFixed(2)}`,
  )
})

test('the chain makes the material denser and more consistent at the defaults', () => {
  const src = signal()
  const plan = computePunchChainPlan(src, SR, {})
  /**
   * The one end-to-end behavioural claim the plugin makes, and the defaults are
   * chosen to land it: more level for the same peak, and less distance between
   * the loud lines and the quiet ones.
   */
  assert.ok(
    plan.densityDb > plan.sourceDensityDb,
    `density ${plan.densityDb.toFixed(2)} did not beat source ${plan.sourceDensityDb.toFixed(2)}`,
  )
  assert.ok(
    plan.spreadDb < plan.sourceSpreadDb,
    `spread ${plan.spreadDb.toFixed(2)} did not beat source ${plan.sourceSpreadDb.toFixed(2)}`,
  )
})

test("the opto's alignment follows the FET's dial", () => {
  const src = signal()
  const low = computePunchChainPlan(src, SR, { drive: 15 })
  const high = computePunchChainPlan(src, SR, { drive: 75 })

  // Same file, so the FET's own offset cannot move...
  assert.ok(Math.abs(low.fetAlignDb - high.fetAlignDb) < 1e-9)
  /**
   * ...but the opto's must, because the FET is handing it a different level.
   * ⚠ THIS IS THE ASSERTION THE PLATE DEPENDS ON. Without it the second dial
   * means something different at every position of the first, the two controls
   * interact through level, and the panel is unlearnable — see the note on
   * `optoAlignDb`.
   */
  assert.ok(
    Math.abs(low.optoAlignDb - high.optoAlignDb) > 1,
    `opto alignment barely moved across the drive dial: `
    + `${low.optoAlignDb.toFixed(2)} vs ${high.optoAlignDb.toFixed(2)}`,
  )
})

test('the plan anchors the opto to the whole file, not to the window it was handed', () => {
  /**
   * ⚠ THE FAILURE THIS CATCHES IS SUBTLE AND WOULD NEVER SHOW UP IN A RENDER.
   * The app hands this function a capped analysis window, so measuring the
   * FET's output directly would anchor the opto to an excerpt while the FET in
   * front of it is anchored to the file — the per-selection inconsistency that
   * `regionAlignDb` exists to prevent, reintroduced one stage downstream.
   *
   * Simulated here by measuring a LOUD excerpt while passing the whole file's
   * offset: the derived opto offset must follow the file, not the excerpt.
   */
  const src = signal()
  const whole = inputAlignDbFor(src, SR)
  const loudExcerpt = [src[0].slice(0, SR * 2).map ? src[0].slice(0, SR * 2) : src[0]]
  const boosted = [Float32Array.from(loudExcerpt[0], v => v * 2)] // +6 dB

  const fromWhole = computePunchChainPlan(src, SR, { fetAlignDb: whole })
  const fromWindow = computePunchChainPlan(boosted, SR, { fetAlignDb: whole })

  // The window is 6 dB louder, but both were told the file's offset, so the
  // opto offsets must stay within the difference the FET's own behaviour makes
  // — not the full 6 dB a fresh measurement of the window would introduce.
  assert.ok(
    Math.abs(fromWhole.optoAlignDb - fromWindow.optoAlignDb) < 6,
    `opto offset tracked the window rather than the file: `
    + `${fromWhole.optoAlignDb.toFixed(2)} vs ${fromWindow.optoAlignDb.toFixed(2)}`,
  )
})

test("the plan's readouts describe the render the user actually hears", () => {
  /**
   * ⚠ THE ONE ASSERTION THAT KEEPS THE FAST PATH HONEST. The plan no longer
   * renders the chain to measure its own output — it applies the pointwise
   * output stage to the render it already has, which is 600 ms cheaper and is
   * only correct because that stage has no memory. If anything with state is
   * ever added after the compressors, this test is what notices: the numbers on
   * the plate would quietly start describing a signal nobody hears.
   *
   * Re-measured through `processPunchChainBuffer`, which is the audible path.
   */
  const src = signal()
  const params = { drive: 45, peakReduction: 65, outputDb: 2 }
  const plan = computePunchChainPlan(src, SR, params)

  const rendered = processPunchChainBuffer(src, SR, {
    ...PUNCH_CHAIN_KERNEL_DEFAULTS,
    ...params,
    // Base rate, because that is what the plan measures — see its note on why
    // oversampling moves neither readout by a tenth of what the plate prints.
    oversample: false,
    fetAlignDb: plan.fetAlignDb,
    optoAlignDb: plan.optoAlignDb,
    makeupDb: plan.makeupDb,
    ceilingDb: plan.ceilingDb,
    ceilingKneeDb: plan.ceilingKneeDb,
  }).channelData

  const phrases = detectPhrases(src, SR)
  assert.equal(measureDensityDb(rendered, SR), plan.densityDb)
  assert.equal(measureSpreadDb(rendered, phrases), plan.spreadDb)
})

test('the closed-form makeup agrees with a converged iterative solve', () => {
  /**
   * ⚠ THE CLOSED FORM IS ONLY VALID WHILE THE MAKEUP IS THE LAST MULTIPLY. It
   * is exact today because nothing follows it but a pointwise ceiling the solve
   * measures without — the output is linear in the gain, so the percentile
   * scales with it and one division answers it. Put a saturator, a limiter or
   * any curve after that multiply and this silently becomes an approximation;
   * iterating against the real renderer is what catches it.
   *
   * CLAUDE.md records the same split between the two embedded plugins:
   * OptoSmooth iterates because its valve sits after the makeup amp, FET Punch
   * does not because its Output is the last multiply. This chain is the FET
   * case, and this test is the proof rather than the assumption.
   */
  const src = signal()
  const params = { drive: 45, peakReduction: 65 }
  const plan = computePunchChainPlan(src, SR, params)

  const measureParams = {
    ...PUNCH_CHAIN_KERNEL_DEFAULTS,
    ...params,
    fetAlignDb: plan.fetAlignDb,
    optoAlignDb: plan.optoAlignDb,
    oversample: false,
    makeupDb: 0, outputDb: 0, ceilingDb: null, ceilingKneeDb: null,
  }
  const iterative = solveMakeupPlan({
    channelData: src,
    latencySamples: 0,
    render: (chs, extra) => processPunchChainBuffer(chs, SR, {
      ...measureParams, ...extra,
    }).channelData,
    gainKey: 'makeupDb',
    reference: 'percentile',
    maxIterations: 6,
    toleranceDb: 0.001,
    minDb: -24,
    maxDb: 24,
  })

  assert.ok(
    Math.abs(plan.makeupDb - iterative.makeupDb) < 0.01,
    `closed form ${plan.makeupDb.toFixed(4)} dB vs converged `
    + `${iterative.makeupDb.toFixed(4)} dB — the makeup is no longer the last `
    + 'multiply, so it cannot be solved in closed form any more',
  )
})

// ── Peak restore ────────────────────────────────────────────────────────────

test('the peak restore lands the output exactly on the ceiling', () => {
  /**
   * The chain level-matches the PERCENTILE, which deliberately leaves the peak
   * under the source — so without this the plugin is quieter than FET Punch at
   * the same settings for no reason the user can see. Measured on narration it
   * is worth up to 1.74 dB at light settings and nothing once the ceiling is
   * holding the peak.
   *
   * Reused rather than reimplemented: `peakRestoreTrimDb` was already generic
   * over a rendered region and its ceiling.
   */
  const src = signal()
  const params = { drive: 20, peakReduction: 25 }
  const plan = computePunchChainPlan(src, SR, params)
  const out = processPunchChainBuffer(src, SR, {
    ...PUNCH_CHAIN_KERNEL_DEFAULTS,
    ...params,
    fetAlignDb: plan.fetAlignDb,
    optoAlignDb: plan.optoAlignDb,
    makeupDb: plan.makeupDb,
    ceilingDb: plan.ceilingDb,
    ceilingKneeDb: plan.ceilingKneeDb,
  }).channelData

  const trimDb = restorePeakToCeiling(out, plan.ceilingDb)
  const outPeakDb = db(peakOfChannels(out))
  assert.ok(
    Math.abs(outPeakDb - plan.ceilingDb) < 0.01,
    `restored peak ${outPeakDb.toFixed(3)} is not on the ceiling ${plan.ceilingDb.toFixed(3)}`,
  )
  /**
   * ⚠ AND IT STILL DOES NOT EXCEED THE SOURCE. The ceiling IS the source's
   * peak, so landing on it is the loudest legal answer; a restore that
   * overshot would break the one guarantee the ceiling exists to provide.
   */
  assert.ok(outPeakDb <= db(peakOfChannels(src)) + 1e-6)
  assert.ok(trimDb >= 0, 'this render sat under the ceiling, so the trim is up')
})

test('the restore does not disturb either readout', () => {
  /**
   * ⚠ THE PROPERTY THAT LETS THE TRIM BE APPLY-ONLY WITHOUT THE PLATE LYING.
   * Preview and apply diverge by this trim — the accepted cost FET Punch
   * already carries — but density and level spread are both differences of two
   * levels measured on the same signal, so a scalar gain cancels out of each.
   * The two numbers the panel printed stay true of the applied file.
   *
   * If a future restore ever stops being a pure scalar (a limiter, a per-block
   * gain), this is what notices.
   */
  const src = signal()
  const plan = computePunchChainPlan(src, SR, { drive: 20, peakReduction: 25 })
  const rendered = processPunchChainBuffer(src, SR, {
    ...PUNCH_CHAIN_KERNEL_DEFAULTS,
    drive: 20, peakReduction: 25, oversample: false,
    fetAlignDb: plan.fetAlignDb,
    optoAlignDb: plan.optoAlignDb,
    makeupDb: plan.makeupDb,
    ceilingDb: plan.ceilingDb,
    ceilingKneeDb: plan.ceilingKneeDb,
  }).channelData

  const phrases = detectPhrases(src, SR)
  const before = {
    density: measureDensityDb(rendered, SR),
    spread: measureSpreadDb(rendered, phrases),
  }
  const trimDb = restorePeakToCeiling(rendered, plan.ceilingDb)
  assert.ok(Math.abs(trimDb) > 0.01, 'this fixture was meant to need a restore')

  assert.ok(Math.abs(measureDensityDb(rendered, SR) - before.density) < 1e-6)
  assert.ok(Math.abs(measureSpreadDb(rendered, phrases) - before.spread) < 1e-6)
})

test('with AUTO off there is no ceiling, so nothing is restored', () => {
  /**
   * The right answer rather than a gap: with AUTO off the level is the user's,
   * and normalising anyway would be the plugin overruling a deliberate setting.
   */
  const src = signal()
  assert.equal(peakRestoreTrimDb(src, null), 0)
  assert.equal(peakRestoreTrimDb(src, undefined), 0)
})

// ── Metrics ─────────────────────────────────────────────────────────────────

test('density is invariant to a scalar gain and to an isolated transient', () => {
  const src = signal()
  const scaled = [Float32Array.from(src[0], v => v * 0.5)]
  assert.ok(
    Math.abs(measureDensityDb(src, SR) - measureDensityDb(scaled, SR)) < 1e-6,
    'density moved under a pure gain change',
  )

  /**
   * ⚠ THE WHOLE REASON THE REFERENCE IS THE 99.9th PERCENTILE. Measured on real
   * narration, a single 12 ms plosive moves a peak-referenced reading by
   * 10.5 dB and a percentile-referenced one by 0.00. A readout that moves with
   * one transient is reading the plosive, not the voice — and a dial solved
   * against it would be too.
   */
  const withPlosive = [Float32Array.from(src[0])]
  const at = Math.round(SR * 3)
  const peak = peakOfChannels(src)
  for (let i = 0; i < Math.round(SR * 0.012); i++) {
    withPlosive[0][at + i] += peak * 3 * Math.exp(-i / (SR * 0.002))
  }
  const moved = Math.abs(measureDensityDb(withPlosive, SR) - measureDensityDb(src, SR))
  assert.ok(moved < 0.5, `density moved ${moved.toFixed(2)} dB for one added transient`)
})

test('spread reads the levelling, and reuses the source phrases to do it', () => {
  const src = signal()
  const phrases = detectPhrases(src, SR)
  assert.ok(phrases.length >= 4, `expected several phrases, found ${phrases.length}`)

  const before = measureSpreadDb(src, phrases)
  const plan = computePunchChainPlan(src, SR, { drive: 45, peakReduction: 70 })
  assert.ok(plan.spreadDb < before, 'heavy settings did not reduce phrase spread')

  /**
   * ⚠ PHRASES COME FROM THE SOURCE, AND MEASURING A RENDER WITH ITS OWN WOULD
   * FLATTER IT. The gate is relative to the material's gated RMS, so on a
   * compressed render the quiet blocks rise toward it and phrases MERGE — which
   * makes the spread of a squashed render look better by measuring fewer,
   * longer phrases rather than more consistent ones.
   */
  const rendered = processPunchChainBuffer(src, SR, {
    drive: 45, peakReduction: 70,
    fetAlignDb: plan.fetAlignDb, optoAlignDb: plan.optoAlignDb,
    makeupDb: plan.makeupDb,
  }).channelData
  assert.ok(
    detectPhrases(rendered, SR).length <= phrases.length,
    'compression was expected to merge phrases, so re-detecting cannot be safe',
  )
})

test('a silent or empty region measures as unknown rather than as a number', () => {
  const silence = [new Float32Array(SR)]
  assert.ok(Number.isNaN(measureDensityDb(silence, SR)))
  assert.equal(detectPhrases(silence, SR).length, 0)
  assert.ok(Number.isNaN(measureSpreadDb(silence, [])))
  assert.equal(detectPhrases([new Float32Array(0)], SR).length, 0)
})

// ── Params ──────────────────────────────────────────────────────────────────

test('panel defaults round-trip to the kernel defaults', () => {
  /**
   * ⚠ THE INHERITANCE TRAP, AND THIS PLUGIN IS EXPOSED TO IT ON BOTH SIDES.
   * Scheps restated its kernel's defaults and drifted twice, once shipping four
   * times the intended gain reduction. This chain holds two kernels, so a
   * re-voicing of either lands here without its knob moving.
   */
  const mapped = toKernelParams(PUNCH_CHAIN_DEFAULTS)
  assert.equal(mapped.drive, PUNCH_CHAIN_KERNEL_DEFAULTS.drive)
  assert.equal(mapped.peakReduction, PUNCH_CHAIN_KERNEL_DEFAULTS.peakReduction)
  assert.equal(mapped.outputDb, PUNCH_CHAIN_KERNEL_DEFAULTS.outputDb)
  assert.equal(mapped.makeupDb, PUNCH_CHAIN_KERNEL_DEFAULTS.makeupDb)
})

test('unmeasured keys are absent from the mapping and cleared on a live push', () => {
  const mapped = toKernelParams(PUNCH_CHAIN_DEFAULTS)
  /**
   * Absent rather than null, so the params object is key-for-key what it is
   * everywhere the measurement is not in play — the shape la2aParams.js pins
   * for the same reason.
   */
  for (const key of PUNCH_CHAIN_MEASURED_KEYS) {
    assert.ok(!(key in mapped), `${key} should be absent when unmeasured`)
  }

  /**
   * ⚠ AND PRESENT AS null ON THE LIVE PATH, or a clear means "unchanged" to a
   * kernel that merges partials — the silent, preview-only bug measuredKeys.js
   * was written against. The two alignments are this plugin's own additions to
   * that list.
   */
  const live = withMeasuredClears(mapped, PUNCH_CHAIN_MEASURED_KEYS)
  for (const key of PUNCH_CHAIN_MEASURED_KEYS) {
    assert.ok(key in live, `${key} must be clearable on a live node`)
    assert.equal(live[key], null)
  }
})

test('measured params carry through the mapping when they are real', () => {
  const mapped = toKernelParams({
    ...PUNCH_CHAIN_DEFAULTS,
    ceilingDb: -1.5, ceilingKneeDb: 2, fetAlignDb: 3.5, optoAlignDb: 9.25,
    makeupDb: 7.5, output: -2,
  })
  assert.equal(mapped.ceilingDb, -1.5)
  assert.equal(mapped.ceilingKneeDb, 2)
  assert.equal(mapped.fetAlignDb, 3.5)
  assert.equal(mapped.optoAlignDb, 9.25)
  assert.equal(mapped.makeupDb, 7.5)
  assert.equal(mapped.outputDb, -2)
})

test('a non-finite param cannot poison the kernel', () => {
  /**
   * Both embedded kernels hold persistent envelope state, so one NaN would make
   * the effect silent until the page is reloaded. Params arrive over a message
   * port from UI state, so this is always one bug away.
   */
  const src = signal()
  const out = processPunchChainBuffer(src, SR, {
    drive: undefined, peakReduction: NaN, makeupDb: NaN, outputDb: undefined,
  }).channelData
  assert.ok(out[0].every(Number.isFinite), 'kernel emitted non-finite samples')
})

test('the ceiling knee never widens past the shared cap', () => {
  const kernel = new PunchChainKernel(SR)
  kernel.setParams({ ceilingDb: -1, ceilingKneeDb: CEILING_KNEE_DB, outputDb: 12 })
  const kneeDb = db(kernel.ceilingLin / kernel.ceilingKneeLin)
  assert.ok(
    kneeDb <= CEILING_KNEE_DB + 1e-6,
    `knee widened to ${kneeDb.toFixed(2)} dB past the ${CEILING_KNEE_DB} dB cap`,
  )
})

test('a positive output trim widens the knee, a negative one does not', () => {
  const solved = 1
  const plain = new PunchChainKernel(SR)
  plain.setParams({ ceilingDb: -1, ceilingKneeDb: solved, outputDb: 0 })
  const up = new PunchChainKernel(SR)
  up.setParams({ ceilingDb: -1, ceilingKneeDb: solved, outputDb: 1 })
  const down = new PunchChainKernel(SR)
  down.setParams({ ceilingDb: -1, ceilingKneeDb: solved, outputDb: -6 })

  const kneeOf = k => db(k.ceilingLin / k.ceilingKneeLin)
  assert.ok(kneeOf(up) > kneeOf(plain), 'a positive trim should widen the knee')
  assert.ok(
    Math.abs(kneeOf(down) - kneeOf(plain)) < 1e-9,
    'a negative trim should leave the knee alone',
  )
})

test('gated RMS rises at the defaults — the plugin does what the plate claims', () => {
  const src = signal()
  const plan = computePunchChainPlan(src, SR, {})
  const out = processPunchChainBuffer(src, SR, {
    ...PUNCH_CHAIN_KERNEL_DEFAULTS,
    fetAlignDb: plan.fetAlignDb, optoAlignDb: plan.optoAlignDb,
    makeupDb: plan.makeupDb, ceilingDb: plan.ceilingDb,
    ceilingKneeDb: plan.ceilingKneeDb,
  }).channelData
  assert.ok(
    db(gatedRmsOfChannels(out, SR)) > db(gatedRmsOfChannels(src, SR)),
    'more level for the same peak is the claim; it did not hold',
  )
})
