/**
 * Stage 4a — Dynamic Range Compression.
 *
 * Feed-forward RMS compressor with soft knee, per-preset parameters.
 *
 * Reference: processing spec v3, Stage 4a.
 *
 * Behavior by preset:
 *   ACX Audiobook  — Conditional: only when crest factor > 20 dB
 *   Podcast Ready  — Always applied
 *   Voice Ready    — Always applied
 *   General Clean  — Always applied
 *
 * Architecture:
 *   - Level detection: RMS with attack/release smoothing (feed-forward)
 *   - Gain computer: soft-knee compressor, knee width = 4 dB (spec §4a)
 *   - Makeup gain: 0 dB — Stage 5 normalization handles level
 *   - Lookahead: none (true real-time model for correctness)
 *
 * Crest factor measurement (ACX conditional):
 *   crest_factor = peak_dBFS - voiced_RMS_dBFS
 *   If crest_factor <= 20 dB, skip compression for ACX Audiobook.
 */

import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels } from './wavWriter.js'
import { PRESETS } from '../presets.js'

const SAMPLE_RATE = 44100
const KNEE_WIDTH_DB = 4  // spec: soft knee 4 dB for all presets

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * Apply dynamic range compression to an audio file.
 *
 * @param {string} inputPath   - 32-bit float WAV
 * @param {string} outputPath  - Output WAV path
 * @param {string} presetId
 * @param {import('./silenceAnalysis.js').SilenceAnalysis} silenceAnalysis
 * @returns {CompressionResult}
 *
 * @typedef {Object} CompressionResult
 * @property {boolean} applied
 * @property {string|null} skippedReason        - Why compression was skipped
 * @property {number|null} crestFactorDb        - Measured crest factor (ACX path)
 * @property {number|null} maxGainReductionDb   - Peak gain reduction during processing
 * @property {number|null} avgGainReductionDb   - Average gain reduction applied
 * @property {{ threshold: number, ratio: number, attack: number, release: number }} params
 */
export async function applyCompression(inputPath, outputPath, presetId, silenceAnalysis) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error(`Unknown preset: ${presetId}`)

  const { mode, ratio, threshold, attack, release } = preset.compression

  // --- mode: 'none' — preset explicitly disables compression (e.g. Noise Eraser) ---
  if (mode === 'none') {
    await copyThrough(inputPath, outputPath)
    return {
      applied: false,
      skippedReason: 'Compression disabled for this preset',
      crestFactorDb: null,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
      params: { threshold, ratio, attack, release },
    }
  }

  const { channels, sampleRate } = await readWavAllChannels(inputPath)

  // Use channel 0 for crest factor analysis
  const analysisSamples = channels[0]

  // --- ACX conditional: measure crest factor ---
  let crestFactorDb = null
  if (mode === 'conditional') {
    crestFactorDb = measureCrestFactor(analysisSamples, silenceAnalysis)
    if (crestFactorDb <= 20) {
      await copyThrough(inputPath, outputPath)
      return {
        applied: false,
        skippedReason: `Crest factor ${round2(crestFactorDb)} dB <= 20 dB threshold`,
        crestFactorDb: round2(crestFactorDb),
        maxGainReductionDb: null,
        avgGainReductionDb: null,
        params: { threshold, ratio, attack, release },
      }
    }
  }

  // --- Build gain curve from channel 0, apply to all channels ---
  const compParams = {
    thresholdDb: threshold,
    ratio,
    attackMs: attack,
    releaseMs: release,
    kneeDb: KNEE_WIDTH_DB,
    makeupGainDb: 0,
  }
  const gainCurve = buildCompressionGainCurve(analysisSamples, sampleRate, compParams)
  const processedChannels = channels.map(ch => applyCompressionGainCurve(ch, gainCurve.curve, compParams.makeupGainDb))

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  return {
    applied: true,
    skippedReason: null,
    crestFactorDb: crestFactorDb !== null ? round2(crestFactorDb) : null,
    maxGainReductionDb: round2(gainCurve.maxGainReductionDb),
    avgGainReductionDb: round2(gainCurve.avgGainReductionDb),
    params: { threshold, ratio, attack, release },
  }
}

