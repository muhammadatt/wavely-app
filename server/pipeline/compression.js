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
 * @property {number|null} thresholdDbfs         - Derived threshold in dBFS (when applied)
 * @property {number|null} derivedRatio          - Derived compression ratio (when applied)
 * @property {number|null} derivedGainReductionDb - Expected gain reduction at the peak (when applied)
 * @property {number|null} maxGainReductionDb    - Peak gain reduction during processing
 * @property {number|null} avgGainReductionDb    - Average gain reduction applied
 * @property {number|null} finalCrestFactorDb    - Achieved crest factor after compression (when applied)
 * @property {number|null} inputPeakDbfs         - Input peak level in dBFS
 * @property {number|null} inputVoicedRmsDbfs    - Input voiced RMS level in dBFS
 * @property {number|null} outputPeakDbfs        - Output peak level in dBFS
 * @property {number|null} outputVoicedRmsDbfs   - Output voiced RMS level in dBFS
 * @property {number|null} samplesExceedingThreshold - Number of samples exceeding compression threshold (when applied)
 * @property {number|null} percentAboveThreshold - Percentage of samples exceeding threshold (when applied)
 * @property {number|null} pOutDbfs              - Target output peak level (pOut) in dBFS (when applied)
 * @property {Array|null} passes                 - Array of individual compression pass results for serial compression
 */
export async function applyCompression(inputPath, outputPath, presetId, frameAnalysis) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error(`Unknown preset: ${presetId}`)

  const presetComp = preset?.compression

  if (!presetComp) {
    await copyThrough(inputPath, outputPath)
    return {
      applied: false,
      inputCrestFactorDb: null,
      targetCrestFactorDb: null,
      finalCrestFactorDb: null,
      skipReason: 'Compression not enabled for this preset',
      thresholdDbfs: null,
      derivedRatio: null,
      derivedGainReductionDb: null,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
      inputPeakDbfs: null,
      inputVoicedRmsDbfs: null,
      outputPeakDbfs: null,
      outputVoicedRmsDbfs: null,
      percentAboveThreshold: null,
      pOutDbfs: null,
      passes: null,
    }
  }

  // Handle both single compression config and array of compression configs
  const compressionConfigs = Array.isArray(presetComp) ? presetComp : [presetComp]

  // Return early if no compression configs
  if (compressionConfigs.length === 0) {
    await copyThrough(inputPath, outputPath)
    return {
      applied: false,
      inputCrestFactorDb: null,
      targetCrestFactorDb: null,
      skipReason: 'No compression configurations provided',
      thresholdDbfs: null,
      derivedRatio: null,
      derivedGainReductionDb: null,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
      finalCrestFactorDb: null,
      inputPeakDbfs: null,
      inputVoicedRmsDbfs: null,
      outputPeakDbfs: null,
      outputVoicedRmsDbfs: null,
      samplesExceedingThreshold: null,
      percentAboveThreshold: null,
      pOutDbfs: null,
      passes: null,
    }
  }

  // Apply serial compression passes
  return await applySerialCompression(inputPath, outputPath, compressionConfigs, frameAnalysis)
}

/**
 * Apply multiple compression passes in series.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Object[]} compressionConfigs - Array of compression configurations
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @returns {Promise<Object>} Aggregated compression result with data from all passes
 */
