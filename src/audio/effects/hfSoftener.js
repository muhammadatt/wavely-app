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
import { SHAPER_LATENCY_SAMPLES } from '../hfSoftenerProcessor.js'
import {
  HF_RESO_FRAME_SIZE, HF_RESO_LATENCY_SAMPLES, HF_RESO_THRESHOLD_DEFAULT_DB, hfResoKernelParams,
} from '../hfSoftenerResoStage.js'
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
  resoThreshold: HF_RESO_THRESHOLD_DEFAULT_DB, // its Threshold (kernel `selectivity`), dB
  air: 0, // dB of Air Band lift after the cut — Air Boost's curve, 0–6
  drive: 0, // input waveshaper, 0–100 %; 0 = off, no latency
  curve: 'quartic', // shaper curve — see dsp/shaperCurves.js
  satMode: 'voiced', // 'voiced' (never shapes sibilants) | 'full'
  emph: 'off', // emphasis around the shaper: 'reverse' | 'off' | 'opto'
  split: 0, // 0–100 %: how the reduction is taken — 0 band cut (tone), 100 broadband duck (level)
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
    airDb: params.air,
    shaperDrive: (params.drive ?? 0) / 100,
    shaperCurve: params.curve,
    shaperMode: params.satMode,
    shaperEmph: params.emph,
    split: (params.split ?? 0) / 100,
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
  let broadbandDb = 0

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
    // The delta's dry side must match the whole chain's latency: the pre-stage
    // always, the shaper's oversampler only while it is engaged.
    resoDelay.delayTime.value = (HF_RESO_LATENCY_SAMPLES + (params.drive > 0 ? SHAPER_LATENCY_SAMPLES : 0))
      / audioContext.sampleRate
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
    // With the pre-stage in, the softener hands over its output WITHOUT the
    // air makeup ('preair'), so the wrapper's delta is only what was removed.
    worklet.port.postMessage({ type: 'listen', mode: delta ? (withReso ? 'preair' : 'delta') : 'off' })
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
          processorOptions: { params: hfResoKernelParams(params.resoThreshold), frameSize: HF_RESO_FRAME_SIZE },
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
      params[name] = value
      if (name === 'resoThreshold') {
        resoNode?.port.postMessage({ type: 'params', params: hfResoKernelParams(value) })
        return
      }
      if (name === 'reso') {
        ensureReso()
        rewire()
        return
      }
      worklet?.port.postMessage({ type: 'params', params: toKernelParams(params) })
      if (name === 'drive') resoDelay.delayTime.value = (HF_RESO_LATENCY_SAMPLES + (value > 0 ? SHAPER_LATENCY_SAMPLES : 0))
        / audioContext.sampleRate
    },

    getParam(name) {
      return params[name]
    },

    /** Shelf depth, positive dB — the max since the last meter post. */
    getReduction() {
      return reductionDb
    },

    /** Broadband share of the reduction (Split), positive dB — max since the last post. */
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
