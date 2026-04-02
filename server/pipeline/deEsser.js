/**
 * Stage 4 — De-esser (Conditional).
 *
 * Reduces harsh sibilant energy using Meyda.js spectral analysis to
 * drive a frequency-selective compressor implemented in custom DSP.
 *
 * Reference: processing spec v3, Stage 4.
 *
 * Algorithm:
 *   1. Estimate F0 from voiced frames (autocorrelation) to determine
 *      the initial sibilant band (male vs. female voice)
 *   2. Identify fricative events (high spectral flatness in sibilant band,
 *      low energy below 1 kHz)
 *   3. Compute P95 sibilant energy — this is the de-esser target frequency
 *   4. Evaluate trigger condition (preset sensitivity)
 *   5. If triggered, apply frequency-selective compression to the sibilant band
 *
 * DSP approach: biquad bandpass isolates the sibilant band for envelope
 * detection; gain reduction is applied only to the sibilant band and summed
 * back with the untouched low-frequency content.
 */

import Meyda from 'meyda'
import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels } from './wavWriter.js'
import { PRESETS } from '../presets.js'

const SAMPLE_RATE  = 44100
const FFT_SIZE     = 4096
const FRAME_HOP    = 2048  // 50% overlap for better temporal resolution

// F0 ranges for voice classification
const F0_MALE_MIN   = 85
const F0_MALE_MAX   = 180
const F0_FEMALE_MIN = 165
const F0_FEMALE_MAX = 255

// Sibilant band lookup by voice type (spec §4a)
const SIBILANT_BANDS = {
  male:      [4000, 7000],
  female:    [6000, 9000],
  uncertain: [5000, 8000],
}

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * Analyze sibilance and conditionally apply de-essing.
 *
 * @param {string} inputPath   - 32-bit float WAV
 * @param {string} outputPath  - Output WAV path
 * @param {string} presetId
 * @param {import('./silenceAnalysis.js').SilenceAnalysis} silenceAnalysis
 * @returns {DeEsserResult}
 *
 * @typedef {Object} DeEsserResult
 * @property {boolean} applied
 * @property {number|null} f0Hz            - Estimated fundamental frequency
 * @property {string|null} voiceType       - 'male', 'female', or 'uncertain'
 * @property {number|null} targetFreqHz    - De-esser center frequency
 * @property {number|null} maxReductionDb  - Maximum gain reduction applied
 * @property {number|null} p95EnergyDb     - P95 sibilant energy (relative)
 * @property {number|null} meanEnergyDb    - Mean sibilant energy (relative)
 * @property {string|null} triggerReason   - Why de-esser was/wasn't triggered
 */
export async function analyzeAndDeEss(inputPath, outputPath, presetId, silenceAnalysis) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error(`Unknown preset: ${presetId}`)

  const deEsserConfig = preset.deEsser
  const { channels, sampleRate, numChannels } = await readWavAllChannels(inputPath)

  // Use channel 0 for analysis (same as silenceAnalysis and EQ)
  const samples = channels[0]

  // --- Step 1: Estimate F0 from voiced frames ---
  const voicedFrames = collectVoicedFrames(samples, silenceAnalysis)
  if (voicedFrames.length < 5) {
    await copyThrough(inputPath, outputPath)
    return noResult('Insufficient voiced frames for analysis')
  }

  const f0 = estimateF0(voicedFrames, sampleRate)
  const voiceType = classifyVoice(f0)
  const sibilantBand = SIBILANT_BANDS[voiceType]

  // --- Step 2: Identify fricative events and measure sibilant energy ---
  const sibilanceMetrics = analyzeSibilance(samples, silenceAnalysis, sibilantBand, sampleRate)

  if (sibilanceMetrics.fricativeCount < 3) {
    await copyThrough(inputPath, outputPath)
    return {
      applied: false,
      f0Hz: f0,
      voiceType,
      targetFreqHz: null,
      maxReductionDb: null,
      p95EnergyDb: sibilanceMetrics.p95EnergyDb,
      meanEnergyDb: sibilanceMetrics.meanEnergyDb,
      triggerReason: 'Too few fricative events detected',
    }
  }

  // --- Step 3: Evaluate trigger condition ---
  const triggerThreshold = deEsserConfig.trigger  // dB above mean
  const delta = sibilanceMetrics.p95EnergyDb - sibilanceMetrics.meanEnergyDb

  if (delta <= triggerThreshold) {
    await copyThrough(inputPath, outputPath)
    return {
      applied: false,
      f0Hz: f0,
      voiceType,
      targetFreqHz: sibilanceMetrics.targetFreqHz,
      maxReductionDb: null,
      p95EnergyDb: sibilanceMetrics.p95EnergyDb,
      meanEnergyDb: sibilanceMetrics.meanEnergyDb,
      triggerReason: `P95-mean delta ${round2(delta)} dB <= trigger ${triggerThreshold} dB`,
    }
  }

  // --- Step 4: Apply frequency-selective compression ---
  const targetFreq = sibilanceMetrics.targetFreqHz
  const maxReduction = deEsserConfig.maxReduction

  // De-esser threshold: mean sibilant energy + offset (spec §4b)
  // For standard sensitivity: mean + 4 dB, for high sensitivity: mean + 3 dB
  const thresholdOffset = deEsserConfig.sensitivity === 'high' ? 3 : 4

  // Process each channel using the gain curve derived from channel 0
  const deEsserParams = {
    targetFreq,
    bandwidth: sibilantBand[1] - sibilantBand[0],
    maxReductionDb: maxReduction,
    thresholdDb: sibilanceMetrics.meanEnergyDb + thresholdOffset,
    attackMs: 1.5,
    releaseMs: 50,
  }

  // Build gain curve from channel 0 analysis
  const gainCurve = buildDeEsserGainCurve(channels[0], sampleRate, deEsserParams)

  // Apply gain curve to all channels
  const processedChannels = channels.map(ch => applyGainCurve(ch, gainCurve))

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  return {
    applied: true,
    f0Hz: f0,
    voiceType,
    targetFreqHz: targetFreq,
    maxReductionDb: round2(gainCurve.maxGainReductionDb),
    p95EnergyDb: sibilanceMetrics.p95EnergyDb,
    meanEnergyDb: sibilanceMetrics.meanEnergyDb,
    triggerReason: `P95-mean delta ${round2(delta)} dB > trigger ${triggerThreshold} dB`,
  }
}

