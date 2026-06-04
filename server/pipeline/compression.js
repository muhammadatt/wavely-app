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
 *   6. Apply feed-forward sample-peak compressor with soft knee and optional
 *      forward lookahead. Attack/release smooth the gain-reduction signal, not
 *      the level estimate, so the detector always sees the true sample peak.
 *
 * Fixed parameters (per spec): attack, release, knee width, makeup gain = 0 dB.
 * Ratio clamping has been removed in favor of simple calculation.
 */

import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels } from './wavWriter.js'

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
 * @param {object} preset
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
export async function applyCompression(inputPath, outputPath, preset, frameAnalysis) {
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
 * Reads the input WAV once, runs all passes against the in-memory buffer,
 * and writes the final result once. Each pass still re-measures the
 * current buffer's crest factor and derives its threshold from those
 * fresh measurements — the threshold-update semantics are unchanged from
 * the previous file-based serial path. The only thing that moves to RAM
 * is the inter-pass buffer (~125 MB for a 12-min mono float32 file at
 * 44.1 kHz), eliminating two intermediate WAV writes + two reads on a
 * 3-pass chain.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Object[]} compressionConfigs - Array of compression configurations
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @returns {Promise<Object>} Aggregated compression result with data from all passes
 */
async function applySerialCompression(inputPath, outputPath, compressionConfigs, frameAnalysis) {
  // Read the input WAV once. Intermediate passes run against the in-memory
  // buffer; the final processed buffer is written out at the end. Channels
  // is an Array<Float32Array>; processedChannels is reassigned per pass to
  // the freshly compressed channels.
  const { channels: inputChannels, sampleRate } = await readWavAllChannels(inputPath)
  let processedChannels = inputChannels
  let originalVoicedRmsDbfs = null

  const passes = []
  let overallInputCrestFactorDb = null
  let overallFinalCrestFactorDb = null

  for (let i = 0; i < compressionConfigs.length; i++) {
    const config = compressionConfigs[i]

    console.log(`[compression] Starting compression pass ${i + 1}/${compressionConfigs.length} (in-memory)`)

    const passResult = await applySingleCompressionPass(
      processedChannels,
      sampleRate,
      config,
      frameAnalysis,
      originalVoicedRmsDbfs,
    )

    if (i === 0) {
      overallInputCrestFactorDb = passResult.inputCrestFactorDb
      originalVoicedRmsDbfs     = passResult.inputVoicedRmsDbfs
    }

    if (passResult.finalCrestFactorDb !== null) {
      overallFinalCrestFactorDb = passResult.finalCrestFactorDb
    }

    passes.push({
      passNumber: i + 1,
      config,
      result:     passResult,
    })

    // Hand off the freshly compressed buffer to the next pass, or stop the
    // chain early if this pass skipped (no voiced frames, or already within
    // target). On skip, processedChannels is unchanged.
    if (passResult.applied) {
      processedChannels = passResult.processedChannels
    } else {
      console.log(`[compression] Pass ${i + 1} skipped, ending compression chain early`)
      break
    }
  }

  // Persist the final buffer. When no pass applied (e.g. first pass found
  // input already within target), fall back to copyThrough so the output
  // is a byte-for-byte copy of the input WAV — preserves chunk layout and
  // any non-audio chunks. When at least one pass applied, the buffer has
  // genuinely changed; serialise it via writeWavChannels.
  const anyApplied = passes.some(p => p.result.applied)
  if (anyApplied) {
    await writeWavChannels(processedChannels, sampleRate, outputPath)
  } else {
    await copyThrough(inputPath, outputPath)
  }

  // processedChannels references on the pass results were only needed to
  // hand the buffer to the next pass; strip them before returning so the
  // result object doesn't pin ~125 MB of float32 data in memory after
  // the caller awaits this promise.
  for (const p of passes) delete p.result.processedChannels

  // The aggregate "last pass" metrics describe what the chain actually did,
  // so they pull from the last pass that APPLIED — not the last pass that
  // ran. With break-early-on-skip, the last entry in `passes` may be the
  // skipped pass that ended the chain, whose threshold/ratio/output fields
  // are null. Falling back to the last applied pass keeps these fields
  // populated whenever any compression ran.
  const lastApplied = [...passes].reverse().find(p => p.result.applied) ?? null
  const lastResult  = lastApplied?.result ?? null
  const firstResult = passes[0]?.result ?? null
  const appliedCount = passes.filter(p => p.result.applied).length

  return {
    applied: anyApplied,
    inputCrestFactorDb: overallInputCrestFactorDb,
    targetCrestFactorDb: lastResult?.targetCrestFactorDb ?? null,
    finalCrestFactorDb: overallFinalCrestFactorDb,
    passes: passes,
    // Legacy aggregate fields — derived from the last APPLIED pass so
    // skip-early scenarios still report meaningful values.
    pOutDbfs:               lastResult?.pOutDbfs               ?? null,
    thresholdDbfs:          lastResult?.thresholdDbfs          ?? null,
    derivedRatio:           lastResult?.derivedRatio           ?? null,
    derivedGainReductionDb: lastResult?.derivedGainReductionDb ?? null,
    maxGainReductionDb: passes.reduce((max, p) => Math.max(max, p.result.maxGainReductionDb || 0), 0),
    avgGainReductionDb: appliedCount > 0
      ? passes.reduce((sum, p) => sum + (p.result.avgGainReductionDb || 0), 0) / appliedCount
      : null,
    // Peak and RMS metrics: input from first pass (whether it applied or
    // not — measurement still ran), output from last applied pass.
    inputPeakDbfs:       firstResult?.inputPeakDbfs       ?? null,
    outputPeakDbfs:      lastResult?.outputPeakDbfs       ?? null,
    inputVoicedRmsDbfs:  firstResult?.inputVoicedRmsDbfs  ?? null,
    outputVoicedRmsDbfs: lastResult?.outputVoicedRmsDbfs  ?? null,
    // Correctly spelled key — `percentAboveTheshold` (typo) kept as an
    // alias for any existing consumer that read the legacy name.
    percentAboveThreshold: lastResult?.percentAboveThreshold ?? null,
    percentAboveTheshold:  lastResult?.percentAboveThreshold ?? null,
  }
}

