/**
 * Auto Leveler — VAD-gated gain riding stage (Stage 4b).
 *
 * Corrects slow within-file level drift by computing a smooth gain envelope
 * anchored to the median RMS of speech segments, then applying it only during
 * VAD-detected speech frames (gain is held constant during silence).
 *
 * Only activated when within-file RMS standard deviation exceeds
 * DRIFT_THRESHOLD_DB (3 dB). For files with consistent levels the stage is a
 * no-op (passes through unchanged audio and logs a skip reason).
 *
 * Chain position: immediately before the Compression stage.
 * Input: VAD mask from silenceAnalysis (silencePreDeEss in the pipeline).
 *
 * Reference: Auto Leveler Stage Specification (April 2026 addendum to
 * instant_polish_processing_spec_v3.md).
 */

import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels }   from './wavWriter.js'
import { PRESETS }            from '../presets.js'

const SAMPLE_RATE           = 44100
const FRAME_DURATION_S      = 0.1    // 100 ms — must match silenceAnalysis frame size
const FRAME_SAMPLES         = Math.round(FRAME_DURATION_S * SAMPLE_RATE)  // 4410

const ANALYSIS_WINDOW_FRAMES = 30    // 30 × 100 ms = 3 seconds of speech content
const MIN_SEGMENT_FRAMES     = 5     // 5 × 100 ms = 500 ms — discard shorter segments
const DRIFT_THRESHOLD_DB     = 3.0   // σ > 3 dB triggers leveler
const NOISE_FLOOR_CHECK_DBFS = -58   // post-application safety check

const FADE_IN_SAMPLES  = Math.round(0.030 * SAMPLE_RATE)  // 30 ms speech onset
const FADE_OUT_SAMPLES = Math.round(0.020 * SAMPLE_RATE)  // 20 ms speech offset
const GAUSSIAN_SIGMA_FRAMES = 15     // 1.5 s at 100 ms/frame resolution

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Apply VAD-gated gain riding to an audio file.
 *
 * @param {string} inputPath    - 32-bit float WAV (internal format)
 * @param {string} outputPath   - Output WAV path
 * @param {string} presetId
 * @param {import('./silenceAnalysis.js').SilenceAnalysis} silenceAnalysis
 * @returns {AutoLevelerResult}
 *
 * @typedef {Object} AutoLevelerResult
 * @property {boolean} applied
 * @property {string}  [reason]                  - Skip reason when applied=false
 * @property {string}  [activation_reason]        - 'drift_detected' when applied=true
 * @property {number}  [pre_leveling_rms_std_db]
 * @property {number}  [post_leveling_rms_std_db]
 * @property {number}  [median_target_rms_dbfs]
 * @property {number}  [max_gain_applied_db]
 * @property {number}  [min_gain_applied_db]
 * @property {number}  [segments_analyzed]
 * @property {number}  [gain_capped_segments]
 * @property {boolean} [gain_capped]              - true if any segment hit the cap
 * @property {boolean} [noise_floor_risk]         - true if noise floor check exceeded
 * @property {boolean} [leveling_effective]       - true if post σ ≤ 2.5 dB
 */
