/**
 * Adaptive Soft Clipper — real-time effect chain wrapper.
 *
 * The DSP lives in ../softClipperProcessor.js (noise-gated speech-level
 * detector driving an adaptive threshold, RBJ pre/de-emphasis pair, 4x
 * oversampled soft-knee clip curve) and runs in an AudioWorklet. The offline
 * apply path renders through the same worklet in an OfflineAudioContext, so
 * the preview is sample-identical to what gets written to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect
 * passes audio through unprocessed, then splices the worklet node in. Same
 * shape as fet1176Compressor.js / la2aCompressor.js.
 */

import { ensureSoftClipperWorklet } from '../softClipperWorkletLoader.js'
import { SOFT_CLIPPER_LATENCY_SAMPLES } from '../softClipperProcessor.js'
import { createLevelTap } from './levelTap.js'

export { SOFT_CLIPPER_LATENCY_SAMPLES }

/**
 * How much history the scrolling scope keeps, in seconds.
 *
 * Long enough to see the adaptive threshold actually move — it rides a 3 s
 * tracker, so a window much shorter than this would show it as a flat line and
 * hide the one behaviour that distinguishes adaptive mode from fixed.
 */
export const SCOPE_SECONDS = 4

export const SOFT_CLIPPER_DEFAULTS = {
  headroomDb: 8, // 4-16, primary control — lower = more clipping
  emphasisDb: 6, // 0-12, HF pre/de-emphasis depth; 0 = bypass both filters
  outputTrimDb: 0, // ±6, gain-match for A/B
  thresholdMode: 'adaptive', // 'adaptive' | 'fixed'
  fixedThresholdDb: -10,
}

/** Params are already kernel-shaped — no renaming needed unlike FET1176/LA2A. */
export function toKernelParams(params) {
  return {
    headroomDb: params.headroomDb,
    emphasisDb: params.emphasisDb,
    outputTrimDb: params.outputTrimDb,
    thresholdMode: params.thresholdMode,
    fixedThresholdDb: params.fixedThresholdDb,
  }
}

export function createSoftClipper(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see fet1176Compressor.js for why
  // nothing may hang off `output` directly.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...SOFT_CLIPPER_DEFAULTS }
  let worklet = null
  let destroyed = false
  let reductionDb = 0

  // Scope ring. Points arrive batched (see the kernel's SCOPE_BATCH) and are
  // APPENDED rather than replacing a latest-frame, because this display is a
  // scroll rather than a snapshot. Sized from the context's own sample rate so
  // the window is SCOPE_SECONDS wherever it runs.
  const scopeCapacity = Math.ceil((SCOPE_SECONDS * audioContext.sampleRate) / 128)
  const scopePeak = new Float32Array(scopeCapacity)
  const scopeThreshold = new Float32Array(scopeCapacity)
  // Threshold starts above full scale so an unwritten tail reads as "not
  // processing" rather than as a threshold sitting at zero, which would draw
  // every sample as clipped.
  scopeThreshold.fill(1)
  let scopeHead = 0
  let scopeFilled = 0
  // Reused by getScope(), so a 60 Hz reader allocates nothing.
  const scopeView = {
    peak: scopePeak,
    threshold: scopeThreshold,
    capacity: scopeCapacity,
    head: 0,
    filled: 0,
  }

  input.connect(preOutput)
  preOutput.connect(output)

  ensureSoftClipperWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'soft-clipper-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type !== 'gr') return
        reductionDb = e.data.reductionDb
        const batch = e.data.scope
        if (!batch) return
        for (let i = 0; i + 1 < batch.length; i += 2) {
          scopePeak[scopeHead] = batch[i]
          scopeThreshold[scopeHead] = batch[i + 1]
          scopeHead = scopeHead + 1 === scopeCapacity ? 0 : scopeHead + 1
          if (scopeFilled < scopeCapacity) scopeFilled++
        }
      }
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Soft Clipper worklet failed to load, running bypassed:', err)
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

    // Peak reduction, positive dB (peak_in - peak_out) — see GainReductionBar,
    // which takes the magnitude either way.
    getReduction() {
      return reductionDb
    },

    /**
     * The scope ring, oldest-to-newest starting at `head` and wrapping.
     *
     * Returns the live arrays rather than a copy — the caller is a canvas
     * redrawing every frame, and copying ~1400 floats 60 times a second to
     * hand back data it only reads would be pure waste. Read it, do not
     * retain it.
     */
    getScope() {
      scopeView.head = scopeHead
      scopeView.filled = scopeFilled
      return scopeView
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

export const softClipperEffect = {
  id: 'soft-clipper',
  name: 'Adaptive Soft Clipper',
  latencySamples: SOFT_CLIPPER_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createSoftClipper(audioContext)
  },
}
