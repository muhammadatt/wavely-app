/**
 * Run with:  npm test
 *
 * These test the client port against the behaviour of
 * server/scripts/corrective_eq.py, which is the calibrated original. Where a
 * constant or a formula appears here it is because the Python has it too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeVoxDoc,
  collectVoicedFrames,
  detectAnomaly,
  estimateBaseline,
  hannSymmetric,
  mergeBands,
  percentile,
  qFromWidth,
  computeBandParams,
  MIN_VOICED_FRAMES,
} from '../../src/audio/voxdoc/analysis.js'
import {
  classifyVoice, MALE_REGIONS, FEMALE_REGIONS, SCAN_LOW, SCAN_HIGH,
} from '../../src/audio/voxdoc/regions.js'
import { buildSuggestions } from '../../src/audio/voxdoc/suggestions.js'
import { peaking, BiquadCascade } from '../../src/audio/dsp/biquad.js'

const SR = 44100

/**
 * Deterministic white noise (mulberry32).
 *
 * Math.random() made these tests pass or fail on luck: the correlation gate
 * finds a periodic component in a few noise frames by chance, and how many it
 * finds changed the assertion outcome from run to run.
 */
function noise(n, seed = 0x9e3779b9) {
  const out = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s |= 0; s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    out[i] = ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1) * 0.2
  }
  return out
}

/**
 * A synthetic voice: a band-limited harmonic stack at f0 with a 1/k glottal
 * rolloff, shaped by a broad formant tilt, with short pauses so the
 * frame-energy floor means something.
 *
 * Summed harmonics rather than an impulse train on purpose. An impulse train
 * generated with `i % (SR/f0)` puts its pulses at integer samples while the
 * true period is fractional, so the spacing jitters between 200 and 201 samples
 * and the pattern only repeats exactly every second period. Autocorrelation
 * then prefers the double lag and the tracker reports f0/2 — an artefact of the
 * generator that would have been read here as a bug in voice classification.
 */
function synthVoice({
  f0 = 120, seconds = 3, resonanceHz = null, resonanceDb = 12, bandwidthHz = 5000,
} = {}) {
  const n = Math.round(SR * seconds)
  const sig = new Float32Array(n)
  const harmonics = Math.floor(bandwidthHz / f0)

  for (let i = 0; i < n; i++) {
    // A pause every 0.75 s, 0.15 s long — enough for a real 10th percentile.
    const t = i / SR
    if (t % 0.75 > 0.6) continue
    let v = 0
    for (let k = 1; k <= harmonics; k++) v += Math.sin(2 * Math.PI * k * f0 * t) / k
    sig[i] = 0.3 * v
  }

  // Broad spectral tilt so the envelope is not flat — a real voice rolls off.
  const tilt = new BiquadCascade(1, 1)
  tilt.setSection(0, peaking(SR, 500, 0.4, -6, 'q'))
  tilt.process(sig, sig, n, 0)

  if (resonanceHz) {
    const res = new BiquadCascade(1, 1)
    res.setSection(0, peaking(SR, resonanceHz, 3.0, resonanceDb, 'q'))
    res.process(sig, sig, n, 0)
  }
  return sig
}

// ── Voice classification ────────────────────────────────────────────────────

test('voice classification boundaries match the Python', () => {
  assert.equal(classifyVoice(120).voiceType, 'male')
  assert.equal(classifyVoice(164.9).voiceType, 'male')
  assert.equal(classifyVoice(165).voiceType, 'ambiguous')
  assert.equal(classifyVoice(200).voiceType, 'ambiguous')
  assert.equal(classifyVoice(200.1).voiceType, 'female')
  assert.equal(classifyVoice(240).voiceType, 'female')
})

test('ambiguous scan ranges interpolate between the two tables', () => {
  const mid = classifyVoice(182.5).regions // exactly halfway
  const m = MALE_REGIONS.mud
  const f = FEMALE_REGIONS.mud
  // Halfway between 200 and 280 is 240; between 420 and 550 is 485 -> 490 at
  // 10 Hz rounding.
  assert.equal(mid.mud[SCAN_LOW], Math.round(((m[SCAN_LOW] + f[SCAN_LOW]) / 2) / 10) * 10)
  assert.equal(mid.mud[SCAN_HIGH], Math.round(((m[SCAN_HIGH] + f[SCAN_HIGH]) / 2) / 10) * 10)
  // Everything else is identical across the tables and must be carried over.
  assert.equal(mid.mud[2], m[2])
  assert.equal(mid.mud[3], m[3])
})

test('an unclassifiable F0 does not throw', () => {
  assert.equal(classifyVoice(0).voiceType, 'male')
  assert.equal(classifyVoice(NaN).voiceType, 'male')
})

// ── Numeric helpers ─────────────────────────────────────────────────────────

