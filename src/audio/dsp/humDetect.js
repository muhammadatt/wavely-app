/**
 * Mains hum detection.
 *
 * Direct port of `analyzeHum` from server/pipeline/humEQ.js, which was already
 * pure JavaScript — only the audio source changes, from an FFmpeg pipe to an
 * AudioBuffer. Runs in a Worker (src/workers/humWorker.js); the FFT is large
 * enough to block a frame or two on the main thread.
 *
 * Method: one very large FFT over the first few seconds, then a two-pass
 * anchored coherence test across the harmonic series.
 *
 * The detector anchors on the SECOND harmonic (120 Hz for 60 Hz mains, 100 Hz
 * for 50 Hz) rather than the fundamental, because user-applied high-pass
 * filters routinely suppress 60 Hz while leaving 120 Hz untouched — and
 * 120 Hz hum from transformer cores and magnetic coupling is in practice more
 * common on modern gear than pure 60 Hz.
 *
 * The anchored coherence test is only the FIRST line of defence against
 * mistaking wanted content for hum, and it has a known blind spot: any sustained
 * pitched source whose fundamental sits near the mains frequency or one of its
 * harmonics puts real energy exactly on the grid being tested. A 120 Hz source
 * is indistinguishable from 60 Hz hum by spectrum shape alone — its harmonics
 * land on 120, 240, 360.
 *
 * The server closes that hole with an F0 veto (stages.js:481) that drops any
 * candidate overlapping the speaker's voiced pitch, using an F0 contour and
 * Silero VAD labels. The same check runs here against F0Tracker, with an energy
 * gate standing in for Silero.
 *
 * TWO DELIBERATE DIFFERENCES from the server:
 *
 *   - The server discards the candidate silently. This reports
 *     `matchesPitchedSource` and leaves the row visible and tickable, so a
 *     narrator who really does sit on 120 Hz can hear the difference in preview
 *     and decide.
 *   - The server could assume speech. This effect is pointed at whatever the
 *     user loaded, so the check is described in terms of a *pitched source*
 *     rather than a speaker. The mechanism is identical — an F0 contour with a
 *     concentration test — but a bass guitar, a sustained synth or a hummed note
 *     trip it exactly as a voice does, and calling that "the speaker" in the UI
 *     would be wrong.
 */

import { getFFT } from './fft.js'
import { F0Tracker } from './f0.js'

/** Analysis window. Hum is stationary, so a few seconds is plenty. */
export const MAX_ANALYSIS_SECONDS = 10

/**
 * Below this the FFT's effective resolution is coarser than the ±5 Hz
 * exclusion zone the floor estimate relies on, and detection is unreliable
 * regardless of how much the input is zero-padded.
 */
export const MIN_ANALYSIS_SECONDS = 1.0

/** 2^19 — about 0.084 Hz per bin at 44.1 kHz. Matches the server. */
export const FFT_SIZE = 524288

export const HUM_DETECT_DEFAULTS = {
  fundamental: 60,
  harmonics: [1, 2, 3, 4, 5],
  detectionThreshold: 8,
  minHarmonicsToTrigger: 2,
  analysisWindow: 50, // ± Hz for the floor estimate
  excludeHz: 5, // ± Hz excluded from the floor around the target
  peakHalfWidthHz: 2,
  minAbsoluteLevel: -80,
  anchorMultiplier: 2,
  anchorMinDeltaDb: 6,
  coherenceSlackDb: 3,
  strictSlackDb: { 3: 1 },
  pitchSourceCheck: true,
}

/**
 * Frequencies where a flagged harmonic could plausibly be the fundamental of a
 * wanted pitched source rather than hum. Only used to decide whether the F0
 * check is worth running for a given harmonic; the verdict comes from the
 * measured pitch. Spans speech but is not limited to it — a bass, a cello and a
 * held synth note all live in here.
 */
const PITCHED_F0_RANGE_HZ = [80, 300]

