import { findSegmentAtTime } from './operations.js'

/**
 * Snap a timeline position to the nearest rising zero-crossing.
 *
 * ── WHY THIS IS ON BY DEFAULT ──────────────────────────────────────────────
 * Cutting a waveform anywhere other than a zero-crossing leaves a step
 * discontinuity at the seam, and a step is a click. On speech it is the single
 * most audible artefact a split can introduce, it survives every downstream
 * process, and — unlike most audio faults — it is completely avoidable by
 * moving the cut by a fraction of a millisecond. There is no case where a
 * narrator wants the click, so the toggle exists to be turned *off* (to place a
 * marker at an exact measured time), not on.
 *
 * ── RISING, NOT EITHER DIRECTION ───────────────────────────────────────────
 * Snapping both edges of a cut to *rising* crossings means the sample before
 * the cut and the sample after it are both near zero AND both heading the same
 * way, so the join is continuous in slope as well as in value. Snapping to the
 * nearest crossing of any direction makes the value continuous but can join a
 * rising edge to a falling one, which is a corner — quieter than a step, still
 * audible on a clean recording.
 *
 * Channel 0 only. On a stereo file the channels do not cross zero at the same
 * instant, so there is no position that satisfies both; picking one channel and
 * saying so beats averaging into a position that is a crossing of neither.
 */

/** How far either side of the requested time to look, in seconds. */
export const SNAP_WINDOW_SEC = 0.01

/**
 * @param {Array} segments - the timeline
 * @param {number} time - requested position, in seconds
 * @param {{ windowSec?: number }} [opts]
 * @returns {number} the snapped position, or `time` unchanged when there is
 *   nothing to snap to: no segment under it, a SilenceSegment (which is zero
 *   everywhere, so every sample is a crossing and none is meaningful), or no
 *   rising crossing within the window.
 */
export function snapToZeroCrossing(segments, time, { windowSec = SNAP_WINDOW_SEC } = {}) {
  const hit = findSegmentAtTime(segments, time)
  if (!hit) return time

  const seg = hit.segment
  const buf = seg.sourceBuffer
  if (!buf) return time

  const sr = buf.sampleRate
  const data = buf.getChannelData(0)

  // Search only within this segment's own slice of its source buffer. Beyond
  // those bounds is audio the timeline does not play, and snapping into it
  // would move the marker onto a crossing that isn't in the file.
  const lo = Math.max(0, Math.ceil(seg.sourceStart * sr))
  const hi = Math.min(data.length - 1, Math.floor(seg.sourceEnd * sr))
  if (hi - lo < 1) return time

  const centre = (seg.sourceStart + hit.localTime) * sr
  const radius = Math.round(windowSec * sr)
  const from = Math.max(lo, Math.floor(centre - radius))
  const to = Math.min(hi - 1, Math.ceil(centre + radius))

  let bestIdx = -1
  let bestDist = Infinity
  for (let i = from; i <= to; i++) {
    if (data[i] <= 0 && data[i + 1] > 0) {
      const d = Math.abs(i - centre)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
  }
  if (bestIdx < 0) return time

  // Interpolate between the two samples that straddle zero. Without this the
  // snap quantises to the sample grid, which at 44.1 kHz is 23 µs of residual
  // offset — inaudible on its own, but it is free to remove and it makes the
  // function's output independent of sample rate.
  const a = data[bestIdx]
  const b = data[bestIdx + 1]
  const frac = b === a ? 0 : -a / (b - a)
  const sourceTime = (bestIdx + frac) / sr

  return seg.outputStart + (sourceTime - seg.sourceStart)
}
