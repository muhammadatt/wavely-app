/**
 * Parallel Silero VAD classification.
 *
 * The whole-file Silero subprocess — one call over the full 16 kHz stream in
 * the analyzeFramesRaw stage — is the slowest analysis pass in the pipeline,
 * and (unlike the NR block) it runs whole-file with no parallelism because the
 * chunk planner downstream consumes its output. This module breaks that
 * chicken-and-egg: it splits the 16 kHz VAD input into silence-snapped chunks,
 * runs the UNCHANGED silero_vad.py on each in parallel across the worker pool,
 * and reassembles a global per-frame isSilence array identical in shape to the
 * single-call output. The caller's energy/noise-floor math and the Silero↔energy
 * merge are untouched — only the subprocess dispatch is parallelized.
 *
 * Determinism. Two mechanisms keep the chunked labels equal to the whole-file
 * run within each chunk's core region:
 *
 *   1. Silence-snapped seams. Split points are chosen in energy-silence regions
 *      (the cheap per-frame RMS the caller already computed), so the model
 *      enters each core from established silence rather than mid-word.
 *   2. Warm-up overlap. Each core is preceded by a warm-up region that is fed
 *      to the model but whose frames are discarded. Silero's GRU hidden state
 *      and its trigger / neg-trigger hysteresis (get_speech_timestamps runs
 *      with min_speech/min_silence = 0, so the only cross-frame dependency is
 *      that 2-state machine) converge during warm-up before the first emitted
 *      frame. Warm-up duration is generous relative to the model's ~few-hundred
 *      -ms effective context.
 *
 * Any residual ±1-frame difference at a seam lands inside silence and is
 * absorbed by the downstream energy-gated boundary expansion in
 * frameAnalysis.js. To A/B the parallel vs. whole-file labels, set
 * SILERO_PARALLEL=0 to force the single-call path.
 *
 * Returns { frames: [{ index, isSilence }] } with GLOBAL frame indices — the
 * same shape the single Silero call's JSON produces — or null when the file is
 * too short / unsplittable or parallelism is disabled, signalling the caller to
 * use the single whole-file call.
 *
 * Env knobs:
 *   SILERO_PARALLEL            — '0' disables (default: enabled)
 *   PYTHON_WORKER_POOL_SIZE    — bounds concurrency; <2 disables (no benefit)
 *   SILERO_PARALLEL_WARMUP_S   — warm-up overlap seconds (default: 2)
 *   SILERO_PARALLEL_MIN_CHUNK_S, _MAX_CHUNK_S, _MIN_SILENCE_MS — planner overrides
 */

import { readFile, rm }   from 'fs/promises'
import { readFileSync }   from 'fs'
import { fileURLToPath }  from 'url'
import path               from 'path'

import { readWavHeader }                          from './wavReader.js'
import { planChunkBoundaries }                    from './chunking.js'
import { extractAudioRange, tempPath, removeTmp } from '../lib/ffmpeg.js'

// Read the shared frame duration directly (same source silero_vad.py and
// frameAnalysis.js use) rather than importing from frameAnalysis.js, which
// would form an import cycle (frameAnalysis → this module → frameAnalysis).
const { FRAME_DURATION_S } = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'frame_config.json'),
    'utf8',
  )
)

const SILERO_SR = 16000  // VAD input is pre-resampled to 16 kHz mono by the caller

/**
 * Classify a 16 kHz mono VAD input in parallel. See module header.
 *
 * @param {string} vadInputPath  16 kHz mono float32 WAV (the caller's pre-resampled VAD input)
 * @param {object} opts
 * @param {Float64Array|number[]} opts.energyFrameRms  Per-frame linear RMS (caller's whole-file energy pass)
 * @param {number} opts.silenceThresholdDbfs           Energy silence threshold (noise floor + 6 dB)
 * @param {number} opts.numFrames                      Caller's frame count
 * @param {(inputPath: string, outputJsonPath: string) => Promise<any>} opts.runVad
 *        Dispatcher that runs silero_vad.py on inputPath and writes labels to outputJsonPath
 *        (the caller's spawnSilero — keeps the worker-pool routing in one place).
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ frames: Array<{ index: number, isSilence: boolean }> } | null>}
 */
