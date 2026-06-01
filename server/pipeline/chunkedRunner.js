/**
 * Chunked block runner.
 *
 * Executes an inner sequence of pipeline stages chunk-by-chunk and stitches
 * the per-chunk outputs back into a single continuous file. Each seam between
 * adjacent chunks uses an equal-power crossfade across a fixed overlap window
 * to absorb minor envelope-state differences (e.g. NR makeup gain that varies
 * a few tenths of a dB between chunks).
 *
 * Invoked by the main orchestrator when it encounters a
 * `{ chunked: [...innerStages] }` entry in a preset's stages array. When the
 * boundary planner returns a single-chunk plan (file too short to chunk, or
 * no qualifying silence), the inner stages run once against the parent ctx
 * with no carve / stitch overhead.
 *
 * Memory model: source carve and stitch are both streaming. The source WAV
 * is never loaded as a whole; each chunk is extracted via FFmpeg by sample
 * range. The stitcher writes the output WAV incrementally and keeps at most
 * two processed-chunk buffers (current + next) resident at any time. A 1-hour
 * mono session stays under ~250 MB peak vs ~2 GB if the source, all chunks,
 * and the output buffer were held in memory simultaneously.
 *
 * In-scope inner stages for v1: hpf, noiseReduce. These produce stable
 * per-chunk results: HPF is stateless beyond a few hundred samples of
 * filter warm-up, and NR models (DF3 / RNNoise) operate on short internal
 * frame windows. 100 ms of overlap covers both comfortably.
 */

import {
  planChunkBoundaries,
  sliceFramesForChunk,
  equalPowerCrossfade,
} from './chunking.js'
import { readWavHeader, readWavAllChannels } from './wavReader.js'
import { openWavStreamWriter }                from './wavWriter.js'
import { extractAudioRange }                  from '../lib/ffmpeg.js'
import { remeasureFrames }                    from './frameAnalysis.js'
import { withThreadLimit }                    from './threadingContext.js'
import { getChunkedThreadLimit }              from './pythonWorker.js'
import { CHUNK_MERGERS, round2 }              from './chunkMergers.js'

const OVERLAP_MS = 100

// Default JS-side concurrency for per-chunk dispatch. With CHUNKED_CONCURRENCY=1
// (the default), chunks process sequentially — identical wall-clock to the
// pre-concurrency runner. With N>1, up to N chunks process in parallel; their
// inner Python stages dispatch into the worker pool (PYTHON_WORKER_POOL_SIZE),
// so end-to-end speedup is bounded by min(CHUNKED_CONCURRENCY, pool size).
const DEFAULT_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.CHUNKED_CONCURRENCY ?? '1', 10) || 1,
)

