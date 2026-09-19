/**
 * FET Punch (1176-style) compressor — real-time effect chain wrapper.
 *
 * The DSP itself lives in ../fet1176Processor.js (FET gain cell with
 * user-set microsecond attack, program-dependent release, four ratio
 * settings plus all-buttons-in, optional sidechain high-pass, FET/class-A
 * saturation) and runs in an AudioWorklet. The offline apply path renders
 * through the same worklet in an OfflineAudioContext, so the preview is
 * sample-identical to what gets written to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect
 * passes audio through unprocessed, then splices the worklet node in.
 */

import { ensureFET1176Worklet } from '../fet1176WorkletLoader.js'
import { createLevelTap } from './levelTap.js'
import {
  FET1176_LATENCY_SAMPLES, FET1176_DEFAULTS, toKernelParams,
} from './fet1176Params.js'

// Re-exported so callers that already reach for these through the effect keep
// working; the definitions live in fet1176Params.js, which Node can import.
export { FET1176_LATENCY_SAMPLES, FET1176_DEFAULTS, toKernelParams }

export function createFET1176Compressor(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off: the chain calls .disconnect()
  // on `output` during rebuilds (wiping ALL its outgoing connections), so
  // nothing internal may hang off `output` — taps and the worklet feed
  // preOutput instead, and preOutput -> output survives every rebuild.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  /**
   * ⚠ `inputAlignDb`, `ceilingDb` AND `ceilingKneeDb` ARE SEEDED HERE BECAUSE
   * `setParam` GATES ON `name in params`.
   * It is measured from the file rather than dialled, so it is deliberately
   * absent from `FET1176_DEFAULTS` — and without a seed that gate would drop
   * every push of it silently, leaving preview running the raw level-dependent
   * behaviour while apply ran the aligned one. Exactly the reason `ceilingDb`
   * and `inputAlignDb` are seeded in `la2aCompressor.js`.
   */
  let params = { ...FET1176_DEFAULTS, inputAlignDb: null, ceilingDb: null, ceilingKneeDb: null }
  let worklet = null
  let destroyed = false
  let grDb = 0
  let liveMakeupDb = null

  // Pass through until the worklet module is loaded, then splice it in.
  input.connect(preOutput)
  preOutput.connect(output)

  ensureFET1176Worklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'fet1176-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type === 'gr') {
          grDb = e.data.grDb
          liveMakeupDb = e.data.liveMakeupDb ?? null
        }
      }
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('FET Punch worklet failed to load, running bypassed:', err)
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

    /**
     * Re-send the kernel params without changing a patch param. The bench
     * tuning is folded in by `toKernelParams` rather than held here, so there
     * is no param name to set — the panel moves module state and then asks the
     * live node to pick it up.
     */
    refreshKernelParams() {
      worklet?.port.postMessage({ type: 'params', params: toKernelParams(params) })
    },

    // Negative dB, matching DynamicsCompressorNode.reduction conventions.
    /**
     * The makeup the audio heard so far asks for, dB, or null before anything
     * has played. A LIVE reading — it only knows what has been through the
     * worklet — so APPLY re-measures offline rather than committing it.
     */
    getLiveMakeupDb() {
      return liveMakeupDb
    },

    
    /** Forget what has played. A new region is new material. */
    resetMakeupTracker() {
      liveMakeupDb = null
      worklet?.port.postMessage({ type: 'resetMakeupTracker' })
    },

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

export const fet1176Effect = {
  id: 'fet1176-compressor',
  name: 'FET Punch Compressor',
  latencySamples: FET1176_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createFET1176Compressor(audioContext)
  },
}
