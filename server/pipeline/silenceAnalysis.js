/**
 * Frame-level silence / voiced-speech detection.
 *
 * Implements the Stage 2a analysis pass described in the processing spec:
 *   - Segment audio into 100 ms frames
 *   - Classify each frame as silence or voiced
 *   - Measure per-frame RMS
 *   - Locate the quietest continuous silence segment (used for room tone)
 *
 * Returns a silenceAnalysis object reused by:
 *   - enhancementEQ (voiced frames for spectral analysis)
 *   - roomTone (quietest silence segment position)
 *   - measure (voiced-frame RMS for normalization)
 *   - riskAssessment (breath/plosive detection)
 *
 * VAD backends (controlled by VAD_BACKEND env var):
 *   - 'silero' (default): Silero VAD v5 neural model classifies isSilence per
 *     frame via Python subprocess. Energy analysis still runs to supply
 *     noiseFloorDbfs, per-frame rmsDbfs, voicedRmsDbfs, and
 *     quietestSilenceSegment — fields Silero does not produce.
 *   - 'energy': Pure JS energy-threshold classifier (noise_floor + 6 dB).
 *     No subprocess. Use as fallback or for A/B comparison.
 *
 * Performance note (Silero backend): ~50–100x real-time on CPU. Silero runs
 * only once per job (at silenceAnalysisRaw). Subsequent pipeline stages call
 * remeasureAudioFrames instead, which re-derives energy metrics from the current
 * audio while preserving the Silero isSilence labels — saving 2–3 Silero spawns
 * per job. Set SILERO_DEVICE=cuda to reduce the single-pass latency further.
 *
 * Logging: silence analysis results are captured in ctx.results (silenceRaw,
 * silencePostNr) and written to the pipeline file log (PIPELINE_LOG=true).
 * No console output is emitted — subprocess stdout is intentionally suppressed
 * to keep the stage-by-stage console log readable.
 */

import { spawn }          from 'child_process'
import { readFile, rm }   from 'fs/promises'
import { fileURLToPath }  from 'url'
import path               from 'path'

import { readWavSamples } from './wavReader.js'

const FRAME_DURATION_S = 0.1   // 100 ms frames — must match FRAME_DURATION_S in silero_vad.py
const BOOTSTRAP_FRAMES = 20    // use this many lowest-energy frames to bootstrap noise floor

const VAD_BACKEND   = process.env.VAD_BACKEND   ?? 'silero'
// Fall back through the other pipeline Python env vars so all scripts share
// the same interpreter without requiring a separate SILERO_PYTHON entry.
const SILERO_PYTHON = process.env.SILERO_PYTHON
                   ?? process.env.DEEPFILTER_PYTHON
                   ?? process.env.SEPARATION_PYTHON
                   ?? 'python3'
const SILERO_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'silero_vad.py'
)

/**
 * Analyze audio frames and return silence/voiced classification.
 * Dispatches to the Silero or energy backend based on VAD_BACKEND.
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
  if (VAD_BACKEND === 'silero') {
    try {
      return await analyzeAudioFramesSilero(wavPath)
    } catch (err) {
      console.warn(
        `[silence] Silero VAD failed — falling back to energy backend. ` +
        `Set VAD_BACKEND=energy to suppress this warning.\n` +
        `Reason: ${err.message}`
      )
      return analyzeAudioFramesEnergy(wavPath)
    }
  }
  return analyzeAudioFramesEnergy(wavPath)
}

/**
 * Hybrid Silero VAD path.
 *
 * Stage A: Energy analysis — computes frameRms[], noiseFloorDbfs, and
 *          silenceThreshold. Does NOT classify isSilence from energy here.
 * Stage B: Silero subprocess — classifies each frame as voiced/silence using
 *          the neural model. Writes results to a temp JSON file.
 * Stage C: Merge — Silero isSilence labels replace the energy classification.
 *          Energy fallback applies for any frame not covered by Silero (±1
 *          frame edge case from 44.1→16 kHz resampling rounding).
 *
 * All scalar fields (noiseFloorDbfs, rmsDbfs, voicedRmsDbfs,
 * quietestSilenceSegment) remain energy-derived. Silero only contributes the
 * isSilence boolean per frame.
 */
