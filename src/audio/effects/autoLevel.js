/**
 * Auto Leveler — real-time effect chain wrapper.
 *
 * NO WORKLET, AND NO DSP AT PLAY TIME, for the same reason as the clip-gain
 * de-esser: the gain curve is fully known before a sample is played. Where the
 * two differ is how the curve reaches the graph.
 *
 * THE DE-ESSER'S TRICK DOES NOT SCALE HERE. It renders its envelope into an
 * AudioBuffer and drives the gain AudioParam with it, which is exact and cheap
 * because a de-essed region is a selection of a few phrases. A leveler is used
 * on whole chapters — that is the point of it — and one Float32 per sample is
 * 317 MB for thirty minutes of mono at 44.1 kHz, plus as much again for the
 * AudioBuffer copy. On a file long enough to need levelling, the buffer
 * approach allocates more memory than the audio it is levelling.
 *
 * So the curve is SCHEDULED, not sampled. Gain is piecewise constant with 30 ms
 * cosine fades between clips, so the whole chapter is a few hundred automation
 * events: `setValueAtTime` for each hold, `setValueCurveAtTime` for each fade,
 * with the fade's curve handed over at one point per sample so Web Audio's
 * linear interpolation between points lands on the cosine exactly. Memory
 * scales with the number of phrases rather than the number of samples.
 *
 * PREVIEW AND APPLY ARE THE SAME CURVE BY CONSTRUCTION. Both read the segment
 * list out of solveAutoLevel — this module schedules it, dsp/autoLevel's
 * expandGainSegments expands it — so there is no second implementation of the
 * curve to drift. autoLevelSegments.test.js pins the two against each other.
 *
 * ABSOLUTE GAIN, NOT DEVIATION FROM UNITY. The de-esser's buffer holds
 * `envelope - 1` so that a moment with no modulator running is clean
 * pass-through rather than silence. Automation has no such failure mode: the
 * param holds its last scheduled value, and `stopTransport` cancels back to 1.
 */

import { createLevelTap } from './levelTap.js'
import { crossfadeWeight, gainDbAtSample } from '../dsp/autoLevel.js'

/**
 * Hard cap on points for one fade, in case a caller hands over a long ramp.
 *
 * A 30 ms fade needs 1324, so this is headroom rather than a real limit; past
 * it the curve is spread over fewer points and Web Audio's interpolation
 * between them is linear-in-gain rather than following the cosine exactly.
 */
const MAX_CURVE_POINTS = 8192

const dbToLin = db => Math.pow(10, db / 20)

/**
 * Render one ramp segment as the linear-gain curve `setValueCurveAtTime` wants.
 *
 * The weight function is the DSP module's, not a copy of it: the scheduled
 * fade and the rendered one have to be the same cosine, and two spellings of
 * `0.5 - 0.5cos(pi t)` in two files is precisely how that stops being true.
 *
 * Interpolation happens in dB and is converted to linear per point, which is
 * what expandGainSegments does. Interpolating linear gain directly would be a
 * different — and audibly duller — fade across a large step.
 */
export function renderRampCurve(segment, sampleRate) {
  const lengthSamples = segment.endSample - segment.startSample
  // ONE POINT PER SAMPLE BOUNDARY, WHICH IS lengthSamples + 1, NOT lengthSamples.
  // Web Audio spreads N curve points across the duration at intervals of
  // duration/(N-1) — the last point lands ON the end, not one step short of it.
  // With N = length + 1 the spacing is exactly one sample and point i sits on
  // sample startSample + i, so the scheduled curve and expandGainSegments read
  // the same phase. Using N = length instead stretches the cosine by one part
  // in `length`, which is inaudible and still wrong: it puts preview and apply
  // on curves that differ, which is the one property this design exists to have.
  const points = Math.min(MAX_CURVE_POINTS, Math.max(2, lengthSamples + 1))
  const denom = points - 1
  const curve = new Float32Array(points)
  for (let i = 0; i < points; i++) {
    const w = crossfadeWeight(i / denom)
    curve[i] = dbToLin(segment.fromDb * (1 - w) + segment.toDb * w)
  }
  return curve
}

