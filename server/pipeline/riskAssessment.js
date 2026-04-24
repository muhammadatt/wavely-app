/**
 * Stage 7 — Quality advisory flag generation.
 *
 * Compliance model v2: replaces the aggregate human_review_risk (Low/Medium/High)
 * with individual quality advisory flags. Each flag has an id, severity
 * (info or review), and a user-facing message.
 *
 * Flags generated:
 *   All presets/profiles:
 *     - over_compression (crest factor < 8 dB — audio sounds over-compressed)
 *
 *   ACX Audiobook preset only:
 *     - loud_breaths (high-energy events in silence regions)
 *     - plosives (sharp low-frequency transients)
 *
 *   ACX output profile only:
 *     - noise_floor_marginal (-60 to -62 dBFS)
 *
 *   Noise Eraser preset:
 *     - separation_used (always flagged)
 *
 *   Pipeline context:
 *     - high_nr_applied (pre-NR noise floor > -55 dBFS — heavy processing was needed)
 *
 *   Auto Leveler (when applied):
 *     - leveler_gain_capped (any window hit the preset's max gain cap)
 *     - leveler_noise_floor_risk (post-application noise floor exceeded -58 dBFS)
 *
 * Reference: docs/instant_polish_compliance_model_v2.md,
 *            Auto Leveler Stage Specification (April 2026 addendum)
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

// Overprocessing: crest factor < 8 dB → over-compressed
const CREST_FACTOR_THRESHOLD_DB = 8

/**
 * @typedef {Object} QualityAdvisoryFlag
 * @property {string} id
 * @property {'info'|'review'} severity
 * @property {string} message
 */

/**
 * @typedef {Object} QualityAdvisory
 * @property {QualityAdvisoryFlag[]} flags
 * @property {boolean} review_recommended
 */

/**
 * Generate quality advisory flags for the processed audio.
 *
 * @param {string} processedPath - Processed WAV (post-chain)
 * @param {string} presetId
 * @param {string} outputProfileId
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @param {number} voicedRmsDbfs - Average voiced RMS (for breath comparison)
 * @param {object} pipelineContext - { preNrNoiseFloor: number|null, noiseFloorDbfs: number|null }
 * @returns {QualityAdvisory}
 */