/**
 * Run a chunked block. The orchestrator-owned `runInnerStage` callback is
 * invoked once per inner stage entry per chunk; it handles registry lookup,
 * inline-config patching, and (when logging is enabled) per-step logging.
 *
 * Returns a structured timings object the orchestrator threads into the
 * `chunked` step's log meta. The shape is stable whether the planner
 * produced a single-chunk plan or split the file; the perChunk array has
 * one entry per chunk and perStage rolls those up keyed by display name.
 *
 * @param {object} ctx                  Parent pipeline context.
 * @param {Array}  innerStages          Inner stage entries (same shape as preset.stages).
 * @param {(ctx, entry) => Promise<void>} runInnerStage  Dispatch callback.
 * @param {object} [plannerOptions]     Override defaults for planChunkBoundaries
 *                                       (targetChunkDurationS, minChunkDurationS,
 *                                       maxChunkDurationS, minSilenceMs). Production
 *                                       callers leave this empty; tests inject smaller
 *                                       chunk sizes to force the multi-chunk path on
 *                                       reasonably-sized synthetic fixtures.
 * @param {number} [concurrency]        Max chunks to process in parallel. Defaults
 *                                       to CHUNKED_CONCURRENCY env var (=1). Inner
 *                                       Python stages dispatch through the worker
 *                                       pool — concurrency above the pool size
 *                                       saturates without further speedup.
 * @param {object} [logger]             Optional pipeline logger. When present and
 *                                       PIPELINE_LOG_CHUNK_SNAPSHOTS is enabled,
 *                                       per-chunk carve inputs and per-stage
 *                                       outputs are copied into the run dir.
 * @returns {Promise<ChunkedTimings>}
 *
 * @typedef {Object} ChunkedTimings
 * @property {Object}        overall
 * @property {number}        overall.plannedChunks
 * @property {number}        overall.overlapMs
 * @property {number}        overall.concurrency        Effective concurrency used for the run
 * @property {number}        overall.carveTotalMs       Sum of FFmpeg carve durations across chunks
 * @property {number}        overall.stitchMs           Stitcher wall-clock (0 for single-chunk plan)
 * @property {number}        overall.innerTotalMs       Sum of all inner stage durations across all chunks (CPU-time)
 * @property {number}        overall.wallClockMs        Wall-clock time spanning the parallel chunk dispatch (<= innerTotalMs when concurrency>1)
 * @property {string|null}   overall.planReason         Set when the plan collapsed to a single chunk
 * @property {Array<ChunkTimings>}  perChunk
 * @property {Object<string, { totalMs: number, avgMs: number, count: number }>} perStage
 *
 * @typedef {Object} ChunkTimings
 * @property {number}   index                  1-based chunk index
 * @property {[number,number]} sampleRange     Carved sample range [start, end)
 * @property {number}   carveMs                FFmpeg extract duration (0 for single-chunk plan)
 * @property {Array<{ name: string, durationMs: number }>} stages
 * @property {number}   totalMs                Sum of stages[i].durationMs + carveMs
 */
