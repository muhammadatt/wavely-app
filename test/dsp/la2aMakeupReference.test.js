/**
 * Run with:  npm test
 *
 * PERCENTILE-REFERENCED MAKEUP, AND THE CEILING THAT MAKES IT LEGAL.
 *
 * ⚠ THE PROMISE UNDER TEST IS ONE THE ARITHMETIC USED TO MAKE FOR FREE. Peak-
 * referenced makeup cannot push the output above the source: it solves for
 * exactly that. A percentile reference gives that up — measured, by nearly
 * 6 dB — and `ceilingDb` puts it back by enforcement. So the guarantee moved
 * from being a property of the solve to being a property of a stage, and a
 * stage can be bypassed, misconfigured or regressed where arithmetic cannot.
 * That is what these tests are for; see the note on `peakOfChannels`.
 *
 * The nulls matter as much as the guarantee: a build that never asks for a
 * percentile must be sample-identical to one from before this existed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  processLA2ABuffer, computeAutoMakeupDb, computeAutoMakeupPlan,
  MAKEUP_PERCENTILE, LA2AKernel,
} from '../../src/audio/la2aProcessor.js'
import {
  CEILING_KNEE_DB, CEILING_KNEE_MARGIN_DB, ceilingKneeDbFor,
} from '../../src/audio/dsp/makeupReference.js'
import { LA2A_DEFAULTS, toKernelParams } from '../../src/audio/effects/la2aParams.js'

const SR = 44100
const db = x => 20 * Math.log10(Math.max(x, 1e-12))
const peak = x => { let p = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a } return p }

/**
 * Narration-shaped: syllables, and one hard onset out of a long silence. The
 * onset is the whole point — it is the shape that binds a peak-referenced
 * solve, so a stimulus without one cannot tell the two references apart.
 */
function stimulus(seconds = 4) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    phase += (2 * Math.PI * 130) / SR
    let s = 0
    for (let h = 1; h <= 10; h++) s += Math.sin(phase * h) / (h * h)
    const gap = t > 1.6 && t < 1.9
    const syl = Math.max(0, Math.sin(2 * Math.PI * 3 * t)) ** 2
    // The onset just after the gap is hot, and nothing else is.
    const hot = t >= 1.9 && t < 1.95 ? 2.2 : 1
    x[i] = gap ? 0.0005 * s : 0.42 * s * syl * hot
  }
  return x
}

const render = (x, params) => processLA2ABuffer([x], SR, {
  lookaheadMs: 0, ...params,
}).channelData[0]

test('the percentile reference asks for more makeup than the peak reference', () => {
  const x = stimulus()
  for (const pr of [50, 60, 70]) {
    const byPeak = computeAutoMakeupPlan([x], SR, { peakReduction: pr })
    const byPct = computeAutoMakeupPlan([x], SR, { peakReduction: pr }, { reference: 'percentile' })
    assert.ok(byPct.makeupDb > byPeak.makeupDb,
      `PR ${pr}: percentile ${byPct.makeupDb.toFixed(2)} should exceed peak ${byPeak.makeupDb.toFixed(2)}`)
  }
})

test('the peak reference returns no ceiling; the percentile reference always does', () => {
  const x = stimulus()
  assert.equal(computeAutoMakeupPlan([x], SR, { peakReduction: 60 }).ceilingDb, null)
  const pct = computeAutoMakeupPlan([x], SR, { peakReduction: 60 }, { reference: 'percentile' })
  assert.ok(Number.isFinite(pct.ceilingDb), 'percentile plan must carry a ceiling')
  assert.ok(Math.abs(pct.ceilingDb - db(peak(x))) < 1e-6,
    `the ceiling is the source peak: ${pct.ceilingDb} vs ${db(peak(x))}`)
})

test('an unknown reference is refused rather than silently treated as peak', () => {
  assert.throws(() => computeAutoMakeupPlan([stimulus(1)], SR, {}, { reference: 'p99' }), /unknown makeup reference/)
})

