/**
 * Scheps Parallel — real-time effect chain wrapper.
 *
 * The DSP lives in ../schepsProcessor.js (two fitted Pultec stages around the
 * existing OptoSmooth kernel, blended against a delay-compensated dry path) and
 * runs in an AudioWorklet. The offline apply path renders through the same
 * worklet in an OfflineAudioContext, so the preview is sample-identical to what
 * gets written to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureSchepsWorklet } from '../schepsWorkletLoader.js'
import { OVERSAMPLE_LATENCY_SAMPLES } from '../dsp/oversample.js'
import { createLevelTap } from './levelTap.js'

/**
 * ⚠ THE PARAMS AND THE LATENCY LIVE IN `schepsParams.js` so they can be reached
 * from Node — see that file. Re-exported here so importers are unchanged.
 *
 * ⚠ IMPORTED AND RE-EXPORTED, NOT JUST RE-EXPORTED, AND THE DIFFERENCE IS A
 * RUNTIME CRASH. `export { X } from '...'` forwards the binding to importers
 * WITHOUT introducing it into this module's scope, so every local use of X is
 * an undefined reference. The first cut of this split re-exported all three and
 * imported only two, and `SCHEPS_LATENCY_SAMPLES` — used by `schepsEffect`
 * below — threw `ReferenceError` the moment the module was touched. `vite build`
 * does not catch an undefined identifier, and no test reaches this file because
 * it pulls the worklet loader, which is the very gap `schepsParams.js` was split
 * out to close. Import first, re-export from the local binding.
 */
import {
  SCHEPS_LATENCY_SAMPLES, SCHEPS_DEFAULTS, toKernelParams,
} from './schepsParams.js'

export { SCHEPS_LATENCY_SAMPLES, SCHEPS_DEFAULTS, toKernelParams }

export function createScheps(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off: the chain calls .disconnect()
  // on `output` during rebuilds (wiping ALL its outgoing connections), so
  // nothing internal may hang off `output` — taps and the worklet feed
  // preOutput instead, and preOutput -> output survives every rebuild.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...SCHEPS_DEFAULTS }
  let worklet = null
  let destroyed = false
  let grDb = 0

  // Pass through until the worklet module is loaded, then splice it in.
  input.connect(preOutput)
  preOutput.connect(output)

  ensureSchepsWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'scheps-processor', {
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
      console.error('Scheps Parallel worklet failed to load, running bypassed:', err)
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

    // Negative dB, matching DynamicsCompressorNode.reduction conventions. This
    // is the wet path's gain reduction, which is what the trick is doing — the
    // summed output is reduced by rather less, in proportion to Mix.
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

export const schepsEffect = {
  id: 'scheps-parallel',
  name: 'Scheps Parallel',
  latencySamples: SCHEPS_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createScheps(audioContext)
  },
}
