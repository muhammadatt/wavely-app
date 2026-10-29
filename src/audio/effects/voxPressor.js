/**
 * VoxPressor — real-time effect chain wrapper.
 *
 * The DSP lives in ../voxPressorProcessor.js and runs in an AudioWorklet; the
 * offline apply path renders through the same worklet in an
 * OfflineAudioContext, so the preview is sample-identical to what lands on the
 * timeline. Until the module loads the effect passes audio through.
 */
import { ensureVoxPressorWorklet } from '../voxPressorWorkletLoader.js'
import { createLevelTap } from './levelTap.js'
// Imported, then re-exported from the local binding — see the note in
// scheps.js on why `export { X } from` alone leaves X undefined here.
import { VOX_LATENCY_SAMPLES, VOX_DEFAULTS, toKernelParams } from './voxPressorParams.js'

export { VOX_LATENCY_SAMPLES, VOX_DEFAULTS, toKernelParams }

export function createVoxPressor(audioContext) {
  const input = audioContext.createGain()
  // Stable internal hand-off: the chain disconnects `output` on rebuilds, so
  // nothing internal hangs off it (see scheps.js).
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  const params = { ...VOX_DEFAULTS }
  let worklet = null
  let destroyed = false
  let peaksGrDb = 0
  let bodyGrDb = 0

  input.connect(preOutput)
  preOutput.connect(output)

  const post = () => worklet?.port.postMessage({ type: 'params', params: toKernelParams(params) })

  ensureVoxPressorWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'vox-pressor-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        // Held until the meter reads it: a Peaks value lasts one report, and a
        // frame that misses it would drop the only sign the 1176 did anything.
        if (e.data?.type === 'gr') {
          peaksGrDb = Math.max(peaksGrDb, e.data.peaksGrDb)
          bodyGrDb = e.data.bodyGrDb
        }
      }
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('VoxPressor worklet failed to load, running bypassed:', err)
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
        post()
      }
    },

    getParam(name) {
      return params[name]
    },

    /**
     * Negative dB per stage, DynamicsCompressorNode's convention. Peaks is the
     * most the 1176 did since the last read, then reset (see onmessage).
     */
    getReductions() {
      const r = { peaks: -peaksGrDb, body: -bodyGrDb }
      peaksGrDb = 0
      return r
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

export const voxPressorEffect = {
  id: 'vox-pressor',
  name: 'VoxPressor',
  latencySamples: VOX_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createVoxPressor(audioContext)
  },
}
