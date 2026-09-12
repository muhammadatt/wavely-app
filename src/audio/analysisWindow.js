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
 * ⚠ THAT LAST SENTENCE IS NO LONGER TRUE OF TWO STAGES, AND THE ANCHORING IS
 * STILL RIGHT — the two facts belong together, because they arrived from
 * different branches and the first looks like it should undo the second.
 * `applyWorkletRegion` now takes an opt-in `preRollSamples`, and OptoSmooth and
 * Scheps ask for 2 s of it, so THEIR applied audio reaches the region with a
 * warm detector while this window still solves against a cold one. The warm
 * number is the correct one; this window's is the one that is off.
 *
 * Measured, warm-apply makeup minus cold-window makeup, by how far the material
 * DROPS in level across the region boundary (loud passage, then a quieter
 * selection — a warm detector enters that gain-reduced and a cold one does not):
 *
 *   drop across the edge    PR 40     PR 60     PR 75     PR 90
 *     0 dB (flat)          +0.011    +0.009    +0.002    +0.000
 *     6 dB                 +0.030    +0.010    +0.003    +0.000
 *    18 dB                 +0.341    +0.041    +0.020    +0.013
 *    25 dB                 +0.369    +0.584    +0.039    +0.024
 *   quieter before        <0.001    <0.001    <0.001    <0.001
 *
 * ⚠ THE AXIS IS THE LEVEL STEP, NOT THE COMPRESSION DEPTH, which is the
 * opposite of the centring bug above and the reason one is a report and this is
 * a footnote. That bug grew with depth and applied to every file; this needs a
 * loud passage butted directly against a much quieter selection, and is 0.03 dB
 * or less on anything gentler than a 6 dB step.
 *
 * ⚠ AND THE PERCENTILE REFERENCE DOES NOT RESCUE THIS ONE — worth stating
 * because the paragraph above says it rescued Scheps from the centring bug, and
 * the inference does not carry. Under a 25 dB step the percentile error (0.584
 * dB) is LARGER than the peak error (0.262), because the two failures are not
 * the same shape: a cold start mis-measures the first few milliseconds, which a
 * percentile ignores and a peak does not, whereas a warm detector enters a
 * quiet region compressed and holds the WHOLE opening down — a bulk shift, which
 * is exactly what a percentile does see. Immunity to one is not immunity to the
 * other.
 *
 * Left as it is rather than fixed: teaching this window about `preRollSamples`
 * means rendering the lead-in on every knob-drag measurement, which is the
 * latency this cap exists to bound, for a correction that is under 0.05 dB on
 * anything but a pathological edge. Pinned in
 * test/dsp/previewApplyConvergence.test.js so it cannot widen unnoticed.
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
  const full = Math.max(1, Math.round(sampleRate * ALIGN_BLOCK_MS / 1000))
  const total = Math.floor((end - start) * sampleRate)
  if (total < 1) return 0
  // ⚠ THE SHORT-REGION FALLBACK MUST MATCH `gatedRmsOfChannels`, and it did not.
  // This returned 0 — "no offset" — for anything under one block while the
  // materialised path fell back to measuring the whole thing as a single block,
  // so the two contracts disagreed for every valid short region. Worse, the
  // test suite PINNED the disagreement: `regionAlign.test.js` asserted the 0 and
  // `inputAlign.test.js` asserted the fallback, so the "two paths agree" claim
  // was tested everywhere except where it was false.
  const block = total >= full ? full : total
  const nBlocks = Math.floor(total / block)
  if (nBlocks < 1) return 0

  const blockRms = new Float64Array(nBlocks)
  // One block's worth of the MONO SUM, reused. Channels have to be summed per
  // sample before squaring — the kernel taps `(L + R) / nChannels`, so opposed
  // content cancels — which is why this accumulates a scratch block rather than
  // adding each channel's energy independently as an earlier version did.
  const mono = new Float64Array(block)

  for (let b = 0; b < nBlocks; b++) {
    mono.fill(0)
    const blockStart = b * block
    const blockEnd = blockStart + block
    // Seconds spanned by this block on the region's own timeline.
    const tStart = start + blockStart / sampleRate
    const tEnd = start + blockEnd / sampleRate

    for (const seg of segments) {
      const dur = getSegmentDuration(seg)
      const segEnd = seg.outputStart + dur
      if (segEnd <= tStart || seg.outputStart >= tEnd) continue
      if (seg.sourceBuffer === null) continue // silence: contributes zero

      const overlapStart = Math.max(tStart, seg.outputStart)
      const overlapEnd = Math.min(tEnd, segEnd)
      const sourceOffset = seg.sourceStart + (overlapStart - seg.outputStart)
      const sourceSampleStart = Math.floor(sourceOffset * sampleRate)
      const copySamples = Math.floor((overlapEnd - overlapStart) * sampleRate)
      // Where this overlap lands inside the block.
      const outBase = Math.floor((overlapStart - start) * sampleRate) - blockStart

      for (let ch = 0; ch < channels; ch++) {
        const srcData = seg.sourceBuffer.getChannelData(ch)
        const n = Math.min(copySamples, srcData.length - sourceSampleStart)
        for (let i = 0; i < n; i++) {
          const at = outBase + i
          if (at < 0 || at >= block) continue
          mono[at] += srcData[sourceSampleStart + i]
        }
      }
    }

    let sum = 0
    for (let i = 0; i < block; i++) {
      const v = mono[i] / channels
      sum += v * v
    }
    blockRms[b] = Math.sqrt(sum / block)
  }

  const gated = gatedRmsFromBlocks(blockRms)
  if (gated > 0) return alignDbForRms(gated)
  // Everything gated out — silence, or a region with no programme in it. Same
  // fallback the materialised path takes.
  let sum = 0
  for (let b = 0; b < nBlocks; b++) sum += blockRms[b] * blockRms[b]
  return alignDbForRms(Math.sqrt(sum / nBlocks))
}

/**
 * Was the whole region analysed, or only the worker's capped window?
 *
 * ⚠ THE CEILING'S KNEE IS ONLY TRUSTWORTHY WHEN THE ANSWER IS YES, and the
 * first version of this shipped without the check on a reasoning that was
 * wrong. The argument was that the span mismatch is safe because a whole-region
 * ceiling can only be HIGHER than the window's, making the true overshoot
 * smaller and the knee merely too wide. That is true of the CEILING and says
 * nothing about the other half: the knee is sized from the window's OUTPUT peak
 * as well, the compressor is stateful, and a transient outside the window can
 * overshoot by more than anything inside it. The subtraction can then return a
 * zero or near-zero width and hard-clamp material nobody measured.
 *
 * It never breaks the guarantee — `softCeiling` still bounds the output — so
 * the cost is a hard corner where a soft one was intended, which is precisely
 * what the knee exists to avoid.
 *
 * So: full region measured, use the measured width; capped window, fall back to
 * the conservative fixed one. Long selections keep exactly the behaviour they
 * have always had, and the recovery applies where it can be justified.
 */
export function analysedWholeRegion(start, end) {
  const { start: aStart, end: aEnd } = analysisWindow(start, end)
  return aStart <= start && aEnd >= end
}
