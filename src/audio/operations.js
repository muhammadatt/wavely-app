import { v4 as uuidv4 } from 'uuid'

/**
 * Recalculate outputStart for all segments from scratch.
 * MUST be called after every operation.
 */
export function recalcOutputStarts(segments) {
  let offset = 0
  for (const seg of segments) {
    seg.outputStart = offset
    offset += getSegmentDuration(seg)
  }
  return segments
}

/** Get the duration of a segment */
export function getSegmentDuration(seg) {
  if (seg.sourceBuffer === null) return seg.duration // SilenceSegment
  return seg.sourceEnd - seg.sourceStart
}

/** Get the outputEnd of a segment */
export function getSegmentOutputEnd(seg) {
  return seg.outputStart + getSegmentDuration(seg)
}

/** Get total timeline duration */
export function getTimelineDuration(segments) {
  if (segments.length === 0) return 0
  const last = segments[segments.length - 1]
  return last.outputStart + getSegmentDuration(last)
}

/**
 * Find which segment contains a given time position.
 * Returns { segment, index, localTime } or null.
 */
export function findSegmentAtTime(segments, time) {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const dur = getSegmentDuration(seg)
    if (time >= seg.outputStart && time < seg.outputStart + dur) {
      return {
        segment: seg,
        index: i,
        localTime: time - seg.outputStart,
      }
    }
  }
  return null
}

/**
 * Deep clone a segment array (for undo snapshots).
 * Does NOT clone AudioBuffer references — they are immutable.
 */
export function cloneSegments(segments) {
  return segments.map(seg => ({ ...seg }))
}

/**
 * Split the segment array at a specific timeline time.
 * Returns new segment array where the segment at that time
 * is split into two. If time falls on a boundary, no split occurs.
 */
export function splitSegmentsAtTime(segments, time) {
  const result = []
  for (const seg of segments) {
    const dur = getSegmentDuration(seg)
    const segEnd = seg.outputStart + dur

    if (time > seg.outputStart && time < segEnd) {
      const splitOffset = time - seg.outputStart

      if (seg.sourceBuffer === null) {
        // Silence segment
        result.push({
          id: uuidv4(),
          sourceBuffer: null,
          duration: splitOffset,
          outputStart: seg.outputStart,
        })
        result.push({
          id: uuidv4(),
          sourceBuffer: null,
          duration: dur - splitOffset,
          outputStart: time,
        })
      } else {
        // Audio segment
        result.push({
          id: uuidv4(),
          sourceBuffer: seg.sourceBuffer,
          sourceBufferId: seg.sourceBufferId,
          sourceStart: seg.sourceStart,
          sourceEnd: seg.sourceStart + splitOffset,
          outputStart: seg.outputStart,
        })
        result.push({
          id: uuidv4(),
          sourceBuffer: seg.sourceBuffer,
          sourceBufferId: seg.sourceBufferId,
          sourceStart: seg.sourceStart + splitOffset,
          sourceEnd: seg.sourceEnd,
          outputStart: time,
        })
      }
    } else {
      result.push({ ...seg })
    }
  }
  return result
}

/**
 * Delete a region [start, end) from the timeline.
 * Splits at both boundaries, removes middle segments, recalcs outputStart.
 */
export function deleteRegion(segments, start, end) {
  if (start >= end) return segments

  let result = splitSegmentsAtTime(segments, start)
  result = splitSegmentsAtTime(result, end)

  // Remove segments fully within [start, end)
  result = result.filter(seg => {
    const segEnd = seg.outputStart + getSegmentDuration(seg)
    const isInside = seg.outputStart >= start && segEnd <= end
    return !isInside
  })

  return recalcOutputStarts(result)
}

/**
 * Extract segments within a region [start, end) for clipboard use.
 * Returns a new array of cloned segments with outputStart recalculated
 * from zero so they can be re-inserted at any position via insertSegments.
 */
