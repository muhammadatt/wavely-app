/**
 * Stage 4a-PC / NE-PC — Parallel Compression.
 *
 * Splits the signal into a dry passthrough and a heavily-compressed wet
 * branch, then mixes them at a preset-specific wet/dry ratio.
 *
 * Wet branch processing chain:
 *   high-ratio compressor → makeup gain → parallel de-esser → VAD gate
 *
 * Key design choices:
 *   - Adaptive threshold: voiced_rms_dbfs − 12 dB (floor: −50 dBFS)
 *   - Crest factor guard: scales wet mix down when pre-PC crest factor
 *     falls below the preset guard threshold, preventing over-compression.
 *   - VAD gate: mutes wet branch during silence to avoid lifting noise floor.
 *   - Parallel de-esser: adaptive (reuses Stage 4 sibilant freq) or
 *     fixed-band (6–9 kHz) when Stage 4 result is unavailable.
 *
 * Reference: Instant Polish Parallel Compression Stage Specification, April 2026.
 */

import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels }   from './wavWriter.js'
import { PRESETS }            from '../presets.js'

const SAMPLE_RATE = 44100

// Parallel threshold derivation (spec §Adaptive Threshold)
const PARALLEL_THRESHOLD_OFFSET_DB = 12
const PARALLEL_THRESHOLD_FLOOR_DB  = -50

// Compressor soft-knee width (same as Stage 4a, spec consistency)
const KNEE_WIDTH_DB = 4

// Parallel de-esser fixed band (used for NE and when Stage 4 didn't apply)
const FIXED_BAND_LOW_HZ  = 6000
const FIXED_BAND_HIGH_HZ = 9000

// Parallel de-esser timing
const PARALLEL_DESSER_ATTACK_MS  = 1
const PARALLEL_DESSER_RELEASE_MS = 40

// Threshold offset above mean sibilant energy (spec)
const PARALLEL_DESSER_THRESHOLD_OFFSET_DB = 2

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * Apply parallel compression to an audio file.
 *
 * @param {string} inputPath
 * @param {string} outputPath  - 32-bit float WAV output
 * @param {string} presetId
 * @param {import('./stages.js').AudioMetrics} frameAnalysis
 *   From ctx.results.metrics. Provides voicedRmsDbfs, frames.
 * @param {import('./deEsser.js').DeEssResult|null} deEssResult
 *   From ctx.results.deEss. Used to reuse Stage 4 sibilant center freq.
 *   Pass null when unavailable — falls back to fixed-band de-esser.
 * @returns {ParallelCompressionResult}
 *
 * @typedef {Object} ParallelCompressionResult
 * @property {boolean} applied
 * @property {string|null} reason               - Skip reason when not applied
 * @property {number|null} thresholdDbfs
 * @property {number|null} voicedRmsDbfs
 * @property {number|null} ratio
 * @property {number|null} attackMs
 * @property {number|null} releaseMs
 * @property {number|null} makeupGainDb
 * @property {number|null} wetMixTarget
 * @property {number|null} wetMixEffective
 * @property {boolean} crestFactorGuardActivated
 * @property {number|null} prePcCrestFactorDb
 * @property {boolean} parallelDesserApplied
 * @property {'adaptive'|'fixed_band'|null} parallelDesserType
 * @property {number|null} parallelDesserCenterFreqHz
 * @property {number|null} parallelDesserMaxReductionDb
 * @property {boolean} vadGateApplied
 * @property {number|null} vadGateFadeMs
 */