test('percentile matches NumPy linear interpolation', () => {
  const v = [1, 2, 3, 4]
  assert.equal(percentile(v, 0), 1)
  assert.equal(percentile(v, 100), 4)
  assert.equal(percentile(v, 50), 2.5)
  // idx = 0.25 * 3 = 0.75 -> 1 + (2-1)*0.75
  assert.equal(percentile(v, 25), 1.75)
})

test('qFromWidth matches the Python formula and its clamps', () => {
  // q = 1 / (2 sinh(ln2/2 * width)), clipped to [0.8, 8].
  assert.ok(Math.abs(qFromWidth(1.0) - 1 / (2 * Math.sinh(Math.LN2 / 2))) < 1e-12)
  assert.equal(qFromWidth(0), 3.0)
  assert.equal(qFromWidth(0.01), 8.0, 'very narrow should clamp to 8')
  assert.equal(qFromWidth(10), 0.8, 'very wide should clamp to 0.8')
})

test('hannSymmetric matches np.hanning', () => {
  const w = hannSymmetric(5)
  // np.hanning(5) = [0, 0.5, 1, 0.5, 0]
  const expected = [0, 0.5, 1, 0.5, 0]
  for (let i = 0; i < 5; i++) assert.ok(Math.abs(w[i] - expected[i]) < 1e-12)
  assert.equal(hannSymmetric(1)[0], 1)
})

// ── Baseline and detection ──────────────────────────────────────────────────

test('a flat envelope produces a flat baseline and no detection', () => {
  const freqs = new Float64Array(1000)
  const env = new Float64Array(1000)
  for (let i = 0; i < 1000; i++) {
    freqs[i] = i * 20 // 0 .. 20 kHz
    env[i] = -30
  }
  const base = estimateBaseline(freqs, env, 200, 420)
  assert.ok(base, 'baseline should be computable')
  for (const v of base.baseline) assert.ok(Math.abs(v - -30) < 1e-9)

  const det = detectAnomaly(base.scanFreqs, base.scanEnv, base.baseline, 2.5, 'hump')
  assert.equal(det.detected, false)
  assert.ok(Math.abs(det.peakDeviationDb) < 1e-9)
})

test('detection finds the peak and measures its width', () => {
  const n = 2000
  const freqs = new Float64Array(n)
  const env = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    freqs[i] = i * 10
    env[i] = -30
  }
  // A 6 dB bump centred on 300 Hz, spanning 250-350 Hz at half height.
  for (let i = 0; i < n; i++) {
    const f = freqs[i]
    if (f >= 200 && f <= 400) env[i] = -30 + 6 * Math.exp(-Math.pow((f - 300) / 50, 2))
  }
  const base = estimateBaseline(freqs, env, 200, 420)
  const det = detectAnomaly(base.scanFreqs, base.scanEnv, base.baseline, 2.5, 'hump')

  assert.equal(det.detected, true)
  assert.ok(Math.abs(det.centerHz - 300) < 15, `centre was ${det.centerHz}`)
  assert.ok(det.deviationDb > 5, `deviation was ${det.deviationDb}`)
  assert.ok(det.widthOctaves > 0 && det.widthOctaves < 2)
})

test('dip detection is the same search with the sign flipped', () => {
  const n = 2000
  const freqs = new Float64Array(n)
  const env = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    freqs[i] = i * 10
    env[i] = -30
  }
  for (let i = 0; i < n; i++) {
    const f = freqs[i]
    if (f >= 1000 && f <= 2700) env[i] = -30 - 6 * Math.exp(-Math.pow((f - 1800) / 300, 2))
  }
  const base = estimateBaseline(freqs, env, 1200, 2500)
  const det = detectAnomaly(base.scanFreqs, base.scanEnv, base.baseline, 3.0, 'dip')

  assert.equal(det.detected, true)
  assert.ok(det.deviationDb < 0, 'a dip must report a negative deviation')
  assert.ok(Math.abs(det.centerHz - 1800) < 100, `centre was ${det.centerHz}`)
})

test('baseline is unavailable when there is no context on one side', () => {
  const freqs = new Float64Array(100)
  const env = new Float64Array(100)
  for (let i = 0; i < 100; i++) {
    freqs[i] = 200 + i // starts at the scan low edge, so no low context
    env[i] = -30
  }
  assert.equal(estimateBaseline(freqs, env, 200, 280), null)
})

// ── Merging ─────────────────────────────────────────────────────────────────

test('bands within a third of an octave merge and sum their gain', () => {
  const { bands, mergeCount } = mergeBands([
    { region: 'mud', centerHz: 300, gainDb: -3, q: 2, widthOctaves: 0.5, cutLimit: 6, boostLimit: 0 },
    { region: 'boxy_honky', centerHz: 330, gainDb: -2, q: 2, widthOctaves: 0.5, cutLimit: 5, boostLimit: 0 },
  ])
  assert.equal(mergeCount, 1)
  assert.equal(bands.length, 1)
  assert.ok(Math.abs(bands[0].centerHz - Math.sqrt(300 * 330)) < 1e-9)
  assert.equal(bands[0].gainDb, -5)
})

