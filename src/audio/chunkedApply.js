/**
 * Parallel apply: a region split into chunks that render in parallel workers
 * and stitch back into what one continuous render produces.
 *
 * WHY. Apply rendered the whole region on one thread. The kernels are the same
 * code in a worker as in the worklet, so a region can be cut into chunks, each
 * rendered from its own run-in of the real audio before it, and the outputs
 * laid end to end. Built for PHAT*SS (~70 s for 10 min of stereo at Warmth 5 /
 * TAPE 6 on one thread), then extended to every plugin whose state a finite
 * run-in settles — see CHUNKED_PLUGINS in chunkRender.js for the list and
 * test/dsp/chunkedApply.test.js for what each one stitches to.
 *
 * ⚠ EVERY CHUNK MUST START ON THE CONTINUOUS RENDER'S GRID. The render runs in
 * 128-sample blocks, and anything resolved per block lands on different samples
 * in a chunk that starts off that grid: PHAT*SS's tape HF shelf recomputes its
 * corner every COEFF_STRIDE samples counted from each block's start, and off
 * the grid it read −28 to −45 dB re the peak at the seams for seconds whatever
 * the run-in. An STFT has a coarser grid of its own, its HOP: ResoTame chunks
 * cut on the 128 grid but off its 512-sample hop read −20 dB re the peak for
 * the whole chunk, and exact on the hop. So `grid` is per plugin, and always a
 * multiple of RENDER_BLOCK.
 *
 * ⚠ AND EACH CHUNK MUST BE GIVEN THE RUN-IN. A seam is the preview/apply
 * pre-roll question asked in the middle of the region: a kernel whose state
 * all decays settles on a run-in as long as its memory, one that latches never
 * does. That is why Tube Saturation is NOT chunked (its skew sign and valley
 * floor depend on history arbitrarily far back), and why `runInS` is per
 * plugin — normally its own pre-roll, which was measured for this.
 *
 * Pure: no worker, no DOM, no kernel — the plan; the per-chunk render is
 * chunkRender.js (the worker's), kept apart so the main thread does not load
 * the kernels. Both are tested under node; processing.js fans them out.
 */

/** The render block (the worklet quantum, and every process…Buffer's). */
export const RENDER_BLOCK = 128
/** Run-in before each chunk after the first when a plugin names none, seconds. */
export const DEFAULT_RUN_IN_S = 1
/** Below this a chunk is not worth a worker of its own, seconds. */
export const MIN_CHUNK_S = 15
/** Most workers one apply uses. */
export const MAX_CHUNK_WORKERS = 8

// Run-ins for the plugins whose own pre-roll is not the right number. The
// compressors (OptoSmooth, Scheps, FET Punch) use their pre-roll as it stands,
// and so does the HF Softener; PHAT*SS uses DEFAULT_RUN_IN_S.
/**
 * ResoTame has no pre-roll (its preview gap is grid phase, not memory), but
 * between two chunks of ONE render it does have memory, and a long one: seams
 * on the test material read −38 / −67 / −92 / −119 / −141 dB re the peak at 1 /
 * 2 / 3 / 4 / 6 s of run-in (on its hop grid). 6 s costs a 15 s chunk 40 % more
 * render and a long region's ~86 s chunks 7 %.
 */
export const RESONANCE_CHUNK_RUN_IN_S = 6
/** Saturation Bench's 0.5 s pre-roll, rounded up: exact at 1 s on the factory layers. */
export const SAT_BENCH_CHUNK_RUN_IN_S = 1
/**
 * The HF Softener's own 2 s pre-roll: −150 dB at 2 s, exact from 4 s (−67 dB at
 * 1 s — the lisp guard's 500 ms hold).
 */
export const HF_SOFTENER_CHUNK_RUN_IN_S = 2

/** How many chunks for a region of `numSamples`, given `cores` available. */
export function chunkCount(numSamples, sampleRate, cores) {
  const byLength = Math.floor(numSamples / (MIN_CHUNK_S * sampleRate))
  const byCores = Math.max(1, Math.min(MAX_CHUNK_WORKERS, Math.floor(cores) - 1))
  return Math.max(1, Math.min(byLength, byCores))
}

/**
 * The chunks, in the coordinates of the continuous render's input (sample 0 is
 * the first sample it renders, `preRoll` before the region):
 *   from   — where this chunk's render starts (a multiple of `grid`)
 *   to     — where its input ends: its last region sample plus `latency`,
 *            rounded up to a whole block (never past the render's own end)
 *   skip   — output samples to drop before its part of the region
 *   start, length — its part of the region, region-relative
 * The first chunk starts where the continuous render does, so its output is
 * that render's exactly.
 */
export function planChunks(numSamples, preRoll, latency, sampleRate, count, { runInS = DEFAULT_RUN_IN_S, grid = RENDER_BLOCK } = {}) {
  if (!(grid > 0) || grid % RENDER_BLOCK !== 0) {
    throw new Error(`chunk grid must be a multiple of ${RENDER_BLOCK}, got ${grid}`)
  }
  const pre = Math.round(runInS * sampleRate)
  const total = preRoll + numSamples + latency
  const chunks = []
  for (let k = 0; k < count; k++) {
    const start = Math.round((k * numSamples) / count)
    const end = Math.round(((k + 1) * numSamples) / count)
    const from = k === 0 ? 0 : Math.max(0, Math.floor((preRoll + start - pre) / grid) * grid)
    // ⚠ AND IT ENDS ON A WHOLE BLOCK. A chunk's last block would otherwise be
    // short where the continuous render's is full, and a kernel that resolves
    // anything per block (the HF Softener does) renders it differently: −101 dB
    // re the peak over the last second of every chunk, whatever the run-in.
    // `from` is on the grid, so rounding `to` up to a block keeps the blocks
    // the continuous render's; the last chunk ends where that render does.
    const to = Math.min(total, Math.ceil((preRoll + end + latency) / RENDER_BLOCK) * RENDER_BLOCK)
    chunks.push({ from, to, skip: preRoll + start - from, start, length: end - start })
  }
  return chunks
}
