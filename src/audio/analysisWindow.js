import { getSegmentDuration } from './operations.js'
import {
  ALIGN_BLOCK_MS, alignDbForRms, gatedRmsFromBlocks,
} from './dsp/inputAlign.js'

/**
 * How much of a region the measured-parameter paths analyse, and from where.
 *
 * ⚠ SPLIT OUT OF processing.js SO IT CAN BE IMPORTED UNDER NODE. That file
 * pulls Vite `?worker&url` specifiers which only the bundler resolves, so
 * nothing in it is reachable from `node --test` — and the arithmetic here is
 * exactly the kind that fails silently and expensively. Same reasoning, and
 * the same remedy, as effects/softClipperParams.js.
 */

/**
 * Cap on how much audio one measurement pass renders, in seconds.
 *
 * It exists for knob latency, not for accuracy: the whole 35.5 s reference file
 * measures in ~230 ms, so a long selection has to be bounded or a drag stalls.
 */
export const AUTO_MAKEUP_MAX_ANALYSIS_S = 30

/**
 * Which slice of a region to measure, when the region is longer than the cap.
 *
 * ⚠ ANCHORED AT THE REGION'S START. IT WAS CENTRED, AND CENTRING WAS A BUG THAT
 * COST UP TO 7.9 dB OF MAKEUP.
 *
 * Reported from use: a file peak-normalised to −1 dBFS came out of FET Punch on
 * the stock Vocal Punch preset at −3.14 dBFS — compressed, and looking as
 * though no makeup had been applied. It had: 8.10 dB of it, against the 10.25
 * a whole-file measurement asks for.
 *
 * THE MECHANISM IS A COLD DETECTOR, and it bites precisely because the makeup
 * is PEAK-referenced. A centred window renders an excerpt starting in the
 * MIDDLE of speech with the compressor's envelope at zero, so the first
 * milliseconds pass essentially uncompressed: measured on the reported file,
 * the excerpt's output peak is −9.57 dBFS **1 ms in**, where the same span
 * taken from a whole-file render peaks at −11.24. Discard 50 ms of the excerpt
 * and the two agree exactly. One cold-start sample sets the peak reference, and
 * `makeup = inputPeak / outputPeak` is then short by the whole difference.
 *
 * ⚠ THE PREMISE THE CENTRING RESTED ON WAS STALE, and that is the reusable
 * lesson. The comment above this used to read "the RMS ratio is stable across a
 * representative stretch" — true, and written when the makeup was RMS-
 * referenced. A single cold-start sample cannot move an RMS; it entirely
 * determines a peak. The measurement's reference changed and the sampling
 * strategy that served it did not.
 *
 * ANCHORING AT THE START IS RIGHT RATHER THAN MERELY BETTER: the apply path
 * renders the whole selection with a cold detector from the selection's start,
 * so a window taken from the start reproduces the cold start the applied audio
 * actually has, instead of manufacturing one mid-phrase.
 *
 * Measured on the reported file, makeup error against a whole-file measurement:
 *
 *                        centred (was)      from the start (now)
 *   FET Punch drive 30     −0.02 dB              0.00 dB
 *   FET Punch drive 55     −2.15                 0.00     <- the report
 *   FET Punch drive 80     −4.67                 0.00
 *   OptoSmooth PR 60       −5.57                 0.00
 *   OptoSmooth PR 75       −7.85                 0.00
 *
 * ⚠ THE ERROR GREW WITH DEPTH, WHICH IS THE SECOND HALF OF THE REPORT. The
 * cold-start transient escapes compression whatever the setting, so the harder
 * the compressor is driven the further the measured output peak sits above the
 * real one. Across FET Punch's Input knob the shipped measurement travelled
 * 13.81 → 2.40 dB where the truth travels 13.83 → 7.07 — so the makeup did
 * respond to the knob, in the wrong proportion and worst where the compressor
 * works hardest. That is what "makeup does not update in response to input
 * level" looks like from the outside.
 *
 * ⚠ SCHEPS AND THE SOFT CLIPPER WERE NEVER AFFECTED, and why is worth keeping.
 * Scheps references the 95th percentile of 100 ms blocks, which one cold block
 * cannot move (measured error 0.03 dB); the soft clipper's peak control is
 * memoryless with a fixed ceiling, so it has no detector to start cold (0.00).
 * The exposure is exactly the peak-referenced measurements with a stateful
 * detector behind them.
 *
 * ⚠ WHAT IS STILL APPROXIMATE: a peak later in the region than the cap is not
 * seen, so on a selection longer than AUTO_MAKEUP_MAX_ANALYSIS_S the makeup can
 * still be a little generous. That is inherent to capping a measurement of an
 * extremum — a peak is not a quantity a representative excerpt can report — and
 * it is now the only approximation left here. Raising the cap trades directly
 * against knob latency: the whole 35.5 s file measures in ~230 ms.
 *
 * @returns {{start: number, end: number}} The span to render and measure.
 */
export function analysisWindow(start, end, maxSeconds = AUTO_MAKEUP_MAX_ANALYSIS_S) {
  if (!(end - start > maxSeconds)) return { start, end }
  return { start, end: start + maxSeconds }
}

