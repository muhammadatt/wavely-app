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
import { fet1176TuningOverrides } from './fet1176Tuning.js'
import { OVERSAMPLE_LATENCY_SAMPLES } from '../dsp/oversample.js'
import { createLevelTap } from './levelTap.js'

/**
 * The gain cell and FET stage run oversampled, and the halfband filters that
 * get them there are linear phase, so the plugin delays. Constant at every
 * setting — see `latencySamples` on the kernel.
 */
export const FET1176_LATENCY_SAMPLES = OVERSAMPLE_LATENCY_SAMPLES

export const FET1176_DEFAULTS = {
  inputDrive: 50, // 0-100, drives the fixed internal threshold
  output: 0, // makeup gain dB
  attack: 4, // dial 1-7, 7 = fastest (20 us)
  release: 4, // dial 1-7, 7 = fastest (50 ms)
  ratio: '4', // '4' | '8' | '12' | '20' | 'all'
  /**
   * FET / output-amp saturation, 0-1, where 1 IS the curve measured from
   * FETish rather than an arbitrary top of travel.
   *
   * ⚠ THIS FILE HAD ITS OWN COPY OF THE DEFAULT AND IT WENT STALE. The kernel's
   * default moved to 1 with the measured curve; this one stayed at 0.35, and
   * since `toKernelParams` always sends `fetDrive` the kernel's value never
   * applied in the app — the panel would have shipped 35 % of the curve while
   * every test and script saw the whole of it.
   */
  fetDrive: 1,
  scHpf: 0, // sidechain high-pass corner in Hz, 0 = off (stock)
  mix: 1, // wet/dry blend for parallel compression
}

/**
 * Map UI param names to kernel param names.
 *
 * ⚠ THE BENCH TUNING IS FOLDED IN HERE AND NOWHERE ELSE. Both the live worklet
 * and the offline apply path build their params through this function, so
 * merging at one point is what keeps them sample-identical — the alternative is
 * threading the tuning through every caller and relying on none of them
 * forgetting. `fet1176TuningOverrides()` is empty unless the bench panel has
 * been touched, so the untouched result is byte-identical to what this returned
 * before the panel existed. See `fet1176Tuning.js`.
 */
export function toKernelParams(params) {
  return {
    ...fet1176TuningOverrides(),
    inputDrive: params.inputDrive,
    outputGainDb: params.output,
    attack: params.attack,
    release: params.release,
    ratio: params.ratio,
    fetDrive: params.fetDrive,
    scHpfHz: params.scHpf,
    mix: params.mix,
    inputAlignDb: params.inputAlignDb ?? 0,
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

  /**
   * ⚠ `inputAlignDb` IS SEEDED HERE BECAUSE `setParam` GATES ON `name in params`.
   * It is measured from the file rather than dialled, so it is deliberately
   * absent from `FET1176_DEFAULTS` — and without a seed that gate would drop
   * every push of it silently, leaving preview running the raw level-dependent
   * behaviour while apply ran the aligned one. Exactly the reason `ceilingDb`
   * and `inputAlignDb` are seeded in `la2aCompressor.js`.
   */
  let params = { ...FET1176_DEFAULTS, inputAlignDb: null }
  let worklet = null
  let destroyed = false
  let grDb = 0
  let liveMakeupDb = null

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

    /**
     * Re-send the kernel params without changing a patch param. The bench
     * tuning is folded in by `toKernelParams` rather than held here, so there
     * is no param name to set — the panel moves module state and then asks the
     * live node to pick it up.
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

export const fet1176Effect = {
  id: 'fet1176-compressor',
  name: 'FET Punch Compressor',
  latencySamples: FET1176_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createFET1176Compressor(audioContext)
  },
}
