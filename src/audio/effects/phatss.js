/**
 * PHAT*SS — real-time effect chain wrapper.
 *
 * The DSP lives in ../phatssProcessor.js (Warmth → its peak guard → a tape HF
 * shelf) and runs in an AudioWorklet. The offline apply path renders through
 * the same worklet in an OfflineAudioContext, so preview and apply share one
 * code path.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensurePhatssWorklet } from '../phatssWorkletLoader.js'
import { createLevelTap } from './levelTap.js'
import { PHATSS_DEFAULTS, toKernelParams } from '../phatssParams.js'

export { PHATSS_DEFAULTS, toKernelParams } from '../phatssParams.js'

export function createPhatss(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...PHATSS_DEFAULTS }
  let worklet = null
  let destroyed = false

  input.connect(preOutput)
  preOutput.connect(output)

  ensurePhatssWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'phatss-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('PHAT*SS worklet failed to load, running bypassed:', err)
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
      if (!(name in params)) return
      params[name] = value
      worklet?.port.postMessage({ type: 'params', params: toKernelParams(params) })
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

export const phatssEffect = {
  id: 'phatss',
  name: 'PHAT*SS',
  createNodes(audioContext) {
    return createPhatss(audioContext)
  },
}
