/**
 * PHAT*SS — real-time effect chain wrapper.
 *
 * The DSP lives in ../phatassProcessor.js (TAPE → makeup → Warmth → its peak
 * guard → a tape HF shelf with Soften) and runs in an AudioWorklet. The offline apply path renders through
 * the same worklet in an OfflineAudioContext, so preview and apply share one
 * code path.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensurePhatassWorklet } from '../phatassWorkletLoader.js'
import { createLevelTap } from './levelTap.js'
import { PHATASS_DEFAULTS, toKernelParams } from '../phatassParams.js'
import { SaturationMeterFollower } from '../dsp/saturationMeter.js'

export { PHATASS_DEFAULTS, toKernelParams } from '../phatassParams.js'

export function createPhatass(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...PHATASS_DEFAULTS }
  let worklet = null
  let destroyed = false
  // The saturation meter's energy followers, fed by the worklet's posts.
  const satMeter = new SaturationMeterFollower(audioContext.sampleRate)

  input.connect(preOutput)
  preOutput.connect(output)

  ensurePhatassWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'phatass-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type === 'sat') satMeter.push(e.data, e.data.frames)
      }
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

    /** What TAPE and Warmth are adding, dB re the clean signal (−Infinity at rest). */
    getSaturationDb() {
      return satMeter.readingDb
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

export const phatassEffect = {
  id: 'phatass',
  name: 'PHAT*SS',
  createNodes(audioContext) {
    return createPhatass(audioContext)
  },
}
