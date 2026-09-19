/**
 * Run with:  npm test
 *
 * THE PEAK RESTORE, AND THE INVARIANT IT PUTS AT RISK.
 *
 * Percentile-referenced makeup matches the BODY to the source and leaves the
 * peak wherever the compression put it — under the source peak by 1.9 dB at
 * light settings on real narration. The restore is a scalar applied to the
 * finished render that puts it back on the ceiling.
 *
 * ⚠⚠ THE OBJECTION TO IT WAS THAT IT IS THE PEAK REFERENCE BY ANOTHER NAME, AND
 * THAT WAS WRONG. It holds only while the ceiling is idle; once the ceiling is
 * catching peaks it is a limiter and the two paths separate. Measured on a
 * narrator's own take at Input 60, both ending at -1 dBFS: restored -16.94 dB
 * rms against the peak reference's -19.21. `restoreIsNotThePeakReference`
 * below is that finding in a form that fails if it stops being true.
 *
 * ⚠ THE INVARIANT IS "NEVER LOUDER THAN THE SOURCE", and the restore is the
 * only thing in the chain that can break it — it adds gain after the ceiling
 * has done its work. Every test here checks it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  peakRestoreTrimDb, restorePeakToCeiling, peakOfChannels,
} from '../../src/audio/dsp/makeupReference.js'
import {
  computeFET1176AutoMakeupPlan, processFET1176Buffer,
} from '../../src/audio/fet1176Processor.js'

const SR = 44100
const db = v => 20 * Math.log10(Math.max(v, 1e-12))

/**
 * Syllabic narration with short transients that outrun a percentile: the shape
 * that makes the restore worth having, and the shape the peak reference chokes
 * on. 1.5 ms spikes are too brief to move the loudest 0.1 % of samples.
 */
function narration(seconds = 6, amp = 0.34) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    phase += (2 * Math.PI * (118 + 14 * Math.sin(2 * Math.PI * 0.6 * t))) / SR
    let s = 0
    for (let h = 1; h <= 12; h++) s += Math.sin(phase * h) / (h * h)
    const syll = Math.max(0, Math.sin(2 * Math.PI * 3.3 * t)) ** 2
    x[i] = amp * s * syll * (t % 3 < 2.4 ? 1 : 0.02)
  }
  for (let k = 0; k < 10; k++) {
    const at = Math.round(SR * (0.4 + k * 0.53))
    if (at + 200 >= n) break
    for (let i = 0; i < 66; i++) x[at + i] += 0.62 * Math.exp(-i / 14) * Math.sin(i * 0.9)
  }
  return x
}

const x = narration()
const sourcePeakDb = db(peakOfChannels([x]))

/** The shipping path: percentile solve, ceiling at the source peak, render. */
function render(inputDrive, { reference = 'percentile', ...rest } = {}) {
  const params = {
    inputDrive, attack: 4, release: 4, ratio: '4', fetDrive: 1, scHpfHz: 0, mix: 1, ...rest,
  }
  const plan = computeFET1176AutoMakeupPlan([x], SR, params, { reference })
  const ceilingDb = reference === 'percentile' ? sourcePeakDb : null
  const { channelData } = processFET1176Buffer([x], SR, {
    ...params, outputGainDb: plan.makeupDb, ceilingDb, ceilingKneeDb: plan.ceilingKneeDb,
  })
  return { channelData, ceilingDb, plan }
}

const SWEEP = [20, 30, 40, 50, 60, 70, 80, 90, 100]

test('the restore lands the peak ON the ceiling, and never above it', () => {
  for (const inputDrive of SWEEP) {
    const { channelData, ceilingDb } = render(inputDrive)
    const trimDb = restorePeakToCeiling(channelData, ceilingDb)
    const out = db(peakOfChannels(channelData))
    assert.ok(Math.abs(out - ceilingDb) < 1e-4,
      `Input ${inputDrive}: landed ${out.toFixed(4)} against a ${ceilingDb.toFixed(4)} ceiling`)
    /**
     * ⚠ THE ONE THAT MATTERS. A restore sized from anything other than this
     * render — the solve's capped window, say — overshoots here, and this is
     * the assertion that catches it.
     */
    assert.ok(out <= ceilingDb + 1e-6,
      `Input ${inputDrive}: LOUDER THAN THE SOURCE by ${(out - ceilingDb).toFixed(4)} dB ` +
      `after a ${trimDb.toFixed(2)} dB restore`)
  }
})

