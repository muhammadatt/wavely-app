/**
 * Stage 4a-E — Frequency-Selective Vocal Expander.
 *
 * Dynamic attenuator that reduces the audibility of residual low-level noise
 * in the silence gaps between words after compression has elevated it. Not a
 * gate, not a replacement for Stage 2 noise reduction: a soft-ratio, band-
 * weighted expander calibrated from the file's measured silence-energy
 * distribution.
 *
 * Chain position: after Stage 4a (serial compression) and Stage 4a-PC
 * (parallel compression); before Stage 4b (Auto Leveler).
 *
 * Architecture (two-path):
 *   - Detection path: 80–800 Hz bandpass (HP80 + LP800 cascade) → 10 ms frame
 *     RMS → threshold compare → gain-reduction envelope with lookahead, attack,
 *     hold, release.
 *   - Attenuation path: static 800 Hz low-pass splits input into low-band and
 *     high-band. Below 800 Hz receives full depth; above 800 Hz receives
 *     softened depth scaled by `highFreqDepth`. Sum is written back to the
 *     output.
 *
 * The spec (addendum, April 2026) suggests FFmpeg `volume` + `equalizer` filters
 * for the DSP. Time-varying per-sample gain with lookahead/hold/release cannot
 * be expressed in FFmpeg filter graphs, so the implementation follows the
 * custom-JS pattern used by compression.js, autoLeveler.js, and
 * parallelCompression.js — read WAV, build sample-level gain curve, write WAV.
 *
 * Reference: Frequency-Selective Vocal Expander Stage Specification (April 2026
 * addendum to instant_polish_processing_spec_v3.md).
 */

import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels }   from './wavWriter.js'

import { PRESETS }            from '../presets.js'

const SAMPLE_RATE      = 44100
const DET_FRAME_S      = 0.010                                  // 10 ms detection frames
const DET_FRAME_SAMPLES = Math.round(DET_FRAME_S * SAMPLE_RATE) // 441
const ANALYSIS_FRAME_S = 0.1                                    // 100 ms — matches frameAnalysis.js
const DET_FRAMES_PER_ANALYSIS_FRAME = Math.round(ANALYSIS_FRAME_S / DET_FRAME_S) // 10

const SKIP_THRESHOLD_DBFS = -72   // skip stage entirely when silence floor is this clean
//const THRESHOLD_FLOOR_DBFS = -70  // clamp below this — expander wouldn't contribute
const ATTENUATION_DETECT_DB = 0.1 // minimum attenuation to count a frame as "expanded"

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Apply frequency-selective vocal expansion to an audio file.
 *
 * @param {string} inputPath    - 32-bit float WAV (internal format)
 * @param {string} outputPath   - Output WAV path
 * @param {string} presetId
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 *   Pre-stage frame analysis (VAD labels + pre-compression silence energy).
 *   Provided via ctx.results.metrics from remeasureFramesPostNr.
 * @returns {VocalExpanderResult}
 *
 * @typedef {Object} VocalExpanderResult
 * @property {boolean} applied
 * @property {string|null} reason
 * @property {number|null} silenceP90PreDb
 * @property {number|null} noiseFloorDb
 * @property {number|null} fullVoicedP50Db
 * @property {number|null} thresholdFromNoiseFloor
 * @property {number|null} thresholdFromVoiced
 * @property {number|null} thresholdDb
 * @property {number|null} headroomOffsetDb
 * @property {number|null} ratio
 * @property {number|null} highFreqDepth
 * @property {number|null} releaseMs
 * @property {number|null} maxAttenuationDb
 * @property {number|null} avgAttenuationSilenceDb
 * @property {number|null} maxAttenuationAppliedDb
 * @property {number|null} pctFramesExpanded
 * @property {number|null} maxVoicedFrameAttenuationDb
 * @property {boolean} overExpansionFlag
 */
