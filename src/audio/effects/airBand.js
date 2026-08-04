/**
 * Air Band — real-time effect chain wrapper.
 *
 * The DSP lives in ../airBandProcessor.js (five Maag-style parametric bells
 * plus a wide high shelf, all scaling from one knob) and runs in an
 * AudioWorklet. The offline apply path renders through the same worklet in an
 * OfflineAudioContext, so the preview is sample-identical to what gets written
 * to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureAirBandWorklet } from '../airBandWorkletLoader.js'
import { createLevelTap } from './levelTap.js'

export const AIR_BAND_DEFAULTS = {
  air: 6, // dB of air lift, 0–24
  output: 0, // output trim dB, for level-matched A/B
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  return {
    gainDb: params.air,
    outputGainDb: params.output,
  }
}

export function createAirBand(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off: the chain calls .disconnect()
  // on `output` during rebuilds (wiping ALL its outgoing connections), so
  // nothing internal may hang off `output` — taps and the worklet feed
  // preOutput instead, and preOutput -> output survives every rebuild.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...AIR_BAND_DEFAULTS }
  let worklet = null
  let destroyed = false

  // Pass through until the worklet module is loaded, then splice it in.
  input.connect(preOutput)
  preOutput.connect(output)

  ensureAirBandWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'air-band-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('AirBoost worklet failed to load, running bypassed:', err)
    })

  // Level meter taps on dedicated monitor nodes fed from stable internal
  // points (input / preOutput), never from `output` — see note above.
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

export const airBandEffect = {
  id: 'air-band',
  name: 'AirBoost',
  createNodes(audioContext) {
    return createAirBand(audioContext)
  },
}