export async function applyParallelCompression(inputPath, outputPath, presetId, frameAnalysis, deEssResult) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error(`[parallelCompression] Unknown preset: ${presetId}`)

  const config = preset.parallelCompression
  if (!config) {
    await copyThrough(inputPath, outputPath)
    return notApplied('preset_not_configured')
  }

  const { channels, sampleRate } = await readWavAllChannels(inputPath)
  const analysisCh = channels[0]
  const numSamples = analysisCh.length

  // ── 1. Adaptive threshold ────────────────────────────────────────────────
  const voicedRms    = frameAnalysis.voicedRmsDbfs ?? frameAnalysis.averageVoicedRmsDbfs ?? -24
  const threshold    = Math.max(voicedRms - PARALLEL_THRESHOLD_OFFSET_DB, PARALLEL_THRESHOLD_FLOOR_DB)

  // ── 2. Pre-PC crest factor ───────────────────────────────────────────────
  const prePcCrestFactor = measureCrestFactor(analysisCh, frameAnalysis)

  // ── 3. Crest factor guard ────────────────────────────────────────────────
  const guardThresh = config.crestGuardThresholdDb
  let effectiveWetMix
  let guardActivated = false

  if (prePcCrestFactor < guardThresh) {
    const wetScale      = Math.max(0, Math.min(1, (prePcCrestFactor - 8) / (guardThresh - 8)))
    effectiveWetMix     = config.wetMix * wetScale
    guardActivated      = true
  } else {
    effectiveWetMix = config.wetMix
  }

  // Hard ceiling (ACX only — wetMixCeiling is non-null only for acx_audiobook)
  if (config.wetMixCeiling !== null) {
    effectiveWetMix = Math.min(effectiveWetMix, config.wetMixCeiling)
  }

  // ── 4. Parallel de-esser config ──────────────────────────────────────────
  const { desserType, desserCenterFreqHz, desserThresholdDb } = resolveParallelDesserConfig(
    presetId,
    deEssResult,
    analysisCh,
    sampleRate,
    frameAnalysis,
    config.parallelDesserMaxReductionDb,
  )

  // ── 5. Build wet compressor gain curve (from channel 0) ──────────────────
  const compCurve = buildCompressorGainCurve(analysisCh, sampleRate, {
    thresholdDb: threshold,
    ratio:       config.ratio,
    attackMs:    config.attackMs,
    releaseMs:   config.releaseMs,
    kneeDb:      KNEE_WIDTH_DB,
  })

  // ── 6. Build VAD gate curve ──────────────────────────────────────────────
  const vadGateCurve = buildVadGateCurve(numSamples, frameAnalysis, config.vadFadeMs, sampleRate)

  // ── 7. Build parallel de-esser gain curve (wet branch only) ─────────────
  const { desserCurve, actualMaxReductionDb } = buildParallelDesserCurve(
    analysisCh,
    sampleRate,
    desserType,
    desserCenterFreqHz,
    desserThresholdDb,
    config.parallelDesserMaxReductionDb,
  )

  const makeupLinear = Math.pow(10, config.makeupGainDb / 20)
  const dryWeight    = 1 - effectiveWetMix
  const wetWeight    = effectiveWetMix

  // ── 8. Mix all channels ──────────────────────────────────────────────────
  const processedChannels = channels.map(ch => {
    const out = new Float32Array(ch.length)
    for (let i = 0; i < ch.length; i++) {
      const dry = ch[i]

      // Wet branch: compress → makeup gain → de-esser → VAD gate
      const compGainLin = Math.pow(10, -compCurve[i] / 20)
      const desserGainLin = Math.pow(10, -desserCurve[i] / 20)
      const wet = dry * compGainLin * makeupLinear * desserGainLin * vadGateCurve[i]

      out[i] = dry * dryWeight + wet * wetWeight
    }
    return out
  })

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  return {
    applied:                     true,
    reason:                      null,
    thresholdDbfs:               round2(threshold),
    voicedRmsDbfs:               round2(voicedRms),
    ratio:                       config.ratio,
    attackMs:                    config.attackMs,
    releaseMs:                   config.releaseMs,
    makeupGainDb:                config.makeupGainDb,
    wetMixTarget:                config.wetMix,
    wetMixEffective:             round2(effectiveWetMix),
    crestFactorGuardActivated:   guardActivated,
    prePcCrestFactorDb:          round2(prePcCrestFactor),
    parallelDesserApplied:       true,
    parallelDesserType:          desserType,
    parallelDesserCenterFreqHz:  desserType === 'adaptive' ? desserCenterFreqHz : null,
    parallelDesserMaxReductionDb: round2(actualMaxReductionDb),
    vadGateApplied:              true,
    vadGateFadeMs:               config.vadFadeMs,
  }
}

// ── Parallel De-esser Config Resolution ─────────────────────────────────────

/**
 * Decide whether to use adaptive (Stage 4 freq) or fixed-band de-esser on the
 * wet branch, and derive the threshold for the sidechain detector.
 *
 * Adaptive: reuse Stage 4 sibilant center freq and meanEnergyDb from deEssResult.
 * Fixed-band: measure sibilant energy in 6–9 kHz band on the current signal.
 */