// F0 veto tolerance and minimum evidence, matching F0_VETO_* in
// server/pipeline/stages.js.
const F0_VETO_HALF_WIDTH_HZ = 15
const F0_VETO_MIN_FRAMES = 10

/**
 * Fraction of pitched frames that must cluster around the median pitch before
 * the pitch estimate is trusted at all.
 *
 * The server tests each candidate against the raw F0 histogram, which is safe
 * there because Silero has already excluded frames that are not speech. Without
 * Silero the tracker also runs on hum-only frames, and hum is periodic — an
 * autocorrelation tracker happily locks onto multiples of 60 Hz. Measured on a
 * pure 60 Hz hum series it yields scattered estimates spread across 60–330 Hz
 * with a concentration around 0.07, where a real sustained source sits at 1.0.
 * Requiring concentration is what separates "something pitched is present" from
 * "the tracker is chasing the hum", and without it a genuine hum harmonic gets
 * vetoed.
 */
const PITCH_CONCENTRATION_MIN = 0.5

/**
 * A candidate is also treated as wanted content when it lands on a harmonic of
 * the measured pitch — a 120 Hz source puts real energy on 240 Hz too, and
 * notching that thins the recording just as badly as notching the fundamental.
 */
const MAX_TRACKED_HARMONIC = 3

/** Pitch jitter multiplies up the harmonic series, so the window widens. */
function pitchToleranceHz(harmonic) {
  return Math.min(harmonic * F0_VETO_HALF_WIDTH_HZ, 40)
}

// STFT geometry for the pitch pass — the grid estimate_f0_contour.py uses.
const F0_FRAME_SIZE = 2048
const F0_HOP = 512

/** Frames must clear the noise floor by this much to count. */
const ACTIVITY_GATE_DB = 8

/**
 * Per-frame F0 over the analysis window, with an energy gate standing in for
 * Silero. Returns the median pitch of whatever sustained source is present and
 * how tightly the estimates cluster around it — see PITCH_CONCENTRATION_MIN for
 * why the second number matters.
 */
function measurePitchedSource(samples, sampleRate) {
  const none = { pitchHz: null, concentration: 0, pitchedFrames: 0 }
  const nFrames = Math.floor((samples.length - F0_FRAME_SIZE) / F0_HOP) + 1
  if (nFrames < 1) return none

  // Frame energies first, so the gate has a noise floor to work from.
  const frameDb = new Float64Array(nFrames)
  for (let f = 0; f < nFrames; f++) {
    const off = f * F0_HOP
    let sumSq = 0
    for (let i = 0; i < F0_FRAME_SIZE; i++) {
      const x = samples[off + i]
      sumSq += x * x
    }
    frameDb[f] = 10 * Math.log10(sumSq / F0_FRAME_SIZE + 1e-20)
  }
  const sorted = Array.from(frameDb).sort((a, b) => a - b)
  const p10 = sorted[Math.floor(sorted.length * 0.1)]
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  // `p10 + 8` is the speech gate reference_eq.py uses, and it is right for
  // material with real dynamic range. It collapses on steady content, though —
  // when every frame sits at the same level the 10th percentile IS that level,
  // so nothing clears the gate and the pitch pass sees no usable frames at all.
  // Falling back to just under the loud end keeps steady material analysable.
  const gateDb = Math.min(p10 + ACTIVITY_GATE_DB, p95 - 3)

  const tracker = new F0Tracker({ sampleRate, frameSize: F0_FRAME_SIZE })
  const frame = new Float64Array(F0_FRAME_SIZE)
  const pitches = []
  for (let f = 0; f < nFrames; f++) {
    const off = f * F0_HOP
    for (let i = 0; i < F0_FRAME_SIZE; i++) frame[i] = samples[off + i]
    const { f0, pitched } = tracker.estimate(frame, frameDb[f] > gateDb)
    if (pitched) pitches.push(f0)
  }
  if (pitches.length < F0_VETO_MIN_FRAMES) return none

  pitches.sort((a, b) => a - b)
  const mid = pitches.length >> 1
  const pitchHz = pitches.length % 2
    ? pitches[mid]
    : 0.5 * (pitches[mid - 1] + pitches[mid])

  let near = 0
  for (const p of pitches) {
    if (Math.abs(p - pitchHz) <= F0_VETO_HALF_WIDTH_HZ) near++
  }

  return {
    pitchHz,
    concentration: near / pitches.length,
    pitchedFrames: pitches.length,
  }
}

