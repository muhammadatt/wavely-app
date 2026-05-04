/**
 * Auto Leveler — VAD-gated gain riding stage (Stage 4b).
 *
 * Corrects within-file level variation by measuring each speech frame's local
 * level (via a centered ±700 ms sliding window) and applying gain to move it
 * toward the file's median speech RMS. Gain is rate-limited for smooth
 * transitions and held constant during silence frames.
 *
 * Only activated when within-file RMS standard deviation exceeds
 * DRIFT_THRESHOLD_DB (3 dB). For files with consistent levels the stage is a
 * no-op (passes through unchanged audio and logs a skip reason).
 *
 * Chain position: immediately before the Compression stage.
 * Input: VAD mask from silenceAnalysis (silencePreDeEss in the pipeline).
 */

import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels }   from './wavWriter.js'
import { PRESETS }            from '../presets.js'

const SAMPLE_RATE           = 44100
const FRAME_DURATION_S      = 0.1    // 100 ms — must match silenceAnalysis frame size
const FRAME_SAMPLES         = Math.round(FRAME_DURATION_S * SAMPLE_RATE)  // 4410

const ANALYSIS_WINDOW_FRAMES = 15    // 15 × 100 ms = 1.5 seconds of speech content
const ANALYSIS_WINDOW_STRIDE = 5     // ~67% overlap — dense knots for responsive tracking
const MIN_SEGMENT_FRAMES     = 5     // 5 × 100 ms = 500 ms — discard shorter segments
const DRIFT_THRESHOLD_DB     = 3.0   // σ > 3 dB triggers leveler
const NOISE_FLOOR_CHECK_DBFS = -58   // post-application safety check

const FADE_IN_SAMPLES  = Math.round(0.030 * SAMPLE_RATE)  // 30 ms speech onset
const LOCAL_LEVEL_RADIUS     = 4     // ±4 frames (±400 ms) centered window for local level
const LOOKAHEAD_FRAMES       = 4     // 4 × 100 ms = 400 ms forward lookahead for gain riding
const CORRECTION_STRENGTH    = 0.60  // 60% correction toward median per frame

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Apply VAD-gated gain riding to an audio file.
 *
 * @param {string} inputPath    - 32-bit float WAV (internal format)
 * @param {string} outputPath   - Output WAV path
 * @param {string} presetId
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
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
export async function applyAutoLeveler(inputPath, outputPath, presetId, frameAnalysis) {
  const config = PRESETS[presetId]?.autoLeveler

  if (!config) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, reason: 'preset_not_applicable' }
  }

  const { channels, sampleRate } = await readWavAllChannels(inputPath)
  const analysisSamples = channels[0]

  // ── Step 1: Build speech analysis windows ─────────────────────────────────

  const speechFrames = buildSpeechFrameList(frameAnalysis)

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
  const maxRateDbPerFrame = maxRateDbPerS * FRAME_DURATION_S

  // ── Step 4: Per-frame gain envelope ────────────────────────────────────────
  //
  // Simple direct algorithm:
  //   1. Measure each speech frame's RMS
  //   2. Estimate local level via centered sliding window of speech frame RMS
  //   3. Compute desired gain = (median − localLevel) × correctionStrength
  //   4. Clamp to ±maxGainDb
  //   5. Rate-limit frame-to-frame changes
  //   6. Hold gain during silence frames

  const numFrames = Math.ceil(analysisSamples.length / FRAME_SAMPLES)
  const { frameGains, gainCappedSegments } = buildFrameGainsDirect(
    frameAnalysis, numFrames, analysisSamples, medianRmsDb, maxGainDb, maxRateDbPerFrame,
  )

  // ── Step 5: Apply gain with VAD gating ────────────────────────────────────

  const n = analysisSamples.length
  const { gainCurve, noiseFloorRisk } = buildSampleGainCurve(
    frameGains, frameAnalysis, n, analysisSamples, maxRateDbPerFrame,
  )

  const processedChannels = channels.map(ch => applyGainCurve(ch, gainCurve))

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  // ── Step 6: Post-application validation ───────────────────────────────────

  const postWindows = buildAnalysisWindows(speechFrames, processedChannels[0])
  const postRmsDb   = postWindows.map(w => w.rmsDb)
  const postStdDb   = postRmsDb.length >= 2 ? computeStdDev(postRmsDb) : null

  let maxGainApplied = -Infinity;
  let minGainApplied = Infinity;
  for (let i = 0; i < gainCurve.length; i++) {
    const g = gainCurve[i];
    if (g > maxGainApplied) maxGainApplied = g;
    if (g < minGainApplied) minGainApplied = g;
  }
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
 * @param {import('./frameAnalysis.js').FrameAnalysis} sa
 * @returns {import('./frameAnalysis.js').FrameInfo[]}
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
 * @param {import('./frameAnalysis.js').FrameInfo[]} speechFrames
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
    i += ANALYSIS_WINDOW_STRIDE  // 50% overlap for smoother gain profile
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
 * Build a per-frame gain array using a direct local-level algorithm.
 *
 * For each speech frame:
 *   1. Measure the frame's RMS
 *   2. Compute a local level estimate from a centered sliding window of
 *      nearby speech frames (±LOCAL_LEVEL_RADIUS, RMS-averaged in linear domain)
 *   3. Desired gain = (median − localLevel) × CORRECTION_STRENGTH
 *   4. Clamp to ±maxGainDb
 *   5. Rate-limit frame-to-frame changes to maxRateDbPerFrame
 *   6. Hold the last speech gain during silence frames
 *
 * @param {import('./frameAnalysis.js').FrameAnalysis} sa
 * @param {number}       numFrames
 * @param {Float32Array} samples         - Channel 0 audio samples
 * @param {number}       medianRmsDb     - Median target RMS (dBFS)
 * @param {number}       maxGainDb       - Maximum gain magnitude (dB)
 * @param {number}       maxRateDbPerFrame - Max gain change per frame (dB)
 * @returns {{ frameGains: Float32Array, gainCappedSegments: number }}
 */
