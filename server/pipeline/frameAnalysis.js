/**
 * Frame-level silence / voiced-speech detection.
 *
 * Implements the Stage 2a analysis pass described in the processing spec:
 *   - Segment audio into 25 ms frames
 *   - Classify each frame as silence or voiced
 *   - Measure per-frame RMS
 *   - Locate the quietest continuous silence segment (used for room tone)
 *
 * Returns a silenceAnalysis object reused by:
 *   - correctiveEQ (voiced frames for cepstral envelope analysis)
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
 * Performance note (Silero backend): ~50–100x real-time on CPU. analyzeFrames
 * runs exactly once per job, in the analyzeFramesRaw stage; on long files the
 * Silero subprocess underneath it is split into silence-snapped chunks run in
 * parallel across the worker pool (see sileroParallel.js), so the wall-clock of
 * this stage scales down with the pool size. measureBefore no longer calls
 * analyzeFrames — analyzeFramesRaw back-fills beforeMeasurements.noiseFloorDbfs
 * after correcting for the peakNormalize gain. All subsequent pipeline stages
 * call remeasureFrames instead, which re-derives energy metrics from the
 * current audio while preserving the Silero isSilence labels. Set
 * SILERO_PARALLEL=0 to force the single whole-file call.
 *
 * Logging: frame analysis results are merged into ctx.results.metrics and
 * written to the pipeline file log (PIPELINE_LOG=true).
 * No console output is emitted — subprocess stdout is intentionally suppressed
 * to keep the stage-by-stage console log readable.
 */

import { readFileSync }   from 'fs'
import { readFile, rm }   from 'fs/promises'
import { fileURLToPath }  from 'url'
import path               from 'path'

import { spawnPython }    from './spawnPython.js'
import { readWavSamples } from './wavReader.js'
import { classifySileroVadParallel } from './sileroParallel.js'
import { decodeToFloat32Mono16k, tempPath, removeTmp } from '../lib/ffmpeg.js'

// Loaded from the shared config so JS and Python always use the same value.
// To change the pipeline frame duration, edit server/config/frame_config.json.
const { FRAME_DURATION_S } = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'frame_config.json'),
    'utf8',
  )
)  // 0.025 s = 25 ms — must match FRAME_DURATION_S in silero_vad.py
const BOOTSTRAP_FRAMES = 20    // use this many lowest-energy frames to bootstrap noise floor

// Time-based frame boundary: frame f starts at sample Math.round(f * FRAME_DURATION_S * sampleRate).
// Frame sizes alternate by ±1 sample but boundaries stay aligned in time across sample rates.
export function frameBoundary(f, sampleRate) {
  return Math.round(f * FRAME_DURATION_S * sampleRate)
}

export { FRAME_DURATION_S }

const VAD_BACKEND   = process.env.VAD_BACKEND   ?? 'silero'
const SILERO_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'silero_vad.py'
)