export async function applyVocalExpander(inputPath, outputPath, presetId, frameAnalysis) {
  const config = PRESETS[presetId]?.vocalExpander

  if (!config || config.enabled !== true) {
    await copyThrough(inputPath, outputPath)
    return skipResult('preset_not_applicable', config)
  }

  if (!frameAnalysis || !frameAnalysis.frames || frameAnalysis.frames.length === 0) {
    await copyThrough(inputPath, outputPath)
    return skipResult('frame_analysis_unavailable', config)
  }

  // ── Step 1: pre-compression silence P90 (snapshot the reference metrics) ──

  const silenceP90PreDb = computeSilenceP90Db(frameAnalysis)

  // ── Step 2: read audio ────────────────────────────────────────────────────

  const { channels, sampleRate } = await readWavAllChannels(inputPath)
  if (sampleRate !== SAMPLE_RATE) {
    // Internal pipeline format is always 44.1 kHz; any deviation is a bug
    // upstream. Fail loudly rather than silently applying a miscalibrated
    // stage.
    throw new Error(
      `[vocalExpander] unexpected sample rate ${sampleRate} — internal format is ${SAMPLE_RATE} Hz`,
    )
  }

  const n = channels[0].length

  // ── Step 3: detection path (80–800 Hz bandpass) + 10 ms frame RMS ─────────
  // Moved before threshold calibration so that calibration operates in the
  // same domain (detection band) as the threshold comparison in Step 7.

  const detection = applyHighpass(channels[0], sampleRate, config.detectionBand.lowHz)
  applyLowpassInPlace(detection, sampleRate, config.detectionBand.highHz)

  const numDetFrames = Math.floor(n / DET_FRAME_SAMPLES)
  const detRmsDb = new Float64Array(numDetFrames)
  for (let f = 0; f < numDetFrames; f++) {
    const start = f * DET_FRAME_SAMPLES
    let sumSq = 0
    for (let i = start; i < start + DET_FRAME_SAMPLES; i++) sumSq += detection[i] * detection[i]
    const rms = Math.sqrt(sumSq / DET_FRAME_SAMPLES)
    detRmsDb[f] = rms > 0 ? 20 * Math.log10(rms) : -120
  }

  // ── Step 4: calibration from measured noise floor ──────────────────────────
  // Use the actual noise floor measurement from frameAnalysis, not Silero's
  // silence labels. Silero's "silence" includes breaths (-20 to -30 dB) which
  // are not noise floor — they're non-speech sounds that should NOT be
  // attenuated. The bootstrapped noiseFloorDbfs represents the true quiet
  // floor (typically -50 to -60 dB) that we want to target.
  //
  // For the voiced anchor, compute P50 of voiced frames to establish a ceiling
  // that protects speech from over-expansion.

  const noiseFloorDb = frameAnalysis.noiseFloorDbfs

  const fullVoicedDb = []
  for (const frame of frameAnalysis.frames) {
    if (!frame.isSilence) {
      fullVoicedDb.push(frame.rmsDbfs)
    }
  }
  const fullVoicedP50Db = computePercentile(fullVoicedDb, 0.5)

  // ── Step 5: skip condition ────────────────────────────────────────────────

  if (noiseFloorDb == null) {
    await copyThrough(inputPath, outputPath)
    return { ...skipResult('no_noise_floor_measurement', config), silenceP90PreDb }
  }

  if (noiseFloorDb < SKIP_THRESHOLD_DBFS) {
    await copyThrough(inputPath, outputPath)
    return {
      ...skipResult('noise_floor_already_below_-72_dbfs', config),
      silenceP90PreDb,
      noiseFloorDb: round2(noiseFloorDb),
    }
  }

  // ── Step 6: threshold calibration ─────────────────────────────────────────
  // Two anchors:
  //   thresholdFromNoiseFloor: headroomOffsetDb above the measured noise floor
  //     — ensures actual noise (not breaths) triggers expansion.
  //   thresholdFromVoiced: headroomOffsetDb below full-band voiced P50
  //     — ensures most voiced frames do not trigger expansion.
  //
  // We use the bootstrapped noiseFloorDbfs (quietest frames) rather than
  // Silero's silence P90, because Silero labels breaths as "silence" even
  // though they're at -20 to -30 dB. Breaths should NOT be attenuated.
  //
  // Math.min picks the stricter (lower) anchor; the Math.max floor at
  // noiseFloorDb prevents the voiced guard from dragging the threshold
  // below the noise floor.

  const thresholdFromNoiseFloor = noiseFloorDb + config.headroomOffsetDb
  const thresholdFromVoiced     = fullVoicedP50Db != null
    ? fullVoicedP50Db - config.headroomOffsetDb
    : thresholdFromNoiseFloor
  const thresholdDb = Math.max(
    Math.min(thresholdFromNoiseFloor, thresholdFromVoiced),
    noiseFloorDb,
  )

  // ── Step 7: per-frame target gain reduction (dB, ≤ 0) ─────────────────────

  const targetGrDb = new Float64Array(numDetFrames)
  for (let f = 0; f < numDetFrames; f++) {
    const rmsDb = detRmsDb[f]
    if (rmsDb >= thresholdDb) {
      targetGrDb[f] = 0
    } else {
      const below = thresholdDb - rmsDb
      const rawGrDb = below * (1 - 1 / config.ratio)
      targetGrDb[f] = -Math.min(rawGrDb, config.maxAttenuationDb)
    }
  }

  // ── Step 8: envelope smoothing (lookahead + attack + hold + release) ──────

  const smoothedGrDb = applyEnvelope(targetGrDb, {
    attackFrames:    Math.max(1, Math.round(config.attackMs    / (DET_FRAME_S * 1000))),
    holdFrames:      Math.max(0, Math.round(config.holdMs      / (DET_FRAME_S * 1000))),
    releaseFrames:   Math.max(1, Math.round(config.releaseMs   / (DET_FRAME_S * 1000))),
    lookaheadFrames: Math.max(0, Math.round(config.lookaheadMs / (DET_FRAME_S * 1000))),
  })

  // ── Step 10: build band-weighted per-sample gain & apply ──────────────────
  //
  // The spec defines a softened_ratio above 800 Hz of
  //   softened_ratio = 1 + (ratio - 1) * high_freq_depth
  // which is mathematically equivalent to scaling the computed gain-reduction
  // (in dB) by `highFreqDepth` above 800 Hz. The simpler dB-scaling form is
  // used here.
  //
  // Decomposition: y = x * gainHigh + low * (gainLow - gainHigh)
  //   where `low` is a static 800 Hz low-pass of x. Below 800 Hz the effective
  //   gain is gainLow; above 800 Hz it is gainHigh. One lowpass per channel.

  const processedChannels = new Array(channels.length)

  let avgAttenSilenceSum = 0
  let avgAttenSilenceCount = 0
  let maxAttenDb = 0
  let maxVoicedAttenDb = 0
  let expandedFrameCount = 0

  for (let ch = 0; ch < channels.length; ch++) {
    const x = channels[ch]
    const low = applyLowpassCopy(x, sampleRate, config.detectionBand.highHz)
    const y = new Float32Array(n)

    for (let i = 0; i < n; i++) {
      const frameIdx = Math.min(Math.floor(i / DET_FRAME_SAMPLES), numDetFrames - 1)
      const nextFrameIdx = Math.min(frameIdx + 1, numDetFrames - 1)
      const progress = (i - frameIdx * DET_FRAME_SAMPLES) / DET_FRAME_SAMPLES

      const grDb = smoothedGrDb[frameIdx] * (1 - progress) + smoothedGrDb[nextFrameIdx] * progress

      const gainHighLin = Math.pow(10, (grDb * config.highFreqDepth) / 20)
      const gainLowLin  = Math.pow(10, grDb / 20)

      y[i] = x[i] * gainHighLin + low[i] * (gainLowLin - gainHighLin)
    }

    processedChannels[ch] = y
  }

  // ── Step 11: aggregate statistics for the report ──────────────────────────

  for (let f = 0; f < numDetFrames; f++) {
    const attenDb = -smoothedGrDb[f] // positive attenuation magnitude
    if (attenDb > ATTENUATION_DETECT_DB) expandedFrameCount++
    if (attenDb > maxAttenDb) maxAttenDb = attenDb

    const analysisIdx = Math.floor(f / DET_FRAMES_PER_ANALYSIS_FRAME)
    const analysisFrame = frameAnalysis.frames[analysisIdx]
    if (!analysisFrame) continue

    if (analysisFrame.isSilence) {
      if (attenDb > ATTENUATION_DETECT_DB) {
        avgAttenSilenceSum += attenDb
        avgAttenSilenceCount++
      }
    } else {
      if (attenDb > maxVoicedAttenDb) maxVoicedAttenDb = attenDb
    }
  }

  const avgAttenuationSilenceDb = avgAttenSilenceCount > 0
    ? avgAttenSilenceSum / avgAttenSilenceCount
    : 0
  const pctFramesExpanded = numDetFrames > 0
    ? (expandedFrameCount / numDetFrames) * 100
    : 0
  const overExpansionFlag = pctFramesExpanded > 35 || maxVoicedAttenDb > 3

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  return {
    applied:                     true,
    reason:                      null,
    silenceP90PreDb:             silenceP90PreDb != null ? round2(silenceP90PreDb) : null,
    noiseFloorDb:                round2(noiseFloorDb),
    fullVoicedP50Db:             fullVoicedP50Db != null ? round2(fullVoicedP50Db) : null,
    thresholdFromNoiseFloor:     round2(thresholdFromNoiseFloor),
    thresholdFromVoiced:         fullVoicedP50Db != null ? round2(thresholdFromVoiced) : null,
    thresholdDb:                 round2(thresholdDb),
    headroomOffsetDb:            config.headroomOffsetDb,
    ratio:                       config.ratio,
    highFreqDepth:               config.highFreqDepth,
    releaseMs:                   config.releaseMs,
    maxAttenuationDb:            config.maxAttenuationDb,
    avgAttenuationSilenceDb:     round2(avgAttenuationSilenceDb),
    maxAttenuationAppliedDb:     round2(maxAttenDb),
    pctFramesExpanded:           round2(pctFramesExpanded),
    maxVoicedFrameAttenuationDb: round2(maxVoicedAttenDb),
    overExpansionFlag,
  }
}

