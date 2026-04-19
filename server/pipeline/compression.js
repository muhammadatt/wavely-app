/**
 * Stage 4a — Adaptive Crest Factor Compression.
 *
 * Input-adaptive model: measures the crest factor of voiced speech frames,
 * compares it to the preset's target, and derives the minimum ratio needed
 * to bridge the gap. Compression is skipped if the input is already within
 * the target crest factor.
 *
 * Reference: Adaptive Compression Specification (April 2026 addendum),
 *            processing spec v3, Stage 4a.
 *
 * Algorithm:
 *   1. Measure input crest factor on voiced frames (peak - voiced RMS, in dB).
 *   2. Skip if input crest factor <= target + 0.5 dB margin.
 *   3. Derive threshold from the preset-specified percentile of the
 *      voiced-frame RMS distribution.
 *   4. Adjust threshold if above peak level (for quiet files).
 *   5. Calculate ratio using simple formula: amplitude / (amplitude - required_reduction)
 *   6. Apply feed-forward RMS compressor with soft knee.
 *
 * Fixed parameters (per spec): attack, release, knee width, makeup gain = 0 dB.
 * Ratio clamping has been removed in favor of simple calculation.
 */

import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels } from './wavWriter.js'
import { PRESETS } from '../presets.js'

const KNEE_WIDTH_DB           = 4      // soft knee width, all presets
const SKIP_MARGIN_DB          = 0.5    // skip if within this margin of target
const FALLBACK_THRESHOLD_DBFS = -22    // used when < MIN_VOICED_FRAMES available
const MIN_VOICED_FRAMES       = 50     // minimum frames for stable percentile estimate

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * Apply dynamic range compression to an audio file.
 *
 * @param {string} inputPath   - 32-bit float WAV
 * @param {string} outputPath  - Output WAV path
 * @param {string} presetId
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @returns {CompressionResult}
 *
 * @typedef {Object} CompressionResult
 * @property {boolean} applied
 * @property {number|null} inputCrestFactorDb    - Measured input crest factor (voiced frames)
 * @property {number|null} targetCrestFactorDb   - Preset target crest factor
 * @property {string|null} skipReason            - Set when applied is false
 * @property {number|null} thresholdPercentile   - Percentile used for threshold (when applied)
 * @property {number|null} thresholdDbfs         - Derived threshold in dBFS (when applied)
 * @property {number|null} derivedRatio          - Derived compression ratio (when applied)
 * @property {number|null} derivedGainReductionDb - Expected gain reduction at the peak (when applied)
 * @property {number|null} maxGainReductionDb    - Peak gain reduction during processing
 * @property {number|null} avgGainReductionDb    - Average gain reduction applied
 * @property {number|null} finalCrestFactorDb    - Achieved crest factor after compression (when applied)
 */