// ── Crest Factor Measurement ────────────────────────────────────────────────

/**
 * Compute crest factor on voiced frames: peak_dBFS - voiced_RMS_dBFS.
 * Uses the same voiced-frame set as the normalization stage.
 */
function measureCrestFactor(samples, silenceAnalysis) {
  let sumSq = 0
  let count = 0
  let peak = 0

  for (const frame of silenceAnalysis.frames) {
    if (frame.isSilence) continue
    const start = frame.offsetSamples
    const end = Math.min(start + frame.lengthSamples, samples.length)
    for (let i = start; i < end; i++) {
      const abs = Math.abs(samples[i])
      sumSq += samples[i] * samples[i]
      if (abs > peak) peak = abs
      count++
    }
  }

  if (count === 0 || peak === 0) return 0

  const voicedRms = Math.sqrt(sumSq / count)
  const peakDb = 20 * Math.log10(peak)
  const rmsDb  = voicedRms > 0 ? 20 * Math.log10(voicedRms) : -120

  return peakDb - rmsDb
}

// ── Compressor DSP ──────────────────────────────────────────────────────────

/**
 * Build a per-sample gain reduction curve (feed-forward, RMS detection).
 *
 * Level detection: power-domain envelope follower with attack/release
 * time constants. Gain computer applies soft-knee compression.
 *
 * Returns the gain curve and statistics. Apply to all channels via
 * applyCompressionGainCurve().
 *
 * @returns {{ curve: Float32Array, maxGainReductionDb: number, avgGainReductionDb: number }}
 */
function buildCompressionGainCurve(samples, sampleRate, params) {
  const { thresholdDb, ratio, attackMs, releaseMs, kneeDb } = params
  const n = samples.length

  const attackCoeff  = Math.exp(-1 / (sampleRate * attackMs / 1000))
  const releaseCoeff = Math.exp(-1 / (sampleRate * releaseMs / 1000))

  // curve[i] = gain reduction in dB (positive = attenuation)
  const curve = new Float32Array(n)
  let powerEnv = 0
  let maxGainReductionDb = 0
  let totalGainReductionDb = 0
  let activeFrames = 0

  for (let i = 0; i < n; i++) {
    const xPow = samples[i] * samples[i]

    if (xPow > powerEnv) {
      powerEnv = attackCoeff * powerEnv + (1 - attackCoeff) * xPow
    } else {
      powerEnv = releaseCoeff * powerEnv + (1 - releaseCoeff) * xPow
    }

    const levelDb = powerEnv > 1e-14 ? 10 * Math.log10(powerEnv) : -120
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
 * Apply a compression gain curve to a channel.
 */
function applyCompressionGainCurve(samples, curve, makeupGainDb) {
  const n = samples.length
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
 * Returns gain reduction in dB (positive = reduction).
 *
 * @param {number} levelDb     - Input level in dBFS
 * @param {number} thresholdDb - Compression threshold in dBFS
 * @param {number} ratio       - Compression ratio (e.g. 3 for 3:1)
 * @param {number} kneeDb      - Knee width in dB (symmetric around threshold)
 */
function computeGainReduction(levelDb, thresholdDb, ratio, kneeDb) {
  const halfKnee = kneeDb / 2
  const x = levelDb - thresholdDb  // distance above threshold

  if (x < -halfKnee) {
    // Below knee: no compression
    return 0
  } else if (x <= halfKnee) {
    // In the knee: quadratic interpolation
    // Formula: gain_reduction = (1 - 1/ratio) * (x + halfKnee)^2 / (2 * kneeDb)
    const t = x + halfKnee
    return (1 - 1 / ratio) * (t * t) / (2 * kneeDb)
  } else {
    // Above knee: full compression
    // gain_reduction = (1 - 1/ratio) * (x - halfKnee) + knee_corner_reduction
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