async function applySerialCompression(inputPath, outputPath, compressionConfigs, frameAnalysis) {
  const fs = await import('fs/promises')

  let currentInputPath = inputPath
  let tempPaths = []
  const passes = []
  let overallInputCrestFactorDb = null
  let overallFinalCrestFactorDb = null
  let originalVoicedRmsDbfs = null

  try {
    for (let i = 0; i < compressionConfigs.length; i++) {
      const config = compressionConfigs[i]
      const isLastPass = i === compressionConfigs.length - 1

      // For the last pass, write to the final output path
      // For intermediate passes, create temporary files
      let currentOutputPath
      if (isLastPass) {
        currentOutputPath = outputPath
      } else {
        currentOutputPath = outputPath.replace(/\.wav$/, `_temp_pass_${i + 1}.wav`)
        tempPaths.push(currentOutputPath)
      }

      console.log(`[compression] Starting compression pass ${i + 1}/${compressionConfigs.length} - Input: ${currentInputPath}, Output: ${currentOutputPath}`)

      // Apply single compression pass
      const passResult = await applySingleCompressionPass(
        currentInputPath,
        currentOutputPath,
        config,
        frameAnalysis,
        originalVoicedRmsDbfs
      )

      // Store the initial input crest factor from the first pass
      if (i === 0) {
        overallInputCrestFactorDb = passResult.inputCrestFactorDb
        originalVoicedRmsDbfs = passResult.inputVoicedRmsDbfs
      }

      // Store the final crest factor from the last pass
      if (isLastPass || passResult.finalCrestFactorDb !== null) {
        overallFinalCrestFactorDb = passResult.finalCrestFactorDb
      }

      passes.push({
        passNumber: i + 1,
        config: config,
        result: passResult
      })

      // Update input path for next pass (unless this is the last pass)
      if (!isLastPass) {
        currentInputPath = currentOutputPath
      }

      // If compression was skipped, break early and copy through remaining passes
      if (!passResult.applied) {
        console.log(`[compression] Pass ${i + 1} skipped, ending compression chain early`)
        if (!isLastPass) {
          await copyThrough(currentInputPath, outputPath)
        }
        break
      }
    }

    return {
      applied: passes.some(p => p.result.applied),
      inputCrestFactorDb: overallInputCrestFactorDb,
      targetCrestFactorDb: passes.length > 0 ? passes[passes.length - 1].result.targetCrestFactorDb : null,
      finalCrestFactorDb: overallFinalCrestFactorDb,
      passes: passes,
      // Legacy fields for backward compatibility (aggregate from all passes)

      // pOut from the last applied pass
      pOutDbfs: passes.length > 0 ? passes[passes.length - 1].result.pOutDbfs : null,
      thresholdDbfs: passes.length > 0 ? passes[passes.length - 1].result.thresholdDbfs : null,
      derivedRatio: passes.length > 0 ? passes[passes.length - 1].result.derivedRatio : null,
      derivedGainReductionDb: passes.length > 0 ? passes[passes.length - 1].result.derivedGainReductionDb : null,
      maxGainReductionDb: passes.reduce((max, p) => Math.max(max, p.result.maxGainReductionDb || 0), 0),
      avgGainReductionDb: passes.length > 0 ? passes.reduce((sum, p) => sum + (p.result.avgGainReductionDb || 0), 0) / passes.filter(p => p.result.applied).length : null,
      // Peak and RMS metrics: input from first pass, output from last applied pass
      inputPeakDbfs: passes.length > 0 ? passes[0].result.inputPeakDbfs : null,
      outputPeakDbfs: passes.length > 0 ? passes[passes.length - 1].result.outputPeakDbfs : null,
      inputVoicedRmsDbfs: passes.length > 0 ? passes[0].result.inputVoicedRmsDbfs : null,
      outputVoicedRmsDbfs: passes.length > 0 ? passes[passes.length - 1].result.outputVoicedRmsDbfs : null,
      // Threshold exceedance metrics: sum across all applied passes
      percentAboveTheshold: passes.length > 0 ? passes[passes.length - 1].result.percentAboveThreshold : null,
    }

  } finally {
    // Clean up temporary files
    for (const tempPath of tempPaths) {
      try {
        await fs.unlink(tempPath)
      } catch (err) {
        console.warn(`[compression] Failed to clean up temp file ${tempPath}:`, err)
      }
    }
  }
}

/**
 * Apply a single compression pass. This is the original compression logic
 * extracted from applyCompression.
 */
