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
 *   4. Derive ratio: peak_above_threshold / (peak_above_threshold - required_reduction)
 *   5. Clamp ratio to [1.2, 6.0]. Log warning if ceiling hit.
 *   6. Apply feed-forward RMS compressor with soft knee.
 *
 * Fixed parameters (per spec): attack, release, knee width, makeup gain = 0 dB.
 */

import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels } from './wavWriter.js'
import { PRESETS } from '../presets.js'

const KNEE_WIDTH_DB           = 4      // soft knee width, all presets
const RATIO_MIN               = 1.2    // below this is a no-op
const RATIO_MAX               = 6.0    // above this: apply ceiling, log warning
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
 * @property {boolean} ratioClamped              - Whether derived ratio was clamped to [1.2, 6.0]
 * @property {number|null} maxGainReductionDb    - Peak gain reduction during processing
 * @property {number|null} avgGainReductionDb    - Average gain reduction applied
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
      ratioClamped: false,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
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
      ratioClamped: false,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
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
      ratioClamped: false,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
    }
  }

  // Step 3: Derive threshold from voiced-frame RMS percentile
  const { thresholdDbfs } = deriveThreshold(frameRmsValues, thresholdPercentile)

  // Step 4: Derive ratio
  const requiredReductionDb = inputCrestFactorDb - targetCrestFactorDb
  const peakAboveThreshold  = peakDbfs - thresholdDbfs

  let derivedRatio
  let ratioClamped = false

  if (peakAboveThreshold <= 0 || peakAboveThreshold - requiredReductionDb <= 0) {
    // Degenerate: peak at or below threshold, or reduction needed exceeds headroom
    derivedRatio = RATIO_MAX
    ratioClamped = true
    console.warn('[compression] Degenerate ratio derivation — clamping to 6:1')
  } else {
    derivedRatio = peakAboveThreshold / (peakAboveThreshold - requiredReductionDb)
    if (derivedRatio < RATIO_MIN) {
      derivedRatio = RATIO_MIN
      ratioClamped = true
    } else if (derivedRatio > RATIO_MAX) {
      derivedRatio = RATIO_MAX
      ratioClamped = true
      console.warn(
        `[compression] Heavy compression needed — derived ratio exceeded 6:1 ceiling. ` +
        `Input crest factor: ${round2(inputCrestFactorDb)} dB, target: ${targetCrestFactorDb} dB.`
      )
    }
  }

  // Step 5: Build gain curve from channel 0, apply to all channels
  const compParams = {
    thresholdDb:  thresholdDbfs,
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

  return {
    applied: true,
    inputCrestFactorDb:     round2(inputCrestFactorDb),
    targetCrestFactorDb,
    skipReason: null,
    thresholdPercentile,
    thresholdDbfs:          round2(thresholdDbfs),
    derivedRatio:           round2(derivedRatio),
    derivedGainReductionDb: round2(requiredReductionDb),
    ratioClamped,
    maxGainReductionDb:     round2(gainCurve.maxGainReductionDb),
    avgGainReductionDb:     round2(gainCurve.avgGainReductionDb),
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