/**
 * The peak sample magnitude of a region, in dBFS, WITHOUT rendering it.
 *
 * Mirrors `renderRegionToBuffer`'s segment walk exactly — that function is a
 * straight copy with no per-segment gain, so scanning the same ranges gives the
 * same answer — but tracks a maximum instead of allocating. An hour of audio
 * costs a read of every sample and not one byte of buffer.
 *
 * ⚠ IT MUST SEE THE WHOLE REGION, WHICH IS WHY IT IS NOT A WORKER MEASUREMENT.
 * Every measured parameter here goes through `measureInWorker`, which caps the
 * pass at AUTO_MAKEUP_MAX_ANALYSIS_S anchored at the region's start. That cap
 * is right for a solve that has to sit behind a knob drag, and it is WRONG for
 * a ceiling: on a region longer than the cap the loudest moment is routinely
 * outside the window, and a ceiling set from an excerpt would clamp everything
 * after it — the whole back half of a take limited to a level the front half
 * happened to reach. Cheap enough that it does not need the cap.
 *
 * Returns -Infinity for an empty or silent region, which callers read as
 * "no ceiling to set".
 */
export function regionPeakDb(segments, start, end, sampleRate, channels) {
  let peak = 0
  for (const seg of segments) {
    const dur = getSegmentDuration(seg)
    const segEnd = seg.outputStart + dur
    if (segEnd <= start || seg.outputStart >= end) continue
    if (seg.sourceBuffer === null) continue // silence

    const overlapStart = Math.max(start, seg.outputStart)
    const overlapEnd = Math.min(end, segEnd)
    const sourceOffset = seg.sourceStart + (overlapStart - seg.outputStart)
    const sourceSampleStart = Math.floor(sourceOffset * sampleRate)
    const copySamples = Math.floor((overlapEnd - overlapStart) * sampleRate)

    for (let ch = 0; ch < channels; ch++) {
      const srcData = seg.sourceBuffer.getChannelData(ch)
      const n = Math.min(copySamples, srcData.length - sourceSampleStart)
      for (let i = 0; i < n; i++) {
        const v = srcData[sourceSampleStart + i]
        const a = v < 0 ? -v : v
        if (a > peak) peak = a
      }
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity
}

/**
 * The side-chain drive offset that brings a region to nominal, dB.
 *
 * ⚠ IT MUST SEE THE WHOLE FILE, AND FOR A DIFFERENT REASON THAN `regionPeakDb`.
 * The ceiling needs the whole region because the loudest moment can be
 * anywhere; alignment needs it because a per-selection offset would make the
 * plugin a different compressor on every selection. Compress a phrase, then
 * compress the paragraph containing it, and the phrase would come out
 * differently the second time — the same edit applied twice, disagreeing with
 * itself. Callers pass 0..totalDuration REGARDLESS of the selection, and that
 * is the one thing about this function a caller can get wrong.
 *
 * Mirrors `regionPeakDb`'s segment walk, with two differences that matter:
 * blocks are indexed in OUTPUT time so they stay aligned across segment
 * boundaries, and samples covered by no segment (silence segments, gaps)
 * contribute zero energy rather than being skipped — a block half silence and
 * half programme has to read as half as loud, or the gate sees the wrong level
 * exactly where an edit put a cut.
 *
 * Returns 0 for an empty or silent region, which is "no offset", not "unknown".
 */
export function regionAlignDb(segments, start, end, sampleRate, channels) {
  const block = Math.max(1, Math.round(sampleRate * ALIGN_BLOCK_MS / 1000))
  const total = Math.floor((end - start) * sampleRate)
  const nBlocks = Math.floor(total / block)
  if (nBlocks < 1) return 0

  // Sum of squares per block, over every channel.
  const energy = new Float64Array(nBlocks)

  for (const seg of segments) {
    const dur = getSegmentDuration(seg)
    const segEnd = seg.outputStart + dur
    if (segEnd <= start || seg.outputStart >= end) continue
    if (seg.sourceBuffer === null) continue // silence: contributes zero energy

    const overlapStart = Math.max(start, seg.outputStart)
    const overlapEnd = Math.min(end, segEnd)
    const sourceOffset = seg.sourceStart + (overlapStart - seg.outputStart)
    const sourceSampleStart = Math.floor(sourceOffset * sampleRate)
    const copySamples = Math.floor((overlapEnd - overlapStart) * sampleRate)
    // Where this segment lands on the region's own timeline, in samples. The
    // block index comes from here rather than from the segment, so a cut does
    // not shift every block after it.
    const outBase = Math.floor((overlapStart - start) * sampleRate)

    for (let ch = 0; ch < channels; ch++) {
      const srcData = seg.sourceBuffer.getChannelData(ch)
      const n = Math.min(copySamples, srcData.length - sourceSampleStart)
      for (let i = 0; i < n; i++) {
        const b = ((outBase + i) / block) | 0
        if (b >= nBlocks) break
        const v = srcData[sourceSampleStart + i]
        energy[b] += v * v
      }
    }
  }

  // Every block spans the same sample count, so one divisor converts the lot.
  const per = block * channels
  for (let b = 0; b < nBlocks; b++) energy[b] = Math.sqrt(energy[b] / per)

  return alignDbForRms(gatedRmsFromBlocks(energy))
}