async function analyzeAudioFramesSilero(wavPath) {
  const { samples, sampleRate } = await readWavSamples(wavPath)

  const frameLengthSamples = Math.round(FRAME_DURATION_S * sampleRate)
  const numFrames = Math.floor(samples.length / frameLengthSamples)

  if (numFrames === 0) {
    return emptyResult()
  }

  // Stage A — energy metrics (always run regardless of VAD backend)
  const frameRms = new Float64Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    const start = f * frameLengthSamples
    const end   = start + frameLengthSamples
    let sumSq = 0
    for (let i = start; i < end; i++) sumSq += samples[i] * samples[i]
    frameRms[f] = Math.sqrt(sumSq / frameLengthSamples)
  }

  const noiseRmsLinear   = bootstrapNoiseRms(frameRms)
  const noiseFloorDbfs   = rmsToDbfs(noiseRmsLinear)
  const silenceThreshold = noiseFloorDbfs + 6

  // Stage B — Silero subprocess
  const jsonPath = wavPath.replace(/\.wav$/i, '') + '_silero_vad.json'
  let sileroFrames = []
  try {
    await spawnSilero(wavPath, jsonPath)
    const raw = JSON.parse(await readFile(jsonPath, 'utf8'))
    sileroFrames = raw.frames
  } finally {
    await rm(jsonPath, { force: true })
  }

  // Stage C — merge Silero labels with energy values
  const sileroMap = new Map(sileroFrames.map(f => [f.index, f.isSilence]))

  const frames = []
  let voicedSumSq = 0
  let voicedFrameCount = 0

  for (let f = 0; f < numFrames; f++) {
    const rmsDbfs = rmsToDbfs(frameRms[f])
    // Silero label takes priority; energy threshold is fallback for any
    // frame index not present in Silero output (±1 frame edge case).
    const isSilence = sileroMap.has(f) ? sileroMap.get(f) : (rmsDbfs < silenceThreshold)

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
 * Spawn the Silero VAD Python script.
 */
function spawnSilero(inputPath, outputJsonPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(SILERO_PYTHON, [
      SILERO_SCRIPT,
      '--input',  inputPath,
      '--output', outputJsonPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    // Drain stdout to prevent pipe buffer deadlock — Silero VAD emits model
    // loading output that can fill the 64 KB OS pipe buffer and block the
    // child process indefinitely if the parent never reads it.
    proc.stdout.on('data', chunk => { stdout += chunk.toString() })
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    proc.on('close', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve()
      } else {
        const reason = code !== null ? `code ${code}` : `signal ${signal}`
        reject(new Error(`Silero VAD exited with ${reason}.\n${stderr.slice(-2000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn Silero VAD: ${err.message}`))
    })
  })
}

/**
 * Energy-threshold classifier (original implementation).
 * Retained as fallback when VAD_BACKEND=energy.
 */
async function analyzeAudioFramesEnergy(wavPath) {
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

  // Bootstrap noise floor: RMS over the BOOTSTRAP_FRAMES lowest-energy frames
  const noiseRmsLinear    = bootstrapNoiseRms(frameRms)
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
 * Re-derive energy metrics from a new audio file while preserving the isSilence
 * labels from a prior SilenceAnalysis. Avoids re-running the Silero subprocess.
 *
 * Use this for all pipeline stages after silenceAnalysisRaw. The VAD frame
 * labels are stable throughout the pipeline — speech content does not move
 * between HPF, NR, and EQ. Energy levels do change, so noiseFloorDbfs,
 * rmsDbfs, voicedRmsDbfs, and quietestSilenceSegment are all re-derived from
 * the current audio.
 *
 * @param {string} wavPath             - Path to 32-bit float WAV (current stage output)
 * @param {SilenceAnalysis} reference  - Analysis from a prior stage (provides isSilence labels)
 * @returns {Promise<SilenceAnalysis>}
 */
export async function remeasureAudioFrames(wavPath, reference) {
  const { samples, sampleRate } = await readWavSamples(wavPath)

  const frameLengthSamples = Math.round(FRAME_DURATION_S * sampleRate)
  const numFrames = Math.floor(samples.length / frameLengthSamples)

  if (numFrames === 0) return emptyResult()

  // Re-compute per-frame RMS from the current (processed) audio
  const frameRms = new Float64Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    const start = f * frameLengthSamples
    let sumSq = 0
    for (let i = start; i < start + frameLengthSamples; i++) sumSq += samples[i] * samples[i]
    frameRms[f] = Math.sqrt(sumSq / frameLengthSamples)
  }

  const noiseRmsLinear   = bootstrapNoiseRms(frameRms)
  const noiseFloorDbfs   = rmsToDbfs(noiseRmsLinear)
  const silenceThreshold = noiseFloorDbfs + 6

  const frames = []
  let voicedSumSq = 0
  let voicedFrameCount = 0

  for (let f = 0; f < numFrames; f++) {
    const rmsDbfs = rmsToDbfs(frameRms[f])
    // Preserve the Silero isSilence label from the reference analysis.
    // Fall back to the energy threshold for any frame index beyond the
    // reference length (should not occur — stage operations don't change
    // sample count, so numFrames is always stable across the pipeline).
    const isSilence = f < reference.frames.length
      ? reference.frames[f].isSilence
      : (rmsDbfs < silenceThreshold)

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

/**
 * Bootstrap a noise-floor estimate from per-frame linear RMS values.
 *
 * Selects the BOOTSTRAP_FRAMES lowest-energy frames and combines them in the
 * power domain (not linear-RMS average), so the result is mathematically the
 * RMS of the combined quietest frames — consistent with how voicedRmsDbfs is
 * computed elsewhere in this module and with how noise floor is compared
 * against the ACX noiseFloorCeiling downstream.
 *
 * A plain mean of linear RMS values underestimates the true RMS whenever the
 * chosen frames have non-uniform energy, which biases the silenceThreshold
 * (= noise_floor + 6) low and can cause voiced-frame misclassification in the
 * energy-fallback branch.
 */
function bootstrapNoiseRms(frameRms) {
  if (frameRms.length === 0) return 0
  const sorted = Float64Array.from(frameRms).sort()
  const n = Math.min(BOOTSTRAP_FRAMES, sorted.length)
  let sumSq = 0
  for (let i = 0; i < n; i++) sumSq += sorted[i] * sorted[i]
  return Math.sqrt(sumSq / n)
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