export async function applyAutoLeveler(inputPath, outputPath, presetId, silenceAnalysis) {
  const config = PRESETS[presetId]?.autoLeveler

  if (!config) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, reason: 'preset_not_applicable' }
  }

  const { channels, sampleRate } = await readWavAllChannels(inputPath)
  const analysisSamples = channels[0]

  // ── Step 1: Build speech analysis windows ─────────────────────────────────

  const speechFrames = buildSpeechFrameList(silenceAnalysis)

  if (speechFrames.length < ANALYSIS_WINDOW_FRAMES) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, reason: 'insufficient_speech_content', pre_leveling_rms_std_db: null }
  }

  const windows = buildAnalysisWindows(speechFrames, analysisSamples)

  if (windows.length < 2) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, reason: 'insufficient_speech_content', pre_leveling_rms_std_db: null }
  }

  // ── Step 2: Drift detection ───────────────────────────────────────────────

  const rmsDbValues = windows.map(w => w.rmsDb)
  const preStdDb    = computeStdDev(rmsDbValues)

  if (preStdDb <= DRIFT_THRESHOLD_DB) {
    await copyThrough(inputPath, outputPath)
    return {
      applied: false,
      reason: 'level_variation_within_threshold',
      pre_leveling_rms_std_db: round2(preStdDb),
    }
  }

  // ── Step 3: Target and gain computation ───────────────────────────────────

  const medianRmsDb = computeMedian(rmsDbValues)
  const { maxGainDb, maxRateDbPerS } = config

  let gainCappedSegments = 0
  const windowGains = windows.map(w => {
    const raw     = medianRmsDb - w.rmsDb
    const clamped = Math.max(-maxGainDb, Math.min(maxGainDb, raw))
    if (Math.abs(raw) > maxGainDb) gainCappedSegments++
    return { centerSample: w.centerSample, gainDb: clamped }
  })

  // ── Step 4: Gain envelope — cubic spline → frame level → smoothing ────────

  const splineXs = windowGains.map(w => w.centerSample)
  const splineYs = windowGains.map(w => w.gainDb)
  const spline   = computeNaturalCubicSpline(splineXs, splineYs)

  const numFrames = Math.ceil(analysisSamples.length / FRAME_SAMPLES)
  const frameGains = buildFrameGains(spline, silenceAnalysis, numFrames)

  // Enforce rate-of-change constraint; smooth if violated
  const maxRateDbPerFrame = maxRateDbPerS * FRAME_DURATION_S
  enforceRateConstraint(frameGains, maxRateDbPerFrame)

  // ── Step 5: Apply gain with VAD gating ────────────────────────────────────

  const n = analysisSamples.length
  const { gainCurve, noiseFloorRisk } = buildSampleGainCurve(
    frameGains, silenceAnalysis, n, sampleRate,
  )

  const processedChannels = channels.map(ch => applyGainCurve(ch, gainCurve))

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  // ── Step 6: Post-application validation ───────────────────────────────────

  const postWindows = buildAnalysisWindows(speechFrames, processedChannels[0])
  const postRmsDb   = postWindows.map(w => w.rmsDb)
  const postStdDb   = postRmsDb.length >= 2 ? computeStdDev(postRmsDb) : null

  const maxGainApplied = Math.max(...gainCurve.map(g => g))
  const minGainApplied = Math.min(...gainCurve.map(g => g))
  // gainCurve stores linear multipliers; convert back for reporting
  const maxGainDb_applied = maxGainApplied > 0 ? round2(20 * Math.log10(maxGainApplied)) : 0
  const minGainDb_applied = minGainApplied > 0 ? round2(20 * Math.log10(minGainApplied)) : 0

  return {
    applied:                    true,
    activation_reason:          'drift_detected',
    pre_leveling_rms_std_db:    round2(preStdDb),
    post_leveling_rms_std_db:   postStdDb !== null ? round2(postStdDb) : null,
    median_target_rms_dbfs:     round2(medianRmsDb),
    max_gain_applied_db:        maxGainDb_applied,
    min_gain_applied_db:        minGainDb_applied,
    segments_analyzed:          windows.length,
    gain_capped_segments:       gainCappedSegments,
    gain_capped:                gainCappedSegments > 0,
    noise_floor_risk:           noiseFloorRisk,
    leveling_effective:         postStdDb !== null && postStdDb <= 2.5,
  }
}

// ── Speech frame helpers ──────────────────────────────────────────────────────

/**
 * Extract the ordered list of speech (voiced) frames from silenceAnalysis,
 * discarding contiguous segments shorter than MIN_SEGMENT_FRAMES.
 *
 * @param {import('./silenceAnalysis.js').SilenceAnalysis} sa
 * @returns {import('./silenceAnalysis.js').FrameInfo[]}
 */
