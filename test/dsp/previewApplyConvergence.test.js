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
import { processSoftClipperBuffer } from '../../src/audio/softClipperProcessor.js'
import { LA2A_PREROLL_S } from '../../src/audio/la2aProcessor.js'
import { SCHEPS_PREROLL_S } from '../../src/audio/schepsProcessor.js'
import { computeAutoMakeupPlan } from '../../src/audio/la2aProcessor.js'
import { MAKEUP_PERCENTILE } from '../../src/audio/dsp/makeupReference.js'

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

/**
 * Two histories 33 dB apart, then an identical lead-in and region. If the
 * output over the region is the same for both, the kernel's state is FULLY
 * DETERMINED by that lead-in.
 */
function historyStillShowsThrough(processFn, params, leadInSamples) {
  const REG = REGION
  const build = loud => {
    const H = SR * 8
    const total = H + leadInSamples + REG
    const x = new Float32Array(total)
    for (let i = 0; i < total; i++) {
      const t = i / SR
      const syllable = Math.max(0, Math.sin(2 * Math.PI * 2.6 * t)) ** 2
      let amp
      if (i < H) amp = loud ? 0.95 : 0.02
      else if (i < H + leadInSamples) amp = 0.35
      else amp = 0.80
      x[i] = amp * syllable * (
        Math.sin(2 * Math.PI * 160 * t) + 0.5 * Math.sin(2 * Math.PI * 320 * t + 0.9)
      )
    }
    return { x, H }
  }
  const a = build(true)
  const b = build(false)
  const ra = processFn([a.x], SR, params)
  const rb = processFn([b.x], SR, params)
  const latency = ra.latencySamples ?? 0
  let worst = 0
  for (let i = 0; i < REG - latency; i++) {
    worst = Math.max(worst, Math.abs(
      ra.channelData[0][a.H + leadInSamples + i + latency]
      - rb.channelData[0][b.H + leadInSamples + i + latency],
    ))
  }
  return worst
}

test('the wired pre-roll exceeds the kernels\' actual memory', () => {
  // WHAT MAKES THE PRE-ROLL CONSTANTS SOUND, and the guard if a time constant
  // is ever lengthened past them. Feeding two histories 33 dB apart and then an
  // identical lead-in, OptoSmooth's output over the region is IDENTICAL — its
  // state is fully determined by the last 2 s, which is exactly why 2 s of
  // pre-roll reproduces the preview bit for bit.
  //
  // ⚠ IT IS ALSO WHY SEEDING THE TRACKER FROM THE RENDER'S OPENING WOULD DO
  // NOTHING FOR THESE TWO. A seed only sets where the state begins, and by the
  // end of a lead-in longer than the memory, where it began has been forgotten.
  // Seeding is a way to shrink a cold-start TRANSIENT, not a way to make two
  // different starting points agree — FET Punch already seeds on its first
  // block and is the one stage that cannot converge at all.
  assert.equal(
    historyStillShowsThrough(processLA2ABuffer, { peakReduction: 75, mode: 'limit' }, SR * LA2A_PREROLL_S),
    0,
    'OptoSmooth: history before the pre-roll window should not reach the output',
  )
  assert.ok(
    historyStillShowsThrough(processSchepsBuffer, {}, SR * SCHEPS_PREROLL_S) < 1e-6,
    'Scheps: history before the pre-roll window should be at float noise',
  )
})

