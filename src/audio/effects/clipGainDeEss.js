/**
 * Clip-Gain De-Esser — real-time effect chain wrapper.
 *
 * NO WORKLET, AND NO DSP AT PLAY TIME. The gain envelope is fully known before
 * a sample is played: sibilance detection ran server-side, and the per-event
 * gain is a pure function of two frozen measurements (see dsp/clipGainDecision).
 * So the envelope is rendered into an AudioBuffer and used to drive a GainNode's
 * `gain` AudioParam directly. Verified sample-exact against direct
 * multiplication — a 1000-sample dip lands on exactly the 1000 samples it
 * should, with zero error.
 *
 * That beats the position-aware worklet this was originally planned as. A
 * worklet counting render quanta has no way to know its absolute position in
 * the timeline, so it needs transport messages and drifts on every seek. Here
 * the modulator is just another scheduled source: it is started with the same
 * `when`/`offset` arithmetic as the audio, so alignment is a property of the
 * construction rather than something to maintain. Latency is zero, and the
 * offline apply path builds the identical graph.
 *
 * THE BUFFER HOLDS DEVIATION FROM UNITY, NOT THE ENVELOPE ITSELF. An AudioParam
 * sums its intrinsic value with whatever is connected to it, so with
 * `gain.value = 1` and a buffer of `envelope - 1` the result is `envelope`. The
 * obvious alternative — `gain.value = 0` and a buffer of the envelope — is the
 * same arithmetic with a far worse failure mode: any moment with no modulator
 * running (before playback, after the buffer ends, between seeks) would be
 * silence rather than clean pass-through.
 */

import { createLevelTap } from './levelTap.js'
import { buildClipGainEnvelope } from '../dsp/clipGainEnvelope.js'
import { decideClipGains } from '../dsp/clipGainDecision.js'

export const DEESSER_DEFAULTS = {
  stridentCeilingDb: 6.0,
  nonStridentCeilingDb: -4.0,
  reductionRatio: 0.5,
  maxReductionDb: 8.0,
  fricativeInMs: 3.0,
  fricativeOutMs: 4.0,
  affricateInMs: 1.5,
  affricateOutMs: 4.5,
}

/** Split UI params into the decision half and the fade half. */
export function toDecisionParams(p) {
  return {
    stridentCeilingDb: p.stridentCeilingDb,
    nonStridentCeilingDb: p.nonStridentCeilingDb,
    reductionRatio: p.reductionRatio,
    maxReductionDb: p.maxReductionDb,
  }
}

export function toFadeParams(p) {
  return {
    fricativeInMs: p.fricativeInMs,
    fricativeOutMs: p.fricativeOutMs,
    affricateInMs: p.affricateInMs,
    affricateOutMs: p.affricateOutMs,
  }
}

/**
 * Render the deviation-from-unity envelope for a region.
 *
 * @param {Array}  measuredEvents  from the sibilance analysis, offsets relative
 *                                 to the region start and already rescaled to
 *                                 this sample rate
 * @param {number} numSamples      length of the analysed region
 * @param {number} sampleRate
 * @param {object} params
 * @returns {{ deviation: Float32Array, treatedCount: number, maxReductionDb: number }}
 */
export function renderDeEsserEnvelope(measuredEvents, numSamples, sampleRate, params) {
  const treated = decideClipGains(measuredEvents, toDecisionParams(params))
  const { multiplier, maxReductionDb } = buildClipGainEnvelope(
    numSamples, sampleRate, treated, toFadeParams(params),
  )

  const deviation = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) deviation[i] = multiplier[i] - 1

  return { deviation, treatedCount: treated.length, maxReductionDb }
}

export function createClipGainDeEsser(audioContext) {
  const input = audioContext.createGain()
  const gainNode = audioContext.createGain()
  const output = audioContext.createGain()

  // Unity intrinsic value: with no modulator connected this is a straight wire.
  gainNode.gain.value = 1
  input.connect(gainNode)
  gainNode.connect(output)

  let params = { ...DEESSER_DEFAULTS }
  let destroyed = false

  /**
   * The envelope only spans the analysed region, not the whole timeline. A
   * full-timeline buffer would be 635 MB of Float32 for a one-hour chapter;
   * scheduling a region-length buffer at the right moment costs nothing and
   * bounds the allocation by the selection.
   */
  let envelopeBuffer = null
  let regionStartSec = 0
  let modulator = null

  function stopTransport() {
    if (!modulator) return
    try {
      modulator.stop()
      modulator.disconnect()
    } catch {
      // Already stopped — starting and stopping in the same tick is normal.
    }
    modulator = null
  }

  /**
   * Schedule the envelope against a playback that starts at `startSec` on the
   * timeline and begins sounding at context time `when`.
   *
   * Two cases, and both are the same arithmetic playback.js already does for
   * segments: playback starting before the region schedules the modulator
   * later, playback starting inside it starts the modulator part-way in.
   */
  function startTransport(when, startSec) {
    stopTransport()
    if (destroyed || !envelopeBuffer) return

    const regionEndSec = regionStartSec + envelopeBuffer.duration
    if (startSec >= regionEndSec) return // region already behind the playhead

    let at = when
    let offset = 0
    if (startSec < regionStartSec) {
      at = when + (regionStartSec - startSec)
    } else {
      offset = startSec - regionStartSec
    }

    modulator = audioContext.createBufferSource()
    modulator.buffer = envelopeBuffer
    modulator.connect(gainNode.gain)
    modulator.start(at, offset)
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
      if (name === 'envelope') {
        // { deviation: Float32Array, startSec: number } — or null to clear.
        stopTransport()
        if (!value || !value.deviation?.length) {
          envelopeBuffer = null
          return
        }
        const buf = audioContext.createBuffer(
          1, value.deviation.length, audioContext.sampleRate,
        )
        buf.copyToChannel(value.deviation, 0)
        envelopeBuffer = buf
        regionStartSec = value.startSec ?? 0
        return
      }
      if (name in params) params[name] = value
    },

    getParam(name) {
      return params[name]
    },

    getInputLevelDb() {
      return inputTap.getLevelDb()
    },

    getOutputLevelDb() {
      return outputTap.getLevelDb()
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

export const clipGainDeEsserEffect = {
  id: 'clip-gain-deesser',
  name: 'Clip-Gain De-Esser',
  latencySamples: 0,
  createNodes(audioContext) {
    return createClipGainDeEsser(audioContext)
  },
}