export async function generateQualityAdvisory(
  processedPath, presetId, outputProfileId, frameAnalysis, voicedRmsDbfs, pipelineContext = {}
) {
  const { samples } = await readWavSamples(processedPath)
  const frameSamples = Math.round(FRAME_S * SAMPLE_RATE)

  /** @type {QualityAdvisoryFlag[]} */
  const flags = []

  // --- Overprocessing detection (all presets) ---
  const overprocessing = detectOverprocessing(samples, frameSamples)
  if (overprocessing.overCompressed) {
    flags.push({
      id: 'over_compression',
      severity: 'review',
      message: 'Output may sound over-compressed. The narration may lack natural dynamic range.',
    })
  }

  // --- ACX Audiobook-specific flags ---
  if (presetId === 'acx_audiobook') {
    // Breath detection
    if (detectBreaths(samples, frameSamples, frameAnalysis, voicedRmsDbfs)) {
      flags.push({
        id: 'loud_breaths',
        severity: 'review',
        message: 'Loud breath sounds detected. ACX reviewers sometimes flag these. Listen and decide.',
      })
    }

    // Plosive detection
    if (detectPlosives(samples, frameSamples)) {
      flags.push({
        id: 'plosives',
        severity: 'review',
        message: 'Possible plosive sounds detected. These may require manual editing.',
      })
    }
  }

  // --- Noise floor marginal (ACX output profile only) ---
  if (outputProfileId === 'acx' && pipelineContext.noiseFloorDbfs != null) {
    const nf = pipelineContext.noiseFloorDbfs
    if (nf <= -60 && nf > -62) {
      flags.push({
        id: 'noise_floor_marginal',
        severity: 'info',
        message: 'Noise floor is within spec but close to the limit. Re-recording in a quieter environment would add headroom.',
      })
    }
  }

  // --- Heavy NR applied (all presets) ---
  // Threshold: pre-NR noise floor > -55 dBFS indicates a significantly noisy
  // recording where DF3 had substantial work to do.
  if (pipelineContext.preNrNoiseFloor != null && pipelineContext.preNrNoiseFloor > -55) {
    flags.push({
      id: 'high_nr_applied',
      severity: 'info',
      message: 'Heavy noise reduction was applied. Some processing character may be audible on close listening.',
    })
  }

  // --- Separation used (Noise Eraser only) ---
  if (presetId === 'noise_eraser') {
    flags.push({
      id: 'separation_used',
      severity: 'review',
      message: 'Voice separation was used. The output may have a processed quality. Review carefully before submitting to ACX.',
    })
  }

  // --- Auto Leveler advisory flags ---
  // These are only generated when the leveler actually ran (applied: true).
  const levelerResult = pipelineContext.autoLeveler
  if (levelerResult?.applied) {
    if (levelerResult.gain_capped) {
      flags.push({
        id: 'leveler_gain_capped',
        severity: 'info',
        message: 'Some sections had large level differences that could not be fully corrected. Manual gain adjustment may help these sections.',
      })
    }

    if (levelerResult.noise_floor_risk) {
      flags.push({
        id: 'leveler_noise_floor_risk',
        severity: 'review',
        message: 'Auto leveling may have affected the noise floor in quiet sections. Verify the noise floor before export.',
      })
    }
  }

  // --- Vocal Expander advisory flags ---
  // Emit `over_expansion` when the expander attenuated more of the file than
  // expected (>35% of frames) or when any VAD-voiced frame received more than
  // 3 dB of attenuation (i.e. the expander reached into quiet speech).
  const expanderResult = pipelineContext.vocalExpander
  if (expanderResult?.applied) {
    const anyVoicedFrameOverExpanded = (expanderResult.maxVoicedFrameAttenuationDb ?? 0) > 3
    const tooManyFramesExpanded      = (expanderResult.pctFramesExpanded ?? 0)        > 35
    if (anyVoicedFrameOverExpanded || tooManyFramesExpanded) {
      flags.push({
        id: 'over_expansion',
        severity: 'review',
        message: 'The expander may have affected quiet speech. Listen for unnatural silences between words or clipped consonants.',
      })
    }
  }

  const review_recommended = flags.some(f => f.severity === 'review')

  return { flags, review_recommended }
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
function detectBreaths(samples, frameSamples, frameAnalysis, voicedRmsDbfs) {
  if (!frameAnalysis || frameAnalysis.frames.length === 0) return false

  const silenceFrames = frameAnalysis.frames.filter(f => f.isSilence)
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
  // We analyze in 20 ms frames, computing low-band energy.
  // FFT_SIZE (4096) is larger than a 20 ms frame (~882 samples at 44.1 kHz),
  // so use a smaller FFT that fits within the frame.
  const FFT_SIZE_PLOSIVE = 512  // 512 < 882, so this fits within a 20 ms frame

  const numFrames = Math.floor(samples.length / frameSamples)
  if (numFrames < 10) return false

  const loEnergyPerFrame = new Float32Array(numFrames)

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSamples
    const end   = Math.min(start + frameSamples, samples.length)

    if (end - start < FFT_SIZE_PLOSIVE) {
      loEnergyPerFrame[f] = 0
      continue
    }

    // Use Meyda to get power spectrum for this frame
    Meyda.bufferSize = FFT_SIZE_PLOSIVE
    const frame = samples.slice(start, start + FFT_SIZE_PLOSIVE)
    const ps    = Meyda.extract('powerSpectrum', frame)
    if (!ps) { loEnergyPerFrame[f] = 0; continue }

    // Sum energy in plosive band (50–150 Hz)
    const binHz = SAMPLE_RATE / FFT_SIZE_PLOSIVE
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

function round2(n) {
  return Math.round(n * 100) / 100
}
