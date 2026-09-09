/**
 * Vocal Saturation — real-time effect chain wrapper.
 *
 * The DSP lives in ../vocalSatProcessor.js (complementary three-band split,
 * knee-order transfer curve with per-band drive, measured-sign asymmetry, and a
 * gain-neutral parallel blend) and runs in an AudioWorklet. The offline apply
 * path renders through the same worklet in an OfflineAudioContext.
 *
 * ⚠ THAT DOES NOT MAKE THEM SAMPLE-IDENTICAL, AND THIS FILE CLAIMED IT DID.
 * Same code and same parameters, but the preview kernel has been running over
 * the whole session while the apply render starts COLD at the region's first
 * sample, so every follower, gate and tracker inside begins somewhere else.
 * Measured at up to 2 dB over the opening of a region before the apply path
 * grew a pre-roll, and about 0.3 dB after. See VOCAL_SAT_PREROLL_S for the
 * numbers and for why no finite pre-roll closes it completely.
 *
 * ⚠ EIGHT OTHER EFFECT WRAPPERS IN THIS DIRECTORY MAKE THE SAME CLAIM and all
 * of them have envelope state too, so it is likely wrong for them as well —
 * OptoSmooth and FET Punch carry the most. None has been measured, so none has
 * been changed; do not read their silence as a clean bill of health.
 *
 * This replaces a server round-trip: the panel used to POST the rendered
 * selection to /api/spot/vocal_saturation and wait on a modal.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureVocalSatWorklet } from '../vocalSatWorkletLoader.js'
import {
  VOCAL_SAT_LATENCY_SAMPLES, VOCAL_SAT_PREROLL_S,
} from '../vocalSatProcessor.js'
import {
  VOCAL_SAT_DEFAULTS, VOCAL_SAT_MODES, VOCAL_SAT_CURVES, VOCAL_SAT_ASYM_MODES,
  toKernelParams,
  MODE_SERIES, MODE_PARALLEL, CURVE_SHAPE, CURVE_CUBIC,
  ASYM_MODE_OFFSET, ASYM_MODE_SPLIT,
} from '../vocalSatParams.js'
import { createLevelTap } from './levelTap.js'

export {
  VOCAL_SAT_LATENCY_SAMPLES, VOCAL_SAT_PREROLL_S,
  VOCAL_SAT_DEFAULTS, VOCAL_SAT_MODES, VOCAL_SAT_CURVES, VOCAL_SAT_ASYM_MODES,
  toKernelParams,
  MODE_SERIES, MODE_PARALLEL, CURVE_SHAPE, CURVE_CUBIC,
  ASYM_MODE_OFFSET, ASYM_MODE_SPLIT,
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
      console.error('Tube Saturation worklet failed to load, running bypassed:', err)
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

export const vocalSatEffect = {
  id: 'vocal-sat',
  name: 'Tube Saturation',
  // The three transfer curves run oversampled, and the halfband filters that
  // get them there are linear phase, so the plugin delays. Constant at every
  // setting — see `latencySamples` on the kernel.
  latencySamples: VOCAL_SAT_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createVocalSat(audioContext)
  },
}
