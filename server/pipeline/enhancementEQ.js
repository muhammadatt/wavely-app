/**
 * Stage 3 — Enhancement EQ.
 *
 * Analyzes the spectral envelope of voiced speech using Meyda.js, compares
 * against the preset's EQ reference profile, and computes parametric EQ
 * parameters for FFmpeg's `equalizer` filter.
 *
 * Reference: processing spec v3, Stage 3.
 *
 * Diagnostic bands:
 *   Body/warmth    100–250 Hz
 *   Mud/boxiness   200–400 Hz
 *   Clarity zone   400–700 Hz
 *   Presence       2000–5000 Hz
 *   Air/sibilance  6000–12000 Hz
 *
 * EQ operations are applied in one chained FFmpeg pass.
 * No single band adjustment exceeds ±5 dB (spec constraint).
 */

import Meyda from 'meyda'
import { readWavSamples } from './wavReader.js'

const FFT_SIZE      = 4096
const SAMPLE_RATE   = 44100
const MAX_GAIN_DB   = 5    // spec: ±5 dB maximum per band
const HOP_SIZE      = FFT_SIZE  // non-overlapping frames for batch analysis

// ── EQ Reference Profiles ────────────────────────────────────────────────────
// Each entry is the expected normalized energy (in dB relative to spectral mean)
// for recordings that "sound right" for the target use case.
// Deviations from these targets drive the trigger logic.
//
// Values are relative to spectral mean across all diagnostic bands.
const EQ_REFERENCES = {
  acx_audiobook: {
    warmth:   -1,    // 100–250 Hz: natural, slight cut OK
    mud:      -3,    // 200–400 Hz: slightly suppressed
    clarity:  -2,    // 400–700 Hz: slightly suppressed
    presence: +3,    // 2–5 kHz:    forward-leaning
    air:       0,    // 6–12 kHz:   neutral
  },
  podcast_ready: {
    warmth:   -2,    // 100–250 Hz: thinner for phone speakers
    mud:      -5,    // 200–400 Hz: assertive mud cut
    clarity:  -3,    // 400–700 Hz: clarity cut for earbuds
    presence: +4,    // 2–5 kHz:    punchy presence
    air:      +1,    // 6–12 kHz:   slight air lift
  },
  voice_ready: {
    warmth:   -1,    // 100–250 Hz: neutral-warm
    mud:      -3,    // 200–400 Hz: moderate mud cut
    clarity:  -2,    // 400–700 Hz: slight clarity cut
    presence: +3,    // 2–5 kHz:    broadcast presence
    air:      +0.5,  // 6–12 kHz:   conservative air
  },
  general_clean: {
    warmth:    0,    // 100–250 Hz: neutral
    mud:      -3,    // 200–400 Hz: moderate mud cut
    clarity:  -2,    // 400–700 Hz: moderate clarity cut
    presence: +3,    // 2–5 kHz:    clear presence
    air:       0,    // 6–12 kHz:   neutral
  },
}

// ── Trigger thresholds (dB deviation from reference to apply EQ) ──────────────
// Per spec: mud cut triggers at > 3 dB above ref (ACX/General), 2 dB (Podcast)
//           presence boost triggers at > 2 dB below ref
const TRIGGERS = {
  acx_audiobook: { mud: 3, presence: 2, warmth: 4, air: 4, clarity: 2 },
  podcast_ready: { mud: 2, presence: 2, warmth: 3, air: 3, clarity: 2 },
  voice_ready:   { mud: 3, presence: 2, warmth: 4, air: 4, clarity: 2 },
  general_clean: { mud: 3, presence: 2, warmth: 3, air: 4, clarity: 2 },
}

// ── EQ center frequencies ────────────────────────────────────────────────────
// Chosen to represent the diagnostic band character. Q factor targets the
// specified bandwidth from the spec.
const EQ_CENTERS = {
  warmth:   { freq: 180, q: 1.5 },  // 100–250 Hz warmth
  mud:      { freq: 285, q: 2.5 },  // 200–400 Hz mud (spec: Q 2–3)
  clarity:  { freq: 520, q: 2.0 },  // 400–700 Hz clarity
  presence: { freq: 4000, q: 1.5 }, // 2–5 kHz presence (spec: 4 kHz, Q 1.5)
  air:      { freq: 10000, q: 0.7, shelf: true }, // 10 kHz shelf per spec
}

// ── Diagnostic band frequency limits ─────────────────────────────────────────
const BANDS = {
  warmth:   [100, 250],
  mud:      [200, 400],
  clarity:  [400, 700],
  presence: [2000, 5000],
  air:      [6000, 12000],
}

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Analyze the spectral envelope and return FFmpeg EQ filter parameters.
 * Does NOT apply the EQ — caller passes these to applyParametricEQ().
 *
 * @param {string} wavPath
 * @param {string} presetId
 * @param {import('./silenceAnalysis.js').SilenceAnalysis} silenceAnalysis
 * @param {number} noiseFloorDbfs  - For Stage 3c ACX noise floor constraint check
 * @returns {EQResult}
 *
 * @typedef {Object} EQResult
 * @property {string[]} ffmpegFilters  - FFmpeg equalizer filter strings (may be empty)
 * @property {Object}   bands          - Per-band EQ details for the report
 * @property {string}   profile        - Preset profile name used
 * @property {boolean}  applied        - True if any EQ was applied
 */
