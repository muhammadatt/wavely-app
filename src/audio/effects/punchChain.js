/**
 * Punch Chain — real-time effect chain wrapper.
 *
 * The DSP lives in ../punchChainProcessor.js (FET Punch's kernel into
 * OptoSmooth's, with the makeup and the ceiling at the composite output) and
 * runs in an AudioWorklet. The offline apply path renders through the same
 * worklet in an OfflineAudioContext, so the preview is sample-identical to what
 * gets written to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensurePunchChainWorklet } from '../punchChainWorkletLoader.js'
import { createLevelTap } from './levelTap.js'
import { onLA2ATuningChange } from './la2aTuning.js'
import { onFET1176TuningChange } from './fet1176Tuning.js'

/**
 * ⚠ IMPORTED AND RE-EXPORTED, NOT JUST RE-EXPORTED, AND THE DIFFERENCE IS A
 * RUNTIME CRASH. `export { X } from '...'` forwards the binding to importers
 * WITHOUT introducing it into this module's scope, so every local use of X is
 * an undefined reference — which `vite build` does not catch and no test
 * reaches, because this file pulls the worklet loader. Scheps shipped exactly
 * that. Import first, re-export from the local binding.
 */
import {
  PUNCH_CHAIN_LATENCY_SAMPLES, PUNCH_CHAIN_DEFAULTS, PUNCH_CHAIN_PREROLL_S,
  PUNCH_CHAIN_MEASURED_KEYS, PUNCH_CHAIN_CLEARABLE_KEYS, toKernelParams,
} from './punchChainParams.js'
import { withMeasuredClears } from './measuredKeys.js'

export {
  PUNCH_CHAIN_LATENCY_SAMPLES, PUNCH_CHAIN_DEFAULTS, PUNCH_CHAIN_PREROLL_S,
  PUNCH_CHAIN_MEASURED_KEYS, PUNCH_CHAIN_CLEARABLE_KEYS, toKernelParams,
}

export function createPunchChain(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off: the chain calls .disconnect() on
  // `output` during rebuilds (wiping ALL its outgoing connections), so nothing
  // internal may hang off `output` — taps and the worklet feed preOutput
  // instead, and preOutput -> output survives every rebuild.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...PUNCH_CHAIN_DEFAULTS }
  let worklet = null
  let destroyed = false
  let grDb = 0
  let fetGrDb = 0
  let optoGrDb = 0

  input.connect(preOutput)
  preOutput.connect(output)

  ensurePunchChainWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'punch-chain-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type === 'gr') {
          grDb = e.data.grDb
          fetGrDb = e.data.fetDb
          optoGrDb = e.data.optoDb
        }
      }
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Punch Chain worklet failed to load, running bypassed:', err)
    })

  const inputMonitor = audioContext.createGain()
  input.connect(inputMonitor)
  const outputMonitor = audioContext.createGain()
  preOutput.connect(outputMonitor)

  const inputTap = createLevelTap(audioContext, inputMonitor)
  const outputTap = createLevelTap(audioContext, outputMonitor)

  function push() {
    worklet?.port.postMessage({
      type: 'params',
      params: withMeasuredClears(toKernelParams(params), PUNCH_CHAIN_CLEARABLE_KEYS),
    })
  }

  /**
   * FOLLOW BOTH BENCH TUNINGS WHILE THIS NODE IS ALIVE.
   *
   * ⚠ SUBSCRIBED HERE RATHER THAN POKED FROM EITHER PANEL, because the panels
   * that own the tunings are OptoSmooth's and FET Punch's and neither should
   * have to know this plugin exists — each one's `refreshKernelTuning` reaches
   * its own node by id, which is the pattern that left Scheps behind. Two
   * subscriptions because this chain embeds two kernels; `toKernelParams` folds
   * both sets of overrides in, so re-sending the same patch params is all it
   * takes.
   */
  const unsubscribeLA2A = onLA2ATuningChange(push)
  const unsubscribeFET = onFET1176TuningChange(push)

  return {
    input,
    output,

    setParam(name, value) {
      if (name in params) {
        params[name] = value
        push()
      }
    },

    getParam(name) {
      return params[name]
    },

    /**
     * Negative dB, matching DynamicsCompressorNode.reduction conventions.
     *
     * ⚠ THE SUM OF TWO STAGES' INSTANTANEOUS READINGS, which is not the chain's
     * reduction at any one sample — the Opto's figure is measured on audio the
     * FET already reduced. Right for a meter, wrong for arithmetic; see
     * `getReduction` on the kernel.
     */
    getReduction() {
      return -grDb
    },

    /** Each stage's reduction separately, for the plate's two meters. */
    getStageReduction() {
      return { fetDb: fetGrDb, optoDb: optoGrDb }
    },

    getInputLevels(channelCount) {
      return inputTap.getLevels(channelCount)
    },

    getOutputLevels(channelCount) {
      return outputTap.getLevels(channelCount)
    },

    /** Re-send the kernel params without changing a patch param. */
    refreshKernelParams() {
      push()
    },

    destroy() {
      destroyed = true
      unsubscribeLA2A()
      unsubscribeFET()
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

export const punchChainEffect = {
  id: 'punch-chain',
  name: 'Punch Chain',
  latencySamples: PUNCH_CHAIN_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createPunchChain(audioContext)
  },
}
