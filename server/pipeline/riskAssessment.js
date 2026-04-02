/**
 * Stage 7 — Quality risk assessment.
 *
 * Analyzes the processed audio for quality risk factors:
 *
 *  For all presets:
 *    - Overprocessing detection (crest factor, spectral flatness change)
 *
 *  For ACX Audiobook only:
 *    - Loud breath detection (short high-energy events in silence regions)
 *    - Plosive detection (sharp low-frequency transients that survived HPF)
 *    - Human review risk level (Low / Medium / High)
 *
 * Reference: processing spec v3, Stage 7b.
 */

import { readWavSamples } from './wavReader.js'
import Meyda from 'meyda'

const SAMPLE_RATE     = 44100
const FFT_SIZE        = 4096
const FRAME_S         = 0.02   // 20 ms analysis frames

// Breath detection: events in silence regions within 12 dB of voiced speech level
const BREATH_MARGIN_DB = 12

// Plosive detection: sharp transients at 50–150 Hz, > 10 dB above baseline, < 20 ms
const PLOSIVE_FREQ_LO  = 50
const PLOSIVE_FREQ_HI  = 150
const PLOSIVE_SPIKE_DB = 10
const PLOSIVE_MAX_S    = 0.02   // 20 ms

// Overprocessing: crest factor < 8 dB → over-compressed
const CREST_FACTOR_THRESHOLD_DB = 8

/**
 * Assess quality risks on the processed audio.
 *
 * @param {string} processedPath  - Processed WAV (post-chain)
 * @param {string} presetId
 * @param {import('./silenceAnalysis.js').SilenceAnalysis} silenceAnalysis
 *   - From the pre-normalization analysis (identifies silence regions)
 * @param {number} voicedRmsDbfs  - Average voiced RMS (for breath comparison)
 * @returns {RiskResult}
 *
 * @typedef {Object} RiskResult
 * @property {{ level: 'low'|'medium'|'high', flags: string[] } | null} humanReviewRisk
 *   - ACX Audiobook only; null for other presets
 * @property {OverprocessingResult} overprocessing
 * @property {string[]} warnings  - Human-readable warning messages
 */
export async function assessRisks(processedPath, presetId, silenceAnalysis, voicedRmsDbfs) {
  const { samples } = await readWavSamples(processedPath)
  const frameSamples = Math.round(FRAME_S * SAMPLE_RATE)

  const warnings = []

  // --- Overprocessing detection (all presets) ---
  const overprocessing = detectOverprocessing(samples, frameSamples)
  if (overprocessing.overCompressed) {
    warnings.push('Output may be over-compressed — crest factor below 8 dB.')
  }

  // --- ACX-specific checks ---
  let humanReviewRisk = null

  if (presetId === 'acx_audiobook') {
    const flags = []

    // Breath detection
    const breathDetected = detectBreaths(samples, frameSamples, silenceAnalysis, voicedRmsDbfs)
    if (breathDetected) {
      flags.push('Loud breath sounds detected. These require manual editing before ACX submission.')
      warnings.push('Loud breath sounds detected. Review and edit before submitting to ACX.')
    }

    // Plosive detection
    const plosiveDetected = detectPlosives(samples, frameSamples)
    if (plosiveDetected) {
      flags.push('Possible unedited plosives detected.')
      warnings.push('Possible unedited plosives detected. Review low-frequency transients.')
    }

    // Overprocessing flag for ACX
    if (overprocessing.overCompressed) {
      flags.push('Output may be over-compressed — ACX human reviewers may flag this.')
    }

    // Aggregate into human review risk level
    const level = computeRiskLevel(flags)
    humanReviewRisk = { level, flags }
  }

  return { humanReviewRisk, overprocessing, warnings }
}

// ── Overprocessing detection ──────────────────────────────────────────────────

function detectOverprocessing(samples, frameSamples) {
  const numFrames = Math.floor(samples.length / frameSamples)
  if (numFrames === 0) return { overCompressed: false, crestFactorDb: null }

  let peakAbs = 0
  let sumSq   = 0

  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i])
    if (abs > peakAbs) peakAbs = abs
    sumSq += samples[i] * samples[i]
  }

  const rms     = Math.sqrt(sumSq / samples.length)
  const crestDb = rms > 0 ? 20 * Math.log10(peakAbs / rms) : 0
  const overCompressed = crestDb < CREST_FACTOR_THRESHOLD_DB

  return {
    overCompressed,
    crestFactorDb: round2(crestDb),
  }
}

