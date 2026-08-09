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
import { PITCH_RANGES, RESONANCE_FRAME_SIZE } from '../resonanceParams.js'

export { PITCH_RANGES, RESONANCE_FRAME_SIZE, effectivePitchRange } from '../resonanceParams.js'

/** This STFT holds back exactly one frame before a sample is reconstructed. */
export const RESONANCE_LATENCY_SAMPLES = RESONANCE_FRAME_SIZE

// Defaults are the acx_audiobook preset's resonanceSuppressor block
// (src/audio/presets.js), which is the tuning these were chosen against.
export const RESONANCE_DEFAULTS = {
  depth: 0.67,
  sharpness: 0.8,
  selectivity: 8,
  attack: 15, // ms
  release: 80, // ms
  maxReduction: 36, // dB
  freqFloor: 40, // Hz
  freqCeil: 20000, // Hz
  mode: 'soft', // 'soft' | 'hard'
  preserveHarmonics: true,
  pitchRange: 'voice', // key of PITCH_RANGES
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  const range = PITCH_RANGES[params.pitchRange] ?? PITCH_RANGES.voice
  return {
    depth: params.depth,
    sharpness: params.sharpness,
    selectivity: params.selectivity,
    attackMs: params.attack,
    releaseMs: params.release,
    maxReductionDb: params.maxReduction,
    freqFloorHz: params.freqFloor,
    freqCeilHz: params.freqCeil,
    mode: params.mode,
    preserveHarmonics: params.preserveHarmonics,
    pitchMinHz: range.minHz,
    pitchMaxHz: range.maxHz,
  }
}

export function createResonance(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...RESONANCE_DEFAULTS }
  let worklet = null
  let destroyed = false
  let grDb = 0

  input.connect(preOutput)
  preOutput.connect(output)

  ensureResonanceWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'resonance-processor', {
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
