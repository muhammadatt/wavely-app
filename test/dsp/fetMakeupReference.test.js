/**
 * Run with:  npm test
 *
 * FET PUNCH'S MAKEUP REFERENCE AND THE CEILING THAT SHIPS WITH IT.
 *
 * ⚠ THE PEAK REFERENCE RAN THE INPUT KNOB BACKWARDS, which is the whole reason
 * this file exists. On syllabic narration with one plosive at the end of a
 * pause, the plosive survives the FET's attack nearly intact and pins the
 * reference for the entire file, so compressing harder delivers LESS level:
 * measured rms -20.85 dB at Input 50 against -22.56 at 70 and -24.37 at 100,
 * every one of them quieter than the -19.18 dB source. Referenced to the 99.9th
 * percentile the same sweep holds the body at -17.90 / -17.89 / -18.28.
 *
 * ⚠ AND THE PERCENTILE ALONE IS HALF A MECHANISM. It gives up "never louder
 * than the source" by construction — that is what stops one transient pinning
 * the file — so the ceiling puts the guarantee back by enforcement. The two are
 * issued together by `computeFET1176AutoMakeupPlan` and there is no API here
 * that yields one without the other. These tests pin the guarantee, because it
 * is no longer a property of the arithmetic.
 *
 * The reference and the ceiling themselves live in `dsp/makeupReference.js`,
 * shared with OptoSmooth; `makeupReference.test.js` covers them as maths and
 * this covers what FET Punch does with them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  processFET1176Buffer,
  computeFET1176AutoMakeupDb,
  computeFET1176AutoMakeupPlan,
  CEILING_KNEE_DB,
} from '../../src/audio/fet1176Processor.js'

const SR = 44100

const peak = (ch) => { let p = 0; for (const v of ch) p = Math.max(p, Math.abs(v)); return p }
const rmsDb = (ch) => { let q = 0; for (const v of ch) q += v * v; return 10 * Math.log10(q / ch.length) }
const db = (v) => 20 * Math.log10(v)

/**
 * Syllabic narration with a plosive at the end of a silence — the shape that
 * pinned the peak reference. The tick has to land where the cell has fully
 * recovered; inside speech it is compressed along with everything else and the
 * two references agree, which is why a plain burst train proves nothing here.
 */
function narration(seconds = 5, amp = 0.42) {
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
    x[i] = voiced ? amp * s * syl : 0.0004 * s
  }
  const at = Math.round(SR * 3.45)
  for (let i = 0; i < Math.round(SR * 0.0015); i++) {
    x[at + i] = 0.95 * Math.sin((2 * Math.PI * 1200 * i) / SR)
  }
  return x
}

/** The render the plan describes: its makeup AND its ceiling, as apply does. */
function renderPlan(x, params, plan) {
  return processFET1176Buffer([x], SR, {
    ...params,
    outputGainDb: plan.makeupDb,
    ceilingDb: plan.ceilingDb,
    ceilingKneeDb: plan.ceilingKneeDb,
  }).channelData[0]
}

const DRIVES = [50, 60, 70, 80, 90, 100]

test('the peak reference makes the Input knob run backwards — the defect, pinned', () => {
  const x = narration()
  const levels = DRIVES.map((inputDrive) => {
    const params = { inputDrive }
    const plan = computeFET1176AutoMakeupPlan([x], SR, params, { reference: 'peak' })
    return rmsDb(renderPlan(x, params, plan))
  })
  // Monotonically DOWN: every step of the knob costs level.
  for (let i = 1; i < levels.length; i++) {
    assert.ok(
      levels[i] < levels[i - 1],
      `drive ${DRIVES[i]}: ${levels[i].toFixed(2)} dB is not below ${levels[i - 1].toFixed(2)}`,
    )
  }
  // And the whole sweep is quieter than the source it compressed.
  assert.ok(levels[0] < rmsDb(x), 'even the shallowest setting loses level')
})

