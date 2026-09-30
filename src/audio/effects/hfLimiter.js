/**
 * HF Limiter — real-time effect chain wrapper.
 *
 * The DSP lives in ../hfLimiterProcessor.js (a lookahead dynamic shelf, then an
 * optional acceleration limiter; see ../dsp/hfLimit.js) and runs in an
 * AudioWorklet. The offline apply path renders through the same worklet in an
 * OfflineAudioContext, so preview and apply share one code path.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureHFLimiterWorklet } from '../hfLimiterWorkletLoader.js'
import { createLevelTap } from './levelTap.js'
import { HF_LIMITER_DEFAULTS, toKernelParams } from '../hfLimiterParams.js'

export { HF_LIMITER_DEFAULTS, toKernelParams } from '../hfLimiterParams.js'

export function createHFLimiter(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...HF_LIMITER_DEFAULTS }
  let worklet = null
  let destroyed = false
  let reductionDb = 0
  let accel = 0
  // Monitor tap, kept out of `params` on purpose: parameters are what the
  // apply path renders with, and a monitor mode must never be one of them.
  let listen = 'off'

  input.connect(preOutput)
  preOutput.connect(output)

  ensureHFLimiterWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'hf-limiter-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type !== 'gr') return
        reductionDb = e.data.reductionDb
        accel = e.data.accel
      }
      worklet.port.postMessage({ type: 'listen', mode: listen })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('HF Limiter worklet failed to load, running bypassed:', err)
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

    /** Shelf depth, positive dB — the deepest since the last meter post. */
    getReduction() {
      return reductionDb
    },

    /** Share of samples the acceleration limiter clamped, 0–1, since the last post. */
    getAccel() {
      return accel
    },

    setListen(mode) {
      listen = mode
      worklet?.port.postMessage({ type: 'listen', mode })
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

export const hfLimiterEffect = {
  id: 'hf-limiter',
  name: 'HF Limiter',
  createNodes(audioContext) {
    return createHFLimiter(audioContext)
  },
}
