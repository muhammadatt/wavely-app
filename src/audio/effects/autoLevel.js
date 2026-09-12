/**
 * Auto Level — real-time effect chain wrapper.
 *
 * NO WORKLET, AND NO DSP AT PLAY TIME — the same arrangement `clipGainDeEss.js`
 * uses, for the same reason. The gain is fully known before a sample is played:
 * `dsp/autoLevel.js` segments the file into voiced clips and solves one flat
 * gain per clip offline. So the envelope is rendered into an AudioBuffer and
 * used to drive a GainNode's `gain` AudioParam directly. Latency is zero, and
 * the offline apply path multiplies the same numbers into the same samples.
 *
 * ⚠ THE BUFFER HOLDS DEVIATION FROM UNITY, NOT THE ENVELOPE ITSELF. An
 * AudioParam SUMS its intrinsic value with whatever is connected to it, so with
 * `gain.value = 1` and a buffer of `envelope - 1` the result is `envelope`. The
 * obvious alternative — `gain.value = 0` and a buffer of the envelope — is the
 * same arithmetic with a far worse failure mode: any moment with no modulator
 * running (before playback, after the buffer ends, between seeks) would be
 * silence rather than clean pass-through.
 *
 * ⚠ THE ENVELOPE IS REGION-SCOPED THOUGH THE ANALYSIS IS WHOLE-FILE, and the
 * two must not be confused. `analyzeAutoLevel` measures the whole timeline
 * because clip targets are a running median over neighbours — analysing only a
 * selection would give one answer for a phrase and another for the paragraph
 * containing it. But the BUFFER covers only the region being previewed: a
 * whole-timeline buffer is 635 MB of Float32 for a one-hour chapter.
 * `renderAutoLevelGainDb` takes an absolute start sample so the two can differ.
 */

import { createLevelTap } from './levelTap.js'
import { scheduleEnvelope } from './envelopeSchedule.js'

export function createAutoLevel(audioContext) {
  const input = audioContext.createGain()
  const gainNode = audioContext.createGain()
  const output = audioContext.createGain()

  // Unity intrinsic value: with no modulator connected this is a straight wire.
  gainNode.gain.value = 1
  input.connect(gainNode)
  gainNode.connect(output)

  let destroyed = false
  let envelopeBuffer = null
  let envelopeDeviation = null
  let regionStartSec = 0
  let modulator = null

  // Transport anchor, so getGainDb() can read the envelope at the position that
  // is actually sounding rather than at the scheduler's clock.
  let transportWhen = 0
  let transportStartSec = 0
  let running = false
  let lastReadIdx = -1

  /**
   * Stop the scheduled envelope. `when` is a context time to stop *at*, which is
   * what makes a gapless loop possible: the next pass is booked slightly ahead
   * of the seam, and the pass still sounding has to run TO the seam rather than
   * be cut off the moment its replacement is scheduled.
   */
  function stopTransport(when) {
    lastReadIdx = -1
    if (!modulator) return
    const node = modulator
    try {
      if (when !== undefined && when > audioContext.currentTime) {
        // Left connected deliberately — it is still sounding until `when`.
        node.stop(when)
      } else {
        node.stop()
        node.disconnect()
      }
    } catch {
      // Already stopped — starting and stopping in the same tick is normal.
    }
    modulator = null
    running = false
  }

  function startTransport(when, startSec) {
    stopTransport(when)
    if (destroyed || !envelopeBuffer) return

    const plan = scheduleEnvelope({
      regionStartSec,
      durationSec: envelopeBuffer.duration,
      when,
      startSec,
    })
    if (plan === null) return

    modulator = audioContext.createBufferSource()
    modulator.buffer = envelopeBuffer
    modulator.connect(gainNode.gain)
    // The disconnect is unconditional: an outgoing modulator is stopped at a
    // FUTURE time, so this is the only point at which it can be freed. The
    // `running` flag is guarded on identity so the outgoing pass cannot clear
    // it for the one that has already replaced it.
    const node = modulator
    node.onended = () => {
      if (modulator === node) running = false
      try {
        node.disconnect()
      } catch {
        // Already disconnected by the immediate stop path.
      }
    }
    modulator.start(plan.at, plan.offset)

    transportWhen = plan.at
    transportStartSec = plan.transportStartSec
    running = true
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
      if (name !== 'envelope') return
      // { deviation: Float32Array, startSec: number } — or null to clear.
      stopTransport()
      if (!value || !value.deviation?.length) {
        envelopeBuffer = null
        envelopeDeviation = null
        return
      }
      const buf = audioContext.createBuffer(
        1, value.deviation.length, audioContext.sampleRate,
      )
      buf.copyToChannel(value.deviation, 0)
      envelopeBuffer = buf
      envelopeDeviation = value.deviation
      regionStartSec = value.startSec ?? 0
    },

    getParam(name) {
      return name === 'envelope' ? envelopeDeviation : undefined
    },

    /**
     * The gain currently being applied, in dB — signed, and that is the point.
     *
     * ⚠ IT IS NOT A GAIN-REDUCTION METER AND MUST NOT BE RENDERED AS ONE. Every
     * other effect here reports `getReduction()`, a negative number, because
     * every other effect only ever attenuates. A leveller's whole job is to
     * raise quiet passages as well as lower loud ones, so a meter that can only
     * point one way would hide half of what it does — and the half a user is
     * most likely to be checking, since lifting a quiet clip is what risks
     * lifting its room tone with it.
     *
     * Read straight out of the envelope rather than measured from the signal:
     * the envelope IS the gain, so this is exact.
     *
     * ⚠ THE LARGEST-MAGNITUDE VALUE OVER THE SPAN SINCE THE LAST CALL, not a
     * point sample. This is polled from an animation frame — one look every
     * ~16.7 ms — and a crossfade is 30 ms, so point sampling lands inside a
     * transition often enough to make the readout flicker between two clips'
     * values. Scanning the elapsed span costs one walk over a frame of samples.
     *
     * Note this is a getter with state: each call consumes the span it reports.
     */
    getGainDb() {
      if (!running || !envelopeDeviation) return 0

      // currentTime is the scheduler's clock: audio scheduled for it has not
      // been heard yet. Backing off by the device latency reports the envelope
      // at the position actually sounding.
      const latency = (audioContext.outputLatency || 0) + (audioContext.baseLatency || 0)
      const elapsed = audioContext.currentTime - transportWhen - latency
      if (elapsed < 0) return 0

      const len = envelopeDeviation.length
      if (lastReadIdx >= len) return 0 // envelope already fully consumed

      const posSec = transportStartSec - regionStartSec + elapsed
      const idx = Math.round(posSec * audioContext.sampleRate)
      if (idx < 0) return 0

      const to = Math.min(idx, len - 1)
      const from = lastReadIdx < 0 || lastReadIdx > to ? to : lastReadIdx
      if (to < from) return 0
      lastReadIdx = to + 1

      let extreme = 0
      for (let i = from; i <= to; i++) {
        if (Math.abs(envelopeDeviation[i]) > Math.abs(extreme)) extreme = envelopeDeviation[i]
      }
      const gain = 1 + extreme
      return gain > 0 ? 20 * Math.log10(gain) : 0
    },

    getInputLevels(channelCount) {
      return inputTap.getLevels(channelCount)
    },

    getOutputLevels(channelCount) {
      return outputTap.getLevels(channelCount)
    },

    destroy() {
      destroyed = true
      stopTransport()
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

export const autoLevelEffect = {
  id: 'auto-level',
  name: 'Auto Level',
  latencySamples: 0,
  createNodes(audioContext) {
    return createAutoLevel(audioContext)
  },
}