export async function runChunkedBlock(ctx, innerStages, runInnerStage, plannerOptions = {}, concurrency = DEFAULT_CONCURRENCY, logger = null) {
  const sourcePath = ctx.currentPath
  const { sampleRate, numSamples: totalSamples } = await readWavHeader(sourcePath)
  const overlapSamples = Math.round(OVERLAP_MS / 1000 * sampleRate)

  // Optional per-chunk per-stage snapshot copier. No-op unless the logger
  // is present and PIPELINE_LOG_CHUNK_SNAPSHOTS is enabled.
  const snapshot = (chunkIdx, name, srcPath) =>
    logger?.chunkSnapshotsEnabled ? logger.copyChunkSnapshot(chunkIdx, name, srcPath) : undefined

  const frames = ctx.results.metrics?.frames ?? []
  const plan = planChunkBoundaries({ frames, sampleRate, totalSamples, options: plannerOptions })

  if (plan.chunks.length === 1) {
    ctx.log(`[chunked] single-chunk plan (${plan.reason}) — running inner stages whole-file`)
    const wallClockStart = Date.now()
    const chunkTimings = {
      index: 1,
      sampleRange: [0, totalSamples],
      carveMs: 0,
      stages: [],
      totalMs: 0,
    }
    let prevPath = ctx.currentPath
    await snapshot(1, 'input', prevPath)
    for (const entry of innerStages) {
      const stageMs = await runTimed(() => runInnerStage(ctx, entry))
      chunkTimings.stages.push({ name: entryDisplayName(entry), durationMs: stageMs })
      chunkTimings.totalMs += stageMs
      if (ctx.currentPath !== prevPath) {
        await snapshot(1, entryDisplayName(entry), ctx.currentPath)
        prevPath = ctx.currentPath
      }
    }
    const wallClockMs = Date.now() - wallClockStart
    return buildTimings(plan, overlapSamples, sampleRate, 0, [chunkTimings], 1, wallClockMs)
  }

  const effectiveConcurrency = Math.max(1, Math.min(concurrency, plan.chunks.length))
  // Per-call PyTorch thread limit for inner stages. Wrapping every inner
  // stage in withThreadLimit means concurrent workers cap their thread
  // count to (chunkedLimit) instead of the env-default (TORCH_NUM_THREADS,
  // tuned for serial calls). Without this, raising TORCH_NUM_THREADS to
  // speed up serial Python stages would crush parallel chunked workloads.
  const chunkedThreadLimit = effectiveConcurrency > 1 ? getChunkedThreadLimit() : null
  ctx.log(
    `[chunked] ${plan.chunks.length} chunks, ${innerStages.length} inner stages each ` +
    `(overlap ${OVERLAP_MS} ms = ${overlapSamples} samples, ` +
    `concurrency=${effectiveConcurrency}` +
    (chunkedThreadLimit != null ? `, torchThreads=${chunkedThreadLimit}` : '') +
    `)`
  )

  // Process each chunk in its own task. Inner stages within a chunk stay
  // sequential (RNNoise depends on DF3's output, etc.); independent chunks
  // run in parallel up to the concurrency cap. Results land in fixed slots
  // so processedChunks[] preserves order for the stitcher regardless of
  // completion order.
  const processedChunks = new Array(plan.chunks.length)
  const perChunkTimings = new Array(plan.chunks.length)

  const processOneChunk = async (i) => {
    const { startSample, endSample } = plan.chunks[i]
    const carveStart = Math.max(0, startSample - overlapSamples)
    const carveEnd   = Math.min(totalSamples, endSample + overlapSamples)

    const chunkInPath = ctx.tmp('.wav')
    const carveMs = await runTimed(() => extractAudioRange(sourcePath, chunkInPath, carveStart, carveEnd))
    await snapshot(i + 1, 'input', chunkInPath)

    const subCtx = createSubContext(ctx, chunkInPath, frames, carveStart, carveEnd)

    ctx.log(`[chunked] chunk ${i + 1}/${plan.chunks.length} start: samples [${carveStart}, ${carveEnd})`)
    const chunkTimings = {
      index: i + 1,
      sampleRange: [carveStart, carveEnd],
      carveMs,
      stages: [],
      totalMs: carveMs,
    }
    let prevPath = chunkInPath
    for (const entry of innerStages) {
      // withThreadLimit applies only when concurrency>1; serial chunk runs
      // (or single-chunk plans handled in the early-return branch) use the
      // default serial thread budget.
      const dispatch = chunkedThreadLimit != null
        ? () => withThreadLimit(chunkedThreadLimit, () => runInnerStage(subCtx, entry))
        : () => runInnerStage(subCtx, entry)
      const stageMs = await runTimed(dispatch)
      chunkTimings.stages.push({ name: entryDisplayName(entry), durationMs: stageMs })
      chunkTimings.totalMs += stageMs
      if (subCtx.currentPath !== prevPath) {
        await snapshot(i + 1, entryDisplayName(entry), subCtx.currentPath)
        prevPath = subCtx.currentPath
      }
    }
    ctx.log(`[chunked] chunk ${i + 1}/${plan.chunks.length} done in ${(chunkTimings.totalMs / 1000).toFixed(2)}s`)

    perChunkTimings[i] = chunkTimings
    processedChunks[i] = {
      carveStart,
      carveEnd,
      coreStart: startSample,
      coreEnd:   endSample,
      processedPath: subCtx.currentPath,
      results:       subCtx.results,
    }
  }

  const wallClockStart = Date.now()
  await runWithConcurrency(plan.chunks.length, effectiveConcurrency, processOneChunk)
  const wallClockMs = Date.now() - wallClockStart

  // Stitch processed chunks → single file (streaming; at most 2 chunks resident)
  const stitchedPath = ctx.tmp('.wav')
  const stitchMs = await runTimed(() =>
    stitchChunks(processedChunks, totalSamples, sampleRate, overlapSamples, stitchedPath),
  )
  ctx.currentPath = stitchedPath

  mergeChunkResults(ctx, processedChunks)
  await refreshPostBlockMetrics(ctx)

  return buildTimings(plan, overlapSamples, sampleRate, stitchMs, perChunkTimings, effectiveConcurrency, wallClockMs)
}

