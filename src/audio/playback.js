import { getSegmentDuration } from './operations.js'
import { getEffectChainIfExists } from './effectChain.js'

/**
 * Playback engine using Web Audio API.
 * Schedules AudioBufferSourceNodes for each segment.
 *
 * Looping is scheduled against the audio clock, not driven from the animation
 * frame. The obvious implementation — notice in `tick()` that the end has gone
 * by, then start a fresh playback from `audioContext.currentTime` — cannot be
 * gapless, and the gap is not small: the frame that notices fires up to one
 * refresh interval *after* the end (~16.7 ms at 60 Hz, more under load), and the
 * nodes it then starts at `currentTime` only begin at the next render quantum on
 * top of that. Every loop pass therefore inserted a variable ~10–20 ms of
 * silence at the seam, which on a short region is a click and on a phrase is an
 * audible stumble.
 *
 * Instead the next pass is scheduled ahead of the boundary, at the exact context
 * time the current pass ends. The animation frame is left doing what it is
 * actually good for — moving the playhead — and never decides when audio
 * starts. The seam is then sample-accurate by construction, and the test suite
 * asserts it (`test/ui/playbackLoop.test.js`) rather than leaving it to the ear.
 */

// How far ahead of the loop seam the next pass is scheduled. Long enough to
// absorb a badly delayed animation frame, short enough that a loop toggled off
// mid-pass rarely has to cancel anything already scheduled.
const LOOP_LOOKAHEAD_SEC = 0.15

// Effects carrying a pre-rendered envelope are re-anchored on a shorter lead.
// Re-anchoring is destructive — it stops the pass that is still sounding at the
// boundary and points the effect's meter at the new pass — so the window where
// the meter reads the pass that has not started yet is kept to under two
// animation frames.
const TRANSPORT_LOOKAHEAD_SEC = 0.06

// { node, endsAt, pass } — endsAt is context time, used to drop finished nodes
// as loop passes accumulate; `pass` identifies which loop pass scheduled the
// node, so a pass scheduled into the lookahead window can be cancelled exactly.
let activeNodes = []
let playbackStartTime = 0   // context time at which the current pass began
let playbackOffset = 0      // timeline position at which the current pass began
let animationFrameId = null

// Loop bookkeeping. `loopFrom` is the timeline position each *repeat* starts
// from, which is not necessarily where the first pass started: playing a whole
// file from the middle loops back to zero, not back to the middle.
let loopEnabled = false
let loopFrom = 0
let passEnd = 0             // timeline position where every pass ends
let passEndsAt = 0          // context time of the current pass's end
let segmentsScheduled = false
let transportScheduled = false
let currentSegments = null
let currentContext = null
let passIndex = 0

/**
 * Schedule every audible segment of [from, to] to sound at context time `at`.
 * Returns nothing; nodes are pushed onto `activeNodes` with the context time
 * they finish, so finished ones can be dropped as passes accumulate.
 */
function scheduleSegments(segments, from, to, at, audioContext, pass) {
  for (const seg of segments) {
    const dur = getSegmentDuration(seg)
    const segEnd = seg.outputStart + dur

    // Skip segments entirely before the start or at/beyond the end
    if (segEnd <= from) continue
    if (seg.outputStart >= to) continue

    if (seg.sourceBuffer === null) {
      // Silence segment — don't schedule any node
      continue
    }

    const node = audioContext.createBufferSource()
    node.buffer = seg.sourceBuffer
    const chain = getEffectChainIfExists()
    node.connect(chain ? chain.getInputNode() : audioContext.destination)

    const scheduleAt = at + Math.max(0, seg.outputStart - from)
    // Starting in the middle of a segment reads into it by the same amount.
    const offset = seg.sourceStart + Math.max(0, from - seg.outputStart)
    // Clamp so this node plays neither before `from` nor past `to`.
    const playLen = Math.min(segEnd, to) - Math.max(seg.outputStart, from)
    if (playLen <= 0) continue

    // Disconnect on end rather than only when the tracking array is pruned:
    // a pass cancelled by setPlaybackLoop is stopped at a *future* time, so
    // there is no moment at which the caller can safely disconnect it, and the
    // pruning paths would otherwise drop the reference while the node is still
    // wired into the graph.
    node.onended = () => {
      try {
        node.disconnect()
      } catch {
        // Already disconnected.
      }
    }

    node.start(scheduleAt, offset, playLen)
    activeNodes.push({ node, endsAt: scheduleAt + playLen, pass })
  }
}

/**
 * Effects carrying a pre-rendered envelope schedule it against the same clock
 * as the segments above. They are given the timeline position rather than a
 * sample counter, so a seek is just a different `startTime` — nothing has to
 * track how many quanta have gone by.
 */
