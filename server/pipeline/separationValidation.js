/**
 * Stage NE-4 — Post-separation validation and artifact assessment.
 *
 * Assesses separation quality by comparing the audio before and after source
 * separation across four dimensions:
 *
 *   1. Residual noise floor       — triggers NE-5 if > -55 dBFS
 *   2. Spectral flatness delta    — detects over-separation artifacts in 2–8 kHz
 *   3. Sibilance ratio            — 4–9 kHz energy preserved post-separation
 *   4. Breath detection ratio     — short low-energy voiced-adjacent events
 *   5. Voice presence check       — aborts if no voiced frames detected
 *
 * Returns a SeparationAssessment object written to ctx.results.separationPipeline.
 */

import Meyda from 'meyda'
import { readWavSamples } from './wavReader.js'
import { analyzeFrames } from './frameAnalysis.js'

const FFT_SIZE   = 4096
const SR         = 44100
const BIN_HZ     = SR / FFT_SIZE

// Artifact threshold: spectral flatness increase > 0.15 in voiced 2–8 kHz frames
const ARTIFACT_FLATNESS_THRESHOLD   = 0.15
// Sibilance: < 0.6 ratio = more than 40% of 4–9 kHz energy removed
const SIBILANCE_LOSS_THRESHOLD      = 0.6
// Breath: ratio below 0.5 = more than half of breath events removed
const BREATH_LOSS_THRESHOLD         = 0.5
// Residual cleanup trigger
const RESIDUAL_CLEANUP_THRESHOLD_DB = -55

/**
 * @typedef {Object} SeparationAssessment
 * @property {number}   postSeparationNoiseFloorDbfs
 * @property {object}   postSeparationFrameAnalysis
 * @property {string[]} artifactFlags
 * @property {number}   sibilanceRatio
 * @property {number}   breathRatio
 * @property {boolean}  needsResidualCleanup
 * @property {'good'|'fair'|'poor'} separationQuality
 */

/**
 * @param {string} preSeparationPath  - Audio after NE-1/NE-2, before NE-3
 * @param {string} postSeparationPath - Audio after NE-3
 * @returns {Promise<SeparationAssessment>}
 */