test('⚠ the soft clipper\'s adaptive mode is why it stays deprecated', () => {
  // Its memory far outruns any pre-roll anyone would wire: with a 2 s lead-in,
  // history from before that lead-in still reaches the output at ~0.9 — three
  // orders of magnitude past OptoSmooth's exact zero. The tracker has ~20 dB to
  // travel from SPEECH_INIT_HOLD_DB at a 3 s time constant.
  //
  // ⚠ AND THE SHIPPING MODE IS FINE. `fixed` has no tracker to be cold and is
  // exactly identical between preview and apply. This test exists so that
  // re-exposing `adaptive` on the faceplate has to argue with a number.
  const adaptive = historyStillShowsThrough(processSoftClipperBuffer, {}, SR * 2)
  assert.ok(
    adaptive > 0.1,
    `adaptive should still be history-dependent at a 2 s lead-in; got ${adaptive.toExponential(2)}`,
  )
  const fixed = historyStillShowsThrough(
    processSoftClipperBuffer, { thresholdMode: 'fixed', fixedThresholdDb: -10 }, SR * 2,
  )
  assert.equal(fixed, 0, 'the shipping fixed mode should be history-independent')
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

/**
 * ── AFTER THE MERGE WITH #150 (input alignment + start-anchored measurement) ──
 *
 * That branch touched both stages this file pins, so both of its interactions
 * with the pre-roll are asserted here rather than reasoned about.
 */

test('the input-alignment offset introduces no state, so the pre-roll still converges', () => {
  // `inputAlignDb` is a side-chain DRIVE offset: it lands in `scDriveDb` at
  // setParams and is read as `over = levelDb + this.scDriveDb`. A scalar added
  // to a level cannot latch, so the convergence argument is unchanged — but the
  // whole point of this file is that the argument is checked, not asserted.
  for (const inputAlignDb of [-12, -6, 6]) {
    const diff = worstDiff(
      processLA2ABuffer, { peakReduction: 60, inputAlignDb }, Math.round(LA2A_PREROLL_S * SR),
    )
    assert.equal(diff, 0, `OptoSmooth align ${inputAlignDb} dB not exact: ${diff.toExponential(2)}`)
  }
  const scheps = worstDiff(processSchepsBuffer, { inputAlignDb: -6 }, Math.round(SCHEPS_PREROLL_S * SR))
  assert.ok(scheps < 1e-7, `Scheps with alignment not exact: ${scheps.toExponential(2)}`)
})

test('the pre-roll moves the measured makeup only at a hard level step', () => {
  /**
   * ⚠ A CROSS-BRANCH INVARIANT THAT NEITHER SIDE STATES ALONE.
   *
   * analysisWindow anchors the measurement at the region start, on the premise
   * that the apply path starts cold there. Since the pre-roll it does not, for
   * these two stages: the solver sees a cold kernel and the applied audio
   * arrives warm. What decides the size of the gap is the LEVEL STEP across the
   * region boundary, not the compression depth — see the table in
   * analysisWindow.js.
   *
   * Two bounds, because one number would hide the shape. Ordinary material has
   * to stay tight; the pathological edge is allowed to be looser but not free.
   */
  const step = (before, inside) => {
    const settle = SR * 10
    const total = settle + SR * 4
    const full = new Float32Array(total)
    for (let i = 0; i < total; i++) {
      const t = i / SR
      const syllable = Math.max(0, Math.sin(2 * Math.PI * 2.6 * t)) ** 2
      const amp = i < settle ? before : inside
      full[i] = amp * syllable * (
        Math.sin(2 * Math.PI * 160 * t)
        + 0.5 * Math.sin(2 * Math.PI * 320 * t + 0.9)
        + 0.25 * Math.sin(2 * Math.PI * 640 * t + 1.7)
      )
    }
    const region = full.slice(settle)
    const pre = full.slice(settle - Math.round(LA2A_PREROLL_S * SR), settle)
    let worst = 0
    for (const peakReduction of [40, 60, 75, 90]) {
      const params = { peakReduction }
      const cold = computeAutoMakeupPlan([region], SR, params, { reference: 'percentile' }).makeupDb
      worst = Math.max(worst, Math.abs(warmSolvedMakeupDb(region, pre, params) - cold))
    }
    return worst
  }

  // Flat, and a 6 dB drop: what ordinary speech does at a selection edge.
  assert.ok(step(0.35, 0.35) < 0.05, `flat material drifted ${step(0.35, 0.35).toFixed(3)} dB`)
  assert.ok(step(0.80, 0.40) < 0.05, `a 6 dB step drifted ${step(0.80, 0.40).toFixed(3)} dB`)
  /**
   * A quieter lead-in barely produces it — the warm detector arrives open.
   *
   * ⚠ RE-DERIVED FOR THE IMPORTED-CURVE DEFAULTS: 4.6e-4 -> 7.4e-3 dB. The
   * emphasis pair puts BIQUADS on the audio path, and a filter has state, so
   * the pre-roll now warms something the old model did not have — a second
   * source of path dependence on top of the detector's. Still four orders
   * below anything audible, and the other three bounds barely moved on the
   * same measurement (flat 0.020, a 6 dB step 0.040, the pathological edge
   * 0.5856 against the 0.584 recorded below).
   *
   * The bound is 0.01 rather than 0.0074 for headroom, and it is deliberately
   * NOT widened to the 0.05 the two above use: this case is an order tighter
   * and should have to stay that way.
   */
  assert.ok(step(0.08, 0.35) < 0.01, `a quiet lead-in drifted ${step(0.08, 0.35).toFixed(4)} dB`)

  // ⚠ THE PATHOLOGICAL EDGE IS PINNED, NOT ASSERTED AWAY. A 25 dB drop right at
  // the boundary reaches 0.584 dB, and that is recorded as the known ceiling.
  // If it grows, the measurement window has to learn about preRollSamples.
  const harsh = step(0.90, 0.05)
  assert.ok(
    harsh > 0.1,
    `a 25 dB step should still show the effect; got ${harsh.toFixed(3)} dB — if it `
    + 'vanished, something changed and analysisWindow.js needs re-measuring',
  )
  assert.ok(
    harsh < 0.7,
    `a 25 dB step drifted ${harsh.toFixed(3)} dB, past the 0.584 dB recorded in `
    + 'analysisWindow.js — teach the measurement window about preRollSamples',
  )
})

/**
 * The makeup that restores the REGION's percentile reference when the kernel
 * reaches that region warm — i.e. what apply actually needs, post-pre-roll.
 * Mirrors computeAutoMakeupPlan's iteration; it has no option for a lead-in.
 */
function warmSolvedMakeupDb(region, pre, params) {
  const measureParams = { ...params, oversample: false, ceilingDb: null }
  const inputRef = percentile(region, MAKEUP_PERCENTILE)
  let makeupDb = 0
  for (let i = 0; i < 4; i++) {
    const fed = new Float32Array(pre.length + region.length)
    fed.set(pre, 0)
    fed.set(region, pre.length)
    const { channelData } = processLA2ABuffer([fed], SR, { ...measureParams, gainDb: makeupDb })
    const out = channelData[0].subarray(pre.length, pre.length + region.length)
    const outRef = percentile(out, MAKEUP_PERCENTILE)
    if (!(outRef > 0)) break
    const correctionDb = 20 * Math.log10(inputRef / outRef)
    makeupDb = Math.max(-24, Math.min(24, makeupDb + correctionDb))
    if (Math.abs(correctionDb) < 0.05) break
  }
  return makeupDb
}

/** |x| at the given top quantile, matching percentileOfChannels' convention. */
function percentile(ch, q) {
  const mags = Float64Array.from(ch, Math.abs).sort()
  const idx = Math.min(mags.length - 1, Math.max(0, Math.floor((1 - q) * mags.length)))
  return mags[idx]
}