/**
 * Refresh whole-file calibration scalars on ctx.results.metrics from the
 * stitched output so downstream stages (compress, autoLeveler, certification)
 * read post-block values rather than the stale pre-block snapshot.
 *
 * Per-chunk noiseReduce passes update their own sub-ctx.results.metrics
 * during the chunk run, but those writes don't reach the parent. Averaging
 * across chunks would only approximate the file-level number; measuring the
 * stitched output gives the exact post-block value at the cost of one
 * frame-analysis pass (a few seconds even on a long file).
 *
 * frames is intentionally left untouched — its isSilence labels remain
 * authoritative from the original analyzeFramesRaw call. This matches the
 * whole-file noiseReduce stage's behaviour (see stages.js: "ctx.results.
 * metrics.frames is left untouched").
 *
 * noiseReduction.post_noise_floor_dbfs is also synced to the refreshed
 * value so the report's NR section agrees with the metrics block — without
 * this they could disagree by the makeup-gain delta averaged across chunks.
 */
async function refreshPostBlockMetrics(ctx) {
  if (!ctx.results.metrics?.frames) return
  const postFa = await remeasureFrames(ctx.currentPath, ctx.results.metrics)
  if (postFa.noiseFloorDbfs       != null) ctx.results.metrics.noiseFloorDbfs       = round2(postFa.noiseFloorDbfs)
  if (postFa.voicedRmsDbfs        != null) ctx.results.metrics.voicedRmsDbfs        = round2(postFa.voicedRmsDbfs)
  if (postFa.averageVoicedRmsDbfs != null) ctx.results.metrics.averageVoicedRmsDbfs = round2(postFa.averageVoicedRmsDbfs)
  if (postFa.silenceThresholdDbfs != null) ctx.results.metrics.silenceThresholdDbfs = round2(postFa.silenceThresholdDbfs)

  // Sync the NR report's post-block noise floor to the refreshed metrics
  // value. mergeChunkResults averages per-chunk scalars, which is fine for
  // a representative figure but doesn't match the stitched-output truth.
  if (ctx.results.noiseReduction && postFa.noiseFloorDbfs != null) {
    ctx.results.noiseReduction.post_noise_floor_dbfs = ctx.results.metrics.noiseFloorDbfs
  }
}

/**
 * Run `taskFn(i)` for i in [0, count) with at most `limit` tasks in flight.
 * Each completion immediately frees a slot for the next pending index, so
 * uneven task durations don't leave idle capacity. Caller-side: tasks write
 * results into fixed-index slots so output order is independent of completion
 * order.
 *
 * Error policy: on the first thrown task, stop scheduling new indices but
 * wait for all in-flight tasks to settle before rethrowing. This prevents a
 * fail-fast Promise.all from letting the outer catch delete tmp files that
 * other worker loops are still writing to. The first error is rethrown; any
 * later errors from in-flight tasks are swallowed (Node would log them as
 * unhandled rejections otherwise and the first error is the actionable one).
 */
async function runWithConcurrency(count, limit, taskFn) {
  let firstError = null
  const captureError = (err) => {
    if (firstError == null) firstError = err
  }

  if (limit >= count) {
    // Use allSettled so all tasks finish before we throw — same rationale as
    // the worker-loop branch below: don't tear down tmp state while other
    // tasks are mid-write.
    const results = await Promise.allSettled(
      Array.from({ length: count }, (_, i) => Promise.resolve().then(() => taskFn(i))),
    )
    for (const r of results) {
      if (r.status === 'rejected') captureError(r.reason)
    }
    if (firstError) throw firstError
    return
  }

  let next = 0
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      // First error short-circuits new-task scheduling so we don't queue more
      // work that would race the caller's cleanup.
      if (firstError) return
      const i = next++
      if (i >= count) return
      try {
        await taskFn(i)
      } catch (err) {
        captureError(err)
        return
      }
    }
  })
  await Promise.all(workers)
  if (firstError) throw firstError
}

