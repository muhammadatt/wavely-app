/**
 * Resonance Suppressor — real-time effect chain wrapper.
 *
 * The DSP lives in ../resonanceProcessor.js (cepstral reference envelope,
 * spike detection, per-bin attack/release) and runs in an AudioWorklet. The
 * offline apply path renders through the same worklet in an
 * OfflineAudioContext, so the preview is sample-identical to what gets written
 * to the timeline.
 *
 * THIS IS THE FIRST LATENT EFFECT. Its STFT holds back a full fftSize before a
 * sample is fully reconstructed, so `latencySamples` is non-zero and the apply
 * path has to render long and trim — see applyWorkletRegion in ../processing.js.
 * Everything shipped before this was zero-latency, which is why that code path
 * had never needed the compensation.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureResonanceWorklet } from '../resonanceWorkletLoader.js'
import { createLevelTap } from './levelTap.js'
import {
  RESONANCE_DEFAULTS,
  RESONANCE_DISPLAY_CURVES,
  RESONANCE_FRAME_SIZE,
  resonanceDisplayRange,
  toKernelParams,
} from '../resonanceParams.js'

export {
  HARMONIC_PITCH_RANGE,
  RESONANCE_FRAME_SIZE,
  RESONANCE_DISPLAY_BINS,
  RESONANCE_DISPLAY_CURVES,
  RESONANCE_ATTACK_MIN_MS,
  RESONANCE_RELEASE_MIN_MS,
  RESONANCE_REF_MODE_DEFAULTS,
  DEFAULT_REF_MODE,
  effectivePitchRange,
  resolveRefMode,
  resonanceDisplayRange,
  withRefModeDefaults,
} from '../resonanceParams.js'

/** This STFT holds back exactly one frame before a sample is reconstructed. */
export const RESONANCE_LATENCY_SAMPLES = RESONANCE_FRAME_SIZE

/**
 * Defaults and the UI→kernel param mapping live in resonanceParams.js and are
 * re-exported here, where every caller already looks for them.
 *
 * They moved because `toKernelParams` is what makes the params survive a
 * structured clone, and this module cannot be loaded outside a bundler — it
 * imports the worklet loader — so the mapping could not be tested where it sat.
 */
export { RESONANCE_DEFAULTS, toKernelParams }

export function createResonance(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...RESONANCE_DEFAULTS }
  let worklet = null
  let destroyed = false
  let grDb = 0

  // Latest per-frequency frame from the kernel, and a view onto it. The view is
  // rebuilt only when a new frame lands, so a display reading it every animation
  // frame — faster than the ~46 Hz the worklet posts at — allocates nothing.
  let displayFrame = null
  let displayView = null

  // Monitoring mode, kept out of `params` on purpose — see ResonanceKernel's
  // setMonitor. It rides its own port message, so the offline render cannot
  // pick it up from a param spread.
  let monitorDelta = false

  input.connect(preOutput)
  preOutput.connect(output)

  ensureResonanceWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'resonance-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type !== 'gr') return
        grDb = e.data.grDb
        if (e.data.display) {
          displayFrame = e.data.display
          displayView = null
        }
      }
      // The worklet loads asynchronously, so it can miss a toggle made while
      // the effect was still passing through.
      worklet.port.postMessage({ type: 'monitor', delta: monitorDelta })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Resonance Suppressor worklet failed to load, running bypassed:', err)
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

    // Negative dB, matching DynamicsCompressorNode.reduction conventions.
    getReduction() {
      return -grDb
    },

    /**
     * The kernel's own view of the last frame, on a log-frequency grid, or null
     * before the worklet has produced one.
     *
     * `mag`, `reference` and `detect` are dBFS; `reduction` is positive dB of
     * cut. All four describe the same single frame, so anything drawn from them
     * agrees about one instant.
     *
     * `reference` does NOT include `selectivity` — the caller adds it, so the
     * threshold line tracks the knob without waiting for the audio thread. And
     * `detect` is the curve the DETECTOR reads, which is not `mag`: in the
     * shipping peak reference mode it is a max-filtered magnitude, so a margin
     * computed from `mag` reports no crossing on bins the kernel is cutting.
     *
     * Returns a live view onto the latest frame rather than a copy. It is valid
     * until the next message arrives, which is what a per-frame drawing loop
     * wants; anything holding it longer must copy.
     */
    getDisplay() {
      if (!displayFrame) return null
      if (!displayView) {
        const bins = displayFrame.length / RESONANCE_DISPLAY_CURVES
        const range = resonanceDisplayRange(audioContext.sampleRate)
        const curve = i => displayFrame.subarray(i * bins, (i + 1) * bins)
        displayView = {
          bins,
          minHz: range.minHz,
          maxHz: range.maxHz,
          mag: curve(0),
          reference: curve(1),
          detect: curve(2),
          reduction: curve(3),
        }
      }
      return displayView
    },

    /**
     * Audition the difference — only what the suppressor is removing.
     *
     * A separate call rather than a parameter: parameters are what the apply
     * path renders with, and this must never be one of them.
     */
    setMonitorDelta(on) {
      monitorDelta = !!on
      worklet?.port.postMessage({ type: 'monitor', delta: monitorDelta })
    },

    isMonitoringDelta() {
      return monitorDelta
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

export const resonanceEffect = {
  id: 'resonance-suppressor',
  name: 'Resonance Suppressor',
  latencySamples: RESONANCE_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createResonance(audioContext)
  },
}
