/**
 * Adaptive Soft Clipper — real-time effect chain wrapper.
 *
 * The DSP lives in ../softClipperProcessor.js (noise-gated speech-level
 * detector driving an adaptive threshold, RBJ pre/de-emphasis pair, 4x
 * oversampled soft-knee clip curve) and runs in an AudioWorklet. The offline
 * apply path renders through the same worklet in an OfflineAudioContext, so
 * the preview is sample-identical to what gets written to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect
 * passes audio through unprocessed, then splices the worklet node in. Same
 * shape as fet1176Compressor.js / la2aCompressor.js.
 */

import { ensureSoftClipperWorklet } from '../softClipperWorkletLoader.js'
import { SOFT_CLIPPER_LATENCY_SAMPLES } from '../softClipperProcessor.js'
import { createLevelTap } from './levelTap.js'

export { SOFT_CLIPPER_LATENCY_SAMPLES }

export const SOFT_CLIPPER_DEFAULTS = {
  headroomDb: 8, // 4-16, primary control — lower = more clipping
  emphasisDb: 6, // 0-12, HF pre/de-emphasis depth; 0 = bypass both filters
  outputTrimDb: 0, // ±6, gain-match for A/B
  thresholdMode: 'adaptive', // 'adaptive' | 'fixed'
  fixedThresholdDb: -10,
}

/** Params are already kernel-shaped — no renaming needed unlike FET1176/LA2A. */
export function toKernelParams(params) {
  return {
    headroomDb: params.headroomDb,
    emphasisDb: params.emphasisDb,
    outputTrimDb: params.outputTrimDb,
    thresholdMode: params.thresholdMode,
    fixedThresholdDb: params.fixedThresholdDb,
  }
}

export function createSoftClipper(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see fet1176Compressor.js for why
  // nothing may hang off `output` directly.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...SOFT_CLIPPER_DEFAULTS }
  let worklet = null
  let destroyed = false
  let reductionDb = 0

  input.connect(preOutput)
  preOutput.connect(output)

  ensureSoftClipperWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'soft-clipper-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type === 'gr') reductionDb = e.data.reductionDb
      }
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Soft Clipper worklet failed to load, running bypassed:', err)
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

    // Peak reduction, positive dB (peak_in - peak_out) — see GainReductionBar,
    // which takes the magnitude either way.
    getReduction() {
      return reductionDb
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

export const softClipperEffect = {
  id: 'soft-clipper',
  name: 'Adaptive Soft Clipper',
  latencySamples: SOFT_CLIPPER_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createSoftClipper(audioContext)
  },
}