function resolveParallelDesserConfig(presetId, deEssResult, samples, sampleRate, frameAnalysis, maxReductionDb) {
  // noise_eraser always uses fixed-band (spec: post-separation altered profile)
  // Standard presets use adaptive when Stage 4 identified a center freq.
  const useAdaptive = (
    presetId !== 'noise_eraser' &&
    deEssResult?.applied === true &&
    deEssResult.targetFreqHz !== null &&
    deEssResult.meanEnergyDb !== null
  )

  if (useAdaptive) {
    return {
      desserType:        'adaptive',
      desserCenterFreqHz: deEssResult.targetFreqHz,
      desserThresholdDb:  deEssResult.meanEnergyDb + PARALLEL_DESSER_THRESHOLD_OFFSET_DB,
    }
  }

  // Fixed-band fallback: measure mean energy in the fixed sibilant band from
  // the current signal to derive a context-appropriate threshold.
  const fixedBandEnergy = measureBandEnergy(samples, sampleRate, FIXED_BAND_LOW_HZ, FIXED_BAND_HIGH_HZ, frameAnalysis)
  const centerFreq = (FIXED_BAND_LOW_HZ + FIXED_BAND_HIGH_HZ) / 2

  return {
    desserType:        'fixed_band',
    desserCenterFreqHz: centerFreq,
    desserThresholdDb:  fixedBandEnergy.meanEnergyDb + PARALLEL_DESSER_THRESHOLD_OFFSET_DB,
  }
}

// ── Crest Factor ─────────────────────────────────────────────────────────────

/**
 * Voiced-frame crest factor: peak_dBFS − voiced_RMS_dBFS.
 * Same algorithm as compression.js (inlined — not exported from that module).
 */
function measureCrestFactor(samples, frameAnalysis) {
  let sumSq = 0
  let count = 0
  let peak  = 0

  for (const frame of frameAnalysis.frames) {
    if (frame.isSilence) continue
    const start = frame.offsetSamples
    const end   = Math.min(start + frame.lengthSamples, samples.length)
    for (let i = start; i < end; i++) {
      const abs = Math.abs(samples[i])
      sumSq += samples[i] * samples[i]
      if (abs > peak) peak = abs
      count++
    }
  }

  if (count === 0 || peak === 0) return 20  // safe default — guard won't activate

  const voicedRms = Math.sqrt(sumSq / count)
  const peakDb    = 20 * Math.log10(peak)
  const rmsDb     = voicedRms > 0 ? 20 * Math.log10(voicedRms) : -120

  return peakDb - rmsDb
}

// ── Compressor Gain Curve ────────────────────────────────────────────────────

/**
 * Feed-forward RMS compressor — builds a per-sample gain reduction curve.
 * Same algorithm as Stage 4a (compression.js), parameterised for high-ratio
 * parallel compression. Gain curve is derived from channel 0; applied to all.
 *
 * @returns {Float32Array} gainReductionDb[i] — positive = attenuation
 */
function buildCompressorGainCurve(samples, sampleRate, params) {
  const { thresholdDb, ratio, attackMs, releaseMs, kneeDb } = params
  const n             = samples.length
  const attackCoeff   = Math.exp(-1 / (sampleRate * attackMs  / 1000))
  const releaseCoeff  = Math.exp(-1 / (sampleRate * releaseMs / 1000))

  const curve = new Float32Array(n)
  let powerEnv = 0

  for (let i = 0; i < n; i++) {
    const xPow = samples[i] * samples[i]
    powerEnv = xPow > powerEnv
      ? attackCoeff  * powerEnv + (1 - attackCoeff)  * xPow
      : releaseCoeff * powerEnv + (1 - releaseCoeff) * xPow

    const levelDb = powerEnv > 1e-14 ? 10 * Math.log10(powerEnv) : -120
    curve[i] = computeGainReduction(levelDb, thresholdDb, ratio, kneeDb)
  }

  return curve
}

/**
 * Soft-knee gain computer. Returns gain reduction in dB (positive = cut).
 */
function computeGainReduction(levelDb, thresholdDb, ratio, kneeDb) {
  const halfKnee = kneeDb / 2
  const x = levelDb - thresholdDb

  if (x < -halfKnee) return 0

  if (x <= halfKnee) {
    const t = x + halfKnee
    return (1 - 1 / ratio) * (t * t) / (2 * kneeDb)
  }

  const cornerReduction = (1 - 1 / ratio) * halfKnee
  return cornerReduction + (1 - 1 / ratio) * (x - halfKnee)
}