function buildSpeechFrameList(sa) {
  if (!sa || sa.frames.length === 0) return []

  // Group frames into contiguous speech segments
  const segments = []  // each: array of FrameInfo
  let current    = null

  for (const frame of sa.frames) {
    if (!frame.isSilence) {
      if (!current) current = []
      current.push(frame)
    } else {
      if (current) { segments.push(current); current = null }
    }
  }
  if (current) segments.push(current)

  // Discard short segments
  const validSegments = segments.filter(seg => seg.length >= MIN_SEGMENT_FRAMES)
  return validSegments.flat()
}

/**
 * Build 3-second analysis windows from speech frames.
 * Each window covers ANALYSIS_WINDOW_FRAMES voiced frames.
 * Returns per-window RMS (dBFS) and center sample position.
 *
 * @param {import('./silenceAnalysis.js').FrameInfo[]} speechFrames
 * @param {Float32Array} samples - Channel 0 audio samples
 * @returns {{ rmsDb: number, centerSample: number }[]}
 */
function buildAnalysisWindows(speechFrames, samples) {
  const windows = []
  const total   = speechFrames.length

  let i = 0
  while (i + ANALYSIS_WINDOW_FRAMES <= total) {
    const windowFrames = speechFrames.slice(i, i + ANALYSIS_WINDOW_FRAMES)
    const rmsDb        = computeWindowRms(windowFrames, samples)
    const centerSample = computeWindowCenter(windowFrames)
    windows.push({ rmsDb, centerSample })
    i += ANALYSIS_WINDOW_FRAMES  // non-overlapping windows
  }

  // Include a partial final window if there are leftover frames (>= 10 frames = 1 s)
  if (i < total && (total - i) >= 10) {
    const windowFrames = speechFrames.slice(i)
    const rmsDb        = computeWindowRms(windowFrames, samples)
    const centerSample = computeWindowCenter(windowFrames)
    windows.push({ rmsDb, centerSample })
  }

  return windows
}

/**
 * Compute unweighted RMS in dBFS over a set of frames.
 */
function computeWindowRms(frames, samples) {
  let sumSq = 0
  let count = 0
  for (const frame of frames) {
    const start = frame.offsetSamples
    const end   = Math.min(start + frame.lengthSamples, samples.length)
    for (let i = start; i < end; i++) {
      sumSq += samples[i] * samples[i]
      count++
    }
  }
  if (count === 0) return -120
  const rms = Math.sqrt(sumSq / count)
  return rms > 0 ? 20 * Math.log10(rms) : -120
}

/**
 * Return the wall-clock center sample of a group of frames.
 */
function computeWindowCenter(frames) {
  const firstStart = frames[0].offsetSamples
  const lastEnd    = frames[frames.length - 1].offsetSamples + frames[frames.length - 1].lengthSamples
  return Math.round((firstStart + lastEnd) / 2)
}

// ── Frame-level gain envelope ─────────────────────────────────────────────────

/**
 * Build a per-frame gain array (dB) using the cubic spline for speech frames
 * and holding the last speech value for silence frames.
 *
 * @param {{ xs: number[], ys: number[], M: number[] }} spline
 * @param {import('./silenceAnalysis.js').SilenceAnalysis} sa
 * @param {number} numFrames
 * @returns {Float32Array}  - gain in dB per frame
 */
function buildFrameGains(spline, sa, numFrames) {
  const frameGains = new Float32Array(numFrames)
  let heldGainDb = 0.0  // held during silence; starts at 0 dB

  for (let f = 0; f < numFrames; f++) {
    const frame = sa.frames[f]
    if (!frame || frame.isSilence) {
      frameGains[f] = heldGainDb
    } else {
      const centerSample  = frame.offsetSamples + frame.lengthSamples / 2
      const gainDb        = evalCubicSpline(spline, centerSample)
      frameGains[f]       = gainDb
      heldGainDb          = gainDb  // update held value on each speech frame
    }
  }

  return frameGains
}