export async function applyCompression(inputPath, outputPath, presetId, frameAnalysis) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error(`Unknown preset: ${presetId}`)

  const presetComp = preset.compression
  const { mode, targetCrestFactorDb, thresholdPercentile, attack, release } = presetComp

  if (mode === 'none') {
    await copyThrough(inputPath, outputPath)
    return {
      applied: false,
      inputCrestFactorDb: null,
      targetCrestFactorDb: null,
      skipReason: 'Compression disabled for this preset',
      thresholdPercentile: null,
      thresholdDbfs: null,
      derivedRatio: null,
      derivedGainReductionDb: null,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
      finalCrestFactorDb: null,
    }
  }

  const { channels, sampleRate } = await readWavAllChannels(inputPath)
  const analysisSamples = channels[0]

  // Step 1: Measure input crest factor on voiced frames
  const { peakDbfs, inputCrestFactorDb, frameRmsValues } =
    measureVoicedCrestFactor(analysisSamples, frameAnalysis)

  if (inputCrestFactorDb === null || peakDbfs === null) {
    console.log('[compression] Compression skipped — no voiced frames available for crest-factor measurement.')
    await copyThrough(inputPath, outputPath)
    return {
      applied: false,
      inputCrestFactorDb: null,
      targetCrestFactorDb,
      skipReason: 'No voiced frames / insufficient voiced content',
      thresholdPercentile: null,
      thresholdDbfs: null,
      derivedRatio: null,
      derivedGainReductionDb: null,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
      finalCrestFactorDb: null,
    }
  }

  // Step 2: Skip if already within target (including 0.5 dB margin)
  if (inputCrestFactorDb <= targetCrestFactorDb + SKIP_MARGIN_DB) {
    console.log(
      `[compression] Compression skipped — input crest factor ${round2(inputCrestFactorDb)} dB` +
      ` already within target ${targetCrestFactorDb} dB.`
    )
    await copyThrough(inputPath, outputPath)
    return {
      applied: false,
      inputCrestFactorDb: round2(inputCrestFactorDb),
      targetCrestFactorDb,
      skipReason: 'Input crest factor within target',
      thresholdPercentile: null,
      thresholdDbfs: null,
      derivedRatio: null,
      derivedGainReductionDb: null,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
      finalCrestFactorDb: round2(inputCrestFactorDb), // Final = input when compression skipped
    }
  }

  // Step 3: Derive threshold from voiced-frame RMS percentile
  const { thresholdDbfs } = deriveThreshold(frameRmsValues, thresholdPercentile)

  // Step 4: Adjust threshold if needed and derive ratio using simple calculation
  const requiredReductionDb = inputCrestFactorDb - targetCrestFactorDb

  const thresholdAdjustment = adjustCompressionThreshold(
    analysisSamples,
    frameAnalysis,
    thresholdDbfs,
    requiredReductionDb
  )

  // MT - Replace Ratio Calculation with Simple Calc
  const reductionNeeded = inputCrestFactorDb - targetCrestFactorDb
  const finalThresholdDbfs = thresholdAdjustment.adjustedThreshold || thresholdDbfs
  const amplitude = peakDbfs - finalThresholdDbfs
  const newAmp = amplitude - reductionNeeded
  const derivedRatio = amplitude / newAmp


  // Step 5: Build gain curve from channel 0, apply to all channels
  const compParams = {
    thresholdDb:  finalThresholdDbfs,
    ratio:        derivedRatio,
    attackMs:     attack,
    releaseMs:    release,
    kneeDb:       KNEE_WIDTH_DB,
    makeupGainDb: 0,
  }
  const gainCurve        = buildCompressionGainCurve(analysisSamples, sampleRate, compParams)
  const processedChannels = channels.map(ch =>
    applyCompressionGainCurve(ch, gainCurve.curve, compParams.makeupGainDb)
  )

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  // Step 6: Measure final crest factor on the compressed audio
  const finalCrestFactorDb = measureFinalCrestFactor(processedChannels[0], frameAnalysis)

  return {
    applied: true,
    inputCrestFactorDb:     round2(inputCrestFactorDb),
    targetCrestFactorDb,
    skipReason: null,
    thresholdPercentile,
    thresholdDbfs:          round2(finalThresholdDbfs),
    derivedRatio:           round2(derivedRatio),
    derivedGainReductionDb: round2(requiredReductionDb),
    maxGainReductionDb:     round2(gainCurve.maxGainReductionDb),
    avgGainReductionDb:     round2(gainCurve.avgGainReductionDb),
    finalCrestFactorDb:     round2(finalCrestFactorDb),
  }
}

// ── Crest Factor Measurement ────────────────────────────────────────────────

/**
 * Measure crest factor on voiced frames only.
 *
 * Returns peak dBFS, overall voiced RMS dBFS, crest factor (peak - RMS), and
 * an array of per-frame RMS values in dBFS for threshold percentile derivation.
 *
 * @param {Float32Array} samples
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @returns {{ peakDbfs: number|null, voicedRmsDbfs: number|null, inputCrestFactorDb: number|null, frameRmsValues: number[] }}
 */
