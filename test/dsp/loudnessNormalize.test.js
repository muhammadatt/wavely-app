/**
 * Run with:  npm test
 *
 * THE GAIN/CEILING SOLVE.
 *
 * ⚠ WHAT IS PINNED HERE IS THAT THE REPORTED NUMBER IS THE RENDERED NUMBER. A
 * normalizer that says "-16 LUFS" and hands back -17.4 is worse than one that
 * refuses: the user is aiming at a spec somebody else will measure, and the
 * panel is the only place they can find out before submitting. Every assertion
 * below re-measures the output rather than trusting the report.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  renderLoudnessNormalize, planNormalization, limitToCeiling, applyGain,
  measuredFor, peakFor, PEAK_MODES,
} from '../../src/audio/dsp/loudnessNormalize.js'
import {
  measureLoudness, measureIntegratedLufs, measureRmsDb,
  measureSamplePeakDb, measureTruePeakDb,
} from '../../src/audio/dsp/loudness.js'

const SR = 44100

/** Speech-shaped: bursts with pauses, so gating and crest factor both bite. */
function narration(seconds = 6, amp = 0.25) {
  const n = Math.round(seconds * SR)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const env = Math.max(0, Math.sin((2 * Math.PI * i) / (SR * 0.7)))
    x[i] = amp * env * env * Math.sin((2 * Math.PI * 180 * i) / SR)
      * (1 + 0.4 * Math.sin((2 * Math.PI * 1400 * i) / SR))
  }
  return x
}

/** The same, with sparse transients — a crest factor no gain can satisfy. */
function spiky(seconds = 6) {
  const x = narration(seconds)
  for (let k = 0; k < 12; k++) {
    const i = Math.floor((k * x.length) / 12) + 1000
    x[i] = 0.9
    x[i + 1] = -0.85
  }
  return x
}

const LUFS = ceilingDb => targetDb => ({ targetDb, unit: 'LUFS', ceilingDb })
const podcast = { targetDb: -16, unit: 'LUFS', ceilingDb: -1 }
const acx = { targetDb: -20, unit: 'RMS', ceilingDb: -3 }

test('a target that fits under the ceiling is one exact gain', () => {
  const x = narration()
  for (const target of [podcast, acx, { targetDb: -23, unit: 'LUFS', ceilingDb: -1 }]) {
    const { channelData, report } = renderLoudnessNormalize([x], SR, target, 'limit')
    assert.equal(report.limitedDb, 0, 'nothing should have been limited')
    const got = target.unit === 'RMS'
      ? measureRmsDb(channelData)
      : measureIntegratedLufs(channelData, SR)
    assert.ok(Math.abs(got - target.targetDb) < 0.05,
      `${target.targetDb} ${target.unit}: rendered ${got.toFixed(3)}`)
    assert.ok(Math.abs(got - report.achievedDb) < 0.05, 'the report must match the render')
  }
})

test('LIMIT hits the target and holds the ceiling on material that cannot do both', () => {
  const x = spiky()
  const before = measureLoudness([x], SR)
  const plan = planNormalization(before, podcast, 'limit')
  assert.equal(plan.ceilingHit, true, 'the fixture must actually exercise the ceiling')

  const { channelData, report } = renderLoudnessNormalize([x], SR, podcast, 'limit')
  assert.equal(report.converged, true)
  assert.ok(report.limitedDb > 1, `limiting should have done real work, got ${report.limitedDb}`)

  const lufs = measureIntegratedLufs(channelData, SR)
  const tp = measureTruePeakDb(channelData)
  assert.ok(Math.abs(lufs - podcast.targetDb) < 0.15, `landed at ${lufs.toFixed(3)} LUFS`)
  assert.ok(tp <= podcast.ceilingDb + 0.01, `true peak ${tp.toFixed(3)} broke the ceiling`)
})