function buildFrameGainsDirect(sa, numFrames, samples, medianRmsDb, maxGainDb, maxRateDbPerFrame) {
  // Step A: Compute per-frame RMS (dBFS) and speech flag for all frames
  const frameRmsDb  = new Float32Array(numFrames).fill(-120)
  const frameSpeech = new Uint8Array(numFrames)  // 1 = speech, 0 = silence
  for (let f = 0; f < numFrames; f++) {
    const frame = sa.frames[f]
    if (frame && !frame.isSilence) {
      frameRmsDb[f]  = computeFrameRms(frame, samples)
      frameSpeech[f] = 1
    }
  }

  // Step B: Compute desired gain for each speech frame using a centered
  // sliding window of SPEECH FRAMES ONLY for local level estimation
  const desiredGains = new Float32Array(numFrames).fill(NaN)
  let gainCappedSegments = 0

  for (let f = 0; f < numFrames; f++) {
    if (!frameSpeech[f]) continue

    // Centered sliding window: only include speech frames in the average
    let sumLinSq = 0, count = 0
    for (let k = f - LOCAL_LEVEL_RADIUS; k <= f + LOCAL_LEVEL_RADIUS; k++) {
      if (k >= 0 && k < numFrames && frameSpeech[k]) {
        const linRms = Math.pow(10, frameRmsDb[k] / 20)
        sumLinSq += linRms * linRms
        count++
      }
    }

    if (count === 0) { desiredGains[f] = 0; continue }

    const localRmsDb = 10 * Math.log10(sumLinSq / count)
    const rawGain = (medianRmsDb - localRmsDb) * CORRECTION_STRENGTH
    const clamped = Math.max(-maxGainDb, Math.min(maxGainDb, rawGain))
    if (Math.abs(rawGain) > maxGainDb) gainCappedSegments++
    desiredGains[f] = clamped
  }

  // Step C: Resolve silence holds — fill silence frames with nearest speech gain
  const targets = new Float32Array(numFrames)
  let lastSpeech = 0
  for (let f = 0; f < numFrames; f++) {
    if (!Number.isNaN(desiredGains[f])) lastSpeech = desiredGains[f]
    targets[f] = lastSpeech
  }

  // Step D: Forward pass with lookahead rate limiting
  //
  // At each frame the rate limiter slews toward the target LOOKAHEAD_FRAMES
  // ahead rather than the current frame's target. This means the gain starts
  // moving toward an upcoming level change before it arrives, so the curve is
  // already close to correct by the time the phrase begins — no lag, no
  // backward pass needed.
  //
  // A directional clamp is applied using each frame's own target as the
  // direction signal. This guarantees the rate-limited curve can never make a
  // bad situation worse: if the lookahead target briefly pulls the gain the
  // wrong way during a transition, the clamp pins it at 0 dB rather than
  // actively attenuating a quiet frame or boosting a loud one.

  const frameGains = new Float32Array(numFrames)
  let current = 0
  for (let f = 0; f < numFrames; f++) {
    const lookaheadIdx = Math.min(f + LOOKAHEAD_FRAMES, numFrames - 1)
    const delta = targets[lookaheadIdx] - current
    if (Math.abs(delta) > maxRateDbPerFrame) {
      current += maxRateDbPerFrame * Math.sign(delta)
    } else {
      current = targets[lookaheadIdx]
    }
    // Directional clamp: floor below-median gains at 0 dB, ceiling above-median
    // gains at 0 dB, so the leveler may fall short but never goes backwards.
    frameGains[f] = targets[f] >= 0 ? Math.max(0, current) : Math.min(0, current)
  }

  return { frameGains, gainCappedSegments }
}