/**
 * ⚠ THE FAILURE THE CEILING EXISTS FOR, PINNED AS A FAILURE. If this ever stops
 * failing, the percentile has stopped over-compensating and the pairing has
 * become unnecessary — which is a finding, not a passing test.
 */
test('percentile makeup WITHOUT the ceiling does exceed the source peak', () => {
  const x = stimulus()
  const plan = computeAutoMakeupPlan([x], SR, { peakReduction: 70 }, { reference: 'percentile' })
  const unguarded = render(x, { peakReduction: 70, gainDb: plan.makeupDb })
  assert.ok(peak(unguarded) > peak(x),
    `expected overshoot without the ceiling: ${db(peak(unguarded)).toFixed(2)} vs ${db(peak(x)).toFixed(2)}`)
})

test('the ceiling holds the output under the source peak at every setting', () => {
  const x = stimulus()
  const inPeak = peak(x)
  for (const pr of [40, 50, 60, 70, 80, 90]) {
    for (const tube of [false, true]) {
      const params = { peakReduction: pr, tube }
      const plan = computeAutoMakeupPlan([x], SR, params, { reference: 'percentile' })
      const y = render(x, { ...params, gainDb: plan.makeupDb, ceilingDb: plan.ceilingDb })
      assert.ok(peak(y) <= inPeak,
        `PR ${pr} tube=${tube}: output ${db(peak(y)).toFixed(3)} exceeded source ${db(inPeak).toFixed(3)}`)
    }
  }
})

/**
 * ⚠ THE ASSERTION IS `<=`, NOT `<`, AND THAT IS THE IMPLEMENTATION AND NOT A
 * WEAKER TEST. `Math.tanh` returns exactly 1 in float64 once its argument
 * passes ~19, so a signal driven far enough above the knee lands ON the
 * ceiling. A first draft asserted strict inequality and passed at 24 dB of gain
 * only because that stimulus never got there; at 18 dB into a -8 dB ceiling it
 * failed. The guarantee is "never louder than the source", which `<=` states
 * exactly and `<` overstates.
 */
test('the ceiling holds against absurd gain, at every drive', () => {
  const x = stimulus(1)
  for (const ceilingDb of [-6, -8, -12]) {
    const ceiling = Math.exp(ceilingDb * Math.LN10 / 20)
    for (const gainDb of [6, 18, 24]) {
      const y = render(x, { peakReduction: 0, gainDb, ceilingDb })
      assert.ok(peak(y) <= ceiling,
        `ceiling ${ceilingDb} at +${gainDb} dB: ${db(peak(y)).toFixed(4)} exceeded it`)
    }
  }
})

test('no ceiling is sample-identical to not passing one', () => {
  const x = stimulus(2)
  const bare = render(x, { peakReduction: 60, gainDb: 6 })
  const explicit = render(x, { peakReduction: 60, gainDb: 6, ceilingDb: null })
  for (let i = 0; i < bare.length; i++) assert.equal(bare[i], explicit[i], `sample ${i} moved`)
})

test('a ceiling above the signal changes nothing', () => {
  const x = stimulus(2)
  const bare = render(x, { peakReduction: 60, gainDb: 0 })
  const high = render(x, { peakReduction: 60, gainDb: 0, ceilingDb: 12 })
  for (let i = 0; i < bare.length; i++) {
    assert.equal(bare[i], high[i], `sample ${i} moved under a ceiling nothing reaches`)
  }
})

test('computeAutoMakeupDb is unchanged and still peak-referenced', () => {
  const x = stimulus(2)
  assert.equal(computeAutoMakeupDb([x], SR, { peakReduction: 60 }),
    computeAutoMakeupPlan([x], SR, { peakReduction: 60 }).makeupDb)
})

test('MAKEUP_PERCENTILE sits clear of the programme', () => {
  assert.ok(MAKEUP_PERCENTILE > 0 && MAKEUP_PERCENTILE <= 0.01,
    'a reference below the 99th percentile would track the programme, not the outlier')
})

