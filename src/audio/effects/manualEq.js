/**
 * Manual EQ — real-time effect chain wrapper.
 *
 * The DSP lives in ../eqProcessor.js (a cascade of up to MAX_BANDS RBJ biquads)
 * and runs in an AudioWorklet. The offline apply path renders through the same
 * worklet in an OfflineAudioContext, so the preview is sample-identical to what
 * gets written to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureManualEqWorklet } from '../eqWorkletLoader.js'
import { createLevelTap, createSpectrumTap } from './levelTap.js'

export const MANUAL_EQ_DEFAULTS = {
  bands: [],
  output: 0, // output trim dB, for level-matched A/B
  soloIndex: null,
  soloProbe: null,
}

/**
 * Map UI params to kernel params.
 *
 * Bands are copied field by field rather than passed through. They arrive as
 * Vue reactive proxies, and `postMessage` throws DataCloneError on a proxy —
 * so this is not defensive tidiness, it is what makes the message send at all.
 * Only the fields the kernel reads are copied; role metadata stays in the UI.
 */
export function toKernelParams(params) {
  return {
    bands: (params.bands ?? []).map(b => ({
      type: b.type,
      frequencyHz: b.frequencyHz,
      gainDb: b.gainDb,
      q: b.q,
      enabled: b.enabled,
    })),
    outputGainDb: params.output ?? 0,
    soloIndex: params.soloIndex ?? null,
    // Copied field by field for the same reason the bands are: it arrives as a
    // reactive proxy and postMessage throws DataCloneError on one.
    soloProbe: params.soloProbe
      ? {
        type: params.soloProbe.type,
        frequencyHz: params.soloProbe.frequencyHz,
        q: params.soloProbe.q,
      }
      : null,
  }
}

export function createManualEq(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off: the chain calls .disconnect()
  // on `output` during rebuilds (wiping ALL its outgoing connections), so
  // nothing internal may hang off `output` — taps and the worklet feed
  // preOutput instead, and preOutput -> output survives every rebuild.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...MANUAL_EQ_DEFAULTS }
  let worklet = null
  let destroyed = false

  // Pass through until the worklet module is loaded, then splice it in.
  input.connect(preOutput)
  preOutput.connect(output)

  ensureManualEqWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'manual-eq-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Manual EQ worklet failed to load, running bypassed:', err)
    })

  // Meter and analyzer taps on dedicated monitor nodes fed from stable internal
  // points (input / preOutput), never from `output` — see note above.
  const inputMonitor = audioContext.createGain()
  input.connect(inputMonitor)
  const outputMonitor = audioContext.createGain()
  preOutput.connect(outputMonitor)

  const inputTap = createLevelTap(audioContext, inputMonitor)
  const outputTap = createLevelTap(audioContext, outputMonitor)
  // Post-EQ spectrum — the trace the General-mode analyzer draws.
  const spectrumTap = createSpectrumTap(audioContext, outputMonitor)

  function push() {
    worklet?.port.postMessage({ type: 'params', params: toKernelParams(params) })
  }

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

    getInputLevels() {
      return inputTap.getLevels()
    },

    getOutputLevels() {
      return outputTap.getLevels()
    },

    getSpectrumDb() {
      return spectrumTap.getSpectrumDb()
    },

    getSpectrumBinWidthHz() {
      return spectrumTap.binWidthHz
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
      spectrumTap.destroy()
    },
  }
}

/**
 * Mint an EQ effect.
 *
 * A factory rather than a singleton because EQ and VoiceRx are two plugins with
 * two band pools, and EffectChain keys entries by id — one shared literal would
 * mean the two overwrite each other's bands on every push.
 */
export function createEqEffect(id, name) {
  return {
    id,
    name,
    createNodes(audioContext) {
      return createManualEq(audioContext)
    },
  }
}

export const manualEqEffect = createEqEffect('manual-eq', 'EQ')

/**
 * VoiceRx's own cascade. Added to the chain ahead of the general EQ — corrective
 * before creative, the same order the server pipeline uses.
 */
export const voiceRxEqEffect = createEqEffect('voicerx-eq', 'VoiceRx')
