import { getSegmentOutputEnd } from './operations.js'

/**
 * Peak envelope of the timeline over a span of seconds, one value per column.
 *
 * WHY A SCOPE NEEDS THIS. A live scope can only ever draw what has already gone
 * through the kernel, which puts "now" at the right-hand edge and every event on
 * a conveyor moving away from it. The Soft Clipper's scope centres the playhead
 * instead, and the right half of that face is audio that has not been processed
 * yet — so it cannot come from the effect. It comes from the timeline the
 * transport is about to play.
 *
 * READ FROM THE SEGMENTS, NOT FROM THE PEAK CACHE. The peak cache is built per
 * source buffer at a zoom-dependent resolution for painting the main waveform;
 * it is coarse, it is keyed to a resolution nobody here chose, and it is absent
 * until a render has happened. This walks the same segment list the transport
 * schedules from, so what the scope shows ahead of the playhead is exactly what
 * the transport is about to hand the effect — including silence segments, which
 * carry no buffer and correctly read as zero.
 *
 * The cost is a linear scan of the span per call: at the scope's window that is
 * ~2 s of samples per frame, a few tenths of a millisecond, against a canvas
 * that repaints anyway. `out` is reused across frames so the per-frame
 * allocation is one nothing.
 *
 * @param {Array} segments timeline segments, ordered by outputStart
 * @param {number} startSec timeline position of the first column
 * @param {number} seconds span covered by all columns together
 * @param {number} columns number of output values
 * @param {Float32Array} [out] reusable destination
 * @returns {Float32Array} peak absolute amplitude per column, 0 where silent or
 *   past the end of the timeline
 */
export function readTimelineEnvelope(segments, startSec, seconds, columns, out) {
  const res = out && out.length === columns ? out : new Float32Array(columns)
  res.fill(0)
  if (!segments?.length || !(seconds > 0) || columns <= 0) return res

  const step = seconds / columns
  // Columns advance monotonically, so the segment search does too — the cursor
  // is what keeps this linear in the span rather than quadratic in the timeline.
  let cursor = 0

  for (let c = 0; c < columns; c++) {
    const t0 = startSec + c * step
    const t1 = t0 + step
    while (cursor < segments.length && getSegmentOutputEnd(segments[cursor]) <= t0) cursor++
    if (cursor >= segments.length) break

    let peak = 0
    // A column can straddle a segment boundary, so this walks every segment it
    // touches rather than only the one it starts in.
    for (let j = cursor; j < segments.length; j++) {
      const seg = segments[j]
      if (seg.outputStart >= t1) break
      const buf = seg.sourceBuffer
      if (buf === null) continue

      const sr = buf.sampleRate
      const into = Math.max(0, t0 - seg.outputStart)
      const upto = Math.min(getSegmentOutputEnd(seg) - seg.outputStart, t1 - seg.outputStart)
      const i0 = Math.max(0, Math.floor((seg.sourceStart + into) * sr))
      const i1 = Math.min(buf.length, Math.ceil((seg.sourceStart + upto) * sr))

      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const data = buf.getChannelData(ch)
        for (let i = i0; i < i1; i++) {
          const a = data[i] < 0 ? -data[i] : data[i]
          if (a > peak) peak = a
        }
      }
    }
    res[c] = peak
  }

  return res
}