// ── VAD Gate Curve ───────────────────────────────────────────────────────────

/**
 * Build a per-sample gate multiplier (0.0–1.0) from VAD frame classifications.
 *
 * Gate is 1.0 during voiced frames and 0.0 during silence. Transitions use
 * a linear fade over fadeSamples to prevent audible pumping.
 */
function buildVadGateCurve(numSamples, frameAnalysis, vadFadeMs, sampleRate) {
  const curve       = new Float32Array(numSamples)
  const fadeSamples = Math.max(1, Math.round(sampleRate * vadFadeMs / 1000))

  // First pass: hard gate from frame classifications
  for (const frame of frameAnalysis.frames) {
    const start = frame.offsetSamples
    const end   = Math.min(start + frame.lengthSamples, numSamples)
    const value = frame.isSilence ? 0.0 : 1.0
    for (let i = start; i < end; i++) {
      curve[i] = value
    }
  }

  // Fill any samples beyond the last frame (treat as silence)
  // (already 0.0 from Float32Array initialisation)

  // Second pass: apply linear fade ramps at transitions
  let prevValue = curve[0]
  for (let i = 1; i < numSamples; i++) {
    const curr = curve[i]
    if (curr !== prevValue) {
      // Transition detected — apply symmetric fade centred on the transition
      const halfFade  = Math.floor(fadeSamples / 2)
      const fadeStart = Math.max(0, i - halfFade)
      const fadeEnd   = Math.min(numSamples, i + halfFade + 1)
      const from      = prevValue
      const to        = curr
      const totalSteps = fadeEnd - fadeStart
      for (let j = fadeStart; j < fadeEnd; j++) {
        const t = (j - fadeStart) / Math.max(1, totalSteps - 1)
        curve[j] = from + (to - from) * t
      }
      i = fadeEnd - 1  // skip the fade region on next iteration
    }
    prevValue = curve[Math.min(i, numSamples - 1)]
  }

  return curve
}

// ── Parallel De-esser Gain Curve ─────────────────────────────────────────────

/**
 * Build a per-sample gain reduction curve for the parallel de-esser.
 *
 * Uses a 2nd-order IIR bandpass to isolate the sibilant band, then applies
 * a feed-forward level detector with attack/release smoothing. When the
 * sibilant energy exceeds the threshold, gain reduction is applied up to
 * maxReductionDb.
 *
 * @param {Float32Array} samples       - Channel 0 analysis samples
 * @param {number} sampleRate
 * @param {'adaptive'|'fixed_band'} desserType
 * @param {number} centerFreqHz        - Sibilant centre frequency
 * @param {number} thresholdDb         - Energy threshold above which reduction starts
 * @param {number} maxReductionDb      - Maximum gain reduction (dB)
 * @returns {{ desserCurve: Float32Array, actualMaxReductionDb: number }}
 */
function buildParallelDesserCurve(samples, sampleRate, desserType, centerFreqHz, thresholdDb, maxReductionDb) {
  const n             = samples.length
  const attackCoeff   = Math.exp(-1 / (sampleRate * PARALLEL_DESSER_ATTACK_MS  / 1000))
  const releaseCoeff  = Math.exp(-1 / (sampleRate * PARALLEL_DESSER_RELEASE_MS / 1000))

  // Bandpass the signal to isolate the sibilant band
  const bandwidth    = desserType === 'adaptive' ? 2000 : (FIXED_BAND_HIGH_HZ - FIXED_BAND_LOW_HZ)
  const lowHz        = desserType === 'adaptive' ? centerFreqHz - bandwidth / 2 : FIXED_BAND_LOW_HZ
  const highHz       = desserType === 'adaptive' ? centerFreqHz + bandwidth / 2 : FIXED_BAND_HIGH_HZ
  const bandpassSig  = applyBandpass(samples, sampleRate, Math.max(20, lowHz), Math.min(sampleRate / 2 - 1, highHz))

  // Feed-forward envelope follower on the bandpass signal
  const curve = new Float32Array(n)
  let envelope = 0
  let actualMaxReductionDb = 0

  for (let i = 0; i < n; i++) {
    const xPow = bandpassSig[i] * bandpassSig[i]
    envelope = xPow > envelope
      ? attackCoeff  * envelope + (1 - attackCoeff)  * xPow
      : releaseCoeff * envelope + (1 - releaseCoeff) * xPow

    const energyDb = envelope > 1e-14 ? 10 * Math.log10(envelope) : -120

    if (energyDb > thresholdDb) {
      const excess      = energyDb - thresholdDb
      const reduction   = Math.min(excess, maxReductionDb)
      curve[i]          = reduction
      if (reduction > actualMaxReductionDb) actualMaxReductionDb = reduction
    } else {
      curve[i] = 0
    }
  }

  return { desserCurve: curve, actualMaxReductionDb }
}