async function applySingleCompressionPass(inputPath, outputPath, config, frameAnalysis, originalVoicedRmsDbfs = null) {
  const { targetCrestFactorDb, attack, release, threshold = "auto", follow = true, maxRatio = 5 } = config

  const { channels, sampleRate } = await readWavAllChannels(inputPath)
  const analysisSamples = channels[0]

  // Step 1: Measure input crest factor on voiced frames
  const { peakDbfs, voicedRmsDbfs, inputCrestFactorDb, frameRmsValues } =
    measureVoicedCrestFactor(analysisSamples, frameAnalysis)

  // Debug: Log input measurements for this pass (verify fresh measurements)
  console.log(`[compression] Pass input measurements - Peak: ${peakDbfs?.toFixed(2)} dBFS, Voiced RMS: ${voicedRmsDbfs?.toFixed(2)} dBFS, Crest Factor: ${inputCrestFactorDb?.toFixed(2)} dB`)

  if (inputCrestFactorDb === null || peakDbfs === null) {
    console.log('[compression] Compression skipped — no voiced frames available for crest-factor measurement.')
    await copyThrough(inputPath, outputPath)
    return {
      applied: false,
      inputCrestFactorDb: null,
      targetCrestFactorDb,
      finalCrestFactorDb: null,
      skipReason: 'No voiced frames / insufficient voiced content',
      thresholdDbfs: null,
      derivedRatio: null,
      derivedGainReductionDb: null,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
      inputPeakDbfs: null,
      inputVoicedRmsDbfs: null,
      outputPeakDbfs: null,
      outputVoicedRmsDbfs: null,
      samplesExceedingThreshold: null,
      percentAboveThreshold: null,
      pOutDbfs: null,
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
      finalCrestFactorDb: round2(inputCrestFactorDb), // Final = input when compression skipped
      skipReason: 'Input crest factor within target',
      thresholdDbfs: null,
      derivedRatio: null,
      derivedGainReductionDb: null,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
      inputPeakDbfs: round2(peakDbfs),
      inputVoicedRmsDbfs: round2(voicedRmsDbfs),
      outputPeakDbfs: round2(peakDbfs), // Same as input when compression skipped
      outputVoicedRmsDbfs: round2(voicedRmsDbfs), // Same as input when compression skipped
      percentAboveThreshold: null,
      pOutDbfs: null,
    }
  }

  // Step 3: Set threshold based on distance of peak from targeted peak
  //const thresholdDbfs = peakDbfs - targetCrestFactorDb

  // Step 3: Set threshold based on preset configuration
  let thresholdDbfs;
  let referenceRmsForThreshold = voicedRmsDbfs;

  if (typeof threshold === 'number') {
    thresholdDbfs = threshold;
    console.log(`[compression] Threshold derivation - Using fixed threshold: ${thresholdDbfs.toFixed(2)} dBFS`);
  } else if (threshold === 'auto') {
    if (follow === false && originalVoicedRmsDbfs !== null) {
      referenceRmsForThreshold = originalVoicedRmsDbfs;
      thresholdDbfs = referenceRmsForThreshold + targetCrestFactorDb;
      console.log(`[compression] Threshold derivation - Using original RMS ${referenceRmsForThreshold.toFixed(2)} dBFS (follow: false), target crest ${targetCrestFactorDb} dB = threshold ${thresholdDbfs.toFixed(2)} dBFS`);
    } else {
      referenceRmsForThreshold = voicedRmsDbfs;
      thresholdDbfs = referenceRmsForThreshold + targetCrestFactorDb;
      console.log(`[compression] Threshold derivation - Using current RMS ${referenceRmsForThreshold.toFixed(2)} dBFS (follow: true), target crest ${targetCrestFactorDb} dB = threshold ${thresholdDbfs.toFixed(2)} dBFS`);
    }
  } else {
    // Fallback
    thresholdDbfs = voicedRmsDbfs + targetCrestFactorDb;
    console.log(`[compression] Threshold derivation - Using fallback current RMS ${voicedRmsDbfs.toFixed(2)} dBFS, target crest ${targetCrestFactorDb} dB = threshold ${thresholdDbfs.toFixed(2)} dBFS`);
  }

  // Step 4: Adjust threshold if needed and derive ratio using simple calculation
  const requiredReductionDb = inputCrestFactorDb - targetCrestFactorDb

  let finalThresholdDbfs = thresholdDbfs
  if (threshold === 'auto') {
    const thresholdAdjustment = adjustCompressionThreshold(
      analysisSamples,
      frameAnalysis,
      thresholdDbfs,
      requiredReductionDb,
      maxRatio
    )
    finalThresholdDbfs = thresholdAdjustment.adjustedThreshold || thresholdDbfs
  }

  // MT - Replace Ratio Calculation with Simple Calc
  const pIn = peakDbfs
  const pOut = pIn - requiredReductionDb
  const calculatedRatio = (pIn - finalThresholdDbfs) / Math.max(pOut - finalThresholdDbfs, 0.001) // Prevent division by zero
  const derivedRatio = Math.min(calculatedRatio, maxRatio)

  // Debug: Log ratio calculation details (verify using current pass peak)
  console.log(`[compression] Ratio calculation - pIn: ${pIn?.toFixed(2)}, pOut: ${pOut?.toFixed(2)}, finalThreshold: ${finalThresholdDbfs?.toFixed(2)}, derivedRatio: ${derivedRatio?.toFixed(2)}`)

  // amplitude = peakDbfs - finalThresholdDbfs
  //const newAmp = amplitude - requiredReductionDb
  //const ratio = amplitude / newAmp

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

  // Apply makeup gain to bring output RMS back to input RMS
  const { voicedRmsDbfs: tempOutputVoicedRmsDbfs } = measureVoicedCrestFactor(processedChannels[0], frameAnalysis)

  let appliedMakeupGainDb = 0
  if (tempOutputVoicedRmsDbfs !== null && tempOutputVoicedRmsDbfs !== -120 && voicedRmsDbfs !== null) {
    appliedMakeupGainDb = voicedRmsDbfs - tempOutputVoicedRmsDbfs
    if (Math.abs(appliedMakeupGainDb) > 0.01) {
      console.log(`[compression] Applying makeup gain: ${appliedMakeupGainDb.toFixed(2)} dB (Input RMS: ${voicedRmsDbfs.toFixed(2)}, Pre-makeup Output RMS: ${tempOutputVoicedRmsDbfs.toFixed(2)})`)
      const gainLin = Math.pow(10, appliedMakeupGainDb / 20)
      for (let c = 0; c < processedChannels.length; c++) {
        const ch = processedChannels[c]
        for (let i = 0; i < ch.length; i++) {
          ch[i] *= gainLin
        }
      }
    }
  }

  // Debug: Log threshold exceedance statistics and pOut
  console.log(`[compression] Pass summary - Threshold: ${finalThresholdDbfs.toFixed(2)} dBFS, pOut: ${pOut.toFixed(2)} dBFS, Samples exceeding threshold: ${gainCurve.samplesExceedingThreshold}, Percentage: ${gainCurve.percentAboveThreshold.toFixed(2)}%`)

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  // Step 6: Measure final crest factor, peak, and RMS on the compressed audio
  const finalCrestFactorDb = measureFinalCrestFactor(processedChannels[0], frameAnalysis)
  const { peakDbfs: outputPeakDbfs, voicedRmsDbfs: outputVoicedRmsDbfs } =
    measureVoicedCrestFactor(processedChannels[0], frameAnalysis)

  return {
    applied: true,
    skipReason: null,
    inputCrestFactorDb:     round2(inputCrestFactorDb),
    targetCrestFactorDb,
    finalCrestFactorDb:     round2(finalCrestFactorDb),
    thresholdDbfs:          round2(finalThresholdDbfs),
    derivedRatio:           round2(derivedRatio),
    derivedGainReductionDb: round2(requiredReductionDb),
    maxGainReductionDb:     round2(gainCurve.maxGainReductionDb),
    avgGainReductionDb:     round2(gainCurve.avgGainReductionDb),
    makeupGainDb:           round2(appliedMakeupGainDb),
    inputPeakDbfs:          round2(peakDbfs),
    targetPeakOut:          round2(pOut),
    outputPeakDbfs:         round2(outputPeakDbfs),
    inputVoicedRmsDbfs:     round2(voicedRmsDbfs),
    outputVoicedRmsDbfs:    round2(outputVoicedRmsDbfs),
    percentAboveThreshold: round2(gainCurve.percentAboveThreshold),
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
 * @param {number} maxRatio - Maximum allowed compression ratio
 * @returns {{adjustedThreshold?: number}}
 */
function adjustCompressionThreshold(samples, frameAnalysis, thresholdDbfs, requiredReductionDb, maxRatio = 5) {
  const peakDbfs = measureVoicedCrestFactor(samples, frameAnalysis).peakDbfs
  let adjustedThreshold = thresholdDbfs

  // Ensure threshold provides enough headroom for the required reduction
  // We want: (peak - threshold) * (1 - 1/ratio) >= requiredReduction
  // Therefore: threshold <= peak - (requiredReduction / (1 - 1/maxRatio))
  const headroomFactor = 1 / (1 - 1/maxRatio)
  const minHeadroom = requiredReductionDb * headroomFactor
  if (thresholdDbfs > peakDbfs - minHeadroom) {
    adjustedThreshold = Math.min(thresholdDbfs, peakDbfs - minHeadroom)
    console.log(`[compression] Adjusted threshold from ${thresholdDbfs.toFixed(1)} to ${adjustedThreshold.toFixed(1)} dBFS (peak: ${peakDbfs.toFixed(1)} dBFS, required: ${requiredReductionDb.toFixed(1)} dB, maxRatio: ${maxRatio}:1)`)
  }

  return { adjustedThreshold: adjustedThreshold !== thresholdDbfs ? adjustedThreshold : undefined }
}

// ── Compressor DSP ──────────────────────────────────────────────────────────

/**
 * Build a per-sample gain reduction curve (feed-forward, RMS detection).
 *
 * Level detection: power-domain envelope follower with attack/release time
 * constants. Gain computer applies soft-knee compression.
 *
 * @returns {{ curve: Float32Array, maxGainReductionDb: number, avgGainReductionDb: number, samplesExceedingThreshold: number, percentAboveThreshold: number }}
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
  let samplesExceedingThreshold = 0

  for (let i = 0; i < n; i++) {
    const xPow = samples[i] * samples[i]

    if (xPow > powerEnv) {
      powerEnv = attackCoeff * powerEnv + (1 - attackCoeff) * xPow
    } else {
      powerEnv = releaseCoeff * powerEnv + (1 - releaseCoeff) * xPow
    }

    const levelDb        = powerEnv > 1e-14 ? 10 * Math.log10(powerEnv) : -120
    const gainReductionDb = computeGainReduction(levelDb, thresholdDb, ratio, kneeDb)

    // Count samples that exceed the threshold (have gain reduction applied)
    if (levelDb > thresholdDb) {
      samplesExceedingThreshold++
    }

    curve[i] = gainReductionDb
    if (gainReductionDb > 0) {
      if (gainReductionDb > maxGainReductionDb) maxGainReductionDb = gainReductionDb
      totalGainReductionDb += gainReductionDb
      activeFrames++
    }
  }

  const avgGainReductionDb = activeFrames > 0 ? totalGainReductionDb / activeFrames : 0
  const percentAboveThreshold = n > 0 ? (samplesExceedingThreshold / n) * 100 : 0
  return { curve, maxGainReductionDb, avgGainReductionDb, samplesExceedingThreshold, percentAboveThreshold }
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