/**
 * ── THE PANEL SEAM ──────────────────────────────────────────────────────────
 *
 * ⚠ EVERY LAYER BELOW IS A PLACE THE CEILING CAN BE DROPPED SILENTLY, and a
 * dropped ceiling is not a missing feature — it is the raised makeup running
 * with nothing behind it, which is the one failure this pairing exists to
 * prevent. Two of these were live bugs while the wiring was being built:
 * `toKernelParams` did not carry the key at all, and `createLA2ACompressor`
 * gates `setParam` on `name in params`, where a param absent from
 * `LA2A_DEFAULTS` never matches.
 */

test('the panel param object carries the ceiling into kernel params', () => {
  const panel = { ...LA2A_DEFAULTS, ceilingDb: -3.5 }
  assert.equal(toKernelParams(panel).ceilingDb, -3.5)
})

test('kernel params omit the ceiling entirely when there is none', () => {
  for (const absent of [{ ...LA2A_DEFAULTS }, { ...LA2A_DEFAULTS, ceilingDb: null }]) {
    assert.ok(!('ceilingDb' in toKernelParams(absent)),
      'an absent ceiling must not appear as a key — la2aTuning.test.js pins this shape')
  }
})

test('a panel-shaped patch actually limits when it carries a ceiling', () => {
  const x = stimulus(2)
  const panel = { ...LA2A_DEFAULTS, peakReduction: 0, gain: 18 }
  const ceilingDb = -8

  const loud = processLA2ABuffer([x], SR, toKernelParams(panel)).channelData[0]
  const held = processLA2ABuffer([x], SR, toKernelParams({ ...panel, ceilingDb })).channelData[0]

  assert.ok(db(peak(loud)) > ceilingDb + 3,
    `the unguarded render should be well over the ceiling: ${db(peak(loud)).toFixed(2)}`)
  assert.ok(db(peak(held)) <= ceilingDb + 1e-9,
    `the guarded one must sit at or under it: ${db(peak(held)).toFixed(4)}`)
})

/**
 * ⚠ NEITHER IS A PATCH VALUE, FOR DIFFERENT REASONS, AND BOTH MATTER.
 *
 * The REFERENCE is fixed in `useLA2A` and has no control: it was a panel toggle
 * for one release, was auditioned, and came out — there is no material on which
 * the peak reference wins, so there was nothing to choose between. Leaving it in
 * `LA2A_DEFAULTS` would put it back in saved patches and presets as a setting
 * that no longer exists.
 *
 * The CEILING is measured from the region's own peak, so a preset carrying one
 * would apply one file's peak to another.
 */
test('neither the reference nor the ceiling is a stored patch value', () => {
  assert.ok(!('makeupReference' in LA2A_DEFAULTS),
    'the reference is fixed in the composable, not stored per patch')
  assert.ok(!('ceilingDb' in LA2A_DEFAULTS),
    'the ceiling is measured from the audio, so it must not be a stored patch value')
})

/**
 * The solve still takes both — the bench renders them side by side
 * (`npm run la2a:makeup`) — and `peak` is still what it does when asked for
 * nothing, which is what keeps every other caller of this function unchanged.
 */
test('the solve still defaults to peak when no reference is named', () => {
  const x = stimulus(2)
  assert.equal(
    computeAutoMakeupPlan([x], SR, { peakReduction: 60 }).makeupDb,
    computeAutoMakeupPlan([x], SR, { peakReduction: 60 }, { reference: 'peak' }).makeupDb,
  )
})

/**
 * ── THE LIVE TRACKER CANNOT SPEAK FOR THE PERCENTILE ────────────────────────
 *
 * ⚠ THIS IS PINNED AS A LIMITATION, NOT A BUG. `liveAutoMakeupDb` inverts the
 * tube shaper at the TARGET PEAK from running extrema — that is what makes it
 * O(1) per sample and what makes it agree with the offline peak solve to
 * hundredths of a dB. Two extrema cannot express a quantile, so there is no
 * small fix that would let it answer for the percentile, and with the solve now
 * fixed there, `useLA2A` no longer consumes the tracker at all.
 *
 * The number below is the whole reason it was dropped: while it still ran, it
 * overwrote the offline value on every meter tick and preview played several dB
 * under apply, reported as makeup gain missing from playback. The kernel-side
 * tracker is still correct and still tested in liveMakeup.test.js; if these two
 * ever converge, the panel could consume it again.
 */