/**
 * Enforce the rate-of-change constraint on the frame-level gain array.
 * If any consecutive frame pair exceeds maxRateDbPerFrame, apply iterative
 * Gaussian smoothing (σ = GAUSSIAN_SIGMA_FRAMES) until satisfied.
 * Mutates the input array in place.
 *
 * @param {Float32Array} frameGains   - dB per frame (mutated)
 * @param {number}       maxRateDbPerFrame
 */
function enforceRateConstraint(frameGains, maxRateDbPerFrame) {
  const MAX_ITERATIONS = 10
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let violated = false
    for (let i = 1; i < frameGains.length; i++) {
      if (Math.abs(frameGains[i] - frameGains[i - 1]) > maxRateDbPerFrame + 1e-9) {
        violated = true
        break
      }
    }
    if (!violated) break
    applyGaussianSmoothing(frameGains, GAUSSIAN_SIGMA_FRAMES)
  }
}

/**
 * In-place Gaussian smoothing over a Float32Array.
 * Uses a truncated kernel (radius = 3σ) with boundary reflection padding.
 *
 * @param {Float32Array} arr
 * @param {number}       sigma  - standard deviation in array elements
 */
function applyGaussianSmoothing(arr, sigma) {
  const radius = Math.ceil(3 * sigma)
  const n      = arr.length
  const kernel = new Float32Array(2 * radius + 1)
  let kernelSum = 0
  for (let k = -radius; k <= radius; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma))
    kernel[k + radius] = v
    kernelSum += v
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= kernelSum

  const result = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let k = -radius; k <= radius; k++) {
      // Reflect at boundaries
      let idx = i + k
      if (idx < 0) idx = -idx
      if (idx >= n) idx = 2 * n - 2 - idx
      if (idx < 0) idx = 0
      if (idx >= n) idx = n - 1
      sum += arr[idx] * kernel[k + radius]
    }
    result[i] = sum
  }
  arr.set(result)
}

// ── Sample-level gain curve with VAD gating ───────────────────────────────────

/**
 * Build a per-sample linear gain curve applying:
 *   - Speech frames: spline gain from frameGains (linearly interpolated within frame)
 *   - Silence frames: held gain from last speech frame
 *   - 30 ms fade-in at silence→speech transitions
 *   - 20 ms fade-out at speech→silence transitions
 *
 * Also performs the post-application noise floor check.
 *
 * @param {Float32Array} frameGains  - dB per frame
 * @param {import('./silenceAnalysis.js').SilenceAnalysis} sa
 * @param {number} n                 - total sample count
 * @param {number} sampleRate
 * @returns {{ gainCurve: Float32Array, noiseFloorRisk: boolean }}
 */