/**
 * Analyze audio frames: classify voiced/silence, measure noise floor and loudness.
 * Dispatches to the Silero or energy backend based on VAD_BACKEND.
 *
 * @param {string} wavPath - Path to 32-bit float WAV (internal format)
 * @returns {FrameAnalysis}
 *
 * @typedef {Object} FrameAnalysis
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
export async function analyzeFrames(wavPath) {
  if (VAD_BACKEND === 'silero') {
    try {
      const result = await analyzeAudioFramesSilero(wavPath)
      console.log(`[silence] VAD backend: silero (${result.frames.length} frames)`)
      return result
    } catch (err) {
      console.warn(
        `[silence] Silero VAD failed — falling back to energy backend. ` +
        `Set VAD_BACKEND=energy to suppress this warning.\n` +
        `Reason: ${err.message}`
      )
      const result = await analyzeAudioFramesEnergy(wavPath)
      console.log(`[silence] VAD backend: energy (fallback)`)
      return result
    }
  }
  console.log(`[silence] VAD backend: energy (VAD_BACKEND=${VAD_BACKEND})`)
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

  const numFrames = Math.floor(samples.length / (FRAME_DURATION_S * sampleRate))

  if (numFrames === 0) {
    return emptyResult()
  }

  // Stage A — energy metrics (always run regardless of VAD backend)
  const frameRms = new Float64Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    const start = frameBoundary(f, sampleRate)
    const end   = frameBoundary(f + 1, sampleRate)
    const len   = end - start
    let sumSq = 0
    for (let i = start; i < end; i++) sumSq += samples[i] * samples[i]
    frameRms[f] = Math.sqrt(sumSq / len)
  }

  const noiseRmsLinear   = bootstrapNoiseRms(frameRms)
  const noiseFloorDbfs   = rmsToDbfs(noiseRmsLinear)
  const silenceThreshold = noiseFloorDbfs + 6

  // Stage B — Silero subprocess
  // Pre-resample to 16 kHz mono float32 with FFmpeg so the Python script
  // doesn't have to run scipy.signal.resample_poly on every call. The VAD
  // operates at 16 kHz, so this matches the model's native rate exactly.
  const jsonPath  = wavPath.replace(/\.wav$/i, '') + '_silero_vad.json'
  const vadInput  = tempPath('.wav')
  let sileroFrames = []
  try {
    await decodeToFloat32Mono16k(wavPath, vadInput)

    // Parallel path: split the 16 kHz VAD input at energy-silence seams and run
    // the (unchanged) Silero subprocess on each chunk across the worker pool,
    // reassembling global frame labels. Returns null when the file is too
    // short / unsplittable or parallelism is disabled, in which case fall
    // through to the single whole-file call below. Seams are silence-snapped
    // and warm-up-padded, so core-region labels match the whole-file run; set
    // SILERO_PARALLEL=0 to force the single call for A/B comparison.
    //
    // A failure in the parallel path (FFmpeg carve / JSON parse / worker error)
    // degrades to the single whole-file Silero call below — NOT to the energy
    // backend. The energy fallback is reserved for Silero itself being broken;
    // a chunking-layer hiccup should still get neural VAD, just non-parallel.
    let parallel = null
    try {
      parallel = await classifySileroVadParallel(vadInput, {
        energyFrameRms:       frameRms,
        silenceThresholdDbfs: silenceThreshold,
        numFrames,
        runVad:               spawnSilero,
      })
    } catch (err) {
      console.warn(
        `[silence] parallel Silero VAD failed — falling back to the single ` +
        `whole-file call. Reason: ${err.message}`
      )
      parallel = null
    }

    if (parallel) {
      sileroFrames = parallel.frames
    } else {
      await spawnSilero(vadInput, jsonPath)
      const raw = JSON.parse(await readFile(jsonPath, 'utf8'))
      sileroFrames = raw.frames
    }
  } finally {
    await rm(jsonPath, { force: true })
    await removeTmp(vadInput)
  }

  // Stage C — merge Silero labels with energy values

  // Step 1: build frames with initial Silero labels
  const sileroMap = new Map(sileroFrames.map(f => [f.index, f.isSilence]))

  const frames = []
  for (let f = 0; f < numFrames; f++) {
    const rmsDbfs = rmsToDbfs(frameRms[f])
    // Silero label takes priority; energy threshold is fallback for any
    // frame index not present in Silero output (±1 frame edge case).
    const isSilence = sileroMap.has(f) ? sileroMap.get(f) : (rmsDbfs < silenceThreshold)

    const start = frameBoundary(f, sampleRate)
    frames.push({
      index:         f,
      offsetSamples: start,
      lengthSamples: frameBoundary(f + 1, sampleRate) - start,
      rmsDbfs:       round2(rmsDbfs),
      isSilence,
    })
  }

  // Step 2: energy-gated 1-frame boundary expansion
  // Silero's get_speech_timestamps operates at 512-sample (32 ms) chunk
  // boundaries at 16 kHz. When a word onset or offset falls mid-chunk, the
  // reported segment boundary can be up to 32 ms off, causing the straddling
  // frame to be labelled silence even though it contains real speech. Promote
  // such frames to voiced only when their energy is above the noise floor —
  // confirming measurable content rather than assuming speech unconditionally
  // at every boundary. (Frame duration is set by FRAME_DURATION_S in
  // frame_config.json; the 32 ms Silero chunk boundary is fixed by the model.)
  // Use raw rmsToDbfs(frameRms[...]) rather than the rounded frames[].rmsDbfs
  // to avoid threshold flips for frames that land close to noiseFloorDbfs.
  // A Set snapshot of the original labels prevents cascade: expanding frame N
  // cannot cause frame N+1 to also expand.
  const boundaryExpansionSet = new Set()
  for (let f = 0; f < numFrames; f++) {
    if (!frames[f].isSilence) {
      if (f > 0             && frames[f - 1].isSilence && rmsToDbfs(frameRms[f - 1]) > noiseFloorDbfs)
        boundaryExpansionSet.add(f - 1)
      if (f < numFrames - 1 && frames[f + 1].isSilence && rmsToDbfs(frameRms[f + 1]) > noiseFloorDbfs)
        boundaryExpansionSet.add(f + 1)
    }
  }
  for (const f of boundaryExpansionSet) {
    frames[f].isSilence = false
  }

  // Step 3: accumulate voiced energy from expanded labels
  let voicedSumSq = 0
  let voicedFrameCount = 0
  for (let f = 0; f < numFrames; f++) {
    if (!frames[f].isSilence) {
      voicedSumSq += frameRms[f] * frameRms[f]
      voicedFrameCount++
    }
  }

  const voicedRmsDbfs = voicedFrameCount > 0
    ? rmsToDbfs(Math.sqrt(voicedSumSq / voicedFrameCount))
    : noiseFloorDbfs

  const quietestSilenceSegment = findQuietestSilenceSegment(frames, frameRms)

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
 *
 * Routed through spawnPython — in the persistent-worker path the Silero
 * model load (a few hundred ms for the JIT artifact) happens inside the
 * worker, but only the first time it's called per server lifetime. The
 * legacy path spawns a fresh interpreter, matching the pre-worker
 * behavior. Either way, stdout/stderr are drained by the shared helper.
 */
