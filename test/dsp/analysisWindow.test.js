/**
 * Run with:  npm test
 *
 * THE AUTO-MAKEUP ANALYSIS WINDOW, and the cold-detector bug that moved it.
 *
 * Reported from use: a file peak-normalised to −1 dBFS came out of FET Punch on
 * the stock Vocal Punch preset at −3.14 dBFS, looking as though no makeup had
 * been applied. 8.10 dB had been, against the 10.25 a whole-file measurement
 * asks for — the shortfall being one cold-start transient at the head of a
 * CENTRED analysis excerpt setting the peak reference.
 *
 * Two kinds of test, because the arithmetic and the reason for it fail
 * differently. The window tests pin WHERE the analysis sits and are what a
 * re-centring breaks — verified by mutation, it fails exactly one of them. The
 * kernel tests pin WHY it has to sit there; they slice the material themselves,
 * so ⚠ they do NOT fail on a re-centring and are not a guard against one. They
 * are the record of the mechanism, so that a future reader who thinks the
 * anchoring is arbitrary can see the cold-start overshoot for themselves.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analysisWindow, AUTO_MAKEUP_MAX_ANALYSIS_S } from '../../src/audio/analysisWindow.js'
import {
  processFET1176Buffer, computeFET1176AutoMakeupDb,
} from '../../src/audio/fet1176Processor.js'

test('a region inside the cap is measured end to end', () => {
  assert.deepEqual(analysisWindow(4, 10), { start: 4, end: 10 })
  assert.deepEqual(analysisWindow(0, AUTO_MAKEUP_MAX_ANALYSIS_S), {
    start: 0, end: AUTO_MAKEUP_MAX_ANALYSIS_S,
  })
})

test('a longer region is measured FROM ITS START, never centred', () => {
  const w = analysisWindow(10, 100)
  assert.equal(w.start, 10, 'the window must begin at the region start')
  assert.equal(w.end, 10 + AUTO_MAKEUP_MAX_ANALYSIS_S)

  // The mutation this exists for: the old centred window. On a 90 s region it
  // put the analysis at [40, 70] — a span whose first sample is mid-phrase.
  const mid = (10 + 100) / 2
  assert.notEqual(w.start, mid - AUTO_MAKEUP_MAX_ANALYSIS_S / 2)
})

const SR = 48000

/**
 * Speech-like material with PLOSIVE-STYLE ONSETS, one of them landing exactly
 * on the first sample of the centred window.
 *
 * ⚠ THAT PLACEMENT IS THE CONDITION THE BUG REQUIRES, NOT A RIGGED TEST. The
 * cold-start overshoot only sets the peak reference when the excerpt begins on
 * something loud, which in real narration is simply "the cut landed mid-word" —
 * on the reported file the centred window opened at 2.76 s and overshot 1 ms
 * later. A first attempt used a smooth syllabic envelope and reproduced
 * nothing: the FET detector's attack is fast enough to catch a gradual onset
 * within a few samples, so there was no overshoot to find. Twelfth time
 * synthetic material has been too clean to answer the question asked of it.
 */
function material(seconds = 40, onsetAt = 5) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  const onsets = []
  for (let t = 1; t < seconds - 1; t += 0.5) onsets.push(t)
  onsets.push(onsetAt) // guarantee one exactly at the centred window's first sample
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const syllable = (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.3 * t)) ** 2
    x[i] = 0.35 * syllable * (
      Math.sin(2 * Math.PI * 130 * t) + 0.5 * Math.sin(2 * Math.PI * 390 * t)
    )
  }
  for (const at of onsets) {
    const k0 = Math.round(at * SR)
    for (let k = 0; k < Math.round(SR * 0.01); k++) {
      const i = k0 + k
      if (i >= n) break
      x[i] += 0.55 * Math.exp(-k / (SR * 0.0012)) * Math.sin(2 * Math.PI * 900 * k / SR)
    }
  }
  return x
}

test('a centred excerpt under-reads the makeup, because its detector starts cold', () => {
  const x = material()
  const p = { inputDrive: 55, attack: 4, release: 5, ratio: '4', fetDrive: 0.35, scHpfHz: 0, mix: 1 }
  const dur = x.length / SR

  const slice = (a, b) => [x.subarray(Math.round(a * SR), Math.round(b * SR))]
  const cap = AUTO_MAKEUP_MAX_ANALYSIS_S

  const whole = computeFET1176AutoMakeupDb([x], SR, p)
  const fromStart = computeFET1176AutoMakeupDb(slice(0, cap), SR, p)
  const centred = computeFET1176AutoMakeupDb(
    slice(dur / 2 - cap / 2, dur / 2 + cap / 2), SR, p)

  // The bug, reproduced: a centred excerpt asks for materially less makeup.
  assert.ok(
    whole - centred > 1,
    `centred should under-read: whole ${whole.toFixed(2)} vs centred ${centred.toFixed(2)}`,
  )
  // The fix: anchored at the start it tracks the whole-region answer.
  assert.ok(
    Math.abs(whole - fromStart) < 0.5,
    `from-start should track: whole ${whole.toFixed(2)} vs ${fromStart.toFixed(2)}`,
  )
})

test('the under-read is a cold-start transient at the head of the excerpt', () => {
  // The mechanism, isolated — this is what makes the peak reference wrong, and
  // it is invisible to an RMS-referenced measurement, which is exactly why the
  // centring survived the switch to peak referencing.
  const x = material()
  const p = { inputDrive: 55, attack: 4, release: 5, ratio: '4', fetDrive: 0.35, scHpfHz: 0, mix: 1, outputGainDb: 0 }
  const cap = AUTO_MAKEUP_MAX_ANALYSIS_S
  const dur = x.length / SR
  const excerpt = [x.subarray(Math.round((dur / 2 - cap / 2) * SR), Math.round((dur / 2 + cap / 2) * SR))]

  const out = processFET1176Buffer(excerpt, SR, p).channelData[0]
  const peakFrom = (skip) => {
    let v = 0
    for (let i = skip; i < out.length; i++) v = Math.max(v, Math.abs(out[i]))
    return v
  }
  const cold = peakFrom(0)
  const warm = peakFrom(Math.round(SR * 0.05)) // 50 ms in

  assert.ok(
    20 * Math.log10(cold / warm) > 1,
    `the first 50 ms should carry an uncompressed overshoot, got ${(20 * Math.log10(cold / warm)).toFixed(2)} dB`,
  )
})
