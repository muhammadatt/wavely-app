/**
 * Vocal Chain — Dynamics section, real-time effect chain wrapper.
 *
 * The DSP lives in ../dynamicsProcessor.js (clip → FET → Pultec/opto block,
 * blended against a delay-compensated post-FET dry path) and runs in an
 * AudioWorklet. The offline apply path renders through the same worklet in an
 * OfflineAudioContext, so the preview is sample-identical to what gets written
 * to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureDynamicsWorklet } from '../dynamicsWorkletLoader.js'
import { createLevelTap } from './levelTap.js'

/**
 * ⚠ THE PARAMS AND THE LATENCY LIVE IN `dynamicsParams.js` so they can be
 * reached from Node — see that file. Re-exported here so importers are
 * unchanged.
 *
 * ⚠ IMPORTED AND RE-EXPORTED, NOT JUST RE-EXPORTED, AND THE DIFFERENCE IS A
 * RUNTIME CRASH. `export { X } from '...'` forwards the binding to importers
 * WITHOUT introducing it into this module's scope, so every local use of X is
 * an undefined reference — `schepsParams.js` records shipping exactly that, and
 * neither `vite build` nor any test reaches it, because the test cannot import
 * a file that pulls a worklet loader.
 */
import {
  DYNAMICS_LATENCY_SAMPLES, DYNAMICS_DEFAULTS, DYNAMICS_MEASURED_KEYS,
  toKernelParams, toLiveKernelParams, dynamicsPreRollSeconds,
} from './dynamicsParams.js'

export {
  DYNAMICS_LATENCY_SAMPLES, DYNAMICS_DEFAULTS, DYNAMICS_MEASURED_KEYS,
  toKernelParams, toLiveKernelParams, dynamicsPreRollSeconds,
}

const ZERO_METERING = Object.freeze({
  clip: { now: 0, peak: 0 },
  fet: { now: 0, peak: 0, avg: 0 },
  opto: { now: 0, peak: 0, avg: 0 },
})

export function createDynamics(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off: the chain calls .disconnect() on
  // `output` during rebuilds (wiping ALL its outgoing connections), so nothing
  // internal may hang off `output` — taps and the worklet feed preOutput
  // instead, and preOutput -> output survives every rebuild.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let panel = { ...DYNAMICS_DEFAULTS }
  let solved = null
  let worklet = null
  let destroyed = false
  let metering = ZERO_METERING

  input.connect(preOutput)
  preOutput.connect(output)

  const push = () => {
    worklet?.port.postMessage({
      type: 'params', params: toLiveKernelParams(panel, solved),
    })
  }

  ensureDynamicsWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'dynamics-processor', {
        processorOptions: { params: toKernelParams(panel, solved) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type === 'gr' && e.data.metering) metering = e.data.metering
      }
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Dynamics worklet failed to load, running bypassed:', err)
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
      /**
       * ⚠ `solution` IS A WHOLE OBJECT, NOT A PARAM, and it is handled first
       * because it is not on `panel` at all. The solve's output describes the
       * FILE — thresholds, drives, two alignment offsets, the blend's measured
       * correlation — and keeping it off the panel object is what stops any of
       * it reaching a saved preset.
       */
      if (name === 'solution') {
        solved = value ?? null
        push()
        return
      }
      if (name in panel) {
        panel[name] = value
        push()
      }
    },

    getParam(name) {
      return name === 'solution' ? solved : panel[name]
    },

    /**
     * What each stage did, as the kernel reported it. All three separately —
     * see the note on `getMetering` in dynamicsProcessor.js for why a summed
     * meter would hide the one failure that must not be silent.
     */
    getMetering() {
      return metering
    },

    /**
     * Total reduction across the section, negative dB, for callers that want
     * one number (a rail badge, a chain overview). ⚠ NOT FOR THE PANEL: the
     * clipper's cap is invisible in a sum.
     */
    getReduction() {
      return -(metering.clip.now + metering.fet.now + metering.opto.now)
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

export const dynamicsEffect = {
  id: 'vocal-chain-dynamics',
  name: 'Vocal Chain Dynamics',
  latencySamples: DYNAMICS_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createDynamics(audioContext)
  },
}