// ── IIR Bandpass Filter ──────────────────────────────────────────────────────

/**
 * Apply a 2nd-order Butterworth bandpass filter (cascaded high-pass + low-pass
 * biquad sections) to isolate a frequency band.
 *
 * Computed via bilinear transform. Returns a new Float32Array.
 */
function applyBandpass(samples, sampleRate, lowHz, highHz) {
  // High-pass at lowHz, then low-pass at highHz
  const hp = applyBiquadHighpass(samples, sampleRate, lowHz)
  return applyBiquadLowpass(hp, sampleRate, highHz)
}

function applyBiquadHighpass(samples, sampleRate, cutoffHz) {
  const w0    = 2 * Math.PI * cutoffHz / sampleRate
  const cosW0 = Math.cos(w0)
  const sinW0 = Math.sin(w0)
  const q     = Math.SQRT1_2  // 1/sqrt(2) = Butterworth Q
  const alpha = sinW0 / (2 * q)

  const b0 =  (1 + cosW0) / 2
  const b1 = -(1 + cosW0)
  const b2 =  (1 + cosW0) / 2
  const a0 =   1 + alpha
  const a1 =  -2 * cosW0
  const a2 =   1 - alpha

  return applyBiquad(samples, b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
}

function applyBiquadLowpass(samples, sampleRate, cutoffHz) {
  const w0    = 2 * Math.PI * cutoffHz / sampleRate
  const cosW0 = Math.cos(w0)
  const sinW0 = Math.sin(w0)
  const q     = Math.SQRT1_2
  const alpha = sinW0 / (2 * q)

  const b0 = (1 - cosW0) / 2
  const b1 =  1 - cosW0
  const b2 = (1 - cosW0) / 2
  const a0 =  1 + alpha
  const a1 = -2 * cosW0
  const a2 =  1 - alpha

  return applyBiquad(samples, b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
}

function applyBiquad(samples, b0, b1, b2, a1, a2) {
  const n   = samples.length
  const out = new Float32Array(n)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0

  for (let i = 0; i < n; i++) {
    const x0  = samples[i]
    const y0  = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    out[i] = y0
    x2 = x1; x1 = x0
    y2 = y1; y1 = y0
  }

  return out
}

// ── Band Energy Measurement ──────────────────────────────────────────────────

/**
 * Measure mean band energy (dB) in a frequency range over voiced frames.
 * Used to set the fixed-band de-esser threshold.
 */
function measureBandEnergy(samples, sampleRate, lowHz, highHz, frameAnalysis) {
  const bandSig  = applyBandpass(samples, sampleRate, lowHz, highHz)

  let sumSq = 0
  let count = 0

  for (const frame of frameAnalysis.frames) {
    if (frame.isSilence) continue
    const start = frame.offsetSamples
    const end   = Math.min(start + frame.lengthSamples, bandSig.length)
    for (let i = start; i < end; i++) {
      sumSq += bandSig[i] * bandSig[i]
      count++
    }
  }

  const meanPower  = count > 0 ? sumSq / count : 1e-14
  const meanEnergy = 10 * Math.log10(Math.max(meanPower, 1e-14))

  return { meanEnergyDb: meanEnergy }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}

function notApplied(reason) {
  return {
    applied:                     false,
    reason,
    thresholdDbfs:               null,
    voicedRmsDbfs:               null,
    ratio:                       null,
    attackMs:                    null,
    releaseMs:                   null,
    makeupGainDb:                null,
    wetMixTarget:                null,
    wetMixEffective:             null,
    crestFactorGuardActivated:   false,
    prePcCrestFactorDb:          null,
    parallelDesserApplied:       false,
    parallelDesserType:          null,
    parallelDesserCenterFreqHz:  null,
    parallelDesserMaxReductionDb: null,
    vadGateApplied:              false,
    vadGateFadeMs:               null,
  }
}

async function copyThrough(inputPath, outputPath) {
  const { readFile, writeFile } = await import('fs/promises')
  await writeFile(outputPath, await readFile(inputPath))
}
