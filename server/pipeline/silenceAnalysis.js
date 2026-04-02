/**
 * Frame-level silence / voiced-speech detection.
 *
 * Implements the Stage 2a analysis pass described in the processing spec:
 *   - Segment audio into 100 ms frames
 *   - Classify each frame as silence or voiced using a dynamic threshold:
 *       silence_threshold = noise_floor_estimate + 6 dB
 *   - Measure per-frame RMS
 *   - Locate the quietest continuous silence segment (used for room tone)
 *
 * Returns a silenceAnalysis object reused by:
 *   - enhancementEQ (voiced frames for spectral analysis)
 *   - roomTone (quietest silence segment position)
 *   - measure (voiced-frame RMS for normalization)
 *   - riskAssessment (breath/plosive detection)
 */

import { readWavSamples } from './wavReader.js'

const FRAME_DURATION_S = 0.1   // 100 ms frames
const BOOTSTRAP_FRAMES = 20    // use this many lowest-energy frames to bootstrap noise floor

/**
 * Analyze audio frames and return silence/voiced classification.
 *
 * @param {string} wavPath - Path to 32-bit float WAV (internal format)
 * @returns {SilenceAnalysis}
 *
 * @typedef {Object} SilenceAnalysis
 * @property {number} noiseFloorDbfs            - Estimated noise floor (dB)
 * @property {number} silenceThresholdDbfs      - noise_floor + 6 dB
 * @property {FrameInfo[]} frames               - Per-frame data
 * @property {number} voicedRmsDbfs             - RMS of voiced frames only
 * @property {number} averageVoicedRmsDbfs      - Same as voicedRmsDbfs (alias)
 * @property {{ offsetSamples: number, lengthSamples: number } | null} quietestSilenceSegment
 *   - The quietest contiguous silence segment (for room tone extraction)
 *
 * @typedef {Object} FrameInfo
 * @property {number} index             - Frame index
 * @property {number} offsetSamples     - Start sample
 * @property {number} lengthSamples     - Frame length in samples
 * @property {number} rmsDbfs           - Frame RMS in dBFS
 * @property {boolean} isSilence        - True if below silence threshold
 */
export async function analyzeAudioFrames(wavPath) {
  const { samples, sampleRate } = await readWavSamples(wavPath)

  const frameLengthSamples = Math.round(FRAME_DURATION_S * sampleRate)
  const numFrames = Math.floor(samples.length / frameLengthSamples)

  if (numFrames === 0) {
    return emptyResult()
  }

  // Compute RMS for every frame
  const frameRms = new Float64Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    const start = f * frameLengthSamples
    const end   = start + frameLengthSamples
    let sumSq = 0
    for (let i = start; i < end; i++) {
      sumSq += samples[i] * samples[i]
    }
    frameRms[f] = Math.sqrt(sumSq / frameLengthSamples)
  }

  // Bootstrap noise floor: average the BOOTSTRAP_FRAMES lowest-energy frames
  const sorted = Float64Array.from(frameRms).sort()
  let noiseRmsLinear = 0
  const n = Math.min(BOOTSTRAP_FRAMES, sorted.length)
  for (let i = 0; i < n; i++) noiseRmsLinear += sorted[i]
  noiseRmsLinear /= n

  const noiseFloorDbfs    = rmsToDbfs(noiseRmsLinear)
  const silenceThreshold  = noiseFloorDbfs + 6 // dynamic threshold per spec

  // Classify each frame
  const frames = []
  let voicedSumSq = 0
  let voicedFrameCount = 0

  for (let f = 0; f < numFrames; f++) {
    const rmsDbfs  = rmsToDbfs(frameRms[f])
    const isSilence = rmsDbfs < silenceThreshold

    frames.push({
      index:         f,
      offsetSamples: f * frameLengthSamples,
      lengthSamples: frameLengthSamples,
      rmsDbfs:       round2(rmsDbfs),
      isSilence,
    })

    if (!isSilence) {
      voicedSumSq += frameRms[f] * frameRms[f]
      voicedFrameCount++
    }
  }

  const voicedRmsDbfs = voicedFrameCount > 0
    ? rmsToDbfs(Math.sqrt(voicedSumSq / voicedFrameCount))
    : noiseFloorDbfs

  // Find quietest contiguous silence segment (≥ 5 frames = 0.5 s)
  const quietestSilenceSegment = findQuietestSilenceSegment(frames, frameRms, frameLengthSamples)

  return {
    noiseFloorDbfs:       round2(noiseFloorDbfs),
    silenceThresholdDbfs: round2(silenceThreshold),
    frames,
    voicedRmsDbfs:        round2(voicedRmsDbfs),
    averageVoicedRmsDbfs: round2(voicedRmsDbfs),
    quietestSilenceSegment,
  }
}

/**
 * Find the quietest contiguous silence segment of at least MIN_SEGMENT_FRAMES.
 * Used for room tone extraction.
 */
function findQuietestSilenceSegment(frames, frameRms, frameLengthSamples) {
  const MIN_FRAMES = 5  // at least 0.5 s

  let bestSegment  = null
  let bestAvgRms   = Infinity
  let segStart     = -1

  const flush = (end) => {
    if (segStart < 0) return
    const len = end - segStart
    if (len < MIN_FRAMES) { segStart = -1; return }

    let sumRms = 0
    for (let i = segStart; i < end; i++) sumRms += frameRms[i]
    const avgRms = sumRms / len

    if (avgRms < bestAvgRms) {
      bestAvgRms = avgRms
      bestSegment = {
        offsetSamples: segStart * frameLengthSamples,
        lengthSamples: len * frameLengthSamples,
      }
    }
    segStart = -1
  }

  for (let i = 0; i < frames.length; i++) {
    if (frames[i].isSilence) {
      if (segStart < 0) segStart = i
    } else {
      flush(i)
    }
  }
  flush(frames.length)

  return bestSegment
}

function rmsToDbfs(rms) {
  if (rms <= 0) return -120
  return 20 * Math.log10(rms)
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function emptyResult() {
  return {
    noiseFloorDbfs:       -60,
    silenceThresholdDbfs: -54,
    frames:               [],
    voicedRmsDbfs:        -20,
    averageVoicedRmsDbfs: -20,
    quietestSilenceSegment: null,
  }
}