/**
 * Is this frequency the measured pitch, or a harmonic of it?
 * Returns the matching harmonic number, or 0 for no match.
 */
function pitchHarmonicOf(frequency, pitchHz) {
  for (let h = 1; h <= MAX_TRACKED_HARMONIC; h++) {
    if (Math.abs(frequency - h * pitchHz) <= pitchToleranceHz(h)) return h
  }
  return 0
}

function round2(n) {
  return n === null || n === undefined || !Number.isFinite(n)
    ? null
    : Math.round(n * 100) / 100
}

function freqToIndex(freq, sampleRate, fftSize) {
  return Math.round((freq * fftSize) / sampleRate)
}

/**
 * Hann-windowed magnitude spectrum in dBFS.
 *
 * Scaling matches the server exactly (magnitude divided by fftSize, floor at
 * -300 dB) because `minAbsoluteLevel` is an absolute threshold — a different
 * normalisation would silently move the detection bar.
 */
function computeMagnitudeSpectrum(samples, fftSize, fft) {
  const windowed = new Float64Array(fftSize)
  const n = Math.min(samples.length, fftSize)
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
    windowed[i] = samples[i] * w
  }

  const bins = (fftSize >>> 1) + 1
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(windowed, re, im)

  const halfSize = fftSize >>> 1
  const magnitudeDb = new Float64Array(halfSize)
  for (let k = 0; k < halfSize; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / fftSize
    magnitudeDb[k] = mag > 0 ? 20 * Math.log10(mag) : -300
  }
  return magnitudeDb
}

/** Peak magnitude within ±halfWidthHz of centerHz. */
function getPeakInBand(magnitudeDb, centerHz, halfWidthHz, sampleRate, fftSize) {
  const freqRes = sampleRate / fftSize
  const center = freqToIndex(centerHz, sampleRate, fftSize)
  const halfBins = Math.ceil(halfWidthHz / freqRes)
  const lo = Math.max(0, center - halfBins)
  const hi = Math.min(magnitudeDb.length - 1, center + halfBins)

  let peak = -Infinity
  for (let i = lo; i <= hi; i++) {
    if (magnitudeDb[i] > peak) peak = magnitudeDb[i]
  }
  return peak
}

/**
 * Median magnitude in a ±windowHz band, excluding ±excludeHz at the target.
 * Median rather than mean so other tonal content in the window cannot drag the
 * floor estimate up and mask a real peak.
 */
function getMedianFloor(magnitudeDb, centerHz, windowHz, excludeHz, sampleRate, fftSize) {
  const freqRes = sampleRate / fftSize
  const center = freqToIndex(centerHz, sampleRate, fftSize)
  const windowBins = Math.ceil(windowHz / freqRes)
  const excludeBins = Math.ceil(excludeHz / freqRes)
  const lo = Math.max(0, center - windowBins)
  const hi = Math.min(magnitudeDb.length - 1, center + windowBins)

  const values = []
  for (let i = lo; i <= hi; i++) {
    if (Math.abs(i - center) > excludeBins) values.push(magnitudeDb[i])
  }
  if (values.length === 0) return -Infinity

  values.sort((a, b) => a - b)
  const mid = values.length >> 1
  return values.length % 2 === 0
    ? (values[mid - 1] + values[mid]) / 2
    : values[mid]
}