// ─── Timing helpers ─────────────────────────────────────────────────────────

async function runTimed(fn) {
  const t0 = Date.now()
  await fn()
  return Date.now() - t0
}

/**
 * Resolve an inner-stage entry to a human-readable label for timing reports.
 * Bare-string entries are returned as-is. Object entries use the config key,
 * suffixed with the model when present so dual-pass `noiseReduce` calls show
 * up as `noiseReduce(df3)` vs `noiseReduce(rnnoise)` rather than colliding.
 */
function entryDisplayName(entry) {
  if (typeof entry === 'string') return entry
  if (!entry || typeof entry !== 'object') return String(entry)
  const [configKey] = Object.keys(entry)
  const inlineConfig = entry[configKey]
  if (inlineConfig && typeof inlineConfig === 'object' && inlineConfig.model) {
    return `${configKey}(${inlineConfig.model})`
  }
  return configKey
}

/**
 * Roll per-chunk timings into the public ChunkedTimings shape, including the
 * per-stage aggregate (total / avg / count). Stable across single-chunk and
 * multi-chunk paths so log consumers don't need to special-case either.
 */
function buildTimings(plan, overlapSamples, sampleRate, stitchMs, perChunkTimings, concurrency, wallClockMs) {
  const overlapMs = Math.round(overlapSamples / sampleRate * 1000)
  let carveTotalMs = 0
  let innerTotalMs = 0
  const perStage = {}

  for (const chunk of perChunkTimings) {
    carveTotalMs += chunk.carveMs
    for (const stage of chunk.stages) {
      innerTotalMs += stage.durationMs
      const agg = perStage[stage.name] ?? { totalMs: 0, avgMs: 0, count: 0 }
      agg.totalMs += stage.durationMs
      agg.count   += 1
      perStage[stage.name] = agg
    }
  }
  for (const name of Object.keys(perStage)) {
    perStage[name].avgMs = Math.round(perStage[name].totalMs / perStage[name].count)
  }

  return {
    overall: {
      plannedChunks: plan.chunks.length,
      overlapMs,
      concurrency,
      carveTotalMs,
      stitchMs,
      innerTotalMs,
      wallClockMs,
      planReason: plan.reason,
    },
    perChunk: perChunkTimings,
    perStage,
  }
}

// ─── Sub-context construction ───────────────────────────────────────────────

/**
 * Build a per-chunk context that aliases the parent for cross-stage state
 * (globalParams, tmp/tmpFiles, log, preset, outputProfile) but isolates
 * results and points currentPath at the chunk's carved input.
 *
 * results.metrics carries the parent's whole-file calibration scalars
 * (noiseFloorDbfs, voicedRmsDbfs, …) so inner stages that read them get the
 * same calibration in every chunk. frames is replaced with the chunk-local
 * slice so any `remeasureFrames(chunkPath, ctx.results.metrics)` call lines
 * up its frame indices against the correct isSilence labels.
 */
function createSubContext(parent, chunkInPath, frames, carveStart, carveEnd) {
  const subFrames = sliceFramesForChunk(frames, carveStart, carveEnd)
  return {
    ...parent,
    currentPath: chunkInPath,
    results: {
      ...parent.results,
      metrics: {
        ...parent.results.metrics,
        frames: subFrames,
      },
    },
  }
}

// ─── Stitcher ────────────────────────────────────────────────────────────────

