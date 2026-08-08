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

export const FET1176_DEFAULTS = {
  inputDrive: 50, // 0-100, drives the fixed internal threshold
  output: 0, // makeup gain dB
  attack: 4, // dial 1-7, 7 = fastest (20 us)
  release: 4, // dial 1-7, 7 = fastest (50 ms)
  ratio: '4', // '4' | '8' | '12' | '20' | 'all'
  fetDrive: 0.35, // FET / output-amp saturation
  scHpf: 0, // sidechain high-pass corner in Hz, 0 = off (stock)
  mix: 1, // wet/dry blend for parallel compression
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  return {
    inputDrive: params.inputDrive,
    outputGainDb: params.output,
    attack: params.attack,
    release: params.release,
    ratio: params.ratio,
    fetDrive: params.fetDrive,
    scHpfHz: params.scHpf,
    mix: params.mix,
  }
}

export function createFET1176Compressor(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off: the chain calls .disconnect()
  // on `output` during rebuilds (wiping ALL its outgoing connections), so
  // nothing internal may hang off `output` — taps and the worklet feed
  // preOutput instead, and preOutput -> output survives every rebuild.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...FET1176_DEFAULTS }
  let worklet = null
  let destroyed = false
  let grDb = 0

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
        if (e.data?.type === 'gr') grDb = e.data.grDb
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

    // Negative dB, matching DynamicsCompressorNode.reduction conventions.
    getReduction() {
      return -grDb
    },

    getInputLevels() {
      return inputTap.getLevels()
    },

    getOutputLevels() {
      return outputTap.getLevels()
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
  createNodes(audioContext) {
    return createFET1176Compressor(audioContext)
  },
}