// ── Silence P90 ─────────────────────────────────────────────────────────────

/**
 * Compute the P90 of silence-frame RMS (dBFS) from a FrameAnalysis.
 * Uses the "ceil index" percentile convention, matching compression.js.
 *
 * @param {import('./frameAnalysis.js').FrameAnalysis} fa
 * @returns {number|null}
 */
function computeSilenceP90Db(fa) {
  const silenceDb = []
  for (const frame of fa.frames) {
    if (frame.isSilence) silenceDb.push(frame.rmsDbfs)
  }
  if (silenceDb.length === 0) return null
  silenceDb.sort((a, b) => a - b)
  const idx = Math.max(0, Math.min(silenceDb.length - 1, Math.ceil(0.9 * silenceDb.length) - 1))
  return silenceDb[idx]
}

// ── Percentile helper ───────────────────────────────────────────────────────

/**
 * Compute an arbitrary percentile from a numeric array.
 * Uses the "ceil index" convention, matching compression.js.
 * The array is sorted ascending in-place.
 *
 * @param {number[]} arr - Values (mutated by sort)
 * @param {number}   p   - Percentile in [0, 1] (e.g. 0.9 for P90, 0.1 for P10)
 * @returns {number|null}
 */
function computePercentile(arr, p) {
  if (arr.length === 0) return null
  arr.sort((a, b) => a - b)
  const idx = Math.max(0, Math.min(arr.length - 1, Math.ceil(p * arr.length) - 1))
  return arr[idx]
}

