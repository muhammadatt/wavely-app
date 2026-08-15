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
  analyzeVoiceRx,
  collectVoicedFrames,
  detectAnomaly,
  estimateBaseline,
  hannSymmetric,
  mergeBands,
  percentile,
  qFromWidth,
  computeBandParams,
  scanRegions,
  correctedEnvelope,
  MIN_VOICED_FRAMES,
  MAX_TOTAL_CAP_FACTOR,
} from '../../src/audio/voicerx/analysis.js'
import {
  classifyVoice, MALE_REGIONS, FEMALE_REGIONS, SCAN_LOW, SCAN_HIGH, MAX_CUT_DB,
  REGION_ORDER, regionAtHz, THRESHOLD_DB,
} from '../../src/audio/voicerx/regions.js'
import { buildSuggestions, buildAdvisories } from '../../src/audio/voicerx/suggestions.js'
import { detectSpectralHoles, holeCoverage } from '../../src/audio/voicerx/holes.js'
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
  // A second, smaller resonance. Two humps rather than one is the only way to
  // exercise what iterating is actually for -- see the late-detection test.
  secondHz = null, secondDb = 8,
  notchHz = null, notchDb = 18, notchQ = 1.0,
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

  for (const [hz, db] of [[resonanceHz, resonanceDb], [secondHz, secondDb]]) {
    if (!hz) continue
    const res = new BiquadCascade(1, 1)
    res.setSection(0, peaking(SR, hz, 3.0, db, 'q'))
    res.process(sig, sig, n, 0)
  }

  // A hole: what a previously applied surgical EQ cut leaves in a file. Broad
  // and deep rather than narrow and deep, because that is the shape that
  // corrupts a context window — a notch narrower than the 0.4-octave window
  // moves its median hardly at all.
  if (notchHz) {
    const cut = new BiquadCascade(1, 1)
    cut.setSection(0, peaking(SR, notchHz, notchQ, -notchDb, 'q'))
    cut.process(sig, sig, n, 0)
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

// ── Frequency to region ─────────────────────────────────────────────────────

test('a frequency inside one region resolves to it', () => {
  for (const table of [MALE_REGIONS, FEMALE_REGIONS]) {
    for (const name of REGION_ORDER) {
      // The geometric centre is unambiguously inside, whatever the neighbours do.
      const centre = Math.sqrt(table[name][SCAN_LOW] * table[name][SCAN_HIGH])
      assert.equal(regionAtHz(table, centre), name, `${name} at its own centre`)
    }
  }
})

test('a gap in the table falls to its nearer neighbour, never to nothing', () => {
  // The female table leaves 130-180 Hz and 1400-1500 Hz uncovered. A click
  // there has to name a role or it does nothing at all, which reads as broken.
  for (const hz of [131, 155, 179, 1401, 1450, 1499]) {
    const region = regionAtHz(FEMALE_REGIONS, hz)
    assert.ok(region, `${hz} Hz resolved to nothing`)
    assert.ok(REGION_ORDER.includes(region))
  }
  assert.equal(regionAtHz(FEMALE_REGIONS, 131), 'sub_bass', 'just above sub_bass')
  assert.equal(regionAtHz(FEMALE_REGIONS, 179), 'body_warmth', 'just below body_warmth')
})

test('an overlap goes to whichever region holds the point more centrally', () => {
  // Female upper_presence (3-6k) and brilliance (5-9k) share a whole kilohertz.
  assert.equal(regionAtHz(FEMALE_REGIONS, 5100), 'upper_presence')
  assert.equal(regionAtHz(FEMALE_REGIONS, 5900), 'brilliance')
})

test('the ends of the axis resolve, and nonsense does not', () => {
  assert.equal(regionAtHz(MALE_REGIONS, 60), 'sub_bass')
  assert.equal(regionAtHz(MALE_REGIONS, 16000), 'air')
  // Beyond the tables it still names the nearest, so a click at the very edge
  // of the plot is never swallowed by rounding.
  assert.equal(regionAtHz(MALE_REGIONS, 59), 'sub_bass')
  assert.equal(regionAtHz(MALE_REGIONS, 16001), 'air')
  assert.equal(regionAtHz(MALE_REGIONS, 0), null)
  assert.equal(regionAtHz(MALE_REGIONS, NaN), null)
  assert.equal(regionAtHz(null, 300), null)
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

/**
 * 900 Hz sits inside the male nasal region (650-1200) and outside every other,
 * and it is clear of the synth's own -6 dB tilt at 500 Hz.
 *
 * These end-to-end tests used to plant at 300 Hz / mud. That stopped working
 * when the trend became the default baseline, and the reason is a real property
 * of the method rather than a bug: at 300 Hz on an F0 120 voice the defect sits
 * on the spectrum's own maximum, where a smooth local reference follows it and
 * almost nothing is left over. The 12 dB resonance that read well clear of
 * threshold against the chord reads 1.24 dB against the trend. The blind spot
 * is pinned explicitly below rather than hidden by moving these tests.
 */
const PROBE = { f0: 120, seconds: 3, resonanceHz: 900, resonanceDb: 12 }

test('a planted resonance is detected in the right region', () => {
  const audio = synthVoice(PROBE)
  const result = analyzeVoiceRx(audio, SR)

  assert.equal(result.ok, true, `analysis failed: ${result.reason}`)
  assert.equal(result.voiceType, 'male', `classified as ${result.voiceType}`)

  const nasal = result.regionResults.find(r => r.name === 'nasal')
  assert.equal(nasal.detected, true, `nasal peak deviation was ${nasal.peakDeviationDb} dB`)
  assert.ok(
    Math.abs(Math.log2(nasal.centerHz / 900)) < 0.3,
    `detected at ${nasal.centerHz} Hz, expected near 900`,
  )
  assert.ok(nasal.gainDb < 0, 'a hump must produce a cut')
  // The bound is the TOTAL cap. MAX_CUT_DB limits a single measurement; the
  // analysis takes several and MAX_TOTAL_CAP_FACTOR bounds their sum.
  const cap = MALE_REGIONS.nasal[MAX_CUT_DB] * MAX_TOTAL_CAP_FACTOR
  assert.ok(nasal.gainDb >= -cap, `gain ${nasal.gainDb} past the nasal total cap ${-cap}`)
})

test('a defect on the spectral maximum is near-invisible to the trend baseline', () => {
  // Not an aspiration — a measured limitation of the shipping detector, pinned
  // so that a change in it is noticed. A smooth local reference cannot separate
  // a broad hump from the peak it sits on, which is why the low-frequency
  // detection rate is what it is. The chord caught this case and paid for it
  // everywhere else: on 31 windows of finished masters it invents 89 bands to
  // the trend's 48.
  const audio = synthVoice({ f0: 120, seconds: 3, resonanceHz: 300, resonanceDb: 12 })

  const trend = analyzeVoiceRx(audio, SR, { baseline: 'trend' })
  const chord = analyzeVoiceRx(audio, SR)
  assert.ok(trend.ok && chord.ok)

  const mudOf = r => r.regionResults.find(x => x.name === 'mud')
  assert.equal(mudOf(chord).detected, true,
    'the shipping chord baseline should still see this; if not, the probe changed')
  assert.equal(mudOf(trend).detected, false,
    `the trend now detects mud at ${mudOf(trend).peakDeviationDb} dB — if this is a real `
    + 'improvement, re-record the scorecards and delete this test')
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
    const r = analyzeVoiceRx(synthVoice({ ...PROBE, resonanceDb: db }), SR)
    return r.regionResults.find(x => x.name === 'nasal').gainDb
  }
  // Both must stay clear of the cap or they saturate to the same number and the
  // comparison says nothing: at 900 Hz the nasal total cap of 5 dB is reached
  // by about a 12 dB resonance.
  const small = gainFor(6)
  const large = gainFor(8)
  assert.ok(large < small, `expected a deeper cut for a bigger resonance: ${large} vs ${small}`)

  // The bound is the TOTAL cap, not the per-pass one. MAX_CUT_DB limits what a
  // single measurement may spend; the analysis takes up to MAX_CORRECTION_PASSES
  // of those, and MAX_TOTAL_CAP_FACTOR bounds the sum. Asserting -6 here would
  // be asserting that iterating never happens.
  const totalLimit = MALE_REGIONS.nasal[MAX_CUT_DB] * MAX_TOTAL_CAP_FACTOR
  assert.ok(large >= -totalLimit, `gain must never exceed the nasal total cap: ${large}`)
})

test('iterating surfaces a region that the first pass could not measure', () => {
  // THIS is what iterating is for, and it is the whole reason
  // MAX_CORRECTION_PASSES is 2 rather than 1. With MAX_TOTAL_CAP_FACTOR at 1 a
  // region reaches its cap on the pass that finds it and can never gain more,
  // so a later pass cannot inflate an existing correction -- it can only find
  // something that was not measurable before.
  //
  // A smaller hump next to a larger one is exactly that case: the big one at
  // 900 Hz lifts the context window boxy_honky is measured against, so 550 Hz
  // reads as ordinary until the 900 Hz correction brings its neighbour down.
  // The same thing happens on real audio -- on the reference clip the mud band
  // appears only on the second pass, after the boxy hump above it is cut.
  const r = analyzeVoiceRx(synthVoice({
    f0: 120, seconds: 3, resonanceHz: 900, resonanceDb: 10, secondHz: 550, secondDb: 8,
  }), SR)
  assert.ok(r.ok)

  const boxy = r.regionResults.find(x => x.name === 'boxy_honky')
  assert.equal(boxy.detected, true, 'the smaller neighbouring hump was never found')
  assert.ok(boxy.detectedOnPass > 1,
    `boxy_honky was found on pass ${boxy.detectedOnPass}; the probe no longer needs iterating`)
  assert.ok(r.passes > 1, 'the analysis settled in one pass; nothing was iterated')
})

test('one analysis settles what repeated analysis used to', () => {
  // The symptom this exists to stop: apply the corrections, analyse the result,
  // and be told there is still work to do. A single pass leaves 30% of every
  // deviation standing by construction (SCALE is 0.70), so anything much over
  // threshold reported again the moment anyone looked.
  const r = analyzeVoiceRx(synthVoice(PROBE), SR)
  assert.ok(r.ok)

  // Apply what it recommends to the envelope it measured, then measure again.
  // This is exactly what the user was doing by hand.
  const after = correctedEnvelope(SR, r.freqsHz, r.envelopeDb, r.bands.map(b => ({
    region: b.region, centerHz: b.freqHz, q: b.q, gainDb: b.gainDb,
  })))
  let peakDb = -Infinity
  for (let k = 0; k < r.freqsHz.length; k++) {
    if (r.freqsHz[k] >= 100 && r.freqsHz[k] <= 16000) {
      peakDb = Math.max(peakDb, r.envelopeDb[k])
    }
  }
  const again = scanRegions(r.freqsHz, after, r.regions, peakDb)
  const before = r.regionResults.find(x => x.name === 'nasal').peakDeviationDb
  const nasal = again.regionResults.find(x => x.name === 'nasal')

  // MOST of it must be gone, not all of it. Requiring it to fall under
  // threshold would be requiring the cap not to work: MAX_TOTAL_CAP_FACTOR is
  // 1, so nasal will never spend more than its 5 dB however large the defect,
  // and stopping short while staying flagged is the deliberate behaviour the
  // next test asserts.
  assert.ok(nasal.peakDeviationDb < before * 0.6,
    `nasal went ${before} -> ${nasal.peakDeviationDb} dB; one analysis barely moved it`)
})


test('iterating never spends more than the total cap', () => {
  // A resonance far past anything the caps can resolve must stop short and stay
  // flagged rather than earning a surgical cut nobody measured carefully.
  const r = analyzeVoiceRx(synthVoice({ ...PROBE, resonanceDb: 40 }), SR)
  // mud carries the largest cut limit of any region, so it bounds every band
  // here whatever region they land in. Assert the loop runs at all: planting a
  // defect the detector cannot see would make this pass vacuously.
  const totalLimit = MALE_REGIONS.mud[MAX_CUT_DB] * MAX_TOTAL_CAP_FACTOR
  assert.ok(r.bands.length > 0, 'a 40 dB resonance produced no bands to cap')
  for (const band of r.bands) {
    assert.ok(
      Math.abs(band.gainDb) <= totalLimit + 0.01,
      `${band.region} spent ${band.gainDb} dB, past the ${totalLimit} dB total cap`,
    )
  }
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
  const result = analyzeVoiceRx(audio, SR)

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

// ── Spectral holes ──────────────────────────────────────────────────────────

/** A log-spaced envelope, for the hole detector's own unit tests. */
function envelopeFrom(fn, { bins = 2048, sr = SR } = {}) {
  const freqs = new Float64Array(bins)
  const env = new Float64Array(bins)
  for (let k = 0; k < bins; k++) {
    freqs[k] = (k * sr) / (2 * (bins - 1))
    env[k] = fn(Math.max(freqs[k], 1))
  }
  return { freqs, env }
}

test('a steep slope is not a hole, at any steepness', () => {
  // The property the whole detector rests on. A voice envelope falls tens of dB
  // across this range, and every smoothing-based reference — running median,
  // high percentile — is biased upward on a slope in proportion to the slope,
  // so it reports a deficit down the entire descent. Closing is exactly zero on
  // a monotone signal regardless of gradient.
  for (const perOctave of [3, 12, 40]) {
    const { freqs, env } = envelopeFrom(f => -perOctave * Math.log2(f / 100))
    const holes = detectSpectralHoles(freqs, env, -Infinity, 60, 16000)
    assert.deepEqual(holes, [], `a ${perOctave} dB/octave slope was read as a hole`)
  }
})

test('a planted notch is found, with its floor and its shoulders', () => {
  const { freqs, env } = envelopeFrom((f) => {
    const octavesFromNotch = Math.log2(f / 5000)
    return -20 * Math.exp(-(octavesFromNotch ** 2) / (2 * 0.25 ** 2))
  })
  const holes = detectSpectralHoles(freqs, env, -Infinity, 60, 16000)

  assert.equal(holes.length, 1)
  const [hole] = holes
  assert.ok(Math.abs(hole.centerHz - 5000) < 250, `floor at ${hole.centerHz}`)
  assert.ok(Math.abs(hole.depthDb - 20) < 1.5, `depth ${hole.depthDb}`)
  // Shoulder to shoulder, so the span reaches out to where the envelope has
  // recovered — not the half-depth points, which would leave the notch's own
  // flanks inside the neighbouring regions' context windows.
  assert.ok(hole.lowHz < 3600 && hole.highHz > 6900, `span ${hole.lowHz}-${hole.highHz}`)
})

test('a brick wall is an edge, not a hole', () => {
  // A lowpassed file falls off a cliff and never comes back. Taking the maximum
  // across the whole window rather than the lower of the two shoulders reads
  // that fall as a vast deficit and plants a hole on the cutoff.
  const { freqs, env } = envelopeFrom(f => (f < 10000 ? 0 : -80))
  assert.deepEqual(detectSpectralHoles(freqs, env, -60, 60, 16000), [])
})

test('a shallow ripple between formants is not a hole', () => {
  // +/-2.5 dB, so 5 dB peak to trough — under MIN_DEPTH_DB. This is the natural
  // corrugation of a formant envelope, and reading it as a series of holes
  // would mask out most of the spectrum on every file.
  const { freqs, env } = envelopeFrom(f => 2.5 * Math.sin(2 * Math.PI * Math.log2(f)))
  assert.deepEqual(detectSpectralHoles(freqs, env, -Infinity, 60, 16000), [])
})

test('coverage is measured in octaves, not hertz', () => {
  const holes = [{ centerHz: 4500, depthDb: 18, lowHz: 4000, highHz: 5000 }]
  // 4-5 kHz is a third of an octave inside 2.5-5 kHz, which is one octave wide.
  assert.ok(Math.abs(holeCoverage(holes, 2500, 5000) - Math.log2(5 / 4)) < 1e-9)
  assert.equal(holeCoverage(holes, 200, 400), 0)
  assert.equal(holeCoverage([], 2500, 5000), 0)
})

test('an anchor inside a hole is replaced, not used', () => {
  // Flat spectrum with a notch sitting exactly in the region's upper context
  // window. Un-repaired, the anchor drops into the notch and the chord tips,
  // which is the whole bug: an ordinary flat region reports a large hump.
  const { freqs, env } = envelopeFrom(f => (f > 5000 && f < 6600 ? -48 : -30))
  const hole = [{ centerHz: 5700, depthDb: 18, lowHz: 5000, highHz: 6600 }]

  const naive = estimateBaseline(freqs, env, 2500, 5000, -Infinity, [])
  const naiveDev = detectAnomaly(naive.scanFreqs, naive.scanEnv, naive.baseline, 2.5, 'hump')
  assert.ok(naiveDev.detected, 'the bug is not reproduced, so the fix proves nothing')

  const repaired = estimateBaseline(freqs, env, 2500, 5000, -Infinity, hole)
  const dev = detectAnomaly(
    repaired.scanFreqs, repaired.scanEnv, repaired.baseline, 2.5, 'hump', repaired.usable,
  )
  assert.equal(dev.detected, false, 'a flat region still read as a hump')
  assert.ok(Math.abs(dev.peakDeviationDb) < 0.5)
})

test('a context window that needs no repair is not widened', () => {
  // sub_bass's low context holds two bins at 48 kHz and 4096-point transforms.
  // A rule that widened whenever a window held fewer than three would reach
  // down into DC rumble on every file analysed, to fix a problem none of them
  // have — so widening happens only once exclusions have removed something.
  const freqs = new Float64Array(64)
  const env = new Float64Array(64)
  for (let k = 0; k < 64; k++) {
    freqs[k] = k * 11.72
    env[k] = freqs[k] < 45 ? -60 : -30
  }
  const base = estimateBaseline(freqs, env, 60, 130, -Infinity, [])
  assert.ok(base, 'a two-bin context window was rejected')
  // Anchored on the two clean bins at 46.9 and 58.6 Hz, not on the -60 dB
  // material below 45 Hz that widening would have pulled in.
  assert.ok(Math.abs(base.baseline[0] - -30) < 0.01, `anchored at ${base.baseline[0]}`)
})

test('a notch does not produce phantom cuts on either side of itself', () => {
  // The failure this whole mechanism exists for. One hole between two scan
  // regions corrupts BOTH — the region below anchors its top in the notch, the
  // region above anchors its bottom in the same notch — so a single 18 dB dip
  // at 5 kHz produces a matched pair of large, confident cuts in upper_presence
  // and brilliance, neither of which needs cutting.
  const clean = analyzeVoiceRx(synthVoice({ f0: 120, seconds: 3, bandwidthHz: 12000 }), SR)
  const notched = analyzeVoiceRx(
    synthVoice({ f0: 120, seconds: 3, bandwidthHz: 12000, notchHz: 5000, notchDb: 18 }), SR,
  )

  assert.equal(notched.ok, true)
  assert.equal(notched.holes.length, 1, 'the notch was not found')
  assert.ok(Math.abs(notched.holes[0].centerHz - 5000) < 600)

  // Neither region either side of the hole may emit a correction.
  for (const name of ['upper_presence', 'brilliance']) {
    const region = notched.regionResults.find(r => r.name === name)
    assert.equal(region.skipReason, 'spectral_hole', `${name} was assessed across a notch`)
    assert.equal(region.detected, false)
    assert.ok(
      !notched.bands.some(b => b.region.includes(name)),
      `${name} produced a band despite sitting across a hole`,
    )
  }

  // And the guard is specific to the hole: the clean control is untouched by
  // any of this, so nothing here is suppressing detections in general.
  assert.deepEqual(clean.holes, [])
  for (const name of ['upper_presence', 'brilliance']) {
    assert.notEqual(
      clean.regionResults.find(r => r.name === name).skipReason,
      'spectral_hole',
    )
  }
})

test('regions away from a notch are unaffected by it', () => {
  // Plant a resonance at 700 Hz (boxy_honky) and a notch at 5 kHz.
  // The notch suppresses upper_presence/brilliance but must not touch boxy_honky.
  const planted = synthVoice({
    f0: 120, seconds: 3, bandwidthHz: 12000, resonanceHz: 700, resonanceDb: 12,
    notchHz: 5000, notchDb: 18,
  })
  const result = analyzeVoiceRx(planted, SR)
  assert.equal(result.holes.length, 1, 'the notch was not detected')
  const boxy = result.regionResults.find(r => r.name === 'boxy_honky')
  assert.equal(boxy.detected, true, 'a planted resonance far from the notch went unfound')
  assert.notEqual(boxy.skipReason, 'spectral_hole', 'boxy_honky was incorrectly suppressed by a distant notch')
  assert.ok(boxy.gainDb < 0)
})

test('a hole is reported to the user, and no correction is offered for it', () => {
  const notched = analyzeVoiceRx(
    synthVoice({ f0: 120, seconds: 3, bandwidthHz: 12000, notchHz: 5000, notchDb: 18 }), SR,
  )
  const advisories = buildAdvisories(notched)
  assert.equal(advisories.length, 1)

  const [adv] = advisories
  assert.match(adv.title, /notch/i)
  assert.match(adv.title, /5\.\d kHz/, `title did not name the frequency: ${adv.title}`)
  // It has to name what it cost the user, in the words on the control surface.
  assert.match(adv.detail, /Presence/)
  assert.match(adv.detail, /Sibilance/)

  // An advisory is not a suggestion: nothing in the correction list refers to
  // it, because there is no band behind it and no button that could apply one.
  assert.ok(!buildSuggestions(notched).some(s => /notch/i.test(s.symptom)))
  assert.deepEqual(buildAdvisories({ ok: true, holes: [], regionResults: [] }), [])
})

test('a female-pitched voice moves the scan ranges', () => {
  const audio = synthVoice({ f0: 220, seconds: 3 })
  const result = analyzeVoiceRx(audio, SR)
  assert.equal(result.ok, true)
  assert.equal(result.voiceType, 'female')
  const mud = result.regionResults.find(r => r.name === 'mud')
  assert.equal(mud.scanLowHz, FEMALE_REGIONS.mud[SCAN_LOW])
  assert.equal(mud.scanHighHz, FEMALE_REGIONS.mud[SCAN_HIGH])
})

test('material too short to analyse reports failure instead of a curve', () => {
  const audio = synthVoice({ f0: 120, seconds: 0.3 })
  const result = analyzeVoiceRx(audio, SR)
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
    const result = analyzeVoiceRx(noise(SR * 2, seed), SR)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no_voiced_frames', `seed ${seed}`)
  }
})

test('short but genuine speech is reported as short, not as non-speech', () => {
  // The other side of the same distinction.
  const result = analyzeVoiceRx(synthVoice({ f0: 120, seconds: 0.35 }), SR)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'insufficient_voiced')
  assert.ok(result.voicedRatio > 0.1, `voiced ratio was ${result.voicedRatio}`)
})

test('suggestions carry the measured centre, gain and Q', () => {
  const result = analyzeVoiceRx(synthVoice(PROBE), SR)
  const suggestions = buildSuggestions(result)

  assert.ok(suggestions.length > 0, 'a planted resonance produced no suggestion')
  const s = suggestions.find(x => x.region.startsWith('nasal'))
  assert.ok(s, `no nasal suggestion in ${suggestions.map(x => x.region).join(', ')}`)
  assert.equal(s.roleId, 'nasal')
  assert.ok(s.symptom.includes('pinched'), `symptom read "${s.symptom}"`)
  assert.ok(s.gainDb < 0)
  assert.ok(s.q >= 0.8 && s.q <= 8, `Q ${s.q} outside the clamp`)
})

test('suggestions are empty when nothing is wrong', () => {
  assert.deepEqual(buildSuggestions({ ok: false, reason: 'insufficient_voiced' }), [])
})

test('thresholdScale changes what is detected without touching the shared tables', () => {
  // A resonance planted just under the shipping threshold: invisible at 1.0,
  // found once the threshold is scaled down. If this ever stops discriminating,
  // the probe has drifted rather than the feature having broken.
  const audio = synthVoice({ f0: 120, seconds: 3, resonanceHz: 900, resonanceDb: 4 })
  const nasalOf = r => r.regionResults.find(x => x.name === 'nasal')

  const shipping = analyzeVoiceRx(audio, SR)
  const lowered = analyzeVoiceRx(audio, SR, { thresholdScale: 0.6 })
  assert.equal(nasalOf(shipping).detected, false,
    `probe is above the shipping threshold at ${nasalOf(shipping).peakDeviationDb} dB`)
  assert.equal(nasalOf(lowered).detected, true,
    `still missed at x0.6, ${nasalOf(lowered).peakDeviationDb} dB`)

  // The region tables are module-level objects shared with the plot, the role
  // clamps and both detectors. Scaling them in place would change every other
  // caller's idea of a threshold, silently and for the rest of the session.
  assert.equal(MALE_REGIONS.nasal[THRESHOLD_DB], 2.5, 'the shared table was mutated')
  assert.equal(nasalOf(analyzeVoiceRx(audio, SR)).detected, false,
    'a scaled analysis leaked into the next unscaled one')
})