export async function classifySileroVadParallel(vadInputPath, {
  energyFrameRms,
  silenceThresholdDbfs,
  numFrames,
  runVad,
  log = console.log,
}) {
  if (process.env.SILERO_PARALLEL === '0') return null

  const poolSize = Math.max(1, parseInt(process.env.PYTHON_WORKER_POOL_SIZE ?? '1', 10) || 1)
  if (poolSize < 2) return null  // single worker — chunks would run serially anyway

  const samplesPerFrame = Math.round(FRAME_DURATION_S * SILERO_SR)  // 400 @ 25 ms / 16 kHz

  const { numSamples: total16k, sampleRate: sr16 } = await readWavHeader(vadInputPath)
  if (sr16 !== SILERO_SR) {
    // Caller is expected to pre-resample to 16 kHz. If that contract ever
    // changes, fall back to the single-call path rather than mis-mapping frames.
    log(`[silero] parallel VAD skipped — input is ${sr16} Hz, expected ${SILERO_SR}`)
    return null
  }

  // Frames whose 16 kHz sample range fits in the VAD input. The caller's
  // energyFrameRms is on the same 25 ms time grid, so index f maps to 16 kHz
  // sample f * samplesPerFrame regardless of the 44.1 kHz source rate.
  const nPlan = Math.min(numFrames, Math.floor(total16k / samplesPerFrame))
  if (nPlan < 2) return null

  // Build a synthetic frame array carrying only the energy silence mask — all
  // planChunkBoundaries needs to snap seams to quiet regions.
  const threshLinear = Math.pow(10, silenceThresholdDbfs / 20)
  const planFrames = new Array(nPlan)
  for (let f = 0; f < nPlan; f++) {
    planFrames[f] = {
      offsetSamples: f * samplesPerFrame,
      lengthSamples: samplesPerFrame,
      isSilence:     energyFrameRms[f] < threshLinear,
    }
  }

  // Aim for roughly one chunk per worker; planChunkBoundaries clamps to its
  // min/max and snaps each seam to the nearest qualifying silence region.
  const totalS    = total16k / sr16
  const minChunkS = parseFloat(process.env.SILERO_PARALLEL_MIN_CHUNK_S ?? '20')
  const maxChunkS = parseFloat(process.env.SILERO_PARALLEL_MAX_CHUNK_S ?? '600')
  const minSilMs  = parseInt(process.env.SILERO_PARALLEL_MIN_SILENCE_MS ?? '500', 10)
  const targetS   = Math.min(maxChunkS, Math.max(minChunkS, totalS / poolSize))

  const plan = planChunkBoundaries({
    frames:       planFrames,
    sampleRate:   sr16,
    totalSamples: nPlan * samplesPerFrame,
    options: {
      targetChunkDurationS: targetS,
      minChunkDurationS:    minChunkS,
      maxChunkDurationS:    maxChunkS,
      minSilenceMs:         minSilMs,
    },
  })

  if (plan.chunks.length < 2) {
    log(`[silero] parallel VAD skipped — ${plan.reason ?? 'single-chunk plan'}`)
    return null
  }

  // Snap each chunk boundary to the frame grid so global frame indices map
  // cleanly to 16 kHz samples (frame f ↔ sample f * samplesPerFrame). Seams sit
  // in silence, so a sub-frame snap is inaudible and label-neutral.
  const cores = plan.chunks.map((c) => ({
    coreStartFrame: Math.round(c.startSample / samplesPerFrame),
    coreEndFrame:   Math.round(c.endSample   / samplesPerFrame),
  }))
  cores[0].coreStartFrame              = 0
  cores[cores.length - 1].coreEndFrame = nPlan

  const warmupS      = parseFloat(process.env.SILERO_PARALLEL_WARMUP_S ?? '2')
  const warmupFrames = Math.max(0, Math.round(warmupS * SILERO_SR / samplesPerFrame))

  const limit = Math.min(cores.length, poolSize)
  log(
    `[silero] parallel VAD: ${cores.length} chunks across ${limit} workers ` +
    `(target ${targetS.toFixed(0)}s, warmup ${warmupS}s)`
  )

  const perChunkFrames = new Array(cores.length)

  const processChunk = async (i) => {
    const { coreStartFrame, coreEndFrame } = cores[i]
    // Warm-up only needs to PRECEDE the core (the hysteresis is causal); a
    // trailing pad guards the boundary-frame mapping at the core's tail.
    const carveStartFrame = Math.max(0,     coreStartFrame - warmupFrames)
    const carveEndFrame   = Math.min(nPlan, coreEndFrame   + warmupFrames)
    const carveStart      = carveStartFrame * samplesPerFrame
    const carveEnd        = Math.min(total16k, carveEndFrame * samplesPerFrame)

    const subWav  = tempPath('.wav')
    const subJson = subWav.replace(/\.wav$/i, '') + '.silvad.json'
    try {
      await extractAudioRange(vadInputPath, subWav, carveStart, carveEnd)
      await runVad(subWav, subJson)
      const raw = JSON.parse(await readFile(subJson, 'utf8'))

      // Rebase local frame indices to global and keep only the core region.
      // Local frame k starts at global sample carveStart + k * samplesPerFrame;
      // carveStart is frame-aligned, so global frame = carveStartFrame + k.
      const kept = []
      for (const fr of raw.frames) {
        const g = carveStartFrame + fr.index
        if (g >= coreStartFrame && g < coreEndFrame) {
          kept.push({ index: g, isSilence: fr.isSilence })
        }
      }
      perChunkFrames[i] = kept
    } finally {
      await rm(subJson, { force: true })
      await removeTmp(subWav)
    }
  }

  // Bounded-concurrency dispatch. Inlined (rather than importing the chunked
  // runner's helper) to avoid an import cycle through frameAnalysis.js. First
  // rejection propagates; a thrown error lets the caller fall back to the
  // energy backend via analyzeFrames()'s existing try/catch.
  let next = 0
  let firstError = null
  const workers = Array.from({ length: limit }, async () => {
    while (firstError == null) {
      const i = next++
      if (i >= cores.length) return
      try {
        await processChunk(i)
      } catch (err) {
        if (firstError == null) firstError = err
        return
      }
    }
  })
  await Promise.all(workers)
  if (firstError) throw firstError

  // Cores tile [0, nPlan) in ascending order; flattening preserves global order.
  return { frames: perChunkFrames.flat() }
}
