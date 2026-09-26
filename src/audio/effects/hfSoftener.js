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
import { HF_RESO_FRAME_SIZE, HF_RESO_LATENCY_SAMPLES, hfResoKernelParams } from '../hfSoftenerResoStage.js'
import { createLevelTap } from './levelTap.js'

export const HF_SOFTENER_DEFAULTS = {
  amount: 40, // %, drives threshold, ratio and depth together — see amountToThresholdDb
  context: 50, // %, Module C depth; 0 = fixed threshold
  rotator: 'sidechain', // 'off' | 'sidechain' | 'inpath'
  release: 40, // ms, HF release outside vowels — fixed, not on the panel
  vowelRelease: true, // let go fast when a vowel starts
  shape: 'band', // 'shelf' | 'band'
  lispGuard: true, // never cut a sibilant below the voice-relative floor
  reso: false, // band-limited ResoTame ahead of the softener — see hfSoftenerResoStage.js
  // Measured from the whole file, not a user setting — see useHFSoftener.
  levelOffset: 0, // dB, file gated RMS minus nominal
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  return {
    amount: params.amount / 100,
    context: params.context / 100,
    rotator: params.rotator,
    releaseMs: params.release,
    vowelRelease: params.vowelRelease,
    shape: params.shape,
    lispGuard: params.lispGuard,
    levelOffsetDb: params.levelOffset,
  }
}

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

  // Monitor tap, kept out of `params` on purpose: parameters are what the
  // apply path renders with, and a monitor mode must never be one of them.
  let listen = 'off'

  // ── Routing ──────────────────────────────────────────────────────────────
  // input → [ResoTame pre-stage] → softener → preOutput, with DELTA built
  // here when the pre-stage is in: the softener's own delta would only hear
  // what IT removed, so the monitor becomes (input delayed by the pre-stage's
  // latency) − (final output) and covers both stages. ⚠ The delay is a
  // DelayNode at 512/fs, whose float32 time may land a hair off an integer
  // sample — a monitoring-only imprecision; apply never uses this path.
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
    const withReso = params.reso && resoNode
    let src = input
    if (withReso) {
      input.connect(resoNode)
      src = resoNode
    }
    src.connect(worklet)
    const delta = listen === 'delta'
    worklet.port.postMessage({ type: 'listen', mode: delta && !withReso ? 'delta' : 'off' })
    if (delta && withReso) {
      input.connect(resoDelay)
      resoDelay.connect(preOutput)
      worklet.connect(invert)
      invert.connect(preOutput)
    } else {
      worklet.connect(preOutput)
    }
  }

  function ensureReso() {
    if (resoNode || !params.reso) return
    ensureResonanceWorklet(audioContext)
      .then(() => {
        if (destroyed || resoNode) return
        resoNode = new AudioWorkletNode(audioContext, 'resonance-processor', {
          processorOptions: { params: hfResoKernelParams(), frameSize: HF_RESO_FRAME_SIZE },
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
      params[name] = value
      if (name === 'reso') {
        ensureReso()
        rewire()
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
