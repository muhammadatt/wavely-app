/**
 * Chunking utilities for intra-file parallel processing.
 *
 * Three independent helpers used by a future chunked orchestrator:
 *
 *   sliceFramesForChunk()    — re-slice a whole-file frameAnalysis.frames
 *                              array down to a chunk's sample range, with
 *                              offsetSamples rebased to chunk-local 0.
 *
 *   planChunkBoundaries()    — choose chunk split points snapped to long
 *                              silence regions, balancing chunk durations
 *                              around a target.
 *
 *   equalPowerCrossfade()    — equal-power crossfade between two channel
 *                              segments. Used when stitching adjacent
 *                              chunks back into a continuous output.
 *
 * Everything here is pure (no I/O, no ctx). Each function is independently
 * unit-testable and free of dependencies on the rest of the pipeline.
 */

// ─── Frame slicing ───────────────────────────────────────────────────────────

/**
 * Return the subset of frames that intersect a chunk's sample range, with
 * offsetSamples rebased so the chunk's first sample is at index 0. Frames
 * that straddle a chunk boundary are truncated so consumers iterating
 * `[offsetSamples, offsetSamples + lengthSamples)` stay inside the chunk's
 * audio buffer.
 *
 * Compressor / parallel-compressor / autoLeveler all iterate
 * frameAnalysis.frames keyed off offsetSamples to decide which samples
 * are voiced. Per-chunk apply needs these labels relative to the chunk's
 * own buffer.
 *
 * @param {Array<{ offsetSamples: number, lengthSamples: number, isSilence: boolean, rmsDbfs?: number, index?: number }>} frames
 *   Whole-file frame array from analyzeFramesRaw.
 * @param {number} chunkStartSample  Absolute sample index where the chunk's
 *   audio buffer starts (inclusive).
 * @param {number} chunkEndSample    Absolute sample index where the chunk's
 *   audio buffer ends (exclusive).
 * @returns {Array<{ offsetSamples: number, lengthSamples: number, isSilence: boolean, rmsDbfs?: number, index?: number }>}
 *   Frame array with offsetSamples in chunk-local coordinates and
 *   lengthSamples truncated at chunk boundaries.
 */
export function sliceFramesForChunk(frames, chunkStartSample, chunkEndSample) {
  if (!Array.isArray(frames) || frames.length === 0) return []
  if (chunkEndSample <= chunkStartSample) return []

  const out = []
  for (const frame of frames) {
    const fStart = frame.offsetSamples
    const fEnd   = fStart + frame.lengthSamples

    // Drop frames entirely outside the chunk
    if (fEnd <= chunkStartSample) continue
    if (fStart >= chunkEndSample) break  // frames are ordered; safe to stop

    // Clamp the frame to the chunk range, then rebase
    const clampedStart = Math.max(fStart, chunkStartSample)
    const clampedEnd   = Math.min(fEnd,   chunkEndSample)
    out.push({
      ...frame,
      offsetSamples: clampedStart - chunkStartSample,
      lengthSamples: clampedEnd - clampedStart,
    })
  }
  return out
}

// ─── Chunk boundary planner ──────────────────────────────────────────────────

const DEFAULT_TARGET_CHUNK_DURATION_S = 300   // 5 minutes
const DEFAULT_MIN_CHUNK_DURATION_S    = 60    // never below 1 minute
const DEFAULT_MAX_CHUNK_DURATION_S    = 600   // never above 10 minutes
const DEFAULT_MIN_SILENCE_MS          = 500   // minimum silence to split at