/**
 * Apply a single compression pass against an in-memory channel buffer.
 *
 * Each pass re-measures the input crest factor on its own input — the
 * same threshold-derivation logic that the previous file-based version
 * used. The freshly compressed channels are returned on the result as
 * `processedChannels`; the serial driver hands them to the next pass
 * (or writes them to disk if this is the last applied pass). Skipped
 * passes return `applied: false` and no processedChannels — the driver
 * keeps the input buffer for downstream use.
 *
 * @param {Float32Array[]} inputChannels
 * @param {number} sampleRate
 * @param {Object} config
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @param {number|null} originalVoicedRmsDbfs - First pass's voicedRmsDbfs (for `follow: false` mode)
 */
async function applySingleCompressionPass(inputChannels, sampleRate, config, frameAnalysis, originalVoicedRmsDbfs = null) {
  const { targetCrestFactorDb, attack, release, threshold = "auto", follow = true, maxRatio = 5, lookahead } = config
  // Forward lookahead window for the sample-peak detector. Defaults to the
  // attack time (capped at 10 ms) so the gain ramp can complete before the
  // peak arrives without over-anticipating on slow-attack passes. Setting
  // lookahead: 0 disables anticipation and lets transients pass through the
  // attack window — useful if the slow-attack pass is intended as a leveler.
  const lookaheadMs = typeof lookahead === 'number' ? lookahead : Math.min(attack, 10)

  const analysisSamples = inputChannels[0]

  // Step 1: Measure input crest factor on voiced frames
  const { peakDbfs, voicedRmsDbfs, inputCrestFactorDb, frameRmsValues } =
    measureVoicedCrestFactor(analysisSamples, frameAnalysis)

  // Debug: Log input measurements for this pass (verify fresh measurements)
  console.log(`[compression] Pass input measurements - Peak: ${peakDbfs?.toFixed(2)} dBFS, Voiced RMS: ${voicedRmsDbfs?.toFixed(2)} dBFS, Crest Factor: ${inputCrestFactorDb?.toFixed(2)} dB`)

  if (inputCrestFactorDb === null || peakDbfs === null) {
    console.log('[compression] Compression skipped — no voiced frames available for crest-factor measurement.')
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

  const pIn = peakDbfs
  const pOut = pIn - requiredReductionDb
  const calculatedRatio = (pIn - finalThresholdDbfs) / Math.max(pOut - finalThresholdDbfs, 0.001) // Prevent division by zero
  const derivedRatio = Math.min(calculatedRatio, maxRatio)

  console.log(`[compression] Ratio calculation - pIn: ${pIn?.toFixed(2)}, pOut: ${pOut?.toFixed(2)}, finalThreshold: ${finalThresholdDbfs?.toFixed(2)}, derivedRatio: ${derivedRatio?.toFixed(2)}`)

  // Step 5: Build gain curve from channel 0, apply to all channels
  const compParams = {
    thresholdDb:  finalThresholdDbfs,
    ratio:        derivedRatio,
    attackMs:     attack,
    releaseMs:    release,
    kneeDb:       KNEE_WIDTH_DB,
    makeupGainDb: 0,
    lookaheadMs,
  }
  const gainCurve         = buildCompressionGainCurve(analysisSamples, sampleRate, compParams)
  const processedChannels = inputChannels.map(ch =>
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

  console.log(`[compression] Pass summary - Threshold: ${finalThresholdDbfs.toFixed(2)} dBFS, pOut: ${pOut.toFixed(2)} dBFS, Samples exceeding threshold: ${gainCurve.samplesExceedingThreshold}, Percentage: ${gainCurve.percentAboveThreshold.toFixed(2)}%`)

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
    // pOutDbfs is the documented name; targetPeakOut kept as a legacy alias.
    pOutDbfs:               round2(pOut),
    targetPeakOut:          round2(pOut),
    outputPeakDbfs:         round2(outputPeakDbfs),
    inputVoicedRmsDbfs:     round2(voicedRmsDbfs),
    outputVoicedRmsDbfs:    round2(outputVoicedRmsDbfs),
    percentAboveThreshold: round2(gainCurve.percentAboveThreshold),
    // Handed to the serial driver so the next pass works against the
    // compressed buffer in RAM. Stripped before the driver returns to
    // its caller so this large Float32Array array isn't pinned by the
    // result object.
    processedChannels,
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
 * Build a per-sample gain reduction curve (feed-forward, sample-peak detection).
 *
 * Detector: sample-peak — max(|x|) over a forward lookahead window of
 *           lookaheadMs. Runs in O(n) via a monotonic-deque sliding maximum.
 * Gain computer: soft-knee compression curve (computeGainReduction).
 * Smoothing: attack/release time constants applied to the gain-reduction
 *            signal itself (not to the level estimate). Attack governs how
 *            fast more reduction is applied; release governs how fast it
 *            decays. When lookaheadMs >= attackMs the gain ramp completes
 *            before the peak arrives — transparent peak control. With shorter
 *            lookahead, transients partially bleed through (creative choice).
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {{ thresholdDb: number, ratio: number, attackMs: number, releaseMs: number, kneeDb: number, lookaheadMs?: number }} params
 * @returns {{ curve: Float32Array, maxGainReductionDb: number, avgGainReductionDb: number, samplesExceedingThreshold: number, percentAboveThreshold: number }}
 */
function buildCompressionGainCurve(samples, sampleRate, params) {
  const { thresholdDb, ratio, attackMs, releaseMs, kneeDb, lookaheadMs = 0 } = params
  const n = samples.length

  const attackCoeff  = attackMs  > 0 ? Math.exp(-1 / (sampleRate * attackMs  / 1000)) : 0
  const releaseCoeff = releaseMs > 0 ? Math.exp(-1 / (sampleRate * releaseMs / 1000)) : 0

  // Lookahead window length in samples, clamped to:
  //   - a hard upper bound of 100 ms (musical lookahead beyond this is
  //     pointless and would smear transients across phonemes);
  //   - the available signal length (n - 1) so the deque buffer cannot
  //     exceed the input itself on very short signals.
  // A misconfigured preset (e.g. lookaheadMs: 5000) used to size the deque
  // to ~220k entries at 44.1 kHz — the clamp keeps deque capacity bounded
  // regardless of how the call site is configured.
  const MAX_LOOKAHEAD_MS = 100
  const requestedLook    = Math.max(0, lookaheadMs)
  const effectiveLookMs  = Math.min(requestedLook, MAX_LOOKAHEAD_MS)
  const L = Math.min(
    Math.max(0, Math.round(sampleRate * effectiveLookMs / 1000)),
    Math.max(0, n - 1)
  )

  // Monotonic deque (decreasing |x|) — circular buffer indexed by dqHead.
  // Holds indices whose absolute sample values form the running maximum over
  // the forward window [i, min(i + L, n - 1)]. Capacity L+2 is sufficient
  // because the eviction rule keeps at most L+1 elements live at any time.
  const dqCap = L + 2
  const dq    = new Int32Array(dqCap)
  const dqAbs = new Float32Array(dqCap)
  let dqHead  = 0
  let dqCount = 0

  const curve = new Float32Array(n)
  let currentGR                 = 0
  let maxGainReductionDb        = 0
  let totalGainReductionDb      = 0
  let activeFrames              = 0
  let samplesExceedingThreshold = 0
  let fedUpTo = -1

  for (let i = 0; i < n; i++) {
    const feedTo = i + L < n ? i + L : n - 1

    // Push new samples into the deque, evicting from the back while the back
    // value is <= the incoming value (preserves monotonic-decreasing order).
    while (fedUpTo < feedTo) {
      fedUpTo++
      const s   = samples[fedUpTo]
      const abs = s < 0 ? -s : s
      while (dqCount > 0) {
        const backPos = (dqHead + dqCount - 1) % dqCap
        if (dqAbs[backPos] <= abs) {
          dqCount--
        } else break
      }
      const insertPos = (dqHead + dqCount) % dqCap
      dq[insertPos]    = fedUpTo
      dqAbs[insertPos] = abs
      dqCount++
    }

    // Drop indices that have fallen out of the window from the front.
    while (dqCount > 0 && dq[dqHead] < i) {
      dqHead = (dqHead + 1) % dqCap
      dqCount--
    }

    const peak    = dqCount > 0 ? dqAbs[dqHead] : 0
    const levelDb = peak > 1e-7 ? 20 * Math.log10(peak) : -120
    const desiredGR = computeGainReduction(levelDb, thresholdDb, ratio, kneeDb)

    if (levelDb > thresholdDb) samplesExceedingThreshold++

    // Smooth the gain-reduction signal. Attack when GR is rising (more
    // reduction needed); release when GR is falling (less reduction needed).
    if (desiredGR > currentGR) {
      currentGR = attackCoeff  * currentGR + (1 - attackCoeff)  * desiredGR
    } else {
      currentGR = releaseCoeff * currentGR + (1 - releaseCoeff) * desiredGR
    }

    curve[i] = currentGR
    if (currentGR > 0) {
      if (currentGR > maxGainReductionDb) maxGainReductionDb = currentGR
      totalGainReductionDb += currentGR
      activeFrames++
    }
  }

  const avgGainReductionDb    = activeFrames > 0 ? totalGainReductionDb / activeFrames : 0
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