/**
 * Streaming reassembly of per-chunk processed audio into a single continuous
 * WAV. The output is written incrementally via openWavStreamWriter; at most
 * two processed-chunk buffers (current + next) are held in memory at any
 * time, so peak memory scales with max chunk duration rather than total file
 * duration.
 *
 * Crossfade region at each seam is `2 * overlapSamples` wide and centred on
 * the planned split sample. Both contributing chunks supply the full
 * crossfade window from their own carve (no edge-of-buffer artefacts).
 *
 * Layout for chunk i (non-edge):
 *   direct copy:  [coreStart + overlap, coreEnd - overlap)
 *   xfade w/ i-1: [coreStart - overlap, coreStart + overlap)   ← written by i-1's seam pass
 *   xfade w/ i+1: [coreEnd   - overlap, coreEnd   + overlap)   ← written here as seam pass
 *
 * First chunk has no leading xfade region; last chunk has no trailing one.
 */
async function stitchChunks(chunks, totalSamples, sampleRate, overlapSamples, outPath) {
  // Open the first chunk to size the output (channel count, sample rate).
  let cur = await readWavAllChannels(chunks[0].processedPath)
  const numChannels = cur.channels.length

  const writer = await openWavStreamWriter(outPath, numChannels, sampleRate, totalSamples)

  try {
    for (let i = 0; i < chunks.length; i++) {
      const { carveStart, coreStart, coreEnd } = chunks[i]
      const isFirst = i === 0
      const isLast  = i === chunks.length - 1

      // Direct-copy range covers the chunk's core minus any seam regions.
      const directStart = isFirst ? coreStart : coreStart + overlapSamples
      const directEnd   = isLast  ? coreEnd   : coreEnd   - overlapSamples

      const directChannels = cur.channels.map(ch =>
        ch.subarray(directStart - carveStart, directEnd - carveStart),
      )
      await writer.write(directChannels)

      // Seam with the NEXT chunk: load next, crossfade the 2*overlap window
      // centred on coreEnd, write, then drop the current chunk and advance.
      if (!isLast) {
        const next = chunks[i + 1]
        const nextLoaded = await readWavAllChannels(next.processedPath)

        const xfStartAbs = coreEnd - overlapSamples
        const xfLen      = 2 * overlapSamples

        const mixedChannels = []
        for (let c = 0; c < numChannels; c++) {
          const tail = cur.channels[c].subarray(
            xfStartAbs - carveStart,
            xfStartAbs - carveStart + xfLen,
          )
          const head = nextLoaded.channels[c].subarray(
            xfStartAbs - next.carveStart,
            xfStartAbs - next.carveStart + xfLen,
          )
          mixedChannels.push(equalPowerCrossfade(tail, head))
        }
        await writer.write(mixedChannels)

        cur = nextLoaded   // chunk i becomes eligible for GC
      }
    }
  } finally {
    await writer.close()
  }
}

// ─── Per-chunk results merge ────────────────────────────────────────────────

/**
 * Fold per-chunk ctx.results entries back into the parent ctx.results so the
 * downstream report builder sees the chunked block as a single logical step.
 *
 * Each inner stage's writes go to its sub-ctx.results, not the parent —
 * sub-ctx is constructed with a fresh results object aliasing the parent's
 * pre-block snapshot. This function gathers per-chunk values for each key
 * registered in CHUNK_MERGERS and delegates the actual merge strategy
 * (first-wins, sum, average, etc.) to the merger.
 *
 * To make a new stage chunk-safe, add an entry to CHUNK_MERGERS keyed by
 * the ctx.results key the stage writes — no changes needed here.
 *
 * Whole-file metric scalars (noiseFloorDbfs, voicedRmsDbfs, …) are NOT
 * handled here; refreshPostBlockMetrics measures the stitched output
 * instead, which is exact rather than an average across chunks.
 */
function mergeChunkResults(ctx, processedChunks) {
  if (!processedChunks.length) return

  for (const [key, merger] of Object.entries(CHUNK_MERGERS)) {
    const chunkValues = processedChunks.map(c => c.results?.[key])
    if (!chunkValues.some(v => v !== undefined)) continue
    const merged = merger(chunkValues)
    if (merged !== undefined) ctx.results[key] = merged
  }
}
