/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectHum,
  MIN_ANALYSIS_SECONDS,
  HUM_DETECT_DEFAULTS,
} from '../../src/audio/dsp/humDetect.js'

const SR = 44100

/**
 * Build a test signal: broadband noise floor, an optional voice-like harmonic
 * stack, and an optional mains hum series.
 *
 * `humDb` is the level of the hum fundamental relative to full scale; each
 * harmonic above it is scaled by `humRolloff^(k-1)`, which is roughly how real
 * transformer hum behaves.
 */
function makeSignal({
  seconds = 3,
  noiseDb = -70,
  humFundamental = null,
  humDb = -45,
  humHarmonics = [1, 2, 3, 4, 5],
  humRolloff = 0.7,
  voiceF0 = null,
  voiceDb = -25,
  voiceJitterHz = 4,
} = {}) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)

  const noiseAmp = Math.pow(10, noiseDb / 20)
  let s = 987654321
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = noiseAmp * (s / 0x3fffffff - 1)
  }

  if (humFundamental) {
    const base = Math.pow(10, humDb / 20)
    for (const k of humHarmonics) {
      const amp = base * Math.pow(humRolloff, k - 1)
      const f = humFundamental * k
      const phase = k * 0.7
      for (let i = 0; i < n; i++) {
        out[i] += amp * Math.sin((2 * Math.PI * f * i) / SR + phase)
      }
    }
  }

  if (voiceF0) {
    // Slow pitch wobble, integrated so phase stays continuous. A dead-steady
    // harmonic stack is not what a voice looks like, and the pitch check keys
    // off how the contour behaves — so the fixture has to wobble.
    const base = Math.pow(10, voiceDb / 20)
    let phase = 0
    for (let i = 0; i < n; i++) {
      const f0 = voiceF0 + voiceJitterHz * Math.sin((2 * Math.PI * 3.1 * i) / SR)
      phase += (2 * Math.PI * f0) / SR
      for (let k = 1; k <= 8; k++) {
        if (f0 * k >= SR / 2) break
        out[i] += (base / k) * 0.8 * Math.sin(k * phase + k * 1.3)
      }
    }
  }

  return out
}

test('detects a clean 60 Hz hum series', () => {
  const sig = makeSignal({ humFundamental: 60 })
  const r = detectHum(sig, SR)
  assert.equal(r.triggered, true, 'should trigger')
  assert.equal(r.tooShort, false)
  assert.equal(r.anchorFrequency, 120, 'anchors on the 2nd harmonic')
  assert.ok(r.anchorDeltaDb > HUM_DETECT_DEFAULTS.anchorMinDeltaDb)
  assert.ok(r.flaggedHarmonics.includes(60))
  assert.ok(r.flaggedHarmonics.includes(120))
})

test('detects 50 Hz mains when told to look there', () => {
  const sig = makeSignal({ humFundamental: 50 })
  const r = detectHum(sig, SR, { fundamental: 50 })
  assert.equal(r.triggered, true)
  assert.equal(r.anchorFrequency, 100)
  assert.ok(r.flaggedHarmonics.includes(100))
})

test('does not find 60 Hz hum in a 50 Hz recording', () => {
  // The harmonic series barely overlaps: 50/100/150/200/250 vs 60/120/180/240/300.
  const sig = makeSignal({ humFundamental: 50 })
  const r = detectHum(sig, SR, { fundamental: 60 })
  assert.equal(r.triggered, false, 'wrong mains setting should not trigger')
})

test('a voice sitting on the mains grid is not mistaken for hum', () => {
  // The blind spot in the spectral test: a 120 Hz speaker puts real vocal
  // energy on 120/240/360, exactly where 60 Hz hum harmonics live. The
  // spectral pass cannot tell them apart — the pitch check is what does.
  const sig = makeSignal({ voiceF0: 120 })
  const r = detectHum(sig, SR)

  assert.ok(
    r.flaggedHarmonics.includes(120),
    'the spectral test is expected to flag it — that is the blind spot',
  )
  assert.ok(r.voicePitchHz !== null, 'a speaker pitch should have been measured')
  assert.ok(Math.abs(r.voicePitchHz - 120) < 6, `measured pitch ${r.voicePitchHz}`)

  const at120 = r.detectionDetail.find(d => d.frequency === 120)
  assert.equal(at120.matchesVoicePitch, true, 'pitch check should identify it as voice')
  assert.equal(at120.voiceHarmonic, 1)

  // 240 Hz is the speaker's second harmonic — real vocal energy, and notching
  // it thins the voice just as badly as notching the fundamental.
  const at240 = r.detectionDetail.find(d => d.frequency === 240)
  assert.equal(at240.matchesVoicePitch, true, 'harmonics of the pitch count too')
  assert.equal(at240.voiceHarmonic, 2)

  assert.equal(r.triggered, false, `false positive: ${JSON.stringify(r.recommendedHarmonics)}`)
  assert.deepEqual(r.recommendedHarmonics, [], 'nothing should be recommended')
})