test('merging a boost-only with a cut-only band does not clamp to zero', () => {
  // The zero-limit trap the Python calls out: body_warmth carries cutLimit 0
  // and mud carries boostLimit 0, so a naive min() would clamp both directions
  // to zero and silently delete the correction.
  const { bands } = mergeBands([
    { region: 'body_warmth', centerHz: 260, gainDb: 3, q: 1.2, widthOctaves: 0.6, cutLimit: 0, boostLimit: 4 },
    { region: 'mud', centerHz: 280, gainDb: -1, q: 2, widthOctaves: 0.5, cutLimit: 6, boostLimit: 0 },
  ])
  assert.equal(bands.length, 1)
  assert.equal(bands[0].gainDb, 2, 'net correction was clamped away')
})

test('distant bands are left alone', () => {
  const { bands, mergeCount } = mergeBands([
    { region: 'mud', centerHz: 300, gainDb: -3, q: 2, widthOctaves: 0.5, cutLimit: 6, boostLimit: 0 },
    { region: 'brilliance', centerHz: 7000, gainDb: -2, q: 3, widthOctaves: 0.5, cutLimit: 4, boostLimit: 0 },
  ])
  assert.equal(mergeCount, 0)
  assert.equal(bands.length, 2)
})

// ── Frame collection ────────────────────────────────────────────────────────

test('voiced frames are found in pitched material and not in noise', () => {
  const voice = collectVoicedFrames(synthVoice({ seconds: 2 }), SR)
  assert.ok(
    voice.frames.length >= MIN_VOICED_FRAMES,
    `only ${voice.frames.length} voiced frames in 2 s of synthetic voice`,
  )

  const noiseResult = collectVoicedFrames(noise(SR * 2), SR)
  assert.ok(
    noiseResult.frames.length < MIN_VOICED_FRAMES,
    `white noise produced ${noiseResult.frames.length} "voiced" frames`,
  )
})

test('the energy gate does not eat continuous speech', () => {
  // A selection with no pauses: p10 is the quietest *speech*, not room tone, so
  // a plain floor + 8 dB gate would throw away most of the material. The gate
  // has to notice that and stand down.
  const n = SR * 2
  const sig = new Float32Array(n)
  const period = SR / 130
  for (let i = 0; i < n; i++) if (i % period < 1) sig[i] = 0.8

  const { frames } = collectVoicedFrames(sig, SR)
  assert.ok(
    frames.length >= MIN_VOICED_FRAMES,
    `gapless speech yielded only ${frames.length} voiced frames`,
  )
})

// ── End to end ──────────────────────────────────────────────────────────────

test('a planted resonance is detected in the right region', () => {
  // 300 Hz sits inside the male mud region (200-420) and outside every other.
  const audio = synthVoice({ f0: 120, seconds: 3, resonanceHz: 300, resonanceDb: 12 })
  const result = analyzeVoxDoc(audio, SR)

  assert.equal(result.ok, true, `analysis failed: ${result.reason}`)
  assert.equal(result.voiceType, 'male', `classified as ${result.voiceType}`)

  const mud = result.regionResults.find(r => r.name === 'mud')
  assert.equal(mud.detected, true, `mud peak deviation was ${mud.peakDeviationDb} dB`)
  assert.ok(
    Math.abs(mud.centerHz - 300) < 60,
    `detected at ${mud.centerHz} Hz, expected near 300`,
  )
  assert.ok(mud.gainDb < 0, 'a hump must produce a cut')
  assert.ok(mud.gainDb >= -6, 'gain must respect the region cut limit')
})

test('gain opposes the deviation and is capped by the region limits', () => {
  // The clamp lives in computeBandParams, so test it there rather than trying
  // to drive the envelope into it: cepstral liftering compresses hard — a 30 dB
  // resonance at Q 3 reaches the envelope as roughly 8 dB — so the caps are
  // rarely the binding constraint in practice. That is a property of the
  // method, on the server as much as here, not something to engineer around.
  const mudScale = 0.70
  const mudCut = 6.0
  const huge = computeBandParams(300, 20, 0.5, mudScale, 0.0, mudCut)
  assert.equal(huge.gainDb, -mudCut, 'cut limit not applied')

  const dip = computeBandParams(1800, -20, 0.5, 0.70, 4.0, 0.0)
  assert.equal(dip.gainDb, 4.0, 'boost limit not applied')

  const normal = computeBandParams(300, 5, 0.5, mudScale, 0.0, mudCut)
  assert.equal(normal.gainDb, -3.5, 'gain should be -deviation x scale')
})