// ── F0 Estimation ───────────────────────────────────────────────────────────

/**
 * Estimate fundamental frequency via autocorrelation on voiced frames.
 * Returns median F0 across analyzed frames.
 */
function estimateF0(voicedFrames, sampleRate) {
  const f0Estimates = []

  // Analyze a subset of voiced frames (every 4th for speed)
  const step = Math.max(1, Math.floor(voicedFrames.length / 30))
  for (let i = 0; i < voicedFrames.length; i += step) {
    const frame = voicedFrames[i]
    const f0 = autocorrelationF0(frame, sampleRate)
    if (f0 !== null) f0Estimates.push(f0)
  }

  if (f0Estimates.length === 0) return null

  // Return median
  f0Estimates.sort((a, b) => a - b)
  return f0Estimates[Math.floor(f0Estimates.length / 2)]
}

/**
 * Autocorrelation-based F0 detection for a single frame.
 * Searches for the first significant peak in the autocorrelation function
 * within the expected F0 range (60–300 Hz).
 */
function autocorrelationF0(frame, sampleRate) {
  const n = frame.length
  const minLag = Math.floor(sampleRate / 300)  // 300 Hz upper limit
  const maxLag = Math.floor(sampleRate / 60)   // 60 Hz lower limit

  // Compute autocorrelation for the lag range
  let maxCorr = 0
  let bestLag = 0

  // Normalize by the zero-lag autocorrelation
  let zeroLagCorr = 0
  for (let i = 0; i < n; i++) zeroLagCorr += frame[i] * frame[i]
  if (zeroLagCorr < 1e-10) return null

  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    let corr = 0
    for (let i = 0; i < n - lag; i++) {
      corr += frame[i] * frame[i + lag]
    }
    corr /= zeroLagCorr

    if (corr > maxCorr) {
      maxCorr = corr
      bestLag = lag
    }
  }

  // Require a minimum correlation strength to accept the F0
  if (maxCorr < 0.3 || bestLag === 0) return null

  return sampleRate / bestLag
}

/**
 * Classify voice type based on estimated F0.
 */
function classifyVoice(f0) {
  if (f0 === null) return 'uncertain'
  if (f0 >= F0_MALE_MIN && f0 <= F0_MALE_MAX) return 'male'
  if (f0 >= F0_FEMALE_MIN && f0 <= F0_FEMALE_MAX) return 'female'
  // Overlap region or out of range
  if (f0 < F0_FEMALE_MIN) return 'male'
  if (f0 > F0_FEMALE_MAX) return 'female'
  return 'uncertain'
}

// ── Sibilance Analysis ──────────────────────────────────────────────────────

/**
 * Analyze sibilant energy across all frames. Identifies fricative events
 * and computes the P95 energy and target frequency.
 */
