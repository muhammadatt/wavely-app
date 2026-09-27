/**
 * Saturation Bench — real-time effect chain wrapper.
 *
 * The DSP lives in ../saturationBenchProcessor.js and runs in an AudioWorklet;
 * the apply path renders the same worklet offline. DELTA is a listen mode on
 * the kernel (output − delayed input: what the layers add) and never reaches
 * the apply path.
 */

import { ensureSaturationBenchWorklet } from '../saturationBenchWorkletLoader.js'
import { createLevelTap } from './levelTap.js'
import { SATURATION_BENCH_DEFAULTS, toKernelParams } from '../saturationBenchParams.js'

export { SATURATION_BENCH_DEFAULTS, SAT_BENCH_LAYER_PRESETS, toKernelParams } from '../saturationBenchParams.js'

export function createSaturationBench(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  const params = {
    ...SATURATION_BENCH_DEFAULTS,
    layers: SATURATION_BENCH_DEFAULTS.layers.map(l => ({ ...l })),
    refPeaks: [...SATURATION_BENCH_DEFAULTS.refPeaks],
  }
  let worklet = null
  let destroyed = false
  let delta = false

  input.connect(preOutput)
  preOutput.connect(output)

  ensureSaturationBenchWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'saturation-bench-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.postMessage({ type: 'listen', mode: delta ? 'delta' : 'off' })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Saturation Bench worklet failed to load, running bypassed:', err)
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
      if (name === 'delta') {
        delta = !!value
        worklet?.port.postMessage({ type: 'listen', mode: delta ? 'delta' : 'off' })
        return
      }
      if (!(name in params)) return
      params[name] = value
      worklet?.port.postMessage({ type: 'params', params: toKernelParams(params) })
    },

    getParam(name) {
      return name === 'delta' ? delta : params[name]
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

export const saturationBenchEffect = {
  id: 'saturation-bench',
  name: 'Saturation Bench',
  createNodes(audioContext) {
    return createSaturationBench(audioContext)
  },
}