function scheduleTransport(at, from) {
  const chain = getEffectChainIfExists()
  if (!chain) return
  for (const entry of chain.effects) {
    if (entry.enabled) entry.nodes?.startTransport?.(at, from)
  }
}

function dropFinishedNodes(now) {
  if (activeNodes.length === 0) return
  activeNodes = activeNodes.filter(entry => {
    if (entry.endsAt > now) return true
    try {
      entry.node.disconnect()
    } catch {
      // Already gone.
    }
    return false
  })
}

/**
 * Stop every node matching `pred` at context time `at`, and pull its tracked
 * end back to match. The nodes stay tracked: they are still connected until
 * they actually stop, so dropping them here would leave the graph holding nodes
 * nothing has a reference to. Their `onended` frees them.
 */
function stopNodesAt(at, pred) {
  for (const entry of activeNodes) {
    if (!pred(entry)) continue
    if (entry.endsAt <= at) continue
    try {
      entry.node.stop(at)
    } catch {
      // Already stopped.
    }
    entry.endsAt = at
  }
}

/**
 * Undo a repeat already booked into the lookahead window. Stopping it at the
 * seam — its own start time — leaves the pass that is sounding untouched.
 */
function cancelScheduledPass() {
  if (segmentsScheduled) stopNodesAt(passEndsAt, entry => entry.pass > passIndex)
  segmentsScheduled = false
  transportScheduled = false
}

/**
 * Start of a fresh pass at context time `at`, cutting off whatever is sounding.
 * Used when the play position ends up outside the region — the only case where
 * a jump is the right answer, since there is no longer anything to play out.
 */
function restartPassAt(at) {
  stopNodesAt(at, () => true)
  passIndex += 1
  playbackStartTime = at
  playbackOffset = loopFrom
  passEndsAt = at + (passEnd - loopFrom)
  segmentsScheduled = false
  transportScheduled = false
  scheduleSegments(currentSegments, loopFrom, passEnd, at, currentContext, passIndex)
  scheduleTransport(at, loopFrom)
}

/**
 * Start playback from a given position.
 * @param {Array} segments - Timeline segments
 * @param {number} startTime - Position in seconds to start from
 * @param {AudioContext} audioContext
 * @param {Function} onTimeUpdate - Called each frame with current time
 * @param {Function} onEnd - Called when playback reaches end (never while looping)
 * @param {number|null} [endTime=null] - Position in seconds to stop at; null = play to end
 * @param {{ loop?: boolean, loopStart?: number|null }} [options] - `loopStart`
 *   is where a repeat begins, defaulting to `startTime`.
 */
export function startPlayback(
  segments, startTime, audioContext, onTimeUpdate, onEnd, endTime = null, options = {},
) {
  stopPlayback()

  const now = audioContext.currentTime
  playbackStartTime = now
  playbackOffset = startTime
  currentSegments = segments
  currentContext = audioContext

  let totalDuration = 0
  for (const seg of segments) {
    totalDuration += getSegmentDuration(seg)
  }

  passEnd = endTime !== null ? endTime : totalDuration
  loopFrom = options.loopStart ?? startTime
  // A zero-length repeat would schedule passes at the same instant forever.
  loopEnabled = !!options.loop && passEnd - loopFrom > 0
  passEndsAt = now + (passEnd - startTime)
  passIndex = 0
  segmentsScheduled = false
  transportScheduled = false

  scheduleSegments(segments, startTime, passEnd, now, audioContext, passIndex)
  scheduleTransport(now, startTime)

  // Animation loop for playhead updates
  function tick() {
    const now = audioContext.currentTime

    // Schedule the next pass before the seam arrives, so the boundary is
    // handled by the audio clock rather than by whenever this frame runs.
    if (loopEnabled && !segmentsScheduled && now >= passEndsAt - LOOP_LOOKAHEAD_SEC) {
      scheduleSegments(currentSegments, loopFrom, passEnd, passEndsAt, audioContext, passIndex + 1)
      segmentsScheduled = true
    }
    if (loopEnabled && !transportScheduled && now >= passEndsAt - TRANSPORT_LOOKAHEAD_SEC) {
      scheduleTransport(passEndsAt, loopFrom)
      transportScheduled = true
    }

    if (now >= passEndsAt) {
      if (!loopEnabled) {
        onTimeUpdate(passEnd)
        stopPlayback()
        if (onEnd) onEnd()
        return
      }
      // Roll the playhead's frame of reference onto the pass that is now
      // sounding. A `while` rather than an `if` because a backgrounded tab
      // stops delivering frames: audio runs on until the last scheduled pass
      // ends, and this catches the bookkeeping up on return.
      while (now >= passEndsAt) {
        playbackStartTime = passEndsAt
        playbackOffset = loopFrom
        passEndsAt += passEnd - loopFrom
        passIndex += 1
        segmentsScheduled = false
        transportScheduled = false
      }
      dropFinishedNodes(now)
    }

    onTimeUpdate(playbackOffset + (now - playbackStartTime))
    animationFrameId = requestAnimationFrame(tick)
  }

  animationFrameId = requestAnimationFrame(tick)
}