test('a scattered pitch contour is not trusted', () => {
  // Pure hum is periodic, so an autocorrelation tracker locks onto multiples of
  // it and reports a "pitch" that is really nothing of the kind. The
  // concentration test is what stops that vetoing genuine hum harmonics.
  const r = detectHum(makeSignal({ humFundamental: 60 }), SR)
  assert.equal(r.voicePitchHz, null, 'no speaker should be reported on pure hum')
  assert.ok(
    r.voicePitchConcentration < 0.5,
    `contour was unexpectedly tight: ${r.voicePitchConcentration}`,
  )
})

test('the pitch check can be turned off', () => {
  // Confirms the veto is what suppresses the previous case, not something else.
  const sig = makeSignal({ voiceF0: 120 })
  const r = detectHum(sig, SR, { voicePitchCheck: false })
  assert.equal(r.triggered, true, 'without the pitch check this is a false positive')
  for (const d of r.detectionDetail) {
    assert.equal(d.matchesVoicePitch, false)
  }
})

test('real hum under a voice at a different pitch still gets found', () => {
  // A 200 Hz speaker over 60 Hz hum: the pitch check must not veto the hum.
  const sig = makeSignal({ humFundamental: 60, humDb: -40, voiceF0: 200, voiceDb: -26 })
  const r = detectHum(sig, SR)
  assert.equal(r.triggered, true, 'hum should survive the pitch check')
  assert.ok(r.recommendedHarmonics.includes(120), `got ${r.recommendedHarmonics}`)
  const at120 = r.detectionDetail.find(d => d.frequency === 120)
  assert.equal(at120.matchesVoicePitch, false, '120 Hz is not this speaker’s pitch')
})

test('a 180 Hz male fundamental alone does not trigger', () => {
  // The case the server's F0 veto exists to catch. The anchored coherence
  // model should already reject it: 180 Hz is prominent but 120 Hz is not, so
  // the anchor fails and nothing is flagged.
  const sig = makeSignal({ voiceF0: 180, voiceDb: -20 })
  const r = detectHum(sig, SR)
  assert.equal(r.triggered, false)
  const at180 = r.detectionDetail.find(d => d.frequency === 180)
  assert.equal(at180.flagged, false)
})

test('reports which candidates could plausibly be a voice', () => {
  const r = detectHum(makeSignal({ humFundamental: 60 }), SR)
  const byFreq = Object.fromEntries(r.detectionDetail.map(d => [d.frequency, d]))
  assert.equal(byFreq[60].looksLikeVoice, false, '60 Hz is below any voice F0')
  assert.equal(byFreq[120].looksLikeVoice, true)
  assert.equal(byFreq[180].looksLikeVoice, true)
  assert.equal(byFreq[300].looksLikeVoice, true)
  // Pure hum with no voice present: in range, but no trusted pitch to match.
  for (const d of r.detectionDetail) {
    assert.equal(d.matchesVoicePitch, false, `${d.frequency} Hz falsely read as voice`)
  }
})

test('a genuine hum harmonic near the speaker is not vetoed', () => {
  // 200 Hz speaker over 60 Hz hum. A naive per-frame overlap test reads ~14%
  // of frames within 15 Hz of 180 (the low tail of the pitch wobble) and would
  // veto a real hum harmonic. Anchoring on the median pitch instead does not.
  const sig = makeSignal({ humFundamental: 60, humDb: -40, voiceF0: 200, voiceDb: -26, voiceJitterHz: 6 })
  const r = detectHum(sig, SR)
  assert.ok(Math.abs(r.voicePitchHz - 200) < 8, `measured pitch ${r.voicePitchHz}`)
  const at180 = r.detectionDetail.find(d => d.frequency === 180)
  assert.equal(at180.matchesVoicePitch, false, '180 Hz is hum, not the speaker')
  assert.ok(r.recommendedHarmonics.includes(180), `got ${r.recommendedHarmonics}`)
})

test('recommendedHarmonics is flaggedHarmonics minus the voice matches', () => {
  const r = detectHum(makeSignal({ voiceF0: 120 }), SR)
  const vetoed = r.detectionDetail.filter(d => d.flagged && d.matchesVoicePitch)
  assert.ok(vetoed.length > 0, 'this fixture is meant to exercise the veto')
  assert.deepEqual(
    r.recommendedHarmonics,
    r.flaggedHarmonics.filter(f => !vetoed.some(v => v.frequency === f)),
  )
})

