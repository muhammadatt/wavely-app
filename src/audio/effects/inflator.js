/**
 * Inflator — real-time effect chain wrapper.
 *
 * The DSP lives in ../inflatorProcessor.js (a port of Kiriki-liszt/JS_Inflator,
 * itself a reimplementation of the Sonnox Inflator) and runs in an
 * AudioWorklet. The offline apply path renders through the same worklet in an
 * OfflineAudioContext, so the preview is sample-identical to what gets written
 * to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureInflatorWorklet } from '../inflatorWorkletLoader.js'
import { INFLATOR_LATENCY_SAMPLES } from '../inflatorProcessor.js'
import { createLevelTap } from './levelTap.js'

export { INFLATOR_LATENCY_SAMPLES }

/**
 * ⚠ EFFECT DEFAULTS TO 0.5 WHERE THE REFERENCE SHIPS 0. A VST must be
 * inaudible until asked; this app opens a plugin engaged and metering, and a
 * panel that does nothing on open reads as broken. Every other default here is
 * the reference's.
 */
export const INFLATOR_DEFAULTS = {
  inputDb: 0,
  effect: 0.5,
  curve: 0,
  outputDb: 0,
  clip: false,
  bandSplit: false,
}

/** Map UI param names to kernel param names — 1:1 for this effect. */
export function toKernelParams(params) {
  return {
    inputDb: params.inputDb,
    effect: params.effect,
    curve: params.curve,
    outputDb: params.outputDb,
    clip: params.clip,
    bandSplit: params.bandSplit,
  }
}

export function createInflator(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  const params = { ...INFLATOR_DEFAULTS }
  let worklet = null
  let destroyed = false

  input.connect(preOutput)
  preOutput.connect(output)

  ensureInflatorWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'inflator-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Inflator worklet failed to load, running bypassed:', err)
    })

  const inputMonitor = audioContext.createGain()
  input.connect(inputMonitor)
  const outputMonitor = audioContext.createGain()
  preOutput.connect(outputMonitor)

  const inputTap = createLevelTap(audioContext, inputMonitor)
  const outputTap = createLevelTap(audioContext, outputMonitor)

  return {
    input,
    output,

    setParam(name, value) {
      if (name in params) {
        params[name] = value
        worklet?.port.postMessage({ type: 'params', params: toKernelParams(params) })
      }
    },

    getParam(name) {
      return params[name]
    },

    getInputLevels(channelCount) {
      return inputTap.getLevels(channelCount)
    },

    getOutputLevels(channelCount) {
      return outputTap.getLevels(channelCount)
    },

    destroy() {
      destroyed = true
      input.disconnect()
      worklet?.disconnect()
      preOutput.disconnect()
      output.disconnect()
      inputMonitor.disconnect()
      outputMonitor.disconnect()
      inputTap.destroy()
      outputTap.destroy()
    },
  }
}

export const inflatorEffect = {
  id: 'inflator',
  name: 'Inflator',
  // The curve runs 4x oversampled through linear-phase halfbands, so the plugin
  // delays. CONSTANT at every setting, Effect 0 included — the dry path is
  // delayed to match rather than passed through, so the apply path can trim a
  // fixed count whatever the knobs are doing.
  latencySamples: INFLATOR_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createInflator(audioContext)
  },
}