export async function validateSeparation(preSeparationPath, postSeparationPath) {
  const [preSA, postSA]   = await Promise.all([
    analyzeFrames(preSeparationPath),
    analyzeFrames(postSeparationPath),
  ])

  // Voice presence check — abort if separation produced silence
  const postVoicedCount = postSA.frames.filter(f => !f.isSilence).length
  if (postVoicedCount === 0) {
    const err = new Error(
      'Voice could not be isolated from this recording. ' +
      'The signal-to-noise ratio may be too low for separation. ' +
      'Try using the Demucs model for better results on heavily noisy recordings.'
    )
    err.statusCode = 422
    throw err
  }

  const [preSamples, postSamples] = await Promise.all([
    readWavSamples(preSeparationPath).then(r => r.samples),
    readWavSamples(postSeparationPath).then(r => r.samples),
  ])

  // Spectral flatness delta — artifact detection in 2–8 kHz voiced frames
  const preFlatness  = measureVoicedSpectralFlatness(preSamples, preSA, 2000, 8000)
  const postFlatness = measureVoicedSpectralFlatness(postSamples, postSA, 2000, 8000)
  const flatnessDelta = postFlatness - preFlatness

  const artifactFlags = []
  if (flatnessDelta > ARTIFACT_FLATNESS_THRESHOLD) {
    artifactFlags.push(
      'High-frequency spectral artifacts detected in separated voice content. Review output carefully.'
    )
  }

  // Sibilance ratio: 4–9 kHz band energy, pre vs post (as linear amplitude ratio)
  const preSibDb  = measureVoicedBandEnergyDb(preSamples, preSA, 4000, 9000)
  const postSibDb = measureVoicedBandEnergyDb(postSamples, postSA, 4000, 9000)
  const sibilanceRatio = round2(Math.pow(10, (postSibDb - preSibDb) / 20))

  if (sibilanceRatio < SIBILANCE_LOSS_THRESHOLD) {
    artifactFlags.push(
      'Sibilance loss detected — bandwidth extension (NE-6) will attempt to restore.'
    )
  }

  // Breath detection ratio: count short low-energy voiced-adjacent frames
  const preBreathCount  = countBreathEvents(preSA)
  const postBreathCount = countBreathEvents(postSA)
  const breathRatio = preBreathCount > 0
    ? round2(postBreathCount / preBreathCount)
    : 1.0

  if (breathRatio < BREATH_LOSS_THRESHOLD) {
    artifactFlags.push(
      'Breath sounds may have been partially removed during separation. Review output for naturalness.'
    )
  }

  const needsResidualCleanup = postSA.noiseFloorDbfs > RESIDUAL_CLEANUP_THRESHOLD_DB

  return {
    postSeparationNoiseFloorDbfs: round2(postSA.noiseFloorDbfs),
    postSeparationFrameAnalysis:  postSA,
    artifactFlags,
    sibilanceRatio,
    breathRatio,
    needsResidualCleanup,
    separationQuality: rateSeparationQuality(artifactFlags, sibilanceRatio, breathRatio),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function measureVoicedSpectralFlatness(samples, frameAnalysis, freqLo, freqHi) {
  const voiced = collectVoicedFrames(samples, frameAnalysis)
  if (voiced.length === 0) return 0

  const loIdx = Math.floor(freqLo / BIN_HZ)
  const hiIdx = Math.ceil(freqHi / BIN_HZ)

  let sum = 0
  let count = 0
  for (const frame of voiced) {
    const ps = Meyda.extract('powerSpectrum', frame)
    if (!ps) continue
    const slice = ps.slice(loIdx, hiIdx + 1)
    const sf    = spectralFlatness(slice)
    if (isFinite(sf)) { sum += sf; count++ }
  }
  return count > 0 ? sum / count : 0
}

function measureVoicedBandEnergyDb(samples, frameAnalysis, freqLo, freqHi) {
  const voiced = collectVoicedFrames(samples, frameAnalysis)
  if (voiced.length === 0) return -80

  const loIdx = Math.floor(freqLo / BIN_HZ)
  const hiIdx = Math.ceil(freqHi / BIN_HZ)

  let totalEnergy = 0
  let count = 0
  for (const frame of voiced) {
    const ps = Meyda.extract('powerSpectrum', frame)
    if (!ps) continue
    const slice = ps.slice(loIdx, hiIdx + 1)
    const mean  = slice.reduce((s, v) => s + v, 0) / slice.length
    if (mean > 0) { totalEnergy += mean; count++ }
  }
  if (count === 0 || totalEnergy === 0) return -80
  return 10 * Math.log10(totalEnergy / count)
}

function spectralFlatness(powerSlice) {
  const n     = powerSlice.length
  if (n === 0) return 0
  const geo   = Math.exp(powerSlice.reduce((s, v) => s + Math.log(Math.max(v, 1e-12)), 0) / n)
  const arith = powerSlice.reduce((s, v) => s + v, 0) / n
  return arith > 0 ? geo / arith : 0
}

function collectVoicedFrames(samples, frameAnalysis) {
  if (!frameAnalysis?.frames?.length) return []
  const frames = []
  for (const frame of frameAnalysis.frames) {
    if (frame.isSilence) continue
    if (frame.offsetSamples + FFT_SIZE > samples.length) break
    frames.push(samples.slice(frame.offsetSamples, frame.offsetSamples + FFT_SIZE))
    if (frames.length >= 150) break
  }
  return frames
}

/**
 * Count breath-candidate events: short low-energy non-silence frames adjacent
 * to a voiced frame. Breaths are typically 50–200 ms (2–8 frames at 25ms/frame)
 * and 8–15 dB below adjacent voiced RMS.
 */
function countBreathEvents(frameAnalysis) {
  const frames = frameAnalysis?.frames ?? []
  const threshold = frameAnalysis?.silenceThresholdDbfs ?? -60
  let count = 0

  for (let i = 1; i < frames.length - 1; i++) {
    const prev = frames[i - 1]
    const curr = frames[i]
    const next = frames[i + 1]
    // A breath candidate: not classified as silence, low-ish energy, flanked by voiced
    if (!curr.isSilence && curr.rmsDbfs < threshold + 12 &&
        (!prev.isSilence || !next.isSilence)) {
      count++
    }
  }
  return count
}

function rateSeparationQuality(artifactFlags, sibilanceRatio, breathRatio) {
  const flagCount = artifactFlags.length
  if (flagCount >= 2 || sibilanceRatio < 0.5 || breathRatio < 0.3) return 'poor'
  if (flagCount === 1 || sibilanceRatio < 0.7 || breathRatio < 0.5) return 'fair'
  return 'good'
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}