test('the percentile reference holds the body across the same sweep', () => {
  const x = narration()
  const levels = DRIVES.map((inputDrive) => {
    const params = { inputDrive }
    const plan = computeFET1176AutoMakeupPlan([x], SR, params, { reference: 'percentile' })
    return rmsDb(renderPlan(x, params, plan))
  })
  const spread = Math.max(...levels) - Math.min(...levels)
  assert.ok(spread < 1, `body level spread ${spread.toFixed(2)} dB across the whole knob`)
  // Louder than the peak reference at every setting, which is the point.
  for (const [i, inputDrive] of DRIVES.entries()) {
    const params = { inputDrive }
    const byPeak = rmsDb(renderPlan(
      x, params, computeFET1176AutoMakeupPlan([x], SR, params, { reference: 'peak' }),
    ))
    assert.ok(levels[i] > byPeak, `drive ${inputDrive}: percentile must not be quieter`)
  }
})

test('the guarantee holds by enforcement: never louder than the source', () => {
  const x = narration()
  const sourcePeak = peak(x)
  for (const inputDrive of DRIVES) {
    for (const mix of [1, 0.5]) {
      const params = { inputDrive, mix }
      const plan = computeFET1176AutoMakeupPlan([x], SR, params, { reference: 'percentile' })
      assert.ok(Number.isFinite(plan.ceilingDb), 'the percentile reference must issue a ceiling')
      assert.ok(Number.isFinite(plan.ceilingKneeDb), 'and the knee it is enforced with')
      const out = renderPlan(x, params, plan)
      assert.ok(
        peak(out) <= sourcePeak,
        `drive ${inputDrive} mix ${mix}: ${db(peak(out)).toFixed(2)} dBFS over ${db(sourcePeak).toFixed(2)}`,
      )
    }
  }
})

test('the percentile reference needs the ceiling — without it the peak escapes', () => {
  const x = narration()
  const params = { inputDrive: 70 }
  const plan = computeFET1176AutoMakeupPlan([x], SR, params, { reference: 'percentile' })
  const bare = processFET1176Buffer([x], SR, {
    ...params, outputGainDb: plan.makeupDb, ceilingDb: null,
  }).channelData[0]
  assert.ok(
    peak(bare) > peak(x),
    'if the un-ceilinged render already fits, this fixture has stopped testing anything',
  )
})

test('the peak reference is unchanged, and issues no ceiling', () => {
  const x = narration()
  for (const inputDrive of DRIVES) {
    const params = { inputDrive }
    const plan = computeFET1176AutoMakeupPlan([x], SR, params)
    assert.equal(plan.ceilingDb, null, 'an arithmetic guarantee needs no enforcement')
    assert.equal(plan.ceilingKneeDb, null)
    // The old entry point is the same number, so every caller that wants the
    // exact-by-construction answer still gets it.
    assert.equal(computeFET1176AutoMakeupDb([x], SR, params), plan.makeupDb)
    const out = renderPlan(x, params, plan)
    assert.ok(peak(out) <= peak(x) * 1.0001, 'and it keeps its own guarantee unaided')
  }
})

test('the knee is sized by the solve: a ceiling with nothing to catch costs nothing', () => {
  const x = narration()
  const params = { inputDrive: 50 }
  const ceilingDb = db(peak(x))
  // A makeup well under the ceiling: nothing overshoots, so nothing is charged.
  const quiet = { ...params, outputGainDb: -12 }
  const withCeiling = processFET1176Buffer([x], SR, {
    ...quiet, ceilingDb, ceilingKneeDb: 0,
  }).channelData[0]
  const without = processFET1176Buffer([x], SR, { ...quiet, ceilingDb: null }).channelData[0]
  assert.deepEqual(
    Array.from(withCeiling), Array.from(without),
    'a zero knee under an unreached ceiling must be the render it always was',
  )
})