function runKernel(x, params) {
  const kernel = new LA2AKernel(SR)
  kernel.setParams({ lookaheadMs: 0, gainDb: 0, ...params })
  const out = [new Float32Array(128)]
  for (let off = 0; off + 128 <= x.length; off += 128) {
    kernel.process([x.subarray(off, off + 128)], out, 128)
  }
  return kernel
}

test('the live tracker matches the offline PEAK solve', () => {
  const x = stimulus(4)
  const kernel = runKernel(x, { peakReduction: 60 })
  const live = kernel.liveAutoMakeupDb()
  assert.ok(Number.isFinite(live), 'the tracker should have heard enough to report')

  const offline = computeAutoMakeupPlan([x], SR, { peakReduction: 60 }).makeupDb
  assert.ok(Math.abs(live - offline) < 0.5,
    `the tracker is the peak solve's live twin: ${live.toFixed(2)} vs ${offline.toFixed(2)}`)
})

/**
 * ⚠ REPRODUCING THE DIVERGENCE NEEDS BOTH HALVES, AND THE OBVIOUS STIMULUS HAS
 * NEITHER. It took two attempts to write this.
 *
 * The transient must be RARER THAN THE PERCENTILE. `stimulus`'s hot onset runs
 * 50 ms — 1.25 % of a four-second file — so the 99.9th percentile counts it as
 * PROGRAMME and both references land within 0.24 dB. At 44.1 kHz the top 0.1 %
 * of four seconds is about 4 ms, so an outlier has to be shorter than that.
 *
 * And it must arrive at a DARK CELL. A 1.5 ms tick dropped into the middle of
 * speech still reads as converged, because the T4 is already lit and compresses
 * the tick along with everything else — the two solves came back 8.39 against
 * 8.56. The tick has to land at the end of a long silence, which is where a
 * plosive after a pause actually lands and is the shape that pinned the makeup
 * on the narration this whole thread started from.
 *
 * With both: live 1.41 dB against a percentile solve's 8.54.
 */
function stimulusWithDarkCellClick(seconds = 5) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    phase += (2 * Math.PI * 130) / SR
    let s = 0
    for (let h = 1; h <= 10; h++) s += Math.sin(phase * h) / (h * h)
    const voiced = t < 2 || t > 3.5
    const syl = Math.max(0, Math.sin(2 * Math.PI * 3 * t)) ** 2
    x[i] = voiced ? 0.42 * s * syl : 0.0004 * s
  }
  // 1.5 ms, at the end of the silence, into a cell that has fully recovered.
  const at = Math.round(SR * 3.45)
  for (let i = 0; i < Math.round(SR * 0.0015); i++) {
    x[at + i] = 0.95 * Math.sin((2 * Math.PI * 1200 * i) / SR)
  }
  return x
}

test('and is therefore well below the percentile solve, which is why it is gated', () => {
  const x = stimulusWithDarkCellClick()
  const live = runKernel(x, { peakReduction: 60 }).liveAutoMakeupDb()
  const percentile = computeAutoMakeupPlan(
    [x], SR, { peakReduction: 60 }, { reference: 'percentile' },
  ).makeupDb

  assert.ok(percentile - live > 1,
    'if these have converged the composable\'s live-tracker gate is no longer needed: '
    + `live ${live.toFixed(2)}, percentile ${percentile.toFixed(2)}`)
})

// ── The ceiling's knee is sized by the solve ─────────────────────────────────
//
// The knee used to be a fixed 3 dB, which costs peak headroom on any render
// that had nothing for the ceiling to catch — see `ceilingKneeDbFor` for the
// measurements. These pin the two halves that matter: it must cost nothing when
// there is no overshoot, and it must not have moved where there is one.