function measureVoicedCrestFactor(samples, frameAnalysis) {
  let sumSq = 0
  let count = 0
  let peak  = 0
  const frameRmsValues = []

  for (const frame of frameAnalysis.frames) {
    if (frame.isSilence) continue
    const start = frame.offsetSamples
    const end   = Math.min(start + frame.lengthSamples, samples.length)
    if (end <= start) continue

    let frameSumSq = 0
    let frameCount = 0
    for (let i = start; i < end; i++) {
      const abs = Math.abs(samples[i])
      const sq  = samples[i] * samples[i]
      sumSq     += sq
      frameSumSq += sq
      if (abs > peak) peak = abs
      count++
      frameCount++
    }
    if (frameCount > 0) {
      const frameRms   = Math.sqrt(frameSumSq / frameCount)
      const frameRmsDb = frameRms > 0 ? 20 * Math.log10(frameRms) : -120
      frameRmsValues.push(frameRmsDb)
    }
  }

  if (count === 0 || peak === 0) {
    return { peakDbfs: null, voicedRmsDbfs: null, inputCrestFactorDb: null, frameRmsValues: [] }
  }

  const voicedRms     = Math.sqrt(sumSq / count)
  const peakDbfs      = 20 * Math.log10(peak)
  const voicedRmsDbfs = voicedRms > 0 ? 20 * Math.log10(voicedRms) : -120



  return {
    peakDbfs,
    voicedRmsDbfs,
    inputCrestFactorDb: peakDbfs - voicedRmsDbfs,
    frameRmsValues,
  }
}

/**
 * Measure final crest factor on the compressed audio using the same voiced frames
 * that were used for the input measurement.
 *
 * @param {Float32Array} compressedSamples - Compressed audio samples
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis - Frame analysis from input
 * @returns {number|null} Final crest factor in dB, or null if no voiced frames
 */
function measureFinalCrestFactor(compressedSamples, frameAnalysis) {
  let sumSq = 0
  let count = 0
  let peak  = 0

  for (const frame of frameAnalysis.frames) {
    if (frame.isSilence) continue
    const start = frame.offsetSamples
    const end   = Math.min(start + frame.lengthSamples, compressedSamples.length)
    if (end <= start) continue

    for (let i = start; i < end; i++) {
      const abs = Math.abs(compressedSamples[i])
      const sq  = compressedSamples[i] * compressedSamples[i]
      sumSq     += sq
      if (abs > peak) peak = abs
      count++
    }
  }

  if (count === 0 || peak === 0) {
    return null
  }

  const voicedRms     = Math.sqrt(sumSq / count)
  const peakDbfs      = 20 * Math.log10(peak)
  const voicedRmsDbfs = voicedRms > 0 ? 20 * Math.log10(voicedRms) : -120



  return peakDbfs - voicedRmsDbfs
}

// ── Threshold Adjustment for Compression ────────────────────────────────────

/**
 * Adjust compression threshold when needed.
 *
 * Handles threshold adjustment when the original threshold is above the peak level,
 * which is common with quiet files.
 *
 * @param {Float32Array} samples - Input audio samples
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis - Frame analysis
 * @param {number} thresholdDbfs - Compression threshold in dBFS
 * @param {number} requiredReductionDb - Required crest factor reduction in dB
 * @returns {{adjustedThreshold?: number}}
 */
function adjustCompressionThreshold(samples, frameAnalysis, thresholdDbfs, requiredReductionDb) {
  const peakDbfs = measureVoicedCrestFactor(samples, frameAnalysis).peakDbfs
  let adjustedThreshold = thresholdDbfs

  // If threshold is above peak (common with quiet files), adjust it based on required reduction
  if (thresholdDbfs >= peakDbfs) {
    // Calculate threshold to provide enough headroom for the required reduction
    // We want: (peak - threshold) * (1 - 1/ratio) >= requiredReduction
    // For max ratio (6:1): (peak - threshold) * (5/6) >= requiredReduction
    // Therefore: threshold <= peak - (requiredReduction * 6/5)
    const minHeadroom = requiredReductionDb * 1.5 // Add 50% margin for effectiveness
    adjustedThreshold = Math.min(thresholdDbfs, peakDbfs - minHeadroom)
    console.log(`[compression] Adjusted threshold from ${thresholdDbfs.toFixed(1)} to ${adjustedThreshold.toFixed(1)} dBFS (peak: ${peakDbfs.toFixed(1)} dBFS, required: ${requiredReductionDb.toFixed(1)} dB)`)
  }

  return { adjustedThreshold: adjustedThreshold !== thresholdDbfs ? adjustedThreshold : undefined }
}

// ── Threshold Derivation ────────────────────────────────────────────────────

/**
 * Derive compression threshold from the percentile of voiced-frame RMS values.
 *
 * Falls back to a fixed threshold when fewer than MIN_VOICED_FRAMES are available.
 *
 * @param {number[]} frameRmsValues - Per-frame RMS in dBFS for all voiced frames
 * @param {number} percentile       - Fractional (0.0–1.0); e.g. 0.75 = 75th percentile
 * @returns {{ thresholdDbfs: number, usedFallback: boolean }}
 */