test('SAFE never touches the ceiling and says how far short it stopped', () => {
  const x = spiky()
  const { channelData, report } = renderLoudnessNormalize([x], SR, podcast, 'safe')
  assert.equal(report.limitedDb, 0, 'SAFE must apply gain and nothing else')
  assert.ok(report.shortfallDb > 1, `SAFE should report a real shortfall, got ${report.shortfallDb}`)

  const tp = measureTruePeakDb(channelData)
  assert.ok(Math.abs(tp - podcast.ceilingDb) < 0.05,
    `SAFE should land exactly on the ceiling, got ${tp.toFixed(3)}`)

  // And the shortfall is the truth, not a rounding: measured back off the render.
  const lufs = measureIntegratedLufs(channelData, SR)
  assert.ok(Math.abs((podcast.targetDb - lufs) - report.shortfallDb) < 0.05,
    `reported ${report.shortfallDb} short, actually ${(podcast.targetDb - lufs).toFixed(3)}`)
})

test('the one-gain path measures its result rather than predicting it', () => {
  // ⚠ REGRESSION. `achievedDb` was `measuredDb + gainDb` here, on the reasoning
  // that one gain is exact arithmetic. It is — but LUFS is GATED against a
  // FIXED -70 LKFS absolute threshold, so a large boost carries blocks up
  // across it that were excluded before, and the average afterwards is over a
  // different set of blocks. Measured on this fixture the shortcut was 1.9 LU
  // out while reporting an exact hit.
  //
  // A very quiet recording is precisely the one that needs a large gain, so
  // this is the file the tool exists for, not a corner of it.
  const n = SR * 8
  const faint = new Float32Array(n)
  const loudAmp = 5.6e-4
  const quietAmp = loudAmp * Math.pow(10, -6 / 20)
  for (let i = 0; i < n; i++) {
    const loud = Math.sin((2 * Math.PI * i) / (SR * 2)) > 0
    faint[i] = (loud ? loudAmp : quietAmp) * Math.sin((2 * Math.PI * 200 * i) / SR)
  }

  const before = measureIntegratedLufs([faint], SR)
  const { channelData, report } = renderLoudnessNormalize([faint], SR, podcast, 'safe')

  // The fixture must actually straddle the gate, or it proves nothing.
  assert.ok(
    Math.abs((before + report.gainDb) - report.achievedDb) > 1,
    'this fixture no longer exercises the gate crossing',
  )
  // What is reported is what is in the buffer.
  assert.ok(Math.abs(measureIntegratedLufs(channelData, SR) - report.achievedDb) < 0.01,
    `reported ${report.achievedDb}, rendered ${measureIntegratedLufs(channelData, SR)}`)
})

test('RMS really is exact under one gain, so nothing was lost by measuring', () => {
  // The counterpart: ACX's measurement is ungated, so gain does move it
  // linearly. Measuring instead of predicting has to agree here, otherwise the
  // re-measure above would have introduced an error of its own.
  const x = narration()
  const { report } = renderLoudnessNormalize([x], SR, acx, 'safe')
  assert.ok(Math.abs((measureRmsDb([x]) + report.gainDb) - report.achievedDb) < 1e-6)
})

test('SAFE and LIMIT agree exactly whenever the ceiling is not in the way', () => {
  // Otherwise the switch would be a character control, which it is not: it only
  // decides what gives when the two constraints disagree.
  const x = narration()
  const a = renderLoudnessNormalize([x], SR, podcast, 'safe')
  const b = renderLoudnessNormalize([x], SR, podcast, 'limit')
  assert.equal(a.report.gainDb, b.report.gainDb)
  for (let i = 0; i < x.length; i += 997) {
    assert.equal(a.channelData[0][i], b.channelData[0][i], `sample ${i}`)
  }
})

test('an ask the limiter cannot reach reports that, rather than claiming it', () => {
  // Past a point the envelope ducks the body by as much as the gain adds. The
  // only honest answer is the loudness that came out and converged: false.
  const { channelData, report } = renderLoudnessNormalize([spiky()], SR, LUFS(-1)(-6), 'limit')
  assert.equal(report.converged, false)
  const lufs = measureIntegratedLufs(channelData, SR)
  assert.ok(Math.abs(lufs - report.achievedDb) < 0.05,
    'the reported figure must be the one that came out')
  assert.ok(lufs < -6, 'and it must be short of the ask, not silently rounded to it')
  assert.ok(measureTruePeakDb(channelData) <= -1 + 0.01, 'the ceiling still holds')
})