test('ceilingKneeDbFor is zero below the margin, and capped at CEILING_KNEE_DB', () => {
  assert.equal(ceilingKneeDbFor(-3), 0)
  assert.equal(ceilingKneeDbFor(-CEILING_KNEE_MARGIN_DB), 0)
  assert.equal(ceilingKneeDbFor(0), CEILING_KNEE_MARGIN_DB)
  assert.equal(ceilingKneeDbFor(0.5), 1)
  assert.equal(ceilingKneeDbFor(CEILING_KNEE_DB), CEILING_KNEE_DB)
  assert.equal(ceilingKneeDbFor(50), CEILING_KNEE_DB)
  // A missing measurement falls back to the widest knee, never to a corner.
  // A MISSING measurement falls back to the widest knee, never to a corner.
  assert.equal(ceilingKneeDbFor(undefined), CEILING_KNEE_DB)
  assert.equal(ceilingKneeDbFor(NaN), CEILING_KNEE_DB)
  // -Infinity is an ANSWER, not a missing one: a silent render catches nothing.
  assert.equal(ceilingKneeDbFor(-Infinity), 0)
})

test('a knee sized to the overshoot costs NOTHING while the ceiling is inert', () => {
  const x = stimulus()
  const bare = render(x, { peakReduction: 55, gainDb: 3, ceilingDb: null })
  const barePeakDb = db(peak(bare))
  /**
   * The regime the fixed 3 dB knee broke: a render sitting just under its
   * ceiling. At 0.5-2.9 dB of headroom the old knee reached down past the peak
   * and attenuated material that was never going to exceed anything.
   */
  for (const headroomDb of [0.6, 1, 2, 2.9]) {
    const ceilingDb = barePeakDb + headroomDb
    const knee = ceilingKneeDbFor(barePeakDb - ceilingDb)
    assert.ok(knee < headroomDb, `headroom ${headroomDb}: knee must stay clear of the peak`)
    const armed = render(x, { peakReduction: 55, gainDb: 3, ceilingDb, ceilingKneeDb: knee })
    assert.deepEqual(Array.from(armed), Array.from(bare),
      `headroom ${headroomDb}: an inert ceiling must cost nothing`)
    /**
     * And the old fixed width DID cost peak here, so this is a real recovery
     * rather than a no-op. Only asserted below 2 dB of headroom: the knee is C1
     * at its start, so at 2.9 dB the peak sits 0.1 dB inside a 3 dB knee where
     * the curve has barely left the unity line and the loss is under a
     * hundredth of a dB. That is the knee behaving correctly, not a miss.
     */
    if (headroomDb <= 2) {
      const legacy = render(x, { peakReduction: 55, gainDb: 3, ceilingDb })
      assert.ok(db(peak(legacy)) < barePeakDb - 0.02,
        `headroom ${headroomDb}: the fixed knee is meant to have cost peak here`)
    }
  }
})

test('the solved knee is consistent with the overshoot the solve measured', () => {
  const x = stimulus()
  for (const pr of [0, 10, 30, 55, 70, 100]) {
    const params = { peakReduction: pr }
    const plan = computeAutoMakeupPlan([x], SR, params, { reference: 'percentile' })
    const common = { ...params, gainDb: plan.makeupDb }
    const bareDb = db(peak(render(x, { ...common, ceilingDb: null })))
    // The solve renders at base rate and one correction step behind, so this is
    // close rather than exact; the margin exists to absorb precisely that.
    assert.ok(Math.abs(plan.ceilingKneeDb - ceilingKneeDbFor(bareDb - plan.ceilingDb)) < 0.1,
      `PR ${pr}: knee ${plan.ceilingKneeDb} disagrees with a ${(bareDb - plan.ceilingDb).toFixed(2)} dB overshoot`)
    const armed = render(x, {
      ...common, ceilingDb: plan.ceilingDb, ceilingKneeDb: plan.ceilingKneeDb,
    })
    assert.ok(db(peak(armed)) <= plan.ceilingDb + 1e-9, `PR ${pr}: ceiling broken`)
  }
})