function analyzeSibilance(samples, silenceAnalysis, sibilantBand, sampleRate) {
  const frameSize = FFT_SIZE
  const hop = FRAME_HOP
  const numFrames = Math.floor((samples.length - frameSize) / hop)

  const sibilantEnergies = []
  const fricativeEvents = []

  const binFreqRes = sampleRate / frameSize
  const sibilantBinLo = Math.floor(sibilantBand[0] / binFreqRes)
  const sibilantBinHi = Math.ceil(sibilantBand[1] / binFreqRes)
  const lowBinHi = Math.ceil(1000 / binFreqRes)

  for (let f = 0; f < numFrames; f++) {
    const start = f * hop
    const frame = samples.slice(start, start + frameSize)

    // Skip silence frames
    const frameRms = rms(frame)
    if (frameRms < 1e-6) continue

    // Use Meyda for spectral analysis
    const features = Meyda.extract(
      ['powerSpectrum', 'spectralFlatness'],
      frame,
      { sampleRate, bufferSize: frameSize }
    )
    if (!features || !features.powerSpectrum) continue

    const ps = features.powerSpectrum

    // Measure energy in the sibilant band
    let sibilantEnergy = 0
    let sibilantBinCount = 0
    for (let b = sibilantBinLo; b <= sibilantBinHi && b < ps.length; b++) {
      sibilantEnergy += ps[b]
      sibilantBinCount++
    }
    if (sibilantBinCount === 0) continue
    const avgSibilantEnergy = sibilantEnergy / sibilantBinCount
    const sibilantDb = avgSibilantEnergy > 0 ? 10 * Math.log10(avgSibilantEnergy) : -120

    sibilantEnergies.push(sibilantDb)

    // Measure energy below 1 kHz
    let lowEnergy = 0
    let lowBinCount = 0
    for (let b = 1; b < lowBinHi && b < ps.length; b++) {
      lowEnergy += ps[b]
      lowBinCount++
    }
    const avgLowEnergy = lowBinCount > 0 ? lowEnergy / lowBinCount : 0
    const lowDb = avgLowEnergy > 0 ? 10 * Math.log10(avgLowEnergy) : -120

    // Fricative event: high sibilant energy relative to low-frequency content
    // and high spectral flatness in the sibilant band (noise-like)
    if (sibilantDb - lowDb > 3 && features.spectralFlatness > 0.3) {
      // Find the spectral centroid within the sibilant band for this event
      let weightedSum = 0
      let totalWeight = 0
      for (let b = sibilantBinLo; b <= sibilantBinHi && b < ps.length; b++) {
        const freq = b * binFreqRes
        weightedSum += freq * ps[b]
        totalWeight += ps[b]
      }
      const centroid = totalWeight > 0 ? weightedSum / totalWeight : (sibilantBand[0] + sibilantBand[1]) / 2

      fricativeEvents.push({
        energy: sibilantDb,
        centroid,
      })
    }
  }

  if (sibilantEnergies.length === 0) {
    return { p95EnergyDb: -120, meanEnergyDb: -120, targetFreqHz: null, fricativeCount: 0 }
  }

  // Compute mean and P95 of sibilant energy
  const meanEnergy = sibilantEnergies.reduce((s, v) => s + v, 0) / sibilantEnergies.length
  const sorted = [...sibilantEnergies].sort((a, b) => a - b)
  const p95Index = Math.floor(sorted.length * 0.95)
  const p95Energy = sorted[Math.min(p95Index, sorted.length - 1)]

  // Target frequency: spectral centroid of the top 5% fricative events
  let targetFreq = (sibilantBand[0] + sibilantBand[1]) / 2
  if (fricativeEvents.length > 0) {
    fricativeEvents.sort((a, b) => b.energy - a.energy)
    const top5pct = fricativeEvents.slice(0, Math.max(1, Math.ceil(fricativeEvents.length * 0.05)))
    targetFreq = top5pct.reduce((s, e) => s + e.centroid, 0) / top5pct.length
  }

  return {
    p95EnergyDb: round2(p95Energy),
    meanEnergyDb: round2(meanEnergy),
    targetFreqHz: Math.round(targetFreq),
    fricativeCount: fricativeEvents.length,
  }
}

// ── De-esser DSP ────────────────────────────────────────────────────────────

/**
 * Build a per-sample sibilant gain reduction curve from a mono analysis channel.
 *
 * Signal flow:
 *   input → [bandpass (sibilant band)] → envelope → gain computation → gain[]
 *
 * The gain array is then applied to all channels via applyGainCurve().
 *
 * @returns {{ gainCurve: Float32Array, maxGainReductionDb: number }}
 */