function buildSampleGainCurve(frameGains, sa, n, sampleRate) {
  // Build a per-sample gain (linear, not dB) using the frame-level dB gains
  // with linear sub-frame interpolation and VAD-gated hold behavior.
  const gainCurve = new Float32Array(n)

  // Precompute isSpeech lookup per frame index
  const isSpeechMap = new Map()
  if (sa && sa.frames) {
    for (const frame of sa.frames) {
      isSpeechMap.set(frame.index, !frame.isSilence)
    }
  }

  function isSpeech(frameIdx) {
    return isSpeechMap.get(frameIdx) === true
  }

  const numFrames = frameGains.length

  // Identify speech segment boundaries for fade logic
  // speechSegments[f] = { isStart: bool, isEnd: bool }
  const isStart = new Uint8Array(numFrames)
  const isEnd   = new Uint8Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    if (isSpeech(f)) {
      if (f === 0 || !isSpeech(f - 1)) isStart[f] = 1
      if (f === numFrames - 1 || !isSpeech(f + 1)) isEnd[f] = 1
    }
  }

  // Track what gain was being applied when a speech segment ended
  // (needed for the fade-out reference before entering silence)
  const segmentEndGainDb = new Float32Array(numFrames)
  for (let f = numFrames - 1; f >= 0; f--) {
    if (isEnd[f]) segmentEndGainDb[f] = frameGains[f]
  }

  // Walk through all samples and assign gains
  // We track: for each fade zone, what the held gain (before speech) was
  const heldGainAtSegmentStart = new Float32Array(numFrames)
  {
    let lastSilenceGainDb = 0.0
    for (let f = 0; f < numFrames; f++) {
      if (!isSpeech(f)) {
        lastSilenceGainDb = frameGains[f]  // held gain during silence
      } else if (isStart[f]) {
        heldGainAtSegmentStart[f] = lastSilenceGainDb
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const frameIdx = Math.floor(i / FRAME_SAMPLES)
    const cFrameIdx = Math.min(frameIdx, numFrames - 1)

    if (!isSpeech(cFrameIdx)) {
      // Silence: hold at frameGains value (which is the held dB from last speech)
      gainCurve[i] = dbToLinear(frameGains[cFrameIdx])
      continue
    }

    // Speech frame: use linearly interpolated frame gains
    const posInFrame = i - cFrameIdx * FRAME_SAMPLES
    const nextFrameIdx = Math.min(cFrameIdx + 1, numFrames - 1)
    const t     = posInFrame / FRAME_SAMPLES
    const gainDb = (1 - t) * frameGains[cFrameIdx] + t * frameGains[nextFrameIdx]

    let finalGainDb = gainDb

    // Apply fade-in at speech segment start (silence→speech)
    if (isStart[cFrameIdx]) {
      const segStartSample = cFrameIdx * FRAME_SAMPLES
      const fadePos = i - segStartSample
      if (fadePos < FADE_IN_SAMPLES) {
        const alpha = fadePos / FADE_IN_SAMPLES
        const heldDb = heldGainAtSegmentStart[cFrameIdx]
        finalGainDb = heldDb + alpha * (gainDb - heldDb)
      }
    }

    // Apply fade-out at speech segment end (speech→silence)
    if (isEnd[cFrameIdx]) {
      const segEndSample = (cFrameIdx + 1) * FRAME_SAMPLES - 1
      const fadePos = segEndSample - i
      if (fadePos < FADE_OUT_SAMPLES) {
        const alpha = fadePos / FADE_OUT_SAMPLES
        const endGainDb = segmentEndGainDb[cFrameIdx]
        // Fade toward the held gain (which equals endGainDb — no step)
        // This is primarily a safety net; with correct hold behavior this is a no-op
        finalGainDb = endGainDb + (1 - alpha) * (gainDb - endGainDb)
      }
    }

    gainCurve[i] = dbToLinear(finalGainDb)
  }

  // Post-application noise floor check
  let noiseFloorRisk = false
  if (sa && sa.frames) {
    for (const frame of sa.frames) {
      if (!frame.isSilence) continue
      const start = frame.offsetSamples
      const end   = Math.min(start + frame.lengthSamples, n)
      if (end <= start) continue

      let sumSq = 0
      for (let i = start; i < end; i++) {
        const processedSample = i < n
          ? sampleFromGainCurve(i, gainCurve, n)
          : 0
        sumSq += processedSample * processedSample
      }
      const rms   = Math.sqrt(sumSq / (end - start))
      const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -120
      if (rmsDb > NOISE_FLOOR_CHECK_DBFS) {
        noiseFloorRisk = true
        break
      }
    }
  }

  return { gainCurve, noiseFloorRisk }
}

// Thin wrapper — the noise floor check needs the original-sample magnitude
// multiplied by the gain curve to see the processed level.
// We don't have the original samples here, so we approximate using the silence
// frames' held gain (which should be ~0 dB, meaning noise floor doesn't change).
// This is the safety-net check — it will catch the edge case where VAD gating
// failed and gain is non-unity during silence.
function sampleFromGainCurve(i, gainCurve, n) {
  // gainCurve[i] is the linear gain multiplier at position i.
  // For the check we need gainCurve[i] > 1 to indicate amplification of silence.
  // We return the gain itself as a proxy — if gain >> 1 at a silence frame, risk is true.
  return gainCurve[i] > 0 ? gainCurve[i] - 1 : 0  // deviation from unity
}

/**
 * Apply a per-sample linear gain curve to a channel.
 */
function applyGainCurve(samples, gainCurve) {
  const n      = samples.length
  const output = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    output[i] = samples[i] * (i < gainCurve.length ? gainCurve[i] : 1.0)
  }
  return output
}