// ── Envelope smoothing ──────────────────────────────────────────────────────

/**
 * Apply lookahead + attack + hold + release smoothing to a per-frame target
 * gain-reduction curve. Returns a smoothed gain curve in dB (≤ 0).
 *
 * Hold logic (per spec): after the signal rises above threshold (target
 * transitions from negative to 0), `holdFrames` frames pass before the
 * release phase begins. Prevents micro-pumping on brief consonant gaps.
 *
 * Lookahead: the gain at frame i is derived from the target at
 * i + lookaheadFrames, so the release begins fractionally before a voiced
 * onset rather than reacting to it.
 */
function applyEnvelope(targetGrDb, { attackFrames, holdFrames, releaseFrames, lookaheadFrames }) {
  const n = targetGrDb.length
  const out = new Float64Array(n)
  const attackCoeff  = Math.exp(-1 / attackFrames)
  const releaseCoeff = Math.exp(-1 / releaseFrames)

  let currentDb = 0
  let holdCounter = 0
  let lastAttenuating = false

  for (let f = 0; f < n; f++) {
    const lookIdx = Math.min(f + lookaheadFrames, n - 1)
    const target = targetGrDb[lookIdx]

    if (target < -1e-6) {
      // Below threshold — attack toward target (more attenuation).
      holdCounter = 0
      lastAttenuating = true
      currentDb = attackCoeff * currentDb + (1 - attackCoeff) * target
    } else {
      // At / above threshold.
      if (lastAttenuating) {
        // Transition from below → above: start hold
        holdCounter = holdFrames
        lastAttenuating = false
      }

      if (holdCounter > 0 && currentDb < -0.05) {
        holdCounter--
        // hold: currentDb unchanged
      } else {
        // release toward 0
        currentDb = releaseCoeff * currentDb // (1 - releaseCoeff) * 0 = 0
        if (currentDb > -1e-4) currentDb = 0 // snap to exactly zero once negligible
      }
    }

    out[f] = currentDb
  }

  return out
}