export function extractRegion(segments, start, end) {
  if (start >= end) return []

  let result = splitSegmentsAtTime(segments, start)
  result = splitSegmentsAtTime(result, end)

  // Keep only segments fully within [start, end)
  result = result.filter(seg => {
    const segEnd = seg.outputStart + getSegmentDuration(seg)
    return seg.outputStart >= start && segEnd <= end
  })

  return recalcOutputStarts(result)
}

/**
 * Trim to selection — keep only audio within [start, end).
 */
export function trimToSelection(segments, start, end) {
  if (start >= end) return segments

  let result = splitSegmentsAtTime(segments, start)
  result = splitSegmentsAtTime(result, end)

  result = result.filter(seg => {
    const segEnd = seg.outputStart + getSegmentDuration(seg)
    return seg.outputStart >= start && segEnd <= end
  })

  return recalcOutputStarts(result)
}

/**
 * Remove everything before the given time.
 */
export function trimBefore(segments, time) {
  let result = splitSegmentsAtTime(segments, time)
  result = result.filter(seg => seg.outputStart >= time)
  return recalcOutputStarts(result)
}

/**
 * Remove everything after the given time.
 */
export function trimAfter(segments, time) {
  let result = splitSegmentsAtTime(segments, time)
  result = result.filter(seg => {
    const segEnd = seg.outputStart + getSegmentDuration(seg)
    return segEnd <= time
  })
  return recalcOutputStarts(result)
}

/**
 * Silence a region [start, end) — replace with SilenceSegment of equal duration.
 */
export function silenceRegion(segments, start, end) {
  if (start >= end) return segments

  let result = splitSegmentsAtTime(segments, start)
  result = splitSegmentsAtTime(result, end)

  const silenceDuration = end - start
  const newResult = []

  let replaced = false
  for (const seg of result) {
    const segEnd = seg.outputStart + getSegmentDuration(seg)
    const isInside = seg.outputStart >= start && segEnd <= end

    if (isInside) {
      if (!replaced) {
        newResult.push({
          id: uuidv4(),
          sourceBuffer: null,
          duration: silenceDuration,
          outputStart: start,
        })
        replaced = true
      }
      // Skip remaining segments inside the region
    } else {
      newResult.push(seg)
    }
  }

  return recalcOutputStarts(newResult)
}

/**
 * Split at playhead position.
 */
export function splitAtPlayhead(segments, time) {
  const result = splitSegmentsAtTime(segments, time)
  return recalcOutputStarts(result)
}

/**
 * Insert clipboard segments at a given position.
 */
export function insertSegments(segments, position, clipboardSegments) {
  let result = splitSegmentsAtTime(segments, position)

  const before = result.filter(seg => {
    const segEnd = seg.outputStart + getSegmentDuration(seg)
    return segEnd <= position
  })
  const after = result.filter(seg => seg.outputStart >= position)

  const inserted = clipboardSegments.map(seg => ({ ...seg, id: uuidv4() }))

  return recalcOutputStarts([...before, ...inserted, ...after])
}

/**
 * Replace segments in a region [start, end) with a new segment
 * pointing to a processed buffer.
 */
export function replaceRegionWithBuffer(segments, start, end, newBuffer, newBufferId) {
  if (start >= end) return segments

  let result = splitSegmentsAtTime(segments, start)
  result = splitSegmentsAtTime(result, end)

  const newResult = []
  let replaced = false

  for (const seg of result) {
    const segEnd = seg.outputStart + getSegmentDuration(seg)
    const isInside = seg.outputStart >= start && segEnd <= end

    if (isInside) {
      if (!replaced) {
        newResult.push({
          id: uuidv4(),
          sourceBuffer: newBuffer,
          sourceBufferId: newBufferId,
          sourceStart: 0,
          sourceEnd: end - start,
          outputStart: start,
        })
        replaced = true
      }
    } else {
      newResult.push(seg)
    }
  }

  return recalcOutputStarts(newResult)
}