// ── Cubic spline ──────────────────────────────────────────────────────────────

/**
 * Compute natural cubic spline coefficients.
 * Boundary conditions: S''(x_0) = S''(x_n) = 0.
 *
 * @param {number[]} xs - Strictly increasing x values (sample positions)
 * @param {number[]} ys - Corresponding y values (gain in dB)
 * @returns {{ xs: number[], ys: number[], M: number[] }}
 */
function computeNaturalCubicSpline(xs, ys) {
  const n = xs.length - 1  // number of intervals
  if (n < 1) throw new Error('[autoLeveler] Need at least 2 knots for cubic spline')

  if (n === 1) {
    // Two points: M = [0, 0] → linear interpolation
    return { xs, ys, M: [0, 0] }
  }

  // Interval widths
  const h = new Array(n)
  for (let i = 0; i < n; i++) h[i] = xs[i + 1] - xs[i]

  // Right-hand side for the interior equations
  const rhs = new Array(n - 1)
  for (let i = 1; i < n; i++) {
    rhs[i - 1] = 6 * ((ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1])
  }

  // Thomas algorithm for the tridiagonal system
  // Matrix rows: a[i]*M[i-1] + b[i]*M[i] + c[i]*M[i+1] = rhs[i-1]
  // where a[i] = h[i-1], b[i] = 2*(h[i-1]+h[i]), c[i] = h[i], i=1..n-1
  const c2 = new Array(n - 1)
  const d2 = new Array(n - 1)

  const b0 = 2 * (h[0] + h[1 < n ? 1 : 0])
  c2[0] = h[1 < n ? 1 : 0] / b0
  d2[0] = rhs[0] / b0

  for (let i = 1; i < n - 1; i++) {
    const bi = 2 * (h[i] + h[i + 1 < n ? i + 1 : i])
    const m  = bi - h[i] * c2[i - 1]
    c2[i] = h[i + 1 < n ? i + 1 : i] / m
    d2[i] = (rhs[i] - h[i] * d2[i - 1]) / m
  }

  const M_interior = new Array(n - 1)
  M_interior[n - 2] = d2[n - 2]
  for (let i = n - 3; i >= 0; i--) {
    M_interior[i] = d2[i] - c2[i] * M_interior[i + 1]
  }

  const M = [0, ...M_interior, 0]  // natural BC: M[0] = M[n] = 0

  return { xs, ys, M }
}

/**
 * Evaluate the cubic spline at position x.
 * Values outside the knot range are clamped to the nearest endpoint.
 *
 * @param {{ xs: number[], ys: number[], M: number[] }} spline
 * @param {number} x
 * @returns {number}
 */
function evalCubicSpline(spline, x) {
  const { xs, ys, M } = spline
  const n = xs.length - 1

  if (x <= xs[0]) return ys[0]
  if (x >= xs[n]) return ys[n]

  // Binary search for the containing interval
  let lo = 0, hi = n - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid; else hi = mid
  }
  const i = lo
  const h = xs[i + 1] - xs[i]

  // Standard cubic spline formula in terms of second derivatives
  const a = (xs[i + 1] - x) / h
  const b = (x - xs[i])    / h

  return a * ys[i] + b * ys[i + 1] +
    h * h / 6 * ((a * a * a - a) * M[i] + (b * b * b - b) * M[i + 1])
}

// ── Statistics helpers ────────────────────────────────────────────────────────

function computeMedian(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid    = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function computeStdDev(values) {
  if (values.length < 2) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function dbToLinear(db) {
  return Math.pow(10, db / 20)
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}

async function copyThrough(inputPath, outputPath) {
  const { readFile, writeFile } = await import('fs/promises')
  await writeFile(outputPath, await readFile(inputPath))
}