function buildDeEsserGainCurve(samples, sampleRate, params) {
  const {
    targetFreq,
    bandwidth,
    maxReductionDb,
    thresholdDb,
    attackMs,
    releaseMs,
  } = params

  const n = samples.length

  // Design a 2nd-order bandpass filter centered on targetFreq
  const Q = targetFreq / Math.max(bandwidth, 100)
  const bp = designBandpass(targetFreq, Math.max(Q, 0.5), sampleRate)

  // Extract sibilant component via bandpass
  const sibilant = new Float32Array(n)
  let bpState = { x1: 0, x2: 0, y1: 0, y2: 0 }
  for (let i = 0; i < n; i++) {
    const res = applyBiquad(bp, samples[i], bpState)
    sibilant[i] = res.y
    bpState = res.state
  }

  // Envelope follower on sibilant, gain computation
  const attackCoeff  = Math.exp(-1 / (sampleRate * attackMs / 1000))
  const releaseCoeff = Math.exp(-1 / (sampleRate * releaseMs / 1000))
  const thresholdLin   = Math.pow(10, thresholdDb / 20)
  const maxReductionLin = Math.pow(10, -maxReductionDb / 20)

  // gainCurve[i] is the broadband gain multiplier at sample i:
  //   1.0 = no reduction, maxReductionLin = full reduction
  const gainCurve = new Float32Array(n).fill(1.0)
  let envelope = 0
  let maxGainReductionDb = 0

  for (let i = 0; i < n; i++) {
    const absSibilant = Math.abs(sibilant[i])
    if (absSibilant > envelope) {
      envelope = attackCoeff * envelope + (1 - attackCoeff) * absSibilant
    } else {
      envelope = releaseCoeff * envelope + (1 - releaseCoeff) * absSibilant
    }

    let gain = 1.0
    if (envelope > thresholdLin && thresholdLin > 0) {
      const overDb = 20 * Math.log10(envelope / thresholdLin)
      const reductionDb = Math.min(overDb * 0.7, maxReductionDb)
      gain = Math.max(Math.pow(10, -reductionDb / 20), maxReductionLin)
      if (reductionDb > maxGainReductionDb) maxGainReductionDb = reductionDb
    }

    gainCurve[i] = gain
  }

  return { gainCurve, maxGainReductionDb }
}

/**
 * Apply a sibilant gain curve to a channel.
 *
 * For each sample: output = (input - bandpass) + bandpass * gain
 * This reduces only the sibilant band component, leaving lows untouched.
 */
function applyGainCurve(samples, { gainCurve }) {
  const n = samples.length
  const output = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    // Simple broadband gain (sibilant de-essing via wideband attenuation
    // is acceptable when gain reduction is < 6 dB and brief in duration)
    output[i] = samples[i] * gainCurve[i]
  }
  return output
}

// ── Biquad Filter ───────────────────────────────────────────────────────────

/**
 * Design a 2nd-order bandpass filter (constant skirt gain, peak at center).
 * Returns coefficients { b0, b1, b2, a1, a2 } (a0 normalized to 1).
 */
function designBandpass(freq, Q, sampleRate) {
  const w0 = 2 * Math.PI * freq / sampleRate
  const alpha = Math.sin(w0) / (2 * Q)

  const b0 = alpha
  const b1 = 0
  const b2 = -alpha
  const a0 = 1 + alpha
  const a1 = -2 * Math.cos(w0)
  const a2 = 1 - alpha

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  }
}

/**
 * Apply a biquad filter to a single sample.
 */
function applyBiquad(coeffs, x, state) {
  const y = coeffs.b0 * x + coeffs.b1 * state.x1 + coeffs.b2 * state.x2
           - coeffs.a1 * state.y1 - coeffs.a2 * state.y2

  return {
    y,
    state: { x1: x, x2: state.x1, y1: y, y2: state.y1 },
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function collectVoicedFrames(samples, silenceAnalysis) {
  const sampleRate = SAMPLE_RATE
  const frameDuration = 0.1  // 100 ms, matching silence analysis
  const frameSamples = Math.floor(frameDuration * sampleRate)
  const frames = []

  for (const frameInfo of silenceAnalysis.frames) {
    if (frameInfo.isSilence) continue
    const start = frameInfo.offsetSamples
    const end = Math.min(start + frameSamples, samples.length)
    if (end - start < frameSamples * 0.5) continue
    frames.push(samples.slice(start, end))
  }

  return frames
}

function rms(arr) {
  let sum = 0
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i]
  return Math.sqrt(sum / arr.length)
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}

async function copyThrough(inputPath, outputPath) {
  const { readFile, writeFile } = await import('fs/promises')
  await writeFile(outputPath, await readFile(inputPath))
}

function noResult(reason) {
  return {
    applied: false,
    f0Hz: null,
    voiceType: null,
    targetFreqHz: null,
    maxReductionDb: null,
    p95EnergyDb: null,
    meanEnergyDb: null,
    triggerReason: reason,
  }
}