export async function analyzeSpectrum(wavPath, presetId, silenceAnalysis, noiseFloorDbfs) {
  const ref     = EQ_REFERENCES[presetId] ?? EQ_REFERENCES.general_clean
  const trigger = TRIGGERS[presetId]      ?? TRIGGERS.general_clean

  const { samples } = await readWavSamples(wavPath)

  // Collect voiced frames for analysis
  const voicedFrameBuffers = collectVoicedFrames(samples, silenceAnalysis, FFT_SIZE)

  if (voicedFrameBuffers.length === 0) {
    return noEQResult(presetId)
  }

  // Compute average power spectrum across voiced frames
  const avgPowerSpectrum = averagePowerSpectrum(voicedFrameBuffers)

  // Measure average energy (in dB) in each diagnostic band
  const measured = measureBandEnergies(avgPowerSpectrum, SAMPLE_RATE, FFT_SIZE)

  // Compute spectral mean (average across all diagnostic bands, in dB)
  const specMeanDb = Object.values(measured).reduce((s, v) => s + v, 0) / Object.keys(measured).length

  // Convert to deviation from spectral mean (so we compare shape, not absolute level)
  const deviation = {}
  for (const band of Object.keys(measured)) {
    deviation[band] = measured[band] - specMeanDb
  }

  // Compute how far each band deviates from its reference target
  const delta = {}
  for (const band of Object.keys(ref)) {
    delta[band] = deviation[band] - ref[band]  // positive = band is elevated
  }

  // Build EQ decisions per band
  const bandResults = {}
  const filters = []

  // --- Mud cut ---
  bandResults.mud_cut = decideBand({
    name: 'mud_cut',
    delta: delta.mud,
    trigger: trigger.mud,
    direction: 'cut',     // positive delta → cut
    maxGain: MAX_GAIN_DB,
    center: EQ_CENTERS.mud,
    gainScale: 0.8,       // don't cut the full delta, be conservative
  })
  if (bandResults.mud_cut.applied) filters.push(bandResults.mud_cut.filter)

  // --- Clarity cut (follows mud cut, per spec) ---
  bandResults.clarity_cut = decideBand({
    name: 'clarity_cut',
    delta: delta.clarity,
    trigger: trigger.clarity,
    direction: 'cut',
    maxGain: 2,           // spec: -1 to -2 dB clarity cut
    center: EQ_CENTERS.clarity,
    gainScale: 0.5,
  })
  if (bandResults.clarity_cut.applied) filters.push(bandResults.clarity_cut.filter)

  // --- Presence boost ---
  bandResults.presence_boost = decideBand({
    name: 'presence_boost',
    delta: delta.presence,
    trigger: trigger.presence,
    direction: 'boost',   // negative delta → boost
    maxGain: MAX_GAIN_DB,
    center: EQ_CENTERS.presence,
    gainScale: 0.7,
  })
  if (bandResults.presence_boost.applied) filters.push(bandResults.presence_boost.filter)

  // --- Warmth boost (ACX: only if mud cut NOT applied, per spec) ---
  const warmthCutApplicable = presetId === 'podcast_ready'  // podcast: warmth cut
  const warmthBoostApplicable = presetId !== 'podcast_ready' && !bandResults.mud_cut.applied
  bandResults.warmth_boost = { applied: false }

  if (warmthCutApplicable && delta.warmth > trigger.warmth) {
    // Podcast warmth cut
    const gainDb = Math.min(delta.warmth * 0.5, 2)
    bandResults.warmth_boost = buildCut('warmth_cut', gainDb, EQ_CENTERS.warmth)
    if (bandResults.warmth_boost.applied) filters.push(bandResults.warmth_boost.filter)
  } else if (warmthBoostApplicable && delta.warmth < -trigger.warmth) {
    // Warmth boost (only if no mud cut applied)
    const gainDb = Math.min(Math.abs(delta.warmth) * 0.5, 2)
    bandResults.warmth_boost = buildBoost('warmth_boost', gainDb, EQ_CENTERS.warmth)
    if (bandResults.warmth_boost.applied) filters.push(bandResults.warmth_boost.filter)
  }

  // --- Air boost ---
  if (delta.air < -trigger.air) {
    const gainDb = Math.min(Math.abs(delta.air) * 0.4, presetId === 'podcast_ready' ? 2 : 1.5)
    bandResults.air_boost = buildBoost('air_boost', gainDb, EQ_CENTERS.air)
    if (bandResults.air_boost.applied) filters.push(bandResults.air_boost.filter)
  } else {
    bandResults.air_boost = { applied: false }
  }

  // --- Stage 3c: ACX noise floor constraint ---
  // If we boosted presence/air and the noise floor is already close to -60 dBFS,
  // reduce or skip high-frequency boosts to avoid pushing hiss above threshold.
  if ((presetId === 'acx_audiobook' || presetId === 'voice_ready') && noiseFloorDbfs > -66) {
    const toMute = filters.filter(f => f.includes('f=10000') || f.includes('f=4000'))
    toMute.forEach(f => {
      const idx = filters.indexOf(f)
      // Halve the gain to reduce noise floor risk
      const halved = f.replace(/g=([\d.]+)/, (_, g) => `g=${round2(parseFloat(g) / 2)}`)
      filters[idx] = halved
    })
  }

  const applied = filters.length > 0

  return {
    ffmpegFilters: filters,
    bands: bandResults,
    profile: presetId,
    applied,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectVoicedFrames(samples, silenceAnalysis, fftSize) {
  if (!silenceAnalysis || !silenceAnalysis.frames || silenceAnalysis.frames.length === 0) {
    // Fallback: use all samples in chunks
    const chunks = []
    for (let i = 0; i + fftSize <= samples.length; i += fftSize) {
      chunks.push(samples.slice(i, i + fftSize))
    }
    return chunks.slice(0, 200)  // cap at 200 frames ~20s of analysis
  }

  const voiced = silenceAnalysis.frames.filter(f => !f.isSilence)
  const buffers = []

  for (const frame of voiced) {
    if (frame.offsetSamples + fftSize > samples.length) break
    buffers.push(samples.slice(frame.offsetSamples, frame.offsetSamples + fftSize))
    if (buffers.length >= 200) break  // cap at 200 frames
  }

  return buffers
}

function averagePowerSpectrum(frames) {
  const size = FFT_SIZE / 2  // Meyda powerSpectrum returns bufferSize/2 bins
  const sum = new Float64Array(size)

  for (const frame of frames) {
    // Meyda.extract expects a standard array or Float32Array of length bufferSize
    const ps = Meyda.extract('powerSpectrum', frame)
    if (!ps) continue
    for (let i = 0; i < size && i < ps.length; i++) {
      sum[i] += ps[i]
    }
  }

  // Average
  for (let i = 0; i < size; i++) sum[i] /= frames.length
  return sum
}

function measureBandEnergies(powerSpectrum, sampleRate, fftSize) {
  const result = {}
  for (const [band, [lo, hi]] of Object.entries(BANDS)) {
    result[band] = bandEnergyDb(powerSpectrum, sampleRate, fftSize, lo, hi)
  }
  return result
}

function bandEnergyDb(ps, sampleRate, fftSize, freqLo, freqHi) {
  const binHz  = sampleRate / fftSize
  const loIdx  = Math.max(0, Math.floor(freqLo / binHz))
  const hiIdx  = Math.min(ps.length - 1, Math.ceil(freqHi / binHz))
  let sum = 0
  let count = 0
  for (let i = loIdx; i <= hiIdx; i++) {
    sum += ps[i]
    count++
  }
  if (count === 0 || sum <= 0) return -80
  return 10 * Math.log10(sum / count)
}

function decideBand({ name, delta, trigger, direction, maxGain, center, gainScale }) {
  const triggered = direction === 'cut'
    ? delta > trigger         // elevated → cut
    : delta < -trigger        // deficient → boost

  if (!triggered) return { applied: false }

  let gainDb = Math.abs(delta) * gainScale
  gainDb = Math.min(gainDb, maxGain)
  gainDb = round2(gainDb)

  if (gainDb < 0.5) return { applied: false }  // below perception threshold

  if (direction === 'cut') return buildCut(name, gainDb, center)
  return buildBoost(name, gainDb, center)
}

function buildCut(name, gainDb, center) {
  const filter = center.shelf
    ? `treble=g=-${gainDb}:f=${center.freq}`
    : `equalizer=f=${center.freq}:t=q:w=${center.q}:g=-${gainDb}`
  return { applied: true, freq_hz: center.freq, gain_db: -gainDb, filter }
}

function buildBoost(name, gainDb, center) {
  const filter = center.shelf
    ? `treble=g=${gainDb}:f=${center.freq}`
    : `equalizer=f=${center.freq}:t=q:w=${center.q}:g=${gainDb}`
  return { applied: true, freq_hz: center.freq, gain_db: gainDb, filter }
}

function noEQResult(presetId) {
  return {
    ffmpegFilters: [],
    bands: {
      mud_cut: { applied: false },
      clarity_cut: { applied: false },
      presence_boost: { applied: false },
      warmth_boost: { applied: false },
      air_boost: { applied: false },
    },
    profile: presetId,
    applied: false,
  }
}

function round2(n) {
  return Math.round(n * 100) / 100
}