// ── Biquad filters (RBJ cookbook, 2nd order) ────────────────────────────────

/**
 * Apply a 2nd-order Butterworth low-pass biquad (Q = 0.707) in-place.
 */
function applyLowpassInPlace(samples, fs, f0) {
  const { b0, b1, b2, a1, a2 } = lowpassCoeffs(fs, f0)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x
    y2 = y1; y1 = y
    samples[i] = y
  }
}

/**
 * Apply a 2nd-order Butterworth low-pass biquad returning a new Float32Array.
 * Leaves the input unchanged (used to produce a low-band copy alongside the
 * original wideband signal for mix-back).
 */
function applyLowpassCopy(samples, fs, f0) {
  const out = new Float32Array(samples.length)
  const { b0, b1, b2, a1, a2 } = lowpassCoeffs(fs, f0)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x
    y2 = y1; y1 = y
    out[i] = y
  }
  return out
}

/**
 * Apply a 2nd-order Butterworth high-pass biquad returning a new Float32Array.
 */
function applyHighpass(samples, fs, f0) {
  const out = new Float32Array(samples.length)
  const { b0, b1, b2, a1, a2 } = highpassCoeffs(fs, f0)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x
    y2 = y1; y1 = y
    out[i] = y
  }
  return out
}

function lowpassCoeffs(fs, f0) {
  const Q  = Math.SQRT1_2
  const w0 = (2 * Math.PI * f0) / fs
  const c  = Math.cos(w0)
  const a  = Math.sin(w0) / (2 * Q)
  const a0 = 1 + a
  return {
    b0: ((1 - c) / 2) / a0,
    b1: (1 - c)       / a0,
    b2: ((1 - c) / 2) / a0,
    a1: (-2 * c)      / a0,
    a2: (1 - a)       / a0,
  }
}

function highpassCoeffs(fs, f0) {
  const Q  = Math.SQRT1_2
  const w0 = (2 * Math.PI * f0) / fs
  const c  = Math.cos(w0)
  const a  = Math.sin(w0) / (2 * Q)
  const a0 = 1 + a
  return {
    b0: ((1 + c) / 2)  / a0,
    b1: (-(1 + c))     / a0,
    b2: ((1 + c) / 2)  / a0,
    a1: (-2 * c)       / a0,
    a2: (1 - a)        / a0,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function skipResult(reason, config) {
  return {
    applied:                     false,
    reason,
    silenceP90PreDb:             null,
    silenceP90PostDb:            null,
    thresholdDb:                 null,
    headroomOffsetDb:            config?.headroomOffsetDb ?? null,
    ratio:                       config?.ratio ?? null,
    highFreqDepth:               config?.highFreqDepth ?? null,
    releaseMs:                   config?.releaseMs ?? null,
    maxAttenuationDb:            config?.maxAttenuationDb ?? null,
    avgAttenuationSilenceDb:     null,
    maxAttenuationAppliedDb:     null,
    pctFramesExpanded:           null,
    maxVoicedFrameAttenuationDb: null,
    overExpansionFlag:           false,
  }
}

function round2(n) {
  return n != null ? Math.round(n * 100) / 100 : null
}

async function copyThrough(inputPath, outputPath) {
  const { readFile, writeFile } = await import('fs/promises')
  await writeFile(outputPath, await readFile(inputPath))
}
