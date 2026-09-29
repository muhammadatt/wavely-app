/**
 * HF Softener — real-time effect chain wrapper.
 *
 * The DSP lives in ../hfSoftenerProcessor.js (dynamic 4.5 kHz shelf, HF
 * detector with an optional phase rotator, adaptive threshold from low/mid
 * energy) and runs in an AudioWorklet. The offline apply path renders through
 * the same worklet in an OfflineAudioContext, so preview and apply share one
 * code path.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureHFSoftenerWorklet } from '../hfSoftenerWorkletLoader.js'
import { ensureResonanceWorklet } from '../resonanceWorkletLoader.js'
import { HF_RESO_FRAME_SIZE, HF_RESO_LATENCY_SAMPLES } from '../hfSoftenerResoStage.js'
import { createLevelTap } from './levelTap.js'
import { HF_SOFTENER_DEFAULTS, toKernelParams, resoOn, resoKernelParams } from '../hfSoftenerParams.js'

export { HF_SOFTENER_DEFAULTS, toKernelParams, resoOn, resoKernelParams } from '../hfSoftenerParams.js'

export function createHFSoftener(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...HF_SOFTENER_DEFAULTS }
  let worklet = null
  let destroyed = false
  let reductionDb = 0
  let thresholdLiftDb = 0
  let broadbandDb = 0

  // Monitor tap, kept out of `params` on purpose: parameters are what the
  // apply path renders with, and a monitor mode must never be one of them.
  let listen = 'off'

  // ── Routing ──────────────────────────────────────────────────────────────
  // input → softener (Duck → EQ → Air) → [Reso post-stage] → preOutput.
  // ⚠ RESO RUNS AFTER THE CUT: turning the "s" down first keeps its shape,
  // and Reso's voice-relative guard then reads the already-softened "s", so
  // it is left little to take on all but the hottest. With Reso in, DELTA is
  // built here — (input delayed by Reso's latency) − (final output) — from
  // the softener's pre-air output, so it shows only what was removed. ⚠ The
  // delay is a DelayNode at 512/fs, whose float32 time may land a hair off an
  // integer sample — a monitoring-only imprecision; apply never uses this path.
  const inputMonitor = audioContext.createGain()
  const outputMonitor = audioContext.createGain()
  preOutput.connect(outputMonitor)

  let resoNode = null
  const resoDelay = audioContext.createDelay(0.1)
  resoDelay.delayTime.value = HF_RESO_LATENCY_SAMPLES / audioContext.sampleRate
  const invert = audioContext.createGain()
  invert.gain.value = -1

  function rewire() {
    for (const n of [input, resoNode, worklet, resoDelay, invert]) n?.disconnect()
    input.connect(inputMonitor)
    if (!worklet) {
      input.connect(preOutput)
      return
    }
    const withReso = resoOn(params) && resoNode
    input.connect(worklet)
    const delta = listen === 'delta'
    // With Reso in, the softener hands over its output WITHOUT the air makeup
    // ('preair'), so the wrapper's delta is only what was removed.
    worklet.port.postMessage({ type: 'listen', mode: delta ? (withReso ? 'preair' : 'delta') : 'off' })
    const last = withReso ? resoNode : worklet
    if (withReso) worklet.connect(resoNode)
    if (delta && withReso) {
      input.connect(resoDelay)
      resoDelay.connect(preOutput)
      last.connect(invert)
      invert.connect(preOutput)
    } else {
      last.connect(preOutput)
    }
  }

  function ensureReso() {
    if (resoNode || !resoOn(params)) return
    ensureResonanceWorklet(audioContext)
      .then(() => {
        if (destroyed || resoNode) return
        resoNode = new AudioWorkletNode(audioContext, 'resonance-processor', {
          processorOptions: { params: resoKernelParams(params), frameSize: HF_RESO_FRAME_SIZE },
        })
        rewire()
      })
      .catch((err) => {
        console.error('HF Softener ResoTame pre-stage failed to load, running without it:', err)
      })
  }

  preOutput.connect(output)
  rewire() // bypassed until the worklet loads

  ensureHFSoftenerWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'hf-softener-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type !== 'gr') return
        reductionDb = e.data.reductionDb
        thresholdLiftDb = e.data.thresholdLiftDb
        broadbandDb = e.data.broadbandDb ?? 0
      }
      ensureReso()
      rewire()
    })
    .catch((err) => {
      console.error('HF Softener worklet failed to load, running bypassed:', err)
    })

  const inputTap = createLevelTap(audioContext, inputMonitor)
  const outputTap = createLevelTap(audioContext, outputMonitor)

  return {
    input,
    output,

    setParam(name, value) {
      if (!(name in params)) return
      const wasOn = resoOn(params)
      params[name] = value
      if (name === 'resoAmount' || name === 'guard') {
        resoNode?.port.postMessage({ type: 'params', params: resoKernelParams(params) })
      }
      if (name === 'resoAmount') {
        // Crossing 0 puts the Reso stage in or takes it out of the chain.
        if (resoOn(params) !== wasOn) {
          ensureReso()
          rewire()
        }
        return
      }
      worklet?.port.postMessage({ type: 'params', params: toKernelParams(params) })
    },

    getParam(name) {
      return params[name]
    },

    /** Shelf depth, positive dB — the max since the last meter post. */
    getReduction() {
      return reductionDb
    },

    /** The Duck stage's reduction, positive dB — max since the last post. */
    getBroadband() {
      return broadbandDb
    },

    /** How far Context is currently holding the threshold up, dB. */
    getThresholdLift() {
      return thresholdLiftDb
    },

    setListen(mode) {
      listen = mode
      rewire()
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
      resoNode?.disconnect()
      resoDelay.disconnect()
      invert.disconnect()
      preOutput.disconnect()
      output.disconnect()
      inputMonitor.disconnect()
      outputMonitor.disconnect()
      inputTap.destroy()
      outputTap.destroy()
    },
  }
}

export const hfSoftenerEffect = {
  id: 'hf-softener',
  name: 'HF Softener',
  createNodes(audioContext) {
    return createHFSoftener(audioContext)
  },
}
