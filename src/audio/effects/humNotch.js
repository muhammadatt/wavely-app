/**
 * Hum Remover — real-time effect chain wrapper.
 *
 * The DSP lives in ../humNotchProcessor.js (narrow peaking cuts at the mains
 * frequency and its harmonics) and runs in an AudioWorklet. The offline apply
 * path renders through the same worklet in an OfflineAudioContext, so the
 * preview is sample-identical to what gets written to the timeline.
 *
 * Unlike the other effects, this one has an analysis step: which frequencies
 * to notch comes from src/audio/dsp/humDetect.js, run once in a Worker behind
 * the panel's Analyze button. The effect itself stays a plain filter chain.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureHumNotchWorklet } from '../humNotchWorkletLoader.js'
import { createLevelTap } from './levelTap.js'

export const HUM_NOTCH_DEFAULTS = {
  frequencies: [], // Hz, chosen by the user from the detection result
  q: 30,
  depth: 18, // dB of cut
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  return {
    frequencies: params.frequencies,
    q: params.q,
    depthDb: params.depth,
  }
}

export function createHumNotch(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...HUM_NOTCH_DEFAULTS }
  let worklet = null
  let destroyed = false

  input.connect(preOutput)
  preOutput.connect(output)

  ensureHumNotchWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'hum-notch-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Hum Remover worklet failed to load, running bypassed:', err)
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

    getInputLevelDb() {
      return inputTap.getLevelDb()
    },

    getOutputLevelDb() {
      return outputTap.getLevelDb()
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

export const humNotchEffect = {
  id: 'hum-notch',
  name: 'Hum Remover',
  createNodes(audioContext) {
    return createHumNotch(audioContext)
  },
}