test('the trim is what the render was short by, and is never negative here', () => {
  for (const inputDrive of SWEEP) {
    const { channelData, ceilingDb } = render(inputDrive)
    const before = db(peakOfChannels(channelData))
    const trimDb = peakRestoreTrimDb(channelData, ceilingDb)
    assert.ok(Math.abs(trimDb - (ceilingDb - before)) < 1e-9)
    // The kernel's ceiling holds the render at or under the source peak, so a
    // restore only ever adds. A negative trim here would mean the ceiling leaked.
    assert.ok(trimDb >= -1e-9,
      `Input ${inputDrive}: the render came back ABOVE the ceiling by ${(-trimDb).toFixed(3)} dB`)
  }
})

/**
 * ⚠ SCALING THE RENDER == ADDING THE TRIM TO BOTH `outputGainDb` AND
 * `ceilingDb`, because the ceiling's knee is defined in dB relative to its own
 * threshold and is therefore homogeneous. Pinned because the equivalence is
 * what makes "scale the finished render" a legitimate implementation rather
 * than an approximation of the honest one.
 */
test('the restore is equivalent to re-rendering with both numbers raised', () => {
  for (const inputDrive of [30, 60, 90]) {
    const { channelData, ceilingDb, plan } = render(inputDrive)
    const trimDb = restorePeakToCeiling(channelData, ceilingDb)
    const { channelData: reRendered } = processFET1176Buffer([x], SR, {
      inputDrive, attack: 4, release: 4, ratio: '4', fetDrive: 1, scHpfHz: 0, mix: 1,
      outputGainDb: plan.makeupDb + trimDb,
      ceilingDb: ceilingDb + trimDb,
      ceilingKneeDb: plan.ceilingKneeDb,
    })
    let worst = 0
    for (let c = 0; c < channelData.length; c++) {
      for (let i = 0; i < channelData[c].length; i++) {
        worst = Math.max(worst, Math.abs(channelData[c][i] - reRendered[c][i]))
      }
    }
    assert.ok(worst < 1e-6, `Input ${inputDrive}: diverged by ${worst.toExponential(2)}`)
  }
})

/**
 * ⚠⚠ THE FINDING THAT OVERTURNED THE OBJECTION. Restoring the peak is NOT the
 * peak reference: the ceiling limits before the restore scales, so the body
 * survives where peak-referenced makeup would have ducked the whole file under
 * an uncompressed transient. They agree only where the ceiling is idle.
 */
test('restore is not the peak reference once the ceiling is working', () => {
  const rmsDb = (chs) => {
    let s = 0
    let n = 0
    for (const c of chs) { for (const v of c) s += v * v; n += c.length }
    return db(Math.sqrt(s / n))
  }
  const delivered = (inputDrive, reference) => {
    const { channelData, ceilingDb } = render(inputDrive, { reference })
    // Both paths judged at the same peak, which is the only fair comparison.
    restorePeakToCeiling(channelData, ceilingDb ?? sourcePeakDb)
    return rmsDb(channelData)
  }
  // Where the ceiling never engages the two are the same operation.
  assert.ok(Math.abs(delivered(20, 'percentile') - delivered(20, 'peak')) < 0.25,
    'at a light setting the restore IS the peak reference')
  // Where it engages, the restore keeps body the peak reference throws away.
  const hard = delivered(80, 'percentile') - delivered(80, 'peak')
  assert.ok(hard > 1,
    `compressing hard, the restore must deliver more body; got ${hard.toFixed(2)} dB`)
})

test('no ceiling and no signal are both no-ops', () => {
  const chs = [Float32Array.from([0.5, -0.25])]
  assert.equal(peakRestoreTrimDb(chs, null), 0)
  assert.equal(peakRestoreTrimDb(chs, undefined), 0)
  assert.equal(peakRestoreTrimDb(chs, NaN), 0)
  assert.equal(restorePeakToCeiling(chs, null), 0)
  assert.deepEqual([...chs[0]], [0.5, -0.25], 'a no-op must not touch the audio')
  assert.equal(peakRestoreTrimDb([new Float32Array(16)], -1), 0, 'silence has no peak to restore')
})

/**
 * ⚠ A RENDER ABOVE THE CEILING IS PULLED DOWN, not left alone. Clamping the
 * trim at zero would skip the only case where the invariant is actually in
 * danger, so the sign is pinned here rather than assumed.
 */
test('a render above the ceiling is brought back down', () => {
  const chs = [Float32Array.from([0.8, -0.4])]
  const trimDb = restorePeakToCeiling(chs, db(0.4))
  assert.ok(trimDb < 0, `expected a cut, got ${trimDb.toFixed(3)} dB`)
  assert.ok(Math.abs(db(peakOfChannels(chs)) - db(0.4)) < 1e-4)
})
