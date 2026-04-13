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

// --- Adaptive threshold (Stage 4a addendum) ---
const ADAPTIVE_WINDOW_SAMPLES = 1024      // ~23 ms @ 44.1 kHz (spec)
const ADAPTIVE_HOP_SAMPLES    = 512       // 50% overlap (spec)
const ADAPTIVE_MIN_WINDOWS    = 50        // below this, fall back to static
const ADAPTIVE_NOISE_MARGIN_DB = 6        // drop windows within noiseFloor + 6 dB

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
 * @property {'adaptive_p85'|'static'|'static_fallback'|null} [thresholdMethod]
 *     How the threshold used for compression was derived.
 * @property {string|null} [fallbackReason]     - If static_fallback, why
 * @property {number|null} [p85Dbfs]            - Adaptive: P85 of voiced-window RMS
 * @property {number|null} [p99Dbfs]            - Adaptive: P99 of voiced-window RMS
 * @property {number|null} [expectedGrDb]       - Adaptive: P99 - P85
 * @property {[number, number]|null} [targetGrWindow]
 * @property {boolean} [thresholdClamped]       - Adaptive: whether the derived value hit the clamp range
 * @property {number|null} [thresholdPreClampDbfs]
 */
export async function applyCompression(inputPath, outputPath, presetId, silenceAnalysis) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error(`Unknown preset: ${presetId}`)

  const presetComp = preset.compression
  const { mode, ratio, threshold: staticThreshold, attack, release } = presetComp

  // --- mode: 'none' — preset explicitly disables compression (e.g. ClearerVoice) ---
  if (mode === 'none') {
    await copyThrough(inputPath, outputPath)
    return {
      applied: false,
      skippedReason: 'Compression disabled for this preset',
      crestFactorDb: null,
      maxGainReductionDb: null,
      avgGainReductionDb: null,
      params: { threshold: staticThreshold, ratio, attack, release },
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
        params: { threshold: staticThreshold, ratio, attack, release },
      }
    }
  }

  // --- Derive threshold (adaptive per spec addendum, or static) ---
  const adaptive = presetComp.thresholdMethod === 'adaptive'
    ? deriveAdaptiveThreshold(analysisSamples, silenceAnalysis, presetComp)
    : {
        thresholdDb:           staticThreshold,
        method:                'static',
        fallbackReason:        null,
        p85Dbfs:               null,
        p99Dbfs:               null,
        expectedGrDb:          null,
        thresholdClamped:      false,
        thresholdPreClampDbfs: null,
      }

  // --- Build gain curve from channel 0, apply to all channels ---
  const compParams = {
    thresholdDb: adaptive.thresholdDb,
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
    params: { threshold: round2(adaptive.thresholdDb), ratio, attack, release },
    thresholdMethod:       adaptive.method,
    fallbackReason:        adaptive.fallbackReason,
    p85Dbfs:               adaptive.p85Dbfs !== null ? round2(adaptive.p85Dbfs) : null,
    p99Dbfs:               adaptive.p99Dbfs !== null ? round2(adaptive.p99Dbfs) : null,
    expectedGrDb:          adaptive.expectedGrDb !== null ? round2(adaptive.expectedGrDb) : null,
    targetGrWindow:        presetComp.targetGrWindow ?? null,
    thresholdClamped:      adaptive.thresholdClamped,
    thresholdPreClampDbfs: adaptive.thresholdPreClampDbfs !== null ? round2(adaptive.thresholdPreClampDbfs) : null,
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

// ── Adaptive Threshold (Stage 4a addendum) ──────────────────────────────────

/**
 * Derive an adaptive compression threshold from the voiced-frame RMS
 * distribution.
 *
 * Algorithm (see `docs/instant_polish_adaptive_compression_threshold.md`):
 *   1. Slide 1024-sample / hop-512 windows across voiced frames only; compute
 *      per-window RMS in dBFS.
 *   2. Drop windows within `noiseFloor + 6 dB` (noise-contaminated breath tails).
 *   3. If surviving windows < 50, fall back to the preset's static threshold.
 *   4. Compute P85 (start) and P99 (peak proxy) of the distribution.
 *   5. Nudge threshold by half the gap between expected GR (P99 - P85) and the
 *      preset's target GR window.
 *   6. Clamp to preset [thresholdMin, thresholdMax].
 *
 * @param {Float32Array} samples
 * @param {import('./silenceAnalysis.js').SilenceAnalysis} silenceAnalysis
 * @param {import('../../src/audio/presets.js').CompressionConfig} presetComp
 * @returns {{
 *   thresholdDb: number,
 *   method: 'adaptive_p85'|'static_fallback',
 *   fallbackReason: string|null,
 *   p85Dbfs: number|null,
 *   p99Dbfs: number|null,
 *   expectedGrDb: number|null,
 *   thresholdClamped: boolean,
 *   thresholdPreClampDbfs: number|null,
 * }}
 */
function deriveAdaptiveThreshold(samples, silenceAnalysis, presetComp) {
  const staticFallback = (reason) => ({
    thresholdDb:           presetComp.threshold,
    method:                'static_fallback',
    fallbackReason:        reason,
    p85Dbfs:               null,
    p99Dbfs:               null,
    expectedGrDb:          null,
    thresholdClamped:      false,
    thresholdPreClampDbfs: null,
  })

  const noiseCeiling = silenceAnalysis.noiseFloorDbfs + ADAPTIVE_NOISE_MARGIN_DB
  const voicedRms = collectVoicedWindowRmsDbfs(samples, silenceAnalysis, noiseCeiling)

  if (voicedRms.length < ADAPTIVE_MIN_WINDOWS) {
    console.log('[compression] adaptive_threshold: insufficient voiced content — using static fallback')
    return staticFallback('insufficient_voiced_content')
  }

  const sorted = voicedRms.sort((a, b) => a - b)
  const p85 = computePercentile(sorted, 85)
  const p99 = computePercentile(sorted, 99)
  const expectedGr = p99 - p85

  const [targetMin, targetMax] = presetComp.targetGrWindow
  let threshold
  if (expectedGr < targetMin) {
    // Compressor barely engaging — lower threshold
    threshold = p85 - (targetMin - expectedGr) / 2
  } else if (expectedGr > targetMax) {
    // Compressor too aggressive — raise threshold
    threshold = p85 + (expectedGr - targetMax) / 2
  } else {
    threshold = p85
  }

  const preClamp = threshold
  const clamped = Math.min(
    Math.max(threshold, presetComp.thresholdMin),
    presetComp.thresholdMax,
  )
  const thresholdClamped = clamped !== preClamp

  return {
    thresholdDb:           clamped,
    method:                'adaptive_p85',
    fallbackReason:        null,
    p85Dbfs:               p85,
    p99Dbfs:               p99,
    expectedGrDb:          expectedGr,
    thresholdClamped,
    thresholdPreClampDbfs: thresholdClamped ? preClamp : null,
  }
}

/**
 * Collect RMS (dBFS) for every 1024-sample window fully contained within a
 * voiced frame, dropping windows at/below the noise-contamination ceiling.
 */
function collectVoicedWindowRmsDbfs(samples, silenceAnalysis, noiseCeilingDbfs) {
  const out = []
  for (const frame of silenceAnalysis.frames) {
    if (frame.isSilence) continue
    const frameEnd = Math.min(frame.offsetSamples + frame.lengthSamples, samples.length)
    for (let start = frame.offsetSamples; start + ADAPTIVE_WINDOW_SAMPLES <= frameEnd; start += ADAPTIVE_HOP_SAMPLES) {
      let sumSq = 0
      const end = start + ADAPTIVE_WINDOW_SAMPLES
      for (let i = start; i < end; i++) sumSq += samples[i] * samples[i]
      const rms = Math.sqrt(sumSq / ADAPTIVE_WINDOW_SAMPLES)
      if (rms <= 0) continue
      const rmsDbfs = 20 * Math.log10(rms)
      if (rmsDbfs < noiseCeilingDbfs) continue
      out.push(rmsDbfs)
    }
  }
  return out
}

/**
 * Percentile via the "ceil index" convention from the spec:
 *   idx = ceil(p/100 * N) - 1, clamped to [0, N-1]
 * `sorted` MUST already be sorted ascending.
 */
function computePercentile(sorted, percentile) {
  const n = sorted.length
  if (n === 0) return 0
  const idx = Math.max(0, Math.min(n - 1, Math.ceil((percentile / 100) * n) - 1))
  return sorted[idx]
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

