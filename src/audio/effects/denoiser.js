/**
 * Spectral Denoise — real-time effect chain wrapper (prototype).
 *
 * The DSP lives in ../denoiserProcessor.js and runs in an AudioWorklet; the
 * offline apply path renders through the same worklet in an
 * OfflineAudioContext, so preview and apply share one code path. The noise
 * profile is learned separately (processing.js → workers/noiseProfileWorker.js)
 * and handed in as a param.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureDenoiserWorklet } from '../denoiserWorkletLoader.js'
import { createLevelTap } from './levelTap.js'
import { DENOISE_DISPLAY_BANDS } from '../dsp/spectralDenoise.js'

export const DENOISER_DEFAULTS = {
  profile: null, // Float32Array |X|² per bin, from learnNoiseProfile
  reduction: 12, // dB
  threshold: 3, // dB above the learned profile
  smoothing: 50, // 0–100
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  return {
    profile: params.profile ?? null,
    reductionDb: params.reduction,
    thresholdDb: params.threshold,
    smoothing: params.smoothing,
  }
}

export function createDenoiser(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...DENOISER_DEFAULTS }
  let worklet = null
  let destroyed = false
  // Monitor, kept out of `params` on purpose: parameters are what the apply
  // path renders with, and a monitor mode must never be one of them.
  let delta = false

  // Latest meter frame from the kernel.
  let reductionDb = 0
  const inBands = new Float32Array(DENOISE_DISPLAY_BANDS).fill(1e-12)
  const outBands = new Float32Array(DENOISE_DISPLAY_BANDS).fill(1e-12)
  let meterSeq = 0

  input.connect(preOutput)
  preOutput.connect(output)

  ensureDenoiserWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'denoiser-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type !== 'meter') return
        reductionDb = e.data.reductionDb
        inBands.set(e.data.inBands)
        outBands.set(e.data.outBands)
        meterSeq++
      }
      worklet.port.postMessage({ type: 'delta', on: delta })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Spectral Denoise worklet failed to load, running bypassed:', err)
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

    /** Hear only what is being removed. */
    setDelta(on) {
      delta = !!on
      worklet?.port.postMessage({ type: 'delta', on: delta })
    },

    /** { seq, reductionDb, inBands, outBands } — bands are mean power per bin (live views). */
    getMeter() {
      return { seq: meterSeq, reductionDb, inBands, outBands }
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

export const denoiserEffect = {
  id: 'spectral-denoise',
  name: 'Spectral Denoise',
  createNodes(audioContext) {
    return createDenoiser(audioContext)
  },
}