test('silence does not trigger', () => {
  const r = detectHum(new Float32Array(SR * 2), SR)
  assert.equal(r.triggered, false)
  // Every harmonic should be rejected, not merely unflagged by accident.
  for (const d of r.detectionDetail) {
    assert.equal(d.flagged, false)
    assert.ok(d.rejectionReason, `${d.frequency} Hz had no rejection reason`)
  }
})

test('broadband noise alone does not trigger', () => {
  const r = detectHum(makeSignal({ noiseDb: -40 }), SR)
  assert.equal(r.triggered, false)
})

test('a single isolated tone does not trigger', () => {
  // One flagged harmonic is more likely a resonance than mains hum, so
  // minHarmonicsToTrigger holds it back.
  const sig = makeSignal({
    humFundamental: 60, humHarmonics: [2], humDb: -40, humRolloff: 1,
  })
  const r = detectHum(sig, SR)
  assert.ok(r.flaggedHarmonics.length <= 1, `flagged ${r.flaggedHarmonics}`)
  assert.equal(r.triggered, false)
})

test('finds hum whose fundamental has been high-passed away', () => {
  // The reason the detector anchors on the 2nd harmonic: user HPFs routinely
  // kill 60 Hz and leave 120 Hz untouched.
  const sig = makeSignal({ humFundamental: 60, humHarmonics: [2, 3, 4] })
  const r = detectHum(sig, SR)
  assert.equal(r.triggered, true, 'should still detect without a fundamental')
  assert.ok(r.flaggedHarmonics.includes(120))
  assert.ok(!r.flaggedHarmonics.includes(60), '60 Hz is absent, should not flag')
})

test('the mains grid wins when the voice cannot explain every flagged harmonic', () => {
  // High-passed hum (120/180/240) has a true period of 60 Hz, below the
  // tracker's floor, so it locks onto 120 Hz with a perfectly steady contour —
  // indistinguishable from a 120 Hz speaker by pitch alone. 180 Hz is what
  // separates them: on the mains grid, absent from a 120 Hz harmonic series.
  const r = detectHum(makeSignal({ humFundamental: 60, humHarmonics: [2, 3, 4] }), SR)

  assert.ok(r.voicePitchHz !== null, 'the tracker is expected to report a pitch here')
  assert.ok(Math.abs(r.voicePitchHz - 120) < 6, `locked onto ${r.voicePitchHz}`)
  assert.equal(r.voicePitchConcentration, 1, 'and to be entirely confident about it')

  // ...and yet nothing is vetoed, because 180 Hz does not fit that series.
  for (const d of r.detectionDetail) {
    assert.equal(d.matchesVoicePitch, false, `${d.frequency} Hz should not be vetoed`)
  }
  assert.equal(r.triggered, true)
  assert.deepEqual(r.recommendedHarmonics, [120, 180, 240])
})

test('refuses to guess on a selection that is too short', () => {
  const short = makeSignal({ seconds: MIN_ANALYSIS_SECONDS * 0.5, humFundamental: 60 })
  const r = detectHum(short, SR)
  assert.equal(r.tooShort, true)
  assert.equal(r.triggered, false)
  assert.ok(r.analyzedSeconds < MIN_ANALYSIS_SECONDS)
  for (const d of r.detectionDetail) {
    assert.equal(d.rejectionReason, 'selection-too-short')
  }
})

test('caps analysis at MAX_ANALYSIS_SECONDS', () => {
  const long = makeSignal({ seconds: 14, humFundamental: 60 })
  const r = detectHum(long, SR)
  assert.equal(r.analyzedSeconds, 10)
})

test('reports the measurements the UI displays', () => {
  const r = detectHum(makeSignal({ humFundamental: 60 }), SR)
  for (const d of r.detectionDetail) {
    assert.equal(typeof d.frequency, 'number')
    assert.equal(typeof d.peakDb, 'number')
    assert.equal(typeof d.floorDb, 'number')
    assert.ok(Math.abs(d.deltaDb - (d.peakDb - d.floorDb)) < 0.02, 'delta must be peak - floor')
    assert.equal(typeof d.flagged, 'boolean')
  }
})

test('rejects an anchorMultiplier outside the harmonics list', () => {
  assert.throws(
    () => detectHum(makeSignal({ humFundamental: 60 }), SR, { harmonics: [1, 3, 5] }),
    /anchorMultiplier/,
  )
})

test('louder hum reads as more prominent', () => {
  const quiet = detectHum(makeSignal({ humFundamental: 60, humDb: -60 }), SR)
  const loud = detectHum(makeSignal({ humFundamental: 60, humDb: -35 }), SR)
  assert.ok(
    loud.anchorDeltaDb > quiet.anchorDeltaDb + 10,
    `expected a clear gap, got ${quiet.anchorDeltaDb} vs ${loud.anchorDeltaDb}`,
  )
})
