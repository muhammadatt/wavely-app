/**
 * LA-2A optical compressor — real-time effect chain wrapper.
 *
 * The DSP itself lives in ../la2aProcessor.js (T4 optical cell with
 * dual-stage memory-dependent release, program-dependent compress/limit
 * ratios, the R37 side-chain trimmer, tube saturation) and runs in an
 * AudioWorklet. The offline apply path renders through the same worklet in
 * an OfflineAudioContext, so the preview is sample-identical to what gets
 * written to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect
 * passes audio through unprocessed, then splices the worklet node in.
 *
 * Params, defaults and the latency arithmetic live in la2aParams.js — see
 * there for why they are not in this file — and are re-exported below.
 */

import { ensureLA2AWorklet } from '../la2aWorkletLoader.js'
import { createLevelTap } from './levelTap.js'
import {
  LA2A_DEFAULTS, LA2A_LATENCY_SAMPLES, LOOKAHEAD_MAX_MS,
  toKernelParams, la2aPatchLatencySamples,
} from './la2aParams.js'

// Re-exported so callers that already reach for these through the effect keep
// working; the definitions live in la2aParams.js, which Node can import.
export {
  LA2A_DEFAULTS, LA2A_LATENCY_SAMPLES, LOOKAHEAD_MAX_MS,
  toKernelParams, la2aPatchLatencySamples,
}

export function createLA2ACompressor(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off: the chain calls .disconnect()
  // on `output` during rebuilds (wiping ALL its outgoing connections), so
  // nothing internal may hang off `output` — taps and the worklet feed
  // preOutput instead, and preOutput -> output survives every rebuild.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  /**
   * ⚠ `ceilingDb` IS SEEDED HERE BECAUSE `setParam` GATES ON `name in params`.
   * It is measured rather than dialled, so it is deliberately absent from
   * `LA2A_DEFAULTS` (see there) — and without a seed that gate would drop every
   * push of it on the floor, silently, leaving the panel's percentile mode
   * running the raised makeup with no ceiling behind it. That is precisely the
   * overshoot the pairing exists to prevent, so it would have been the one bug
   * this feature must not have.
   *
   * `inputAlignDb` is seeded for exactly the same reason: it is measured from
   * the whole file, absent from `LA2A_DEFAULTS`, and without a seed here every
   * push of it would be dropped by the same gate — leaving preview running the
   * raw hardware behaviour while apply ran the aligned one.
   */
  let params = { ...LA2A_DEFAULTS, ceilingDb: null, ceilingKneeDb: null, inputAlignDb: null }
  let worklet = null
  let destroyed = false
  let grDb = 0
  let liveMakeupDb = null

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

    /**
     * Re-send the kernel params without changing a patch param. The bench
     * tuning is folded in by `toKernelParams` rather than held here, so there
     * is no param name to set — the tuning panel moves module state and then
     * asks the live node to pick it up.
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

export const la2aEffect = {
  id: 'la2a-compressor',
  name: 'LA-2A Compressor',
  // Nominal, for a chain that wants one number. The apply path does not use
  // this — it asks `la2aPatchLatencySamples` with the params in hand.
  latencySamples: LA2A_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createLA2ACompressor(audioContext)
  },
}
