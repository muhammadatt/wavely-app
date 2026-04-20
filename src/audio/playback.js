import { getSegmentDuration } from './operations.js'

/**
 * Playback engine using Web Audio API.
 * Schedules AudioBufferSourceNodes for each segment.
 */

let activeNodes = []
let playbackStartTime = 0
let playbackOffset = 0
let animationFrameId = null

/**
 * Start playback from a given position.
 * @param {Array} segments - Timeline segments
 * @param {number} startTime - Position in seconds to start from
 * @param {AudioContext} audioContext
 * @param {Function} onTimeUpdate - Called each frame with current time
 * @param {Function} onEnd - Called when playback reaches end
 * @param {number|null} [endTime=null] - Position in seconds to stop at; null = play to end
 */
export function startPlayback(segments, startTime, audioContext, onTimeUpdate, onEnd, endTime = null) {
  stopPlayback()

  const now = audioContext.currentTime
  playbackStartTime = now
  playbackOffset = startTime

  let totalDuration = 0
  for (const seg of segments) {
    totalDuration += getSegmentDuration(seg)
  }

  // Schedule each segment
  for (const seg of segments) {
    const dur = getSegmentDuration(seg)
    const segEnd = seg.outputStart + dur

    // Skip segments entirely before the start or at/beyond endTime
    if (segEnd <= startTime) continue
    if (endTime !== null && seg.outputStart >= endTime) continue

    if (seg.sourceBuffer === null) {
      // Silence segment — don't schedule any node
      continue
    }

    const node = audioContext.createBufferSource()
    node.buffer = seg.sourceBuffer
    node.connect(audioContext.destination)

    const scheduleAt = now + Math.max(0, seg.outputStart - startTime)
    let offset = seg.sourceStart
    let playLen = dur

    if (startTime > seg.outputStart) {
      // Starting in the middle of this segment
      const skipAmount = startTime - seg.outputStart
      offset = seg.sourceStart + skipAmount
      playLen = dur - skipAmount
    }

    // Clamp playLen so this node doesn't play past endTime
    if (endTime !== null) {
      const segEffectiveStart = Math.max(seg.outputStart, startTime)
      playLen = Math.min(segEnd, endTime) - segEffectiveStart
    }

    node.start(scheduleAt, offset, playLen)
    activeNodes.push(node)
  }

  const playEnd = endTime !== null ? endTime : totalDuration

  // Animation loop for playhead updates
  function tick() {
    const currentTime = playbackOffset + (audioContext.currentTime - playbackStartTime)

    if (currentTime >= playEnd) {
      onTimeUpdate(playEnd)
      stopPlayback()
      if (onEnd) onEnd()
      return
    }

    onTimeUpdate(currentTime)
    animationFrameId = requestAnimationFrame(tick)
  }

  animationFrameId = requestAnimationFrame(tick)
}

/**
 * Stop all active playback.
 */
export function stopPlayback() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }

  for (const node of activeNodes) {
    try {
      node.stop()
      node.disconnect()
    } catch {
      // Node may already have stopped
    }
  }
  activeNodes = []
}

/**
 * Get the current playback time.
 */
export function getCurrentPlaybackTime(audioContext) {
  if (!audioContext || activeNodes.length === 0) return null
  return playbackOffset + (audioContext.currentTime - playbackStartTime)
}