function spawnSilero(inputPath, outputJsonPath) {
  return spawnPython(
    SILERO_SCRIPT,
    ['--input', inputPath, '--output', outputJsonPath],
    'SileroVAD',
  )
}

/**
 * Energy-threshold classifier (original implementation).
 * Retained as fallback when VAD_BACKEND=energy.
 */
async function analyzeAudioFramesEnergy(wavPath) {
  const { samples, sampleRate } = await readWavSamples(wavPath)

  const numFrames = Math.floor(samples.length / (FRAME_DURATION_S * sampleRate))

  if (numFrames === 0) {
    return emptyResult()
  }

  // Compute RMS for every frame
  const frameRms = new Float64Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    const start = frameBoundary(f, sampleRate)
    const end   = frameBoundary(f + 1, sampleRate)
    const len   = end - start
    let sumSq = 0
    for (let i = start; i < end; i++) {
      sumSq += samples[i] * samples[i]
    }
    frameRms[f] = Math.sqrt(sumSq / len)
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

    const start = frameBoundary(f, sampleRate)
    frames.push({
      index:         f,
      offsetSamples: start,
      lengthSamples: frameBoundary(f + 1, sampleRate) - start,
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
  const quietestSilenceSegment = findQuietestSilenceSegment(frames, frameRms)

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
 * labels from a prior FrameAnalysis. Avoids re-running the Silero subprocess.
 *
 * Use this for all pipeline stages after analyzeFramesRaw. The VAD frame
 * labels are stable throughout the pipeline — speech content does not move
 * between HPF, NR, and EQ. Energy levels do change, so noiseFloorDbfs,
 * rmsDbfs, voicedRmsDbfs, and quietestSilenceSegment are all re-derived from
 * the current audio.
 *
 * @param {string} wavPath           - Path to 32-bit float WAV (current stage output)
 * @param {FrameAnalysis} reference  - Analysis from a prior stage (provides isSilence labels)
 * @returns {Promise<FrameAnalysis>}
 */
export async function remeasureFrames(wavPath, reference) {
  const { samples, sampleRate } = await readWavSamples(wavPath)

  const numFrames = Math.floor(samples.length / (FRAME_DURATION_S * sampleRate))

  if (numFrames === 0) return emptyResult()

  // Re-compute per-frame RMS from the current (processed) audio
  const frameRms = new Float64Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    const start = frameBoundary(f, sampleRate)
    const end   = frameBoundary(f + 1, sampleRate)
    const len   = end - start
    let sumSq = 0
    for (let i = start; i < end; i++) sumSq += samples[i] * samples[i]
    frameRms[f] = Math.sqrt(sumSq / len)
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

    const start = frameBoundary(f, sampleRate)
    frames.push({
      index:         f,
      offsetSamples: start,
      lengthSamples: frameBoundary(f + 1, sampleRate) - start,
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

  const quietestSilenceSegment = findQuietestSilenceSegment(frames, frameRms)

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
function findQuietestSilenceSegment(frames, frameRms) {
  const MIN_FRAMES = 5  // at least 125 ms (5 × 25 ms frames)

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
      const startSample = frames[segStart].offsetSamples
      const lastFrame   = frames[end - 1]
      bestSegment = {
        offsetSamples: startSample,
        lengthSamples: (lastFrame.offsetSamples + lastFrame.lengthSamples) - startSample,
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

/**
 * Lightweight noise-floor-only measurement.
 * Reads the WAV, computes per-frame RMS, and bootstraps the noise floor from
 * the lowest BOOTSTRAP_FRAMES frames. Skips building the full frame array,
 * voiced RMS, and quietest-silence-segment search.
 * Used by measureAfter for non-audiobook ACX presets where only the noise
 * floor is needed for certification (no breath/plosive detection).
 */
export async function measureNoiseFloorOnly(wavPath) {
  const { samples, sampleRate } = await readWavSamples(wavPath)
  const numFrames = Math.floor(samples.length / (FRAME_DURATION_S * sampleRate))
  if (numFrames === 0) return -60

  const frameRms = new Float64Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    const start = frameBoundary(f, sampleRate)
    const end   = frameBoundary(f + 1, sampleRate)
    const len   = end - start
    let sumSq = 0
    for (let i = start; i < end; i++) sumSq += samples[i] * samples[i]
    frameRms[f] = Math.sqrt(sumSq / len)
  }

  return round2(rmsToDbfs(bootstrapNoiseRms(frameRms)))
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
