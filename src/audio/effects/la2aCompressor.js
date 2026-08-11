/**
 * LA-2A optical compressor — real-time effect chain wrapper.
 *
 * The DSP itself lives in ../la2aProcessor.js (T4 optical cell with
 * dual-stage memory-dependent release, program-dependent compress/limit
 * ratios, R37 sidechain emphasis, tube saturation) and runs in an
 * AudioWorklet. The offline apply path renders through the same worklet in
 * an OfflineAudioContext, so the preview is sample-identical to what gets
 * written to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect
 * passes audio through unprocessed, then splices the worklet node in.
 */

import { ensureLA2AWorklet } from '../la2aWorkletLoader.js'
import { OVERSAMPLE_LATENCY_SAMPLES } from '../dsp/oversample.js'
import { createLevelTap } from './levelTap.js'

/**
 * The tube stage runs oversampled, and the halfband filters that get it there
 * are linear phase, so the plugin delays. Constant at every setting — see
 * `latencySamples` on the kernel.
 */
export const LA2A_LATENCY_SAMPLES = OVERSAMPLE_LATENCY_SAMPLES

export const LA2A_DEFAULTS = {
  mode: 'compress', // 'compress' | 'limit'
  peakReduction: 50,
  gain: 0, // makeup gain dB
  tubeDrive: 0.3,
  emphasis: 0, // R37 HF sidechain emphasis, 0 = flat (stock)
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  return {
    mode: params.mode,
    peakReduction: params.peakReduction,
    gainDb: params.gain,
    tubeDrive: params.tubeDrive,
    emphasis: params.emphasis,
  }
}

export function createLA2ACompressor(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off: the chain calls .disconnect()
  // on `output` during rebuilds (wiping ALL its outgoing connections), so
  // nothing internal may hang off `output` — taps and the worklet feed
  // preOutput instead, and preOutput -> output survives every rebuild.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...LA2A_DEFAULTS }
  let worklet = null
  let destroyed = false
  let grDb = 0

  // Pass through until the worklet module is loaded, then splice it in.
  input.connect(preOutput)
  preOutput.connect(output)

  ensureLA2AWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'la2a-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type === 'gr') grDb = e.data.grDb
      }
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('LA-2A worklet failed to load, running bypassed:', err)
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

    // Negative dB, matching DynamicsCompressorNode.reduction conventions.
    getReduction() {
      return -grDb
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

export const la2aEffect = {
  id: 'la2a-compressor',
  name: 'LA-2A Compressor',
  latencySamples: LA2A_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createLA2ACompressor(audioContext)
  },
}