/**
 * Choose split points along a file so each chunk lands at a long silence
 * region near the target duration. Returns contiguous, non-overlapping
 * ranges that cover [0, totalSamples).
 *
 * The orchestrator then expands each range by an overlap margin (so the
 * compressor envelope can pre-warm and adjacent chunks can crossfade) when
 * actually carving the audio.
 *
 * Algorithm:
 *   1. Identify silence regions ≥ minSilenceMs from the VAD frame array.
 *   2. Compute the ideal chunk count from totalSamples / targetDuration.
 *   3. Greedily place N-1 split points at silence midpoints whose distance
 *      from the next ideal boundary is minimal, subject to min/max chunk
 *      duration constraints.
 *   4. If no qualifying silence falls in the [min, max] window for the
 *      next boundary, give up on that split — the resulting chunk may be
 *      longer than target but never exceeds maxChunkDurationS in the next
 *      round, since search restarts from the previous boundary.
 *
 * Returns a single-chunk plan when the file is shorter than 2× the minimum,
 * or when no silence region qualifies anywhere — never produces an
 * arbitrary split.
 *
 * @param {object} args
 * @param {Array<{ offsetSamples: number, lengthSamples: number, isSilence: boolean }>} args.frames
 * @param {number} args.sampleRate
 * @param {number} args.totalSamples
 * @param {object} [args.options]
 * @param {number} [args.options.targetChunkDurationS]
 * @param {number} [args.options.minChunkDurationS]
 * @param {number} [args.options.maxChunkDurationS]
 * @param {number} [args.options.minSilenceMs]
 * @returns {{
 *   chunks: Array<{ startSample: number, endSample: number }>,
 *   splitsAtSilenceMidpoints: number[],
 *   silenceRegions: Array<{ startSample: number, endSample: number, durationMs: number }>,
 *   reason: string|null,
 * }}
 */
export function planChunkBoundaries({ frames, sampleRate, totalSamples, options = {} }) {
  const targetS   = options.targetChunkDurationS ?? DEFAULT_TARGET_CHUNK_DURATION_S
  const minS      = options.minChunkDurationS    ?? DEFAULT_MIN_CHUNK_DURATION_S
  const maxS      = options.maxChunkDurationS    ?? DEFAULT_MAX_CHUNK_DURATION_S
  const minSilMs  = options.minSilenceMs         ?? DEFAULT_MIN_SILENCE_MS

  const minChunkSamples = Math.round(minS * sampleRate)
  const maxChunkSamples = Math.round(maxS * sampleRate)
  const targetSamples   = Math.round(targetS * sampleRate)

  // File too short to chunk meaningfully
  if (totalSamples < 2 * minChunkSamples) {
    return {
      chunks: [{ startSample: 0, endSample: totalSamples }],
      splitsAtSilenceMidpoints: [],
      silenceRegions: [],
      reason: 'file_shorter_than_two_min_chunks',
    }
  }

  const silenceRegions = collectSilenceRegions(frames, sampleRate, minSilMs)
  if (silenceRegions.length === 0) {
    return {
      chunks: [{ startSample: 0, endSample: totalSamples }],
      splitsAtSilenceMidpoints: [],
      silenceRegions: [],
      reason: 'no_qualifying_silence_regions',
    }
  }

  // Greedy split placement. Search is anchored to the cursor (= last emitted
  // split, or 0 initially), and only advances when a split is actually placed.
  // If no qualifying silence is found in [cursor + min, cursor + max] for the
  // next chunk, we bail to a single-chunk plan rather than skipping forward —
  // advancing without emitting a split previously broke the max-duration
  // guarantee for the final chunk in speech-dense regions.
  const splits  = []
  let cursor    = 0
  let regionIdx = 0
  let bailReason = null
  while (cursor + maxChunkSamples < totalSamples) {
    const idealNext = cursor + targetSamples
    const windowLo  = cursor + minChunkSamples
    const windowHi  = cursor + maxChunkSamples

    // Advance regionIdx past any silence regions before the window
    while (regionIdx < silenceRegions.length
           && silenceRegions[regionIdx].midpointSample < windowLo) {
      regionIdx++
    }

    // Find best candidate in [windowLo, windowHi] — closest to idealNext
    let bestIdx     = -1
    let bestDist    = Infinity
    for (let i = regionIdx; i < silenceRegions.length; i++) {
      const mid = silenceRegions[i].midpointSample
      if (mid > windowHi) break
      const dist = Math.abs(mid - idealNext)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx  = i
      }
    }

    if (bestIdx < 0) {
      // No silence in [cursor + min, cursor + max] for the next split.
      // Bail to a single-chunk plan: continuing without emitting a split
      // would leave the trailing chunk anchored to the previous split and
      // potentially span the rest of the file, violating maxChunkDurationS.
      bailReason = 'no_silence_in_split_window'
      splits.length = 0
      break
    }

    const splitSample = silenceRegions[bestIdx].midpointSample
    splits.push(splitSample)
    cursor    = splitSample
    regionIdx = bestIdx + 1
  }

  // Build chunk ranges from sorted split points
  const chunks = []
  let chunkStart = 0
  for (const splitSample of splits) {
    chunks.push({ startSample: chunkStart, endSample: splitSample })
    chunkStart = splitSample
  }
  chunks.push({ startSample: chunkStart, endSample: totalSamples })

  return {
    chunks,
    splitsAtSilenceMidpoints: splits,
    silenceRegions,
    reason: chunks.length === 1
      ? (bailReason ?? 'no_split_window_had_silence')
      : null,
  }
}