function deriveThreshold(frameRmsValues, percentile) {
  if (frameRmsValues.length < MIN_VOICED_FRAMES) {
    console.log(
      `[compression] Fewer than ${MIN_VOICED_FRAMES} voiced frames — ` +
      `falling back to fixed threshold ${FALLBACK_THRESHOLD_DBFS} dBFS`
    )
    return { thresholdDbfs: FALLBACK_THRESHOLD_DBFS, usedFallback: true }
  }

  const sorted = [...frameRmsValues].sort((a, b) => a - b)
  const idx    = Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1))
  return { thresholdDbfs: sorted[idx], usedFallback: false }
}

// ── Compressor DSP ──────────────────────────────────────────────────────────

/**
 * Build a per-sample gain reduction curve (feed-forward, RMS detection).
 *
 * Level detection: power-domain envelope follower with attack/release time
 * constants. Gain computer applies soft-knee compression.
 *
 * @returns {{ curve: Float32Array, maxGainReductionDb: number, avgGainReductionDb: number }}
 */
function buildCompressionGainCurve(samples, sampleRate, params) {
  const { thresholdDb, ratio, attackMs, releaseMs, kneeDb } = params
  const n = samples.length

  const attackCoeff  = Math.exp(-1 / (sampleRate * attackMs / 1000))
  const releaseCoeff = Math.exp(-1 / (sampleRate * releaseMs / 1000))

  const curve = new Float32Array(n)
  let powerEnv         = 0
  let maxGainReductionDb = 0
  let totalGainReductionDb = 0
  let activeFrames     = 0

  for (let i = 0; i < n; i++) {
    const xPow = samples[i] * samples[i]

    if (xPow > powerEnv) {
      powerEnv = attackCoeff * powerEnv + (1 - attackCoeff) * xPow
    } else {
      powerEnv = releaseCoeff * powerEnv + (1 - releaseCoeff) * xPow
    }

    const levelDb        = powerEnv > 1e-14 ? 10 * Math.log10(powerEnv) : -120
    const gainReductionDb = computeGainReduction(levelDb, thresholdDb, ratio, kneeDb)

    curve[i] = gainReductionDb
    if (gainReductionDb > 0) {
      if (gainReductionDb > maxGainReductionDb) maxGainReductionDb = gainReductionDb
      totalGainReductionDb += gainReductionDb
      activeFrames++
    }
  }

  const avgGainReductionDb = activeFrames > 0 ? totalGainReductionDb / activeFrames : 0
  return { curve, maxGainReductionDb, avgGainReductionDb }
}

/**
 * Apply a compression gain curve to a single channel.
 */
function applyCompressionGainCurve(samples, curve, makeupGainDb) {
  const n      = samples.length
  const output = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const gainLin = Math.pow(10, (-curve[i] + makeupGainDb) / 20)
    output[i] = samples[i] * gainLin
  }
  return output
}

/**
 * Soft-knee gain computer.
 *
 * Returns gain reduction in dB (positive = attenuation).
 *
 * @param {number} levelDb     - Input level in dBFS
 * @param {number} thresholdDb - Compression threshold in dBFS
 * @param {number} ratio       - Compression ratio (e.g. 3 for 3:1)
 * @param {number} kneeDb      - Knee width in dB (symmetric around threshold)
 */
function computeGainReduction(levelDb, thresholdDb, ratio, kneeDb) {
  const halfKnee = kneeDb / 2
  const x = levelDb - thresholdDb

  if (x < -halfKnee) {
    return 0
  } else if (x <= halfKnee) {
    // Quadratic interpolation through knee
    const t = x + halfKnee
    return (1 - 1 / ratio) * (t * t) / (2 * kneeDb)
  } else {
    // Full compression above knee
    const cornerReduction = (1 - 1 / ratio) * (kneeDb / 2)
    return cornerReduction + (1 - 1 / ratio) * (x - halfKnee)
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}

async function copyThrough(inputPath, outputPath) {
  const { readFile, writeFile } = await import('fs/promises')
  await writeFile(outputPath, await readFile(inputPath))
}
