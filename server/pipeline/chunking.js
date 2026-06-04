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

const DEFAULT_TARGET_CHUNK_DURATION_S = 120   // 2 minutes
// Minimum chunk duration is an overhead-amortisation floor, not a quality
// floor: each chunk pays ~2 s of fixed cost (two remeasureFrames passes ≈ 1 s
// each per measured NR runs, plus FFmpeg carve + stitch crossfade + worker
// IPC). At 30 s that's ~7 % overhead, which is the practical edge of
// worthwhile parallelism. Going lower buys nothing — useful chunk count is
// capped at a small multiple of CHUNKED_CONCURRENCY (more chunks ≠ more
// parallelism, just more harness), so smaller chunks only add overhead. The
// prior 60 s floor was set before concurrency-aware sizing existed; with
// balancing in play it made `200 s @ c=3` and `300 s @ c=4` fail to align
// because the implied per-chunk duration grazed the floor. If the per-chunk
// harness shrinks (e.g. once the remeasureFrames audit lands), this can drop
// further.
const DEFAULT_MIN_CHUNK_DURATION_S    = 30
const DEFAULT_MAX_CHUNK_DURATION_S    = 600   // never above 10 minutes
const DEFAULT_MIN_SILENCE_MS          = 500   // minimum silence to split at

// How far above minChunkDurationS a balanced chunk duration must sit before we
// trust the silence-snapped greedy loop to actually realise that chunk count.
const MIN_DURATION_MARGIN = 1.2

/**
 * Pick a chunk count that is a multiple of `concurrency` so the parallel
 * dispatch fills every wave evenly — no "overhang" wave where some workers sit
 * idle. (Example: 3 chunks on 2 slots runs wave 1 = chunks 1+2, then wave 2 =
 * chunk 3 alone with the other worker idle — ~25% of capacity wasted.)
 *
 * Anchors on the natural count implied by `targetS`, then snaps to whichever
 * bracketing multiple of `concurrency` yields a chunk duration closest to
 * `targetS` while still inside [minS, maxS]. Ties break toward fewer chunks,
 * since each extra chunk adds a fixed per-chunk harness cost (the NR stage's
 * two remeasure passes run per chunk).
 *
 * Returns the chosen count, or null when no multiple of `concurrency` fits the
 * duration rails (e.g. the file is too short to hold one full wave above the
 * minimum) — the caller then falls back to plain target-based planning, so this
 * never produces a plan worse than the concurrency-unaware one.
 *
 * @param {number} totalS      Total audio duration in seconds
 * @param {number} targetS     Desired chunk duration (the anchor)
 * @param {number} minS        Minimum chunk duration
 * @param {number} maxS        Maximum chunk duration
 * @param {number} concurrency Parallel slot count to align the chunk count to
 * @returns {number|null}
 */
function balancedChunkCount(totalS, targetS, minS, maxS, concurrency) {
  if (concurrency <= 1) return null

  // Chunk-count bounds implied by the duration rails.
  const minCount = Math.max(1, Math.ceil(totalS / maxS))   // fewest chunks within max-duration
  const maxCount = Math.floor(totalS / minS)               // most chunks within min-duration
  if (maxCount < concurrency) return null                  // can't even fill one full wave above min

  const natural = Math.max(1, Math.round(totalS / targetS))
  const candidates = new Set([
    Math.floor(natural / concurrency) * concurrency,
    Math.ceil(natural / concurrency)  * concurrency,
  ])

  let best = null
  let bestScore = Infinity
  for (const c of candidates) {
    if (c < concurrency) continue              // need at least one full wave
    if (c < minCount || c > maxCount) continue // honor the duration rails
    const durS = totalS / c
    // The greedy loop snaps each split to the nearest qualifying silence and
    // excludes silences inside the first min-chunk window. A balanced duration
    // sitting right on the floor leaves no room for that snap, so the loop
    // overshoots and the realised count drifts off the multiple. Require a
    // margin above min so a claimed balanced count is one the loop can hit.
    if (durS < minS * MIN_DURATION_MARGIN) continue
    // Closeness to the configured target, tie-broken toward fewer chunks.
    const score = Math.abs(durS - targetS) + c * 1e-6
    if (score < bestScore) { bestScore = score; best = c }
  }
  return best
}


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
 *   2. Greedily place split points at silence midpoints whose distance from
 *      `cursor + targetDuration` is minimal, subject to min/max chunk
 *      duration constraints. Keep emitting splits while the remaining file
 *      is large enough to form another chunk near the target size — i.e.
 *      while `remaining > target + min`. Without this, a `max` materially
 *      larger than `target` lets the trailing chunk balloon to max even
 *      when more silences are available to split on.
 *   3. The search window upper bound is capped at `totalSamples - min` so
 *      a split never leaves a trailing chunk below the minimum.
 *   4. If no qualifying silence falls in the search window: accept the
 *      splits emitted so far when the trailing chunk still satisfies max,
 *      otherwise bail to a single-chunk plan (the only way to honor the
 *      max-duration guarantee).
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
 * @param {number} [args.options.concurrencyHint] Parallel slot count. When > 1,
 *   the chunk count is nudged to a multiple of this so every parallel wave is
 *   full (avoids the idle-worker "overhang" of e.g. 3 chunks on 2 slots).
 *   Defaults to 1 (no adjustment).
 * @returns {{
 *   chunks: Array<{ startSample: number, endSample: number }>,
 *   splitsAtSilenceMidpoints: number[],
 *   silenceRegions: Array<{ startSample: number, endSample: number, durationMs: number }>,
 *   reason: string|null,
 *   balancedChunkCount: number|null,
 * }}
 */