/**
 * Identify contiguous runs of frames with isSilence === true totaling at
 * least minSilenceMs of duration. Returns each region's absolute sample
 * range, duration, and midpoint.
 */
function collectSilenceRegions(frames, sampleRate, minSilenceMs) {
  const minSamples = Math.round(minSilenceMs * sampleRate / 1000)
  const regions    = []

  let runStart = -1
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]
    if (frame.isSilence) {
      if (runStart < 0) runStart = i
    } else if (runStart >= 0) {
      flushRun(regions, frames, runStart, i, minSamples, sampleRate)
      runStart = -1
    }
  }
  if (runStart >= 0) flushRun(regions, frames, runStart, frames.length, minSamples, sampleRate)
  return regions
}

function flushRun(regions, frames, fromIdx, toIdx, minSamples, sampleRate) {
  const startSample = frames[fromIdx].offsetSamples
  const endFrame    = frames[toIdx - 1]
  const endSample   = endFrame.offsetSamples + endFrame.lengthSamples
  const length      = endSample - startSample
  if (length < minSamples) return
  regions.push({
    startSample,
    endSample,
    durationMs:     length / sampleRate * 1000,
    midpointSample: Math.round((startSample + endSample) / 2),
  })
}

// ─── Crossfade ───────────────────────────────────────────────────────────────

/**
 * Equal-power crossfade between two single-channel segments of identical
 * length. The output mixes `tail` (fading out, cosine weight) with `head`
 * (fading in, sine weight). Both inputs must already be aligned to the
 * same sample positions.
 *
 * Used by the chunked orchestrator's stitcher: when chunk A's processed
 * output ends with N samples of overlap with chunk B's processed head,
 * those N samples become an equal-power blend. Equal-power (not linear)
 * preserves perceived loudness through the crossfade — important when
 * the two sides may have slightly different envelope state from
 * compression / autoLeveler.
 *
 * @param {Float32Array} tail   Last N samples of the earlier chunk's output
 * @param {Float32Array} head   First N samples of the later chunk's output
 * @returns {Float32Array}      Mixed segment, length N
 */
export function equalPowerCrossfade(tail, head) {
  if (tail.length !== head.length) {
    throw new Error(
      `equalPowerCrossfade: tail/head length mismatch (${tail.length} vs ${head.length})`
    )
  }
  const n = tail.length
  const out = new Float32Array(n)
  if (n === 0) return out
  if (n === 1) {
    // Single-sample overlap — equal-power weights collapse to 0.707 each.
    out[0] = (tail[0] + head[0]) * Math.SQRT1_2
    return out
  }

  // Precompute denominator once; sin/cos per sample.
  const denom = n - 1
  for (let i = 0; i < n; i++) {
    const t       = (i / denom) * (Math.PI / 2)
    const wTail   = Math.cos(t)
    const wHead   = Math.sin(t)
    out[i] = tail[i] * wTail + head[i] * wHead
  }
  return out
}