export function createAutoLeveler(audioContext) {
  const input = audioContext.createGain()
  const gainNode = audioContext.createGain()
  const output = audioContext.createGain()

  gainNode.gain.value = 1
  input.connect(gainNode)
  gainNode.connect(output)

  let destroyed = false

  /** The solved curve: segment list plus where on the timeline it starts. */
  let segments = null
  let regionStartSec = 0
  let curveSampleRate = audioContext.sampleRate

  // Transport anchor, so getGainDb() can read the curve at the position that is
  // actually sounding rather than the one being scheduled.
  let transportWhen = 0
  let transportStartSec = 0
  let running = false

  function cancelAutomation() {
    const now = audioContext.currentTime
    try {
      gainNode.gain.cancelScheduledValues(now)
    } catch {
      // Nothing scheduled.
    }
    gainNode.gain.value = 1
  }

  function stopTransport() {
    running = false
    if (destroyed) return
    cancelAutomation()
  }

  /**
   * Schedule the curve against a playback starting at `startSec` on the
   * timeline and sounding from context time `when`.
   *
   * Everything before `startSec` is skipped; the value in force at that point
   * is set at `when` so a seek into the middle of a phrase starts at that
   * phrase's gain rather than ramping into it from unity.
   */
  function startTransport(when, startSec) {
    stopTransport()
    if (destroyed || !segments?.length) return

    const param = gainNode.gain
    const regionEndSec = regionStartSec + lastSample() / curveSampleRate
    if (startSec >= regionEndSec) return   // region already behind the playhead

    // Context time for a timeline position, and its inverse for the region.
    const ctxTimeForSample = s =>
      when + (regionStartSec + s / curveSampleRate - startSec)

    // Where playback enters the region, in region samples. Negative when
    // playback starts before the region — then the region's own head is used.
    const entrySample = Math.max(
      0, Math.round((startSec - regionStartSec) * curveSampleRate),
    )

    param.setValueAtTime(dbToLin(gainDbAtSample(segments, entrySample)), when)

    for (const seg of segments) {
      if (seg.endSample <= entrySample) continue      // already behind us

      const at = ctxTimeForSample(seg.startSample)

      if (seg.fromDb === seg.toDb) {
        // A hold that started before entry is already covered by the
        // setValueAtTime above; only schedule holds that begin ahead.
        if (at > when) param.setValueAtTime(dbToLin(seg.fromDb), at)
        continue
      }

      if (at <= when) {
        // Seeking into the middle of a 30 ms fade. A curve cannot be started in
        // the past, so the entry value already holds and the fade's endpoint is
        // set where it lands — 30 ms of a fade replaced by its destination,
        // once, only when the playhead is dropped inside one.
        const end = ctxTimeForSample(seg.endSample)
        if (end > when) param.setValueAtTime(dbToLin(seg.toDb), end)
        continue
      }

      param.setValueCurveAtTime(
        renderRampCurve(seg, curveSampleRate),
        at,
        (seg.endSample - seg.startSample) / curveSampleRate,
      )
    }

    transportWhen = when
    transportStartSec = Math.max(startSec, regionStartSec)
    running = true
  }

  function lastSample() {
    return segments?.length ? segments[segments.length - 1].endSample : 0
  }

  const inputMonitor = audioContext.createGain()
  input.connect(inputMonitor)
  const outputMonitor = audioContext.createGain()
  gainNode.connect(outputMonitor)

  const inputTap = createLevelTap(audioContext, inputMonitor)
  const outputTap = createLevelTap(audioContext, outputMonitor)

  return {
    input,
    output,
    startTransport,
    stopTransport,

    setParam(name, value) {
      if (name !== 'curve') return
      // { segments, startSec, sampleRate } — or null to clear.
      stopTransport()
      if (!value?.segments?.length) {
        segments = null
        return
      }
      segments = value.segments
      regionStartSec = value.startSec ?? 0
      curveSampleRate = value.sampleRate ?? audioContext.sampleRate
    },

    getParam(name) {
      if (name === 'curve') return segments
      return undefined
    },

    /**
     * SIGNED gain at the playhead, in dB — not a reduction.
     *
     * A leveler's boosts are the point of it: reporting only the cuts, as the
     * compressors' `getReduction` convention does, would leave the meter at
     * rest through exactly the passages the user reached for this to fix.
     *
     * Read from the curve rather than measured from the signal. The curve IS
     * the gain, so this is exact, and unlike a level difference it cannot be
     * confused by the audio's own dynamics.
     */
    getGainDb() {
      if (!running || !segments) return 0

      // currentTime is the scheduler's clock: audio scheduled for it has not
      // been heard yet. Backing off by the device latency reports the curve at
      // the position actually sounding.
      const latency = (audioContext.outputLatency || 0) + (audioContext.baseLatency || 0)
      const elapsed = audioContext.currentTime - transportWhen - latency
      if (elapsed < 0) return 0

      const posSec = transportStartSec - regionStartSec + elapsed
      const idx = Math.round(posSec * curveSampleRate)
      if (idx < 0 || idx >= lastSample()) return 0
      return gainDbAtSample(segments, idx)
    },

    getInputLevels(channelCount) {
      return inputTap.getLevels(channelCount)
    },

    getOutputLevels(channelCount) {
      return outputTap.getLevels(channelCount)
    },

    destroy() {
      destroyed = true
      running = false
      try {
        gainNode.gain.cancelScheduledValues(audioContext.currentTime)
      } catch {
        // Context already closed.
      }
      input.disconnect()
      gainNode.disconnect()
      output.disconnect()
      inputMonitor.disconnect()
      outputMonitor.disconnect()
      inputTap.destroy()
      outputTap.destroy()
    },
  }
}

export const autoLevelerEffect = {
  id: 'auto-leveler',
  name: 'Auto Leveler',
  latencySamples: 0,
  createNodes(audioContext) {
    return createAutoLeveler(audioContext)
  },
}