/**
 * Detect mains hum in a mono sample buffer.
 *
 * @param {Float32Array|Float64Array} samples mono; only the first
 *   MAX_ANALYSIS_SECONDS are examined
 * @param {number} sampleRate
 * @param {Partial<typeof HUM_DETECT_DEFAULTS>} [options]
 * @returns {{
 *   triggered: boolean,
 *   tooShort: boolean,
 *   analyzedSeconds: number,
 *   anchorFrequency: number,
 *   anchorDeltaDb: number|null,
 *   flaggedHarmonics: number[],
 *   detectionDetail: Array<{
 *     frequency: number, multiplier: number, peakDb: number|null,
 *     floorDb: number|null, deltaDb: number|null, flagged: boolean,
 *     rejectionReason: string|null, inPitchRange: boolean,
 *   }>,
 * }}
 */
export function detectHum(samples, sampleRate, options = {}) {
  const opts = { ...HUM_DETECT_DEFAULTS, ...options }
  const {
    fundamental, harmonics, detectionThreshold, minHarmonicsToTrigger,
    analysisWindow, excludeHz, peakHalfWidthHz, minAbsoluteLevel,
    anchorMultiplier, anchorMinDeltaDb, coherenceSlackDb, strictSlackDb,
  } = opts

  const anchorFrequency = fundamental * anchorMultiplier
  if (!harmonics.includes(anchorMultiplier)) {
    throw new Error(
      `anchorMultiplier (${anchorMultiplier}) must be in the harmonics list`,
    )
  }

  const maxSamples = Math.min(samples.length, MAX_ANALYSIS_SECONDS * sampleRate)
  const analyzedSeconds = maxSamples / sampleRate
  const empty = {
    triggered: false,
    tooShort: true,
    analyzedSeconds,
    anchorFrequency,
    anchorDeltaDb: null,
    flaggedHarmonics: [],
    detectionDetail: harmonics.map(multiplier => ({
      frequency: fundamental * multiplier,
      multiplier,
      peakDb: null,
      floorDb: null,
      deltaDb: null,
      flagged: false,
      rejectionReason: 'selection-too-short',
      inPitchRange: false,
      matchesPitchedSource: false,
      pitchOverlapFraction: 0,
    })),
  }
  if (analyzedSeconds < MIN_ANALYSIS_SECONDS) return empty

  const view = samples.subarray(0, maxSamples)
  const fft = getFFT(FFT_SIZE)
  const magnitudeDb = computeMagnitudeSpectrum(view, FFT_SIZE, fft)

  // Second line of defence, only worth the pitch pass if some candidate could
  // plausibly be the fundamental of a wanted pitched source.
  const anyInPitchRange = harmonics.some(m => {
    const f = fundamental * m
    return f >= PITCHED_F0_RANGE_HZ[0] && f <= PITCHED_F0_RANGE_HZ[1]
  })
  const source =
    opts.pitchSourceCheck && anyInPitchRange
      ? measurePitchedSource(view, sampleRate)
      : { pitchHz: null, concentration: 0, pitchedFrames: 0 }
  // Only trust the pitch when the estimates actually cluster; a scattered
  // contour means the tracker was chasing the hum, not following a real source.
  const pitchTrusted =
    source.pitchHz !== null && source.concentration >= PITCH_CONCENTRATION_MIN

  // First pass: measure every harmonic, flag nothing yet.
  const measurements = harmonics.map(multiplier => {
    const frequency = fundamental * multiplier
    const peakDb = getPeakInBand(magnitudeDb, frequency, peakHalfWidthHz, sampleRate, FFT_SIZE)
    const floorDb = getMedianFloor(
      magnitudeDb, frequency, analysisWindow, excludeHz, sampleRate, FFT_SIZE,
    )
    return { multiplier, frequency, peakDb, floorDb, deltaDb: peakDb - floorDb }
  })

  const anchor = measurements.find(m => m.multiplier === anchorMultiplier)
  const anchorDelta = anchor.deltaDb
  const anchorPasses = anchorDelta >= anchorMinDeltaDb

  // Second pass: coherence rules.
  const detectionDetail = []
  const flaggedHarmonics = []

  for (const m of measurements) {
    const { multiplier, frequency, peakDb, floorDb, deltaDb } = m

    let flagged = false
    let rejectionReason = null

    if (!anchorPasses) {
      rejectionReason = 'anchor-failed'
    } else if (peakDb < minAbsoluteLevel) {
      rejectionReason = 'below-absolute-floor'
    } else if (multiplier === anchorMultiplier) {
      // Anchor coherence IS the bar for the anchor itself, so deltas between
      // anchorMinDeltaDb and detectionThreshold still count toward the trigger.
      flagged = true
    } else if (deltaDb < detectionThreshold) {
      rejectionReason = 'below-threshold'
    } else if (multiplier === 1) {
      // Fundamental: no upper bound against the anchor. High-pass filters push
      // it arbitrarily low, and an unfiltered one can sit above the anchor.
      flagged = true
    } else {
      const slack = strictSlackDb[multiplier] ?? coherenceSlackDb
      if (deltaDb <= anchorDelta + slack) flagged = true
      else rejectionReason = 'anchor-coherence'
    }

    const inPitchRange =
      frequency >= PITCHED_F0_RANGE_HZ[0] && frequency <= PITCHED_F0_RANGE_HZ[1]
    const pitchHarmonic = pitchTrusted
      ? pitchHarmonicOf(frequency, source.pitchHz)
      : 0

    detectionDetail.push({
      frequency,
      multiplier,
      peakDb: round2(peakDb),
      floorDb: round2(floorDb),
      deltaDb: round2(deltaDb),
      flagged,
      rejectionReason,
      inPitchRange,
      pitchHarmonic,
      // Filled in below, once the whole flagged set can be weighed.
      matchesPitchedSource: false,
    })

    if (flagged) flaggedHarmonics.push(frequency)
  }

  // Weigh the two explanations for the flagged set before vetoing anything.
  //
  // A pitch match on its own is not enough. Hum whose fundamental has been
  // high-passed away — energy at 120, 180 and 240 — has a true period of 60 Hz,
  // below the tracker's floor, so it locks onto 120 Hz with a rock-steady
  // contour and looks exactly like a real 120 Hz source. What separates them is
  // 180 Hz: it sits on the mains grid but is nowhere in a 120 Hz harmonic
  // series. So the pitched-source hypothesis only wins when it accounts for
  // EVERY flagged harmonic; a single one off the series means the mains grid is
  // the better explanation and nothing is vetoed.
  //
  // When both are genuinely present — a 120 Hz voice or bass over real 60 Hz
  // hum — the grid wins and the shared harmonics get notched. That is the right
  // call by default: no notch can separate hum from wanted content at the same
  // frequency, and the row stays tickable either way.
  const flaggedDetails = detectionDetail.filter(d => d.flagged)
  const pitchExplainsAll =
    flaggedDetails.length > 0 && flaggedDetails.every(d => d.pitchHarmonic > 0)
  if (pitchExplainsAll) {
    for (const d of detectionDetail) {
      d.matchesPitchedSource = d.pitchHarmonic > 0
    }
  }

  // What the detector would notch once the pitch check has had its say. A
  // single remaining harmonic is more likely musical content or a room
  // resonance than mains hum, so it does not trigger on its own.
  const recommendedHarmonics = detectionDetail
    .filter(d => d.flagged && !d.matchesPitchedSource)
    .map(d => d.frequency)
  const triggered = recommendedHarmonics.length >= minHarmonicsToTrigger

  return {
    triggered,
    tooShort: false,
    analyzedSeconds,
    anchorFrequency,
    anchorDeltaDb: round2(anchorDelta),
    /** Everything the spectral test flagged, before the pitch check. */
    flaggedHarmonics,
    /** What to actually notch — flagged, minus anything the pitch check claimed. */
    recommendedHarmonics,
    /**
     * Median pitch of the sustained source found in the selection, or null
     * when none was found or the contour was too scattered to trust. Usually a
     * voice, but a bass, cello or held synth note reads the same way.
     */
    pitchedSourceHz: pitchTrusted ? round2(source.pitchHz) : null,
    pitchConcentration: round2(source.concentration),
    detectionDetail,
  }
}