/**
 * Turn looping on or off without interrupting what is already sounding — the
 * loop button is live during playback.
 *
 * Turning it off has to undo any pass already scheduled into the lookahead
 * window, or playback would run one repeat past the click.
 */
export function setPlaybackLoop(enabled, loopStart = null) {
  if (!currentContext) return
  if (enabled) {
    if (loopStart !== null) loopFrom = loopStart
    loopEnabled = passEnd - loopFrom > 0
    return
  }
  loopEnabled = false
  // Otherwise playback would run one repeat past the click, since the next pass
  // may already be booked into the lookahead window. stopPlayback covers a
  // transport torn down before the cancelled nodes reach their own `onended`.
  cancelScheduledPass()
}

/**
 * Move the region being played (and looped) while it is sounding.
 *
 * Dragging the edge of a selection under a running loop has to change what the
 * loop plays *now* — waiting for the next play() means auditioning a boundary
 * by ear is a stop/adjust/start cycle per attempt, which is the whole reason
 * the edges are draggable in the first place.
 *
 * Everything here is expressed against the same audio clock the seam is, so
 * adjusting a region does not itself introduce a gap. Three cases:
 *
 * - **The end moved later.** The tail past the old end was never scheduled, so
 *   it is scheduled now, against the pass that is already sounding — its start
 *   time is the old end's context time, so it joins on sample-accurately.
 * - **The end moved earlier, but is still ahead of the play position.** The
 *   nodes sounding are stopped at the new end instead of the old one.
 * - **The end moved behind the play position.** There is nothing left of this
 *   pass to play out, so a looping transport wraps immediately and a
 *   non-looping one ends. This is the one case that jumps, and it jumps because
 *   the alternative is playing audio the user just excluded.
 *
 * A moved *start* needs none of that: it is where the next repeat begins, so it
 * takes effect at the seam like any other loop bookkeeping.
 */
export function setPlaybackRegion(regionStart, regionEnd) {
  if (!currentContext || !currentSegments) return
  // A zero-length or inverted region would schedule passes at the same instant
  // forever. Callers hand these over mid-drag, so ignoring them is routine.
  if (!(regionEnd > regionStart)) return

  const now = currentContext.currentTime
  const prevEnd = passEnd
  const prevEndsAt = passEndsAt

  // Any repeat already booked was booked against the old region.
  cancelScheduledPass()

  loopFrom = regionStart
  passEnd = regionEnd

  // Where the new end falls on the clock, in this pass's frame of reference.
  const endsAt = playbackStartTime + (passEnd - playbackOffset)

  // Past the end already — either the end was dragged behind the play position,
  // or the seam arrived between the last frame and this call, in which case the
  // pass being extended is no longer the pass that is sounding.
  if (endsAt <= now || now >= prevEndsAt) {
    if (loopEnabled) {
      restartPassAt(now)
      return
    }
    stopNodesAt(now, () => true)
    // tick() reports the end and tears the transport down on the next frame.
    passEndsAt = now
    return
  }

  if (passEnd > prevEnd) {
    scheduleSegments(currentSegments, prevEnd, passEnd, prevEndsAt, currentContext, passIndex)
  } else if (passEnd < prevEnd) {
    stopNodesAt(endsAt, entry => entry.pass <= passIndex)
  }
  passEndsAt = endsAt
}

/**
 * Stop all active playback.
 */
export function stopPlayback() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }

  // Envelope modulators are scheduled sources like any other, so they have to
  // be torn down with the segments — otherwise a stopped transport keeps
  // driving gain from a buffer that no longer lines up with anything.
  const transportChain = getEffectChainIfExists()
  if (transportChain) {
    for (const entry of transportChain.effects) entry.nodes?.stopTransport?.()
  }

  for (const entry of activeNodes) {
    try {
      entry.node.stop()
      entry.node.disconnect()
    } catch {
      // Node may already have stopped
    }
  }
  activeNodes = []
  passIndex = 0
  loopEnabled = false
  segmentsScheduled = false
  transportScheduled = false
  currentSegments = null
  currentContext = null
}

/**
 * Get the current playback time.
 */
export function getCurrentPlaybackTime(audioContext) {
  if (!audioContext || activeNodes.length === 0) return null
  return playbackOffset + (audioContext.currentTime - playbackStartTime)
}