test('ACX is measured with ACX’s meter, not the streaming one', () => {
  // ⚠ THE WHOLE POINT OF `unit`. Ungated RMS against sample peak; a file
  // normalized with the LUFS meter would sit several dB from ACX's window.
  const x = narration()
  const { channelData, report } = renderLoudnessNormalize([x], SR, acx, 'limit')
  assert.ok(Math.abs(measureRmsDb(channelData) - -20) < 0.05)
  assert.ok(measureSamplePeakDb(channelData) <= -3 + 0.01)
  assert.ok(Math.abs(report.measuredDb - measureRmsDb([x])) < 1e-9,
    'the "before" figure must be the RMS one too')
})

test('measuredFor and peakFor read the meter the target names', () => {
  const m = measureLoudness([narration()], SR)
  assert.equal(measuredFor(m, 'LUFS'), m.lufs)
  assert.equal(measuredFor(m, 'RMS'), m.rmsDb)
  assert.equal(peakFor(m, 'LUFS'), m.truePeakDb)
  assert.equal(peakFor(m, 'RMS'), m.samplePeakDb)
})

test('the panel’s preview and the render use the same plan', () => {
  // planNormalization is what the faceplate prints before Apply; if it and the
  // render disagreed, the number under the knob would not be the number that
  // comes out. Same function, so they cannot.
  const x = spiky()
  const before = measureLoudness([x], SR)
  for (const mode of PEAK_MODES.map(m => m.id)) {
    const plan = planNormalization(before, podcast, mode)
    const { report } = renderLoudnessNormalize([x], SR, podcast, mode)
    assert.equal(report.gainDb, plan.gainDb, mode)
    assert.equal(report.ceilingHit, plan.ceilingHit, mode)
  }
})

test('silence is answered, not divided by', () => {
  const quiet = new Float32Array(SR)
  const { channelData, report } = renderLoudnessNormalize([quiet], SR, podcast, 'limit')
  assert.equal(report.silent, true)
  assert.equal(report.gainDb, 0)
  assert.equal(channelData[0], quiet, 'silence is returned untouched')
})

// ── The limiter ─────────────────────────────────────────────────────────────

test('the limiter holds the ceiling and keeps the region sample-aligned', () => {
  const x = applyGain([spiky()], 12)
  const out = limitToCeiling(x, -1, SR)
  assert.equal(out[0].length, x[0].length, 'latency must be removed, not returned')
  assert.ok(measureSamplePeakDb(out) <= -1 + 1e-6,
    `sample peak ${measureSamplePeakDb(out)} broke the ceiling`)
})

test('the limiter is channel-linked, so it cannot swing the stereo image', () => {
  // A transient in one channel only. Independent limiters would duck that side
  // alone and move the picture; one detector moves both by the same amount.
  const n = SR
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    left[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / SR)
    right[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / SR)
  }
  left[SR >> 1] = 0.95

  const out = limitToCeiling([left, right], -6, SR)
  // Away from the transient nothing moves; through it, both sides move together.
  const at = (SR >> 1) - 40
  const ratioL = out[0][at] / left[at]
  const ratioR = out[1][at] / right[at]
  assert.ok(Math.abs(ratioL - ratioR) < 1e-6,
    `the two channels were gained differently: ${ratioL} vs ${ratioR}`)
  assert.ok(ratioL < 0.999, 'the fixture must actually put the limiter to work')
})

test('a signal already under the ceiling passes through the limiter unchanged', () => {
  const x = [narration(2, 0.05)]
  const out = limitToCeiling(x, -1, SR)
  for (let i = 0; i < x[0].length; i += 331) {
    assert.ok(Math.abs(out[0][i] - x[0][i]) < 1e-6, `sample ${i} moved`)
  }
})