test('a bigger resonance produces a bigger correction', () => {
  const gainFor = db => {
    const r = analyzeVoxDoc(
      synthVoice({ f0: 120, seconds: 3, resonanceHz: 300, resonanceDb: db }), SR,
    )
    return r.regionResults.find(x => x.name === 'mud').gainDb
  }
  const small = gainFor(12)
  const large = gainFor(30)
  assert.ok(large < small, `expected a deeper cut for a bigger resonance: ${large} vs ${small}`)
  assert.ok(large >= -6, 'gain must never exceed the mud cut limit')
})

test('a dead band is not mistaken for a deficiency', () => {
  // The synthetic voice has harmonics only to ~5 kHz and a steep cut above it,
  // so the air region contains numerical noise and nothing else. A dip detector
  // reads that as an enormous shortfall and asks for a boost — which would lift
  // hiss and nothing else. Any brick-walled file (low-bitrate MP3, a 10 kHz
  // phone recording) hits this in the real world.
  // Harmonics to 9 kHz: brilliance (5-9 kHz) has real, quiet content while air
  // (9-16 kHz) has none — so the guard has to separate two regions that are
  // both far below the envelope peak.
  const audio = synthVoice({ f0: 120, seconds: 3, bandwidthHz: 9000 })
  const result = analyzeVoxDoc(audio, SR)

  const air = result.regionResults.find(r => r.name === 'air')
  assert.equal(air.skipReason, 'no_energy', 'dead air region was assessed anyway')
  assert.equal(air.detected, false)
  assert.ok(
    !result.bands.some(b => b.region.includes('air')),
    'a band was produced for a region with no content',
  )
  // And nothing is handed to the display to draw from.
  assert.equal(air.scanEnv, undefined)

  // The guard must not touch regions that are merely quiet: brilliance sits far
  // below the peak but has real harmonic content.
  const brilliance = result.regionResults.find(r => r.name === 'brilliance')
  assert.notEqual(brilliance.skipReason, 'no_energy', 'real content was suppressed')
})

test('a female-pitched voice moves the scan ranges', () => {
  const audio = synthVoice({ f0: 220, seconds: 3 })
  const result = analyzeVoxDoc(audio, SR)
  assert.equal(result.ok, true)
  assert.equal(result.voiceType, 'female')
  const mud = result.regionResults.find(r => r.name === 'mud')
  assert.equal(mud.scanLowHz, FEMALE_REGIONS.mud[SCAN_LOW])
  assert.equal(mud.scanHighHz, FEMALE_REGIONS.mud[SCAN_HIGH])
})

test('material too short to analyse reports failure instead of a curve', () => {
  const audio = synthVoice({ f0: 120, seconds: 0.3 })
  const result = analyzeVoxDoc(audio, SR)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'insufficient_voiced')
  assert.equal(result.requiredFrames, MIN_VOICED_FRAMES)
})

test('material with no pitch at all is reported distinctly', () => {
  // The user needs "this is not speech" and "this is too short" to read
  // differently — they call for different next actions. The distinction is a
  // proportion, not a strict zero: the correlation gate finds a periodic
  // component in the odd noise frame by chance, and one lucky frame must not
  // turn "this is traffic rumble" into "select a longer stretch of it".
  for (const seed of [1, 2, 3, 12345, 0x9e3779b9]) {
    const result = analyzeVoxDoc(noise(SR * 2, seed), SR)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no_voiced_frames', `seed ${seed}`)
  }
})

test('short but genuine speech is reported as short, not as non-speech', () => {
  // The other side of the same distinction.
  const result = analyzeVoxDoc(synthVoice({ f0: 120, seconds: 0.35 }), SR)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'insufficient_voiced')
  assert.ok(result.voicedRatio > 0.1, `voiced ratio was ${result.voicedRatio}`)
})

test('suggestions carry the measured centre, gain and Q', () => {
  const audio = synthVoice({ f0: 120, seconds: 3, resonanceHz: 300, resonanceDb: 12 })
  const result = analyzeVoxDoc(audio, SR)
  const suggestions = buildSuggestions(result)

  assert.ok(suggestions.length > 0, 'a planted resonance produced no suggestion')
  const s = suggestions.find(x => x.region.startsWith('mud'))
  assert.ok(s, `no mud suggestion in ${suggestions.map(x => x.region).join(', ')}`)
  assert.equal(s.roleId, 'mud')
  assert.ok(s.symptom.includes('muddy'), `symptom read "${s.symptom}"`)
  assert.ok(s.gainDb < 0)
  assert.ok(s.q >= 0.8 && s.q <= 8, `Q ${s.q} outside the clamp`)
})

test('suggestions are empty when nothing is wrong', () => {
  assert.deepEqual(buildSuggestions({ ok: false, reason: 'insufficient_voiced' }), [])
})