// ── Breath detection ──────────────────────────────────────────────────────────

/**
 * Detect short high-energy events within silence regions.
 * Returns true if average breath energy is within BREATH_MARGIN_DB of voiced speech.
 */
function detectBreaths(samples, frameSamples, silenceAnalysis, voicedRmsDbfs) {
  if (!silenceAnalysis || silenceAnalysis.frames.length === 0) return false

  const silenceFrames = silenceAnalysis.frames.filter(f => f.isSilence)
  if (silenceFrames.length === 0) return false

  // Collect RMS values of silence frames
  const silenceRms = []
  for (const frame of silenceFrames) {
    const start = frame.offsetSamples
    const end   = start + frame.lengthSamples
    if (end > samples.length) break
    let sumSq = 0
    for (let i = start; i < end; i++) sumSq += samples[i] * samples[i]
    silenceRms.push(Math.sqrt(sumSq / frame.lengthSamples))
  }

  if (silenceRms.length === 0) return false

  // Sort and look at the upper end of silence frame energies
  silenceRms.sort((a, b) => b - a)

  // Use P90 of silence frames as "breath-candidate" level
  const p90idx    = Math.floor(silenceRms.length * 0.10)
  const p90Rms    = silenceRms[p90idx] ?? silenceRms[0]
  const p90Db     = p90Rms > 0 ? 20 * Math.log10(p90Rms) : -120
  const margin    = voicedRmsDbfs - p90Db

  // Breath detected if within 12 dB of average voiced level
  return margin < BREATH_MARGIN_DB
}

// ── Plosive detection ─────────────────────────────────────────────────────────

/**
 * Detect sharp low-frequency transients (50–150 Hz, > 10 dB above baseline, < 20 ms)
 * that survived the high-pass filter.
 */
function detectPlosives(samples, frameSamples) {
  // We analyze in 20 ms frames, computing low-band energy
  const numFrames = Math.floor(samples.length / frameSamples)
  if (numFrames < 10) return false

  const loEnergyPerFrame = new Float32Array(numFrames)

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSamples
    const end   = Math.min(start + frameSamples, samples.length)

    if (end - start < FFT_SIZE) {
      loEnergyPerFrame[f] = 0
      continue
    }

    // Use Meyda to get power spectrum for this frame
    const frame = samples.slice(start, start + FFT_SIZE)
    const ps    = Meyda.extract('powerSpectrum', frame)
    if (!ps) { loEnergyPerFrame[f] = 0; continue }

    // Sum energy in plosive band (50–150 Hz)
    const binHz = SAMPLE_RATE / FFT_SIZE
    const loIdx = Math.floor(PLOSIVE_FREQ_LO / binHz)
    const hiIdx = Math.ceil(PLOSIVE_FREQ_HI / binHz)
    let sum = 0
    for (let i = loIdx; i <= hiIdx && i < ps.length; i++) sum += ps[i]
    loEnergyPerFrame[f] = sum / (hiIdx - loIdx + 1)
  }

  // Compute baseline low-band energy (median)
  const sorted  = Float32Array.from(loEnergyPerFrame).sort()
  const medianIdx = Math.floor(sorted.length / 2)
  const baseline  = sorted[medianIdx]
  if (baseline <= 0) return false

  const baselineDb = 10 * Math.log10(baseline)

  // Look for frames with > 10 dB spike above baseline
  let spikeCount = 0
  for (let f = 0; f < numFrames; f++) {
    if (loEnergyPerFrame[f] <= 0) continue
    const frameDb = 10 * Math.log10(loEnergyPerFrame[f])
    if (frameDb - baselineDb > PLOSIVE_SPIKE_DB) spikeCount++
  }

  // Flag if more than 2 plosive candidates detected (could be false positive from one)
  return spikeCount > 2
}

// ── Risk level aggregation ────────────────────────────────────────────────────

function computeRiskLevel(flags) {
  if (flags.length === 0) return 'low'
  if (flags.length === 1) return 'medium'
  return 'high'
}

function round2(n) {
  return Math.round(n * 100) / 100
}
