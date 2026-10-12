/**
 * PHAT*SS apply, split into chunks that render in parallel workers and stitch
 * back into exactly what one continuous render produces.
 *
 * WHY. Apply rendered the whole region on one thread: ~70 s for 10 min of
 * stereo at Warmth 5 / TAPE 6 (894 ms per 10 s after the October 2026
 * performance pass). The kernel is the same code in a worker as in the worklet,
 * so a region can be cut into chunks, each rendered from its own run-in of the
 * real audio before it, and the outputs laid end to end.
 *
 * ⚠ EVERY CHUNK MUST START ON THE CONTINUOUS RENDER'S 128-SAMPLE BLOCK GRID.
 * The tape HF shelf recomputes its corner every COEFF_STRIDE samples counted
 * from the start of each 128-sample block, so a chunk whose render starts off
 * that grid updates its corner on different samples for the whole chunk: on a
 * 175 s narration + drums file at 7.5 ips the error sat at −45.6 dB re the
 * peak up to 7 s after a seam, whatever the run-in (0.25 / 1 / 2 s all read
 * −28 to −40 dB at Warmth 10 / TAPE 12). Aligned, it vanishes.
 *
 * ⚠ AND IT MUST BE GIVEN THE RUN-IN. With every start aligned and
 * CHUNK_PREROLL_S of run-in, the same file stitches to −141 / −147 dB re its
 * peak with CLEAN (one continuous render's own float noise), and to −87 dB
 * with THICK — the hysteresis loop's memory, which no finite run-in erases
 * exactly. At 0.25 s of run-in everything sat near −61 to −67 dB.
 *
 * Pure: no worker, no DOM, no kernel — the plan; the per-chunk render is
 * phatassChunkRender.js (the worker's), kept apart so the main thread does not
 * load the kernel. Both are tested under node; processing.js fans them out.
 */

/** The render block (the worklet quantum, and processPhatassBuffer's). */
export const RENDER_BLOCK = 128
/** Run-in before each chunk after the first, seconds of the real audio before it. */
export const CHUNK_PREROLL_S = 1
/** Below this a chunk is not worth a worker of its own, seconds. */
export const MIN_CHUNK_S = 15
/** Most workers one apply uses. */
export const MAX_CHUNK_WORKERS = 8

/** How many chunks for a region of `numSamples`, given `cores` available. */
export function chunkCount(numSamples, sampleRate, cores) {
  const byLength = Math.floor(numSamples / (MIN_CHUNK_S * sampleRate))
  const byCores = Math.max(1, Math.min(MAX_CHUNK_WORKERS, Math.floor(cores) - 1))
  return Math.max(1, Math.min(byLength, byCores))
}

/**
 * The chunks, in the coordinates of the continuous render's input (sample 0 is
 * the first sample it renders, `preRoll` before the region):
 *   from   — where this chunk's render starts (a multiple of RENDER_BLOCK)
 *   to     — where its input ends: its last region sample plus `latency`
 *   skip   — output samples to drop before its part of the region
 *   start, length — its part of the region, region-relative
 * The first chunk starts where the continuous render does, so its output is
 * that render's exactly.
 */
export function planChunks(numSamples, preRoll, latency, sampleRate, count) {
  const pre = Math.round(CHUNK_PREROLL_S * sampleRate)
  const chunks = []
  for (let k = 0; k < count; k++) {
    const start = Math.round((k * numSamples) / count)
    const end = Math.round(((k + 1) * numSamples) / count)
    const from = k === 0 ? 0 : Math.max(0, Math.floor((preRoll + start - pre) / RENDER_BLOCK) * RENDER_BLOCK)
    chunks.push({ from, to: preRoll + end + latency, skip: preRoll + start - from, start, length: end - start })
  }
  return chunks
}
