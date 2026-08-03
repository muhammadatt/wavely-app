/**
 * Vocal Saturation — real-time effect chain wrapper.
 *
 * The DSP lives in ../vocalSatProcessor.js (complementary three-band split,
 * blended tanh/arctan transfer with per-band drive, gain-neutral parallel
 * blend) and runs in an AudioWorklet. The offline apply path renders through
 * the same worklet in an OfflineAudioContext, so the preview is
 * sample-identical to what gets written to the timeline.
 *
 * This replaces a server round-trip: the panel used to POST the rendered
 * selection to /api/spot/vocal_saturation and wait on a modal.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureVocalSatWorklet } from '../vocalSatWorkletLoader.js'
import { createLevelTap } from './levelTap.js'

// Same names and defaults the panel already used, so the UI is unchanged.
export const VOCAL_SAT_DEFAULTS = {
  drive: 2.0,
  wetDry: 0.3,
  bias: 0.5,
  softness: 0.3,
  lowCrossover: 500,
  midCrossover: 3500,
  lowDriveMult: 5.0,
  midDriveMult: 0.1,
  highDriveMult: 0.1,
}

/** Map UI param names to kernel param names — 1:1 for this effect. */
export function toKernelParams(params) {
  return {
    drive: params.drive,
    wetDry: params.wetDry,
    bias: params.bias,
    softness: params.softness,
    lowCrossover: params.lowCrossover,
    midCrossover: params.midCrossover,
    lowDriveMult: params.lowDriveMult,
    midDriveMult: params.midDriveMult,
    highDriveMult: params.highDriveMult,
  }
}

export function createVocalSat(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...VOCAL_SAT_DEFAULTS }
  let worklet = null
  let destroyed = false

  input.connect(preOutput)
  preOutput.connect(output)

  ensureVocalSatWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'vocal-sat-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Vocal Saturation worklet failed to load, running bypassed:', err)
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

export const vocalSatEffect = {
  id: 'vocal-sat',
  name: 'Vocal Saturation',
  createNodes(audioContext) {
    return createVocalSat(audioContext)
  },
}