export function planChunkBoundaries({ frames, sampleRate, totalSamples, options = {} }) {
  const targetSraw      = options.targetChunkDurationS ?? DEFAULT_TARGET_CHUNK_DURATION_S
  const minS            = options.minChunkDurationS    ?? DEFAULT_MIN_CHUNK_DURATION_S
  const maxS            = options.maxChunkDurationS    ?? DEFAULT_MAX_CHUNK_DURATION_S
  const minSilMs        = options.minSilenceMs         ?? DEFAULT_MIN_SILENCE_MS
  const _rawHint        = Number(options.concurrencyHint ?? 1)
  const concurrencyHint = Number.isFinite(_rawHint) ? Math.max(1, Math.floor(_rawHint)) : 1

  const minChunkSamples = Math.round(minS * sampleRate)
  const maxChunkSamples = Math.round(maxS * sampleRate)

  // File too short to chunk meaningfully
  if (totalSamples < 2 * minChunkSamples) {
    return {
      chunks: [{ startSample: 0, endSample: totalSamples }],
      splitsAtSilenceMidpoints: [],
      silenceRegions: [],
      reason: 'file_shorter_than_two_min_chunks',
      balancedChunkCount: null,
    }
  }

  const silenceRegions = collectSilenceRegions(frames, sampleRate, minSilMs)
  if (silenceRegions.length === 0) {
    return {
      chunks: [{ startSample: 0, endSample: totalSamples }],
      splitsAtSilenceMidpoints: [],
      silenceRegions: [],
      reason: 'no_qualifying_silence_regions',
      balancedChunkCount: null,
    }
  }

  // Concurrency-aware target: nudge the chunk count to a multiple of the
  // parallel slot count so every wave is full. Falls back to the raw target
  // when no balanced count fits the duration rails. The greedy loop below is
  // still silence-snapped, so the realised count can drift by ±1 in pathological
  // silence layouts — the rails and single-chunk fallback keep that safe.
  const balancedTargetCount = concurrencyHint > 1
    ? balancedChunkCount(totalSamples / sampleRate, targetSraw, minS, maxS, concurrencyHint)
    : null
  const targetS       = balancedTargetCount ? (totalSamples / sampleRate) / balancedTargetCount : targetSraw
  const targetSamples = Math.round(targetS * sampleRate)

  // Greedy split placement. Search is anchored to the cursor (= last emitted
  // split, or 0 initially), and only advances when a split is actually placed.
  //
  // Loop predicate: keep emitting splits while the remaining file is larger
  // than `target + min` — i.e. while there's room for another chunk near
  // target size with a trailing chunk above min. Stopping at `remaining ≤
  // max` (the previous behavior) left the trailing chunk free to balloon
  // up to max, producing badly unbalanced plans whenever max ≫ target.
  //
  // Search window upper bound is also capped at `totalSamples - min` so a
  // split never strands a trailing chunk below the minimum.
  //
  // If no qualifying silence is found in the window: stop early and keep
  // the splits emitted so far when the trailing chunk still satisfies max,
  // otherwise bail to a single-chunk plan (continuing without emitting a
  // split would leave the trailing chunk anchored to the previous split
  // and potentially violate maxChunkDurationS).
  const splits  = []
  let cursor    = 0
  let regionIdx = 0
  let bailReason = null
  while (totalSamples - cursor > targetSamples + minChunkSamples) {
    const idealNext = cursor + targetSamples
    const windowLo  = cursor + minChunkSamples
    const windowHi  = Math.min(cursor + maxChunkSamples, totalSamples - minChunkSamples)

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
      // No silence in the search window. If the trailing chunk we'd produce
      // by stopping here still satisfies maxChunkDurationS, accept the
      // splits already placed. Otherwise bail to a single-chunk plan.
      if (totalSamples - cursor <= maxChunkSamples) {
        bailReason = 'no_silence_in_split_window_stop_early'
        break
      }
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

  // Report balancing only when the silence-snapped loop actually landed a
  // multiple of the slot count. balancedTargetCount above is the *target*; the
  // realised count can fall short when silence layout near the min-chunk floor
  // forces an overshoot (the loop still returns a valid, rail-respecting plan).
  // Reporting the realised-balanced count — or null when it drifted — keeps the
  // field honest: non-null ⟹ this plan has no idle-worker overhang.
  const balancedCount = (
    concurrencyHint > 1 &&
    chunks.length > 1 &&
    chunks.length % concurrencyHint === 0
  ) ? chunks.length : null

  return {
    chunks,
    splitsAtSilenceMidpoints: splits,
    silenceRegions,
    reason: chunks.length === 1
      ? (bailReason ?? 'no_split_window_had_silence')
      : null,
    balancedChunkCount: balancedCount,
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