test('and it is unchanged wherever the solve asks for the old fixed width', () => {
  const x = stimulus()
  const ceilingDb = db(peak(x))
  /**
   * Driven past the cap with a manual gain on purpose. The solve only asks for
   * the full 3 dB once the overshoot reaches CEILING_KNEE_DB minus the margin,
   * and on THIS stimulus the percentile makeup never gets there — it overshoots
   * by 0.04-0.24 dB across the whole knob, where the real narration it was
   * measured on undershoots by 0.3-0.7 at low drive. Synthetic material does
   * not reproduce either end of this, which is why the ledger's numbers are
   * from a recording and these assertions are about invariants.
   */
  for (const gainDb of [18, 24]) {
    const overshootDb = db(peak(render(x, {
      peakReduction: 70, gainDb, ceilingDb: null,
    }))) - ceilingDb
    assert.ok(overshootDb > CEILING_KNEE_DB, `gain ${gainDb}: meant to saturate the cap`)
    assert.equal(ceilingKneeDbFor(overshootDb), CEILING_KNEE_DB)
    const base = { peakReduction: 70, gainDb, ceilingDb }
    assert.deepEqual(
      Array.from(render(x, { ...base, ceilingKneeDb: CEILING_KNEE_DB })),
      Array.from(render(x, base)),
      `gain ${gainDb}: a capped knee must be the render it always was`,
    )
  }
})

test('the guarantee survives every knee width, including zero', () => {
  const x = stimulus()
  const ceilingDb = db(peak(x))
  for (const ceilingKneeDb of [0, 0.5, 1.08, CEILING_KNEE_DB]) {
    // Absurd gain, so everything is driven hard into the ceiling.
    const out = render(x, { peakReduction: 70, gainDb: 24, ceilingDb, ceilingKneeDb })
    assert.ok(Number.isFinite(out[0]), `knee ${ceilingKneeDb}: no NaN from a zero span`)
    for (let i = 0; i < out.length; i++) {
      assert.ok(Number.isFinite(out[i]))
      assert.ok(db(Math.abs(out[i])) <= ceilingDb + 1e-9,
        `knee ${ceilingKneeDb}: sample ${i} broke the ceiling`)
    }
  }
})

test('an absent knee is the old fixed width, so nothing upstream of the solve moves', () => {
  const x = stimulus()
  const ceilingDb = db(peak(x)) - 6
  const base = { peakReduction: 60, gainDb: 6, ceilingDb }
  assert.deepEqual(
    Array.from(render(x, base)),
    Array.from(render(x, { ...base, ceilingKneeDb: CEILING_KNEE_DB })),
  )
  // Out-of-range widths clamp rather than throw or wrap.
  assert.deepEqual(
    Array.from(render(x, { ...base, ceilingKneeDb: 99 })),
    Array.from(render(x, { ...base, ceilingKneeDb: CEILING_KNEE_DB })),
  )
  assert.deepEqual(
    Array.from(render(x, { ...base, ceilingKneeDb: -5 })),
    Array.from(render(x, { ...base, ceilingKneeDb: 0 })),
  )
})

test('the knee reaches kernel params only when it is real', () => {
  assert.equal('ceilingKneeDb' in toKernelParams({ ...LA2A_DEFAULTS }), false)
  const withKnee = toKernelParams({ ...LA2A_DEFAULTS, ceilingDb: -3, ceilingKneeDb: 0 })
  // Zero is a REAL width — a hard ceiling — not an absent one.
  assert.equal(withKnee.ceilingKneeDb, 0)
})

test('the peak reference returns no knee, having no ceiling to soften', () => {
  const plan = computeAutoMakeupPlan([stimulus()], SR, { peakReduction: 60 })
  assert.equal(plan.ceilingDb, null)
  assert.equal(plan.ceilingKneeDb, null)
})
