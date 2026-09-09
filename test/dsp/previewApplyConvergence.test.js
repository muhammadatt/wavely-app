/**
 * PREVIEW/APPLY CONVERGENCE — which stages a pre-roll can make exact.
 *
 * Run with:  npm test
 *
 * The preview worklet runs over everything the user played; the offline apply
 * render starts COLD at the region's first sample. Any stage with envelope
 * state therefore produces something different, and `applyWorkletRegion`'s
 * `preRollSamples` exists to close that gap.
 *
 * ⚠ IT ONLY CLOSES FOR SOME OF THEM, AND THE TEST THAT SEPARATES THEM IS ONE
 * QUESTION: does anything in the kernel LATCH, or does all of its state decay?
 *
 *   decays only  -> a finite pre-roll reaches BIT-EXACT
 *     OptoSmooth   ballistics driven by the input
 *     Scheps       holds the LA-2A kernel, so it inherits that
 *
 *   latches      -> no pre-roll can ever be exact
 *     FET Punch    `trkInPeak` is a running maximum, never decays
 *     Tube Sat     sticky skew sign, and a valley floor that only creeps up
 *
 *   neither      -> not a convergence problem at all
 *     ResoTame     an STFT frame-PHASE error; see its own test below
 *
 * This file pins the first group. The second group is asserted NOT to converge,
 * so that if someone gives one of them a bounded reference the test goes red
 * and the pre-roll can be wired for it too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processLA2ABuffer } from '../../src/audio/la2aProcessor.js'
import { processSchepsBuffer } from '../../src/audio/schepsProcessor.js'
import { processResonanceBuffer } from '../../src/audio/resonanceProcessor.js'
import { processFET1176Buffer } from '../../src/audio/fet1176Processor.js'
import { LA2A_PREROLL_S } from '../../src/audio/la2aProcessor.js'
import { SCHEPS_PREROLL_S } from '../../src/audio/schepsProcessor.js'

const SR = 44100
const SETTLE = SR * 10
const REGION = SR * 2

/**
 * Adversarial material: loud right up to the region boundary, then quiet. Any
 * release or ballistic memory is at its most compressed entering the region and
 * must relax through it — precisely what a cold start cannot know.
 */
function adversarial(total, settle = SETTLE) {
  const x = new Float32Array(total)
  for (let i = 0; i < total; i++) {
    const t = i / SR
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 2.6 * t)) ** 2
    const amp = i < settle ? 0.80 : 0.10
    x[i] = amp * syllable * (
      Math.sin(2 * Math.PI * 160 * t)
      + 0.5 * Math.sin(2 * Math.PI * 320 * t + 0.9)
      + 0.25 * Math.sin(2 * Math.PI * 640 * t + 1.7)
    )
  }
  return x
}

/** Worst sample difference between a settled preview and a pre-rolled apply. */
function worstDiff(processFn, params, preRollSamples) {
  return worstDiffAt(processFn, params, preRollSamples, SETTLE)
}

/** As above, with the region's start position given — the STFT case needs it. */
function worstDiffAt(processFn, params, preRollSamples, settle) {
  const total = settle + REGION
  const full = adversarial(total, settle)
  const run = processFn([full], SR, params)
  const latency = run.latencySamples ?? 0
  const preview = run.channelData[0]

  const fed = full.slice(settle - preRollSamples, total)
  const applied = processFn([fed], SR, params).channelData[0]

  let worst = 0
  for (let i = 0; i < REGION - latency; i++) {
    worst = Math.max(
      worst,
      Math.abs(preview[settle + i + latency] - applied[preRollSamples + i + latency]),
    )
  }
  return worst
}

test('a cold apply really does differ — the premise of the whole pre-roll', () => {
  // If this ever stops being true the pre-roll is dead weight and should come
  // out of applyWorkletRegion rather than being carried indefinitely.
  const cold = worstDiff(processLA2ABuffer, { peakReduction: 75, mode: 'limit' }, 0)
  assert.ok(cold > 1e-3, `a cold OptoSmooth apply should differ; got ${cold.toExponential(2)}`)
})

test('OptoSmooth is BIT-EXACT at its wired pre-roll', () => {
  // Nothing here latches: every piece of state is driven by the input and its
  // influence decays, so after a few time constants the state is a function of
  // recent input alone.
  for (const params of [
    { peakReduction: 50 },
    { peakReduction: 75, mode: 'limit' },
    { peakReduction: 90, mode: 'limit' },
  ]) {
    const diff = worstDiff(processLA2ABuffer, params, Math.round(LA2A_PREROLL_S * SR))
    assert.equal(diff, 0, `OptoSmooth ${JSON.stringify(params)} not exact: ${diff.toExponential(2)}`)
  }
})

test('Scheps is BIT-EXACT at its wired pre-roll, because it holds that kernel', () => {
  const diff = worstDiff(processSchepsBuffer, {}, Math.round(SCHEPS_PREROLL_S * SR))
  assert.equal(diff, 0, `Scheps not exact: ${diff.toExponential(2)}`)
})

test('⚠ ResoTame is grid-phase limited, which a pre-roll cannot fix', () => {
  // NOT A CONVERGENCE PROBLEM, WHICH IS WHY NO PRE-ROLL IS WIRED FOR IT. An
  // STFT reconstructs on a grid anchored at sample 0 of whatever it is handed,
  // so what decides agreement is the ABSOLUTE phase `(regionStart - preRoll) %
  // hop`, not the length of the lead-in. And the preview's anchor is wherever
  // that worklet happened to start, which the apply path cannot know.
  //
  // ⚠ A SWEEP OF 0/0.5/1/2/4 SECONDS ONCE LOOKED LIKE A HARD FLOOR AT 4e-4.
  // It is not a floor — every one of those lengths simply missed the grid.
  const hop = 512
  // Region start ON the grid: a pre-roll that is a whole number of hops keeps
  // the phase, and the two runs agree exactly.
  const settledOnGrid = hop * 861
  assert.equal(
    worstDiffAt(processResonanceBuffer, {}, hop * 173, settledOnGrid), 0,
    'with the phase preserved, ResoTame should agree exactly',
  )
  // Seven samples off, and it does not — despite an identical amount of
  // lead-in. That is the proof it is phase and not convergence.
  assert.ok(
    worstDiffAt(processResonanceBuffer, {}, hop * 173 + 7, settledOnGrid) > 0,
    'breaking the phase should break the agreement',
  )
  // The residue is tiny — a phase artefact, not a level error — which is why
  // this is recorded rather than chased.
  const realistic = worstDiffAt(processResonanceBuffer, {}, hop * 173, SR * 10)
  assert.ok(
    realistic < 1e-3,
    `off-grid residue should stay negligible; got ${realistic.toExponential(2)}`,
  )
})

test('⚠ FET Punch CANNOT be made exact, and this records why', () => {
  // `trkInPeak` is a running maximum — "the loudest input sample heard so far"
  // — so it carries the whole preview session and an offline render cannot
  // match it. A pre-roll helps a lot (stock: -0.668 dB cold, -0.022 at 2 s) and
  // never closes. No pre-roll is wired for it.
  //
  // If someone gives that tracker a bounded reference — a decaying peak, or a
  // percentile over a window — this goes red, and FET Punch can then be wired
  // like the other three.
  const diff = worstDiff(processFET1176Buffer, { inputDrive: 70, attack: 1, release: 1 }, SR * 2)
  assert.ok(
    diff > 1e-4,
    `FET Punch converged to ${diff.toExponential(2)} — if its makeup tracker `
    + 'stopped latching, wire preRollSamples for it and delete this test',
  )
})