/**
 * Compute RMS in dBFS for a single frame.
 */
function computeFrameRms(frame, samples) {
  const start = frame.offsetSamples
  const end   = Math.min(start + frame.lengthSamples, samples.length)
  let sumSq = 0, count = 0
  for (let i = start; i < end; i++) {
    sumSq += samples[i] * samples[i]
    count++
  }
  if (count === 0) return -120
  const rms = Math.sqrt(sumSq / count)
  return rms > 0 ? 20 * Math.log10(rms) : -120
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
 * @param {Float32Array} frameGains     - dB per frame
 * @param {import('./frameAnalysis.js').FrameAnalysis} sa
 * @param {number} n                    - total sample count
 * @param {Float32Array} samples        - Original channel 0 samples (for noise floor check)
 * @param {number}       maxRatePerFrame - Max gain change per frame (dB), for pre-fade clamping
 * @returns {{ gainCurve: Float32Array, noiseFloorRisk: boolean }}
 */
function buildSampleGainCurve(frameGains, sa, n, samples, maxRatePerFrame) {
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
  const isStart = new Uint8Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    if (isSpeech(f)) {
      if (f === 0 || !isSpeech(f - 1)) isStart[f] = 1
    }
  }

  // Walk through all samples and assign gains
  for (let i = 0; i < n; i++) {
    const frameIdx = Math.floor(i / FRAME_SAMPLES)
    const cFrameIdx = Math.min(frameIdx, numFrames - 1)

    if (!isSpeech(cFrameIdx)) {
      // Silence: hold at frameGains value
      let finalGainDb = frameGains[cFrameIdx]

      // Pre-fade (lookahead) into the next speech segment
      // Ramps toward the target gain during the last 30ms of silence,
      // but clamps the target so the ramp doesn't exceed the rate limit.
      const nextFrameIdx = cFrameIdx + 1
      if (nextFrameIdx < numFrames && isStart[nextFrameIdx]) {
        const segStartSample = nextFrameIdx * FRAME_SAMPLES
        const preFadePos = segStartSample - i
        if (preFadePos <= FADE_IN_SAMPLES) {
          const alpha = 1 - (preFadePos / FADE_IN_SAMPLES)
          // Clamp the pre-fade target so total ramp over FADE_IN duration
          // respects the per-frame rate limit (scaled to fade duration)
          const fadeDurationFrames = FADE_IN_SAMPLES / FRAME_SAMPLES
          const maxFadeDb = maxRatePerFrame * Math.max(fadeDurationFrames, 1)
          const rawTarget = frameGains[nextFrameIdx]
          const delta = rawTarget - finalGainDb
          const clampedTarget = finalGainDb + Math.max(-maxFadeDb, Math.min(maxFadeDb, delta))
          finalGainDb = finalGainDb + alpha * (clampedTarget - finalGainDb)
        }
      }

      gainCurve[i] = dbToLinear(finalGainDb)
      continue
    }

    // Speech frame: use linearly interpolated frame gains
    const posInFrame = i - cFrameIdx * FRAME_SAMPLES
    const nextFrameIdx = Math.min(cFrameIdx + 1, numFrames - 1)
    const t     = posInFrame / FRAME_SAMPLES
    const gainDb = (1 - t) * frameGains[cFrameIdx] + t * frameGains[nextFrameIdx]

    gainCurve[i] = dbToLinear(gainDb)
  }

  // Post-application noise floor check: measure actual processed level in
  // silence frames (original sample × gain curve) to detect if the leveler
  // has amplified the noise floor above the safety threshold.
  let noiseFloorRisk = false
  if (sa && sa.frames && samples) {
    for (const frame of sa.frames) {
      if (!frame.isSilence) continue
      const start = frame.offsetSamples
      const end   = Math.min(start + frame.lengthSamples, n)
      if (end <= start) continue

      let sumSq = 0
      for (let i = start; i < end; i++) {
        const processed = samples[i] * gainCurve[i]
        sumSq += processed * processed
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
