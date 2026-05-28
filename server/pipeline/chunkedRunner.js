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
import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels }   from './wavWriter.js'

const OVERLAP_MS = 100

/**
 * Run a chunked block. The orchestrator-owned `runInnerStage` callback is
 * invoked once per inner stage entry per chunk; it handles registry lookup,
 * inline-config patching, and (when logging is enabled) per-step logging.
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
 */
export async function runChunkedBlock(ctx, innerStages, runInnerStage, plannerOptions = {}) {
  const sourcePath = ctx.currentPath
  const { channels, sampleRate } = await readWavAllChannels(sourcePath)
  const totalSamples   = channels[0].length
  const overlapSamples = Math.round(OVERLAP_MS / 1000 * sampleRate)

  const frames = ctx.results.metrics?.frames ?? []
  const plan = planChunkBoundaries({ frames, sampleRate, totalSamples, options: plannerOptions })

  if (plan.chunks.length === 1) {
    ctx.log(`[chunked] single-chunk plan (${plan.reason}) — running inner stages whole-file`)
    for (const entry of innerStages) {
      await runInnerStage(ctx, entry)
    }
    return
  }

  ctx.log(
    `[chunked] ${plan.chunks.length} chunks, ${innerStages.length} inner stages each ` +
    `(overlap ${OVERLAP_MS} ms = ${overlapSamples} samples)`
  )

  // Pre-carve all chunk input buffers from the loaded source channels.
  const processedChunks = []
  for (let i = 0; i < plan.chunks.length; i++) {
    const { startSample, endSample } = plan.chunks[i]
    const carveStart = Math.max(0, startSample - overlapSamples)
    const carveEnd   = Math.min(totalSamples, endSample + overlapSamples)

    const chunkChannels = channels.map(ch => ch.subarray(carveStart, carveEnd))
    const chunkInPath = ctx.tmp('.wav')
    await writeWavChannels(chunkChannels, sampleRate, chunkInPath)

    const subCtx = createSubContext(ctx, chunkInPath, frames, carveStart, carveEnd)

    ctx.log(`[chunked] chunk ${i + 1}/${plan.chunks.length}: samples [${carveStart}, ${carveEnd})`)
    for (const entry of innerStages) {
      await runInnerStage(subCtx, entry)
    }

    processedChunks.push({
      carveStart,
      carveEnd,
      coreStart: startSample,
      coreEnd:   endSample,
      processedPath: subCtx.currentPath,
      results:       subCtx.results,
    })
  }

  // Stitch processed chunks → single file
  const stitchedPath = ctx.tmp('.wav')
  await stitchChunks(processedChunks, totalSamples, sampleRate, overlapSamples, stitchedPath)
  ctx.currentPath = stitchedPath

  mergeChunkResults(ctx, processedChunks)
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
 * Reassemble per-chunk processed audio into a single continuous file. The
 * crossfade region at each seam is `2 * overlapSamples` wide and centred on
 * the planned split sample, so both contributing chunks supply the full
 * crossfade window from their own carve (no edge-of-buffer artefacts).
 *
 * Layout for chunk i (non-edge):
 *   direct copy:  [coreStart + overlap, coreEnd - overlap)
 *   xfade w/ i-1: [coreStart - overlap, coreStart + overlap)   ← written by i-1's "next" xfade
 *   xfade w/ i+1: [coreEnd   - overlap, coreEnd   + overlap)   ← written here as "next" xfade
 *
 * First chunk has no leading xfade region; last chunk has no trailing one.
 */
async function stitchChunks(chunks, totalSamples, sampleRate, overlapSamples, outPath) {
  // All chunks have the same channel count — read first to size the output.
  const first = await readWavAllChannels(chunks[0].processedPath)
  const numChannels = first.channels.length

  const output = []
  for (let c = 0; c < numChannels; c++) output.push(new Float32Array(totalSamples))

  // Cache processed channels per chunk to avoid re-reading during the seam pass.
  const procs = [first.channels]
  for (let i = 1; i < chunks.length; i++) {
    const r = await readWavAllChannels(chunks[i].processedPath)
    procs.push(r.channels)
  }

  for (let i = 0; i < chunks.length; i++) {
    const { carveStart, coreStart, coreEnd } = chunks[i]
    const procCh = procs[i]
    const isFirst = i === 0
    const isLast  = i === chunks.length - 1

    const directStart = isFirst ? coreStart : coreStart + overlapSamples
    const directEnd   = isLast  ? coreEnd   : coreEnd   - overlapSamples

    for (let c = 0; c < numChannels; c++) {
      const src = procCh[c]
      const dst = output[c]
      for (let s = directStart; s < directEnd; s++) {
        dst[s] = src[s - carveStart]
      }
    }

    // Write crossfade with the NEXT chunk (this chunk's tail meets next's head).
    // The xfade region in absolute samples is centred on the split (= coreEnd).
    if (!isLast) {
      const next = chunks[i + 1]
      const nextProc = procs[i + 1]
      const xfStartAbs = coreEnd - overlapSamples
      const xfLen      = 2 * overlapSamples

      for (let c = 0; c < numChannels; c++) {
        const tail = procCh[c].subarray(
          xfStartAbs - carveStart,
          xfStartAbs - carveStart + xfLen,
        )
        const head = nextProc[c].subarray(
          xfStartAbs - next.carveStart,
          xfStartAbs - next.carveStart + xfLen,
        )
        const mixed = equalPowerCrossfade(tail, head)
        for (let s = 0; s < xfLen; s++) {
          output[c][xfStartAbs + s] = mixed[s]
        }
      }
    }
  }

  await writeWavChannels(output, sampleRate, outPath)
}

// ─── Per-chunk results merge ────────────────────────────────────────────────

/**
 * Fold per-chunk ctx.results entries back into the parent ctx.results so the
 * downstream report builder sees the chunked block as a single logical step.
 *
 * For v1 the only inner stages that write report keys are noiseReduce
 * variants — they overwrite `results.noiseReduction` on each pass, so each
 * sub-ctx ends up holding the report from the LAST inner noiseReduce call
 * (matching the whole-file behaviour). Numeric scalars that legitimately
 * vary per chunk (noise floor measurements, NR makeup gain) are averaged
 * across chunks to give a representative file-level figure.
 *
 * Future inner stages that write their own keys can extend this switch.
 */
function mergeChunkResults(ctx, processedChunks) {
  const first = processedChunks[0].results
  if (!first) return

  if (first.noiseReduction) {
    const merged = { ...first.noiseReduction }
    const averagedKeys = ['makeupGainDb', 'post_noise_floor_dbfs', 'pre_noise_floor_dbfs']
    for (const key of averagedKeys) {
      const values = processedChunks
        .map(c => c.results.noiseReduction?.[key])
        .filter(v => typeof v === 'number' && isFinite(v))
      if (values.length) {
        merged[key] = round2(values.reduce((a, b) => a + b, 0) / values.length)
      }
    }
    ctx.results.noiseReduction = merged
  }
}

function round2(n) {
  return Math.round(n * 100) / 100
}