test('an absent knee falls back to the widest fixed width, never to none', () => {
  const x = narration()
  const params = { inputDrive: 70, outputGainDb: 12 }
  const ceilingDb = db(peak(x))
  const absent = processFET1176Buffer([x], SR, { ...params, ceilingDb }).channelData[0]
  const widest = processFET1176Buffer([x], SR, {
    ...params, ceilingDb, ceilingKneeDb: CEILING_KNEE_DB,
  }).channelData[0]
  assert.deepEqual(Array.from(absent), Array.from(widest))
  assert.ok(peak(absent) <= peak(x), 'and it is still a guarantee')
})

test('the solve is exact at Mix 1 and still solved below it', () => {
  const x = narration()
  for (const mix of [1, 0.7, 0.5, 0.3]) {
    const params = { inputDrive: 70, mix }
    const plan = computeFET1176AutoMakeupPlan([x], SR, params, { reference: 'percentile' })
    /**
     * ⚠ MEASURED THROUGH THE RENDER, NOT THE SOLVE'S OWN ARITHMETIC. The point
     * of pinning it at every Mix is that the iteration OptoSmooth uses would
     * not converge here — three passes at Mix 0.3 came out 6.1 dB short — so
     * this asserts the answer against the audio that actually comes out.
     */
    const out = processFET1176Buffer([x], SR, {
      ...params, outputGainDb: plan.makeupDb, ceilingDb: null,
    }).channelData[0]
    const ref = (ch) => {
      const all = Float32Array.from(ch, (v) => Math.abs(v))
      all.sort()
      return all[Math.round(all.length * 0.999) - 1]
    }
    assert.ok(
      Math.abs(db(ref(out)) - db(ref(x))) < 0.1,
      `mix ${mix}: body landed ${(db(ref(out)) - db(ref(x))).toFixed(2)} dB off target`,
    )
  }
})

test('mix 0 is the dry signal and asks for nothing', () => {
  const x = narration()
  for (const reference of ['peak', 'percentile']) {
    const plan = computeFET1176AutoMakeupPlan([x], SR, { inputDrive: 70, mix: 0 }, { reference })
    assert.deepEqual(plan, { makeupDb: 0, ceilingDb: null, ceilingKneeDb: null })
  }
})

test('an unknown reference is refused rather than silently defaulted', () => {
  assert.throws(
    () => computeFET1176AutoMakeupPlan([narration(0.2)], SR, {}, { reference: 'rms' }),
    /unknown makeup reference/,
  )
})

/**
 * ⚠ A `null` MUST BE ABLE TO TURN THE GUARANTEE OFF, and on the LIVE node that
 * is not free. `setParam` re-maps the whole panel object and posts it, and the
 * kernel MERGES a partial — so an omitted key means "unchanged", not "null",
 * and a measured ceiling would stay armed against a gain the user now owns.
 * OptoSmooth hit exactly that and needed `withMeasuredClears` to dig out,
 * because its mapping spreads these keys conditionally. FET Punch's maps them
 * unconditionally, so the clear already reaches the kernel — this pins that
 * difference rather than leaving it to chance, since making the mapping
 * conditional would reintroduce a silent, preview-only divergence.
 */
test('the measured keys are always mapped, so a null can clear them', async () => {
  const { toKernelParams, FET1176_DEFAULTS } =
    await import('../../src/audio/effects/fet1176Params.js')
  const mapped = toKernelParams({ ...FET1176_DEFAULTS })
  for (const key of ['ceilingDb', 'ceilingKneeDb', 'inputAlignDb']) {
    assert.ok(key in mapped, `${key} must be present even when nothing measured it`)
  }
  const armed = toKernelParams({ ...FET1176_DEFAULTS, ceilingDb: -3, ceilingKneeDb: 1 })
  assert.equal(armed.ceilingDb, -3)
  assert.equal(armed.ceilingKneeDb, 1)
  const cleared = toKernelParams({ ...FET1176_DEFAULTS, ceilingDb: null, ceilingKneeDb: null })
  assert.equal(cleared.ceilingDb, null)
  assert.equal(cleared.ceilingKneeDb, null)
})
