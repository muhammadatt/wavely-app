/**
 * HF Softener — real-time effect chain wrapper.
 *
 * The DSP lives in ../deEsserProcessor.js (dynamic 4.5 kHz shelf, HF
 * detector with an optional phase rotator, adaptive threshold from low/mid
 * energy) and runs in an AudioWorklet. The offline apply path renders through
 * the same worklet in an OfflineAudioContext, so preview and apply share one
 * code path.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureHFSoftenerWorklet } from '../deEsserWorkletLoader.js'
import { ensureResonanceWorklet } from '../resonanceWorkletLoader.js'
import { ensureHFLimiterWorklet } from '../hfLimiterWorkletLoader.js'
import { softenLatencySamples } from '../deEsserSoftenStage.js'
import { HF_RESO_FRAME_SIZE, HF_RESO_LATENCY_SAMPLES } from '../deEsserResoStage.js'
import { createLevelTap, createSpectrumTap } from './levelTap.js'
import { createScopeRing } from '../deEsserScope.js'
import { HF_SOFTENER_DEFAULTS, toKernelParams, resoOn, resoKernelParams, softenOn, softenStageKernelParams } from '../deEsserParams.js'

export { HF_SOFTENER_DEFAULTS, toKernelParams, resoOn, resoKernelParams, softenOn, softenStageKernelParams } from '../deEsserParams.js'

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
  let resoDb = 0
  let softenDb = 0
  // Lamp: the Air lift, since the last meter post.
  let airLamp = 0
  // Activity scope: one point per kernel quantum, appended as they arrive.
  const scope = createScopeRing(audioContext.sampleRate)
  // Held while the transport is stopped: the worklet keeps running on
  // silence, and without the hold that silence scrolled what just played
  // off the scope within its two seconds of history.
  let scopeHeld = false

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
  // Soften: the HF Limiter's kernel with the shelf out (deEsserSoftenStage.js),
  // after Reso. Like Reso it is in the chain only while its knob is above 0.
  let softenNode = null
  const postDelay = audioContext.createDelay(0.1)
  const invert = audioContext.createGain()
  invert.gain.value = -1

  function rewire() {
    for (const n of [input, resoNode, softenNode, worklet, postDelay, invert]) n?.disconnect()
    input.connect(inputMonitor)
    if (!worklet) {
      input.connect(preOutput)
      return
    }
    // The post-stages in, in chain order, with their latencies.
    const post = []
    if (resoOn(params) && resoNode) post.push([resoNode, HF_RESO_LATENCY_SAMPLES])
    if (softenOn(params) && softenNode) post.push([softenNode, softenLatencySamples(audioContext.sampleRate)])
    input.connect(worklet)
    const delta = listen === 'delta'
    // AUDITION: the detector's own signal (its band), straight out of the
    // softener — the post-stages would only process a signal that is not audio.
    const audition = listen === 'sidechain'
    // With a post-stage in, the softener hands over its output WITHOUT the air
    // makeup ('preair'), so the wrapper's delta is only what was removed.
    worklet.port.postMessage({ type: 'listen', mode: audition ? 'sidechain' : delta ? (post.length ? 'preair' : 'delta') : 'off' })
    let last = worklet
    for (const [node] of audition ? [] : post) {
      last.connect(node)
      last = node
    }
    if (delta && post.length && !audition) {
      postDelay.delayTime.value = post.reduce((s, [, l]) => s + l, 0) / audioContext.sampleRate
      input.connect(postDelay)
      postDelay.connect(preOutput)
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
        resoNode.port.onmessage = (e) => {
          if (e.data?.type === 'gr') resoDb = e.data.grDb ?? 0
        }
        rewire()
      })
      .catch((err) => {
        console.error('HF Softener ResoTame pre-stage failed to load, running without it:', err)
      })
  }

  function ensureSoften() {
    if (softenNode || !softenOn(params)) return
    ensureHFLimiterWorklet(audioContext)
      .then(() => {
        if (destroyed || softenNode) return
        softenNode = new AudioWorkletNode(audioContext, 'hf-limiter-processor', {
          processorOptions: { params: softenStageKernelParams(params) },
        })
        softenNode.port.onmessage = (e) => {
          if (e.data?.type === 'gr') softenDb = e.data.transientDb ?? 0
        }
        rewire()
      })
      .catch((err) => {
        console.error('HF Softener Soften stage failed to load, running without it:', err)
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
        airLamp = e.data.air ?? 0
        if (!scopeHeld) scope.push(e.data.scope)
      }
      ensureReso()
      ensureSoften()
      rewire()
    })
    .catch((err) => {
      console.error('HF Softener worklet failed to load, running bypassed:', err)
    })

  const inputTap = createLevelTap(audioContext, inputMonitor)
  const outputTap = createLevelTap(audioContext, outputMonitor)
  // The input's spectrum, drawn behind the response curve with the Detect and
  // Band corners over it. Created on first read, so a closed panel costs no FFT.
  let spectrumTap = null

  return {
    input,
    output,

    setParam(name, value) {
      if (!(name in params)) return
      const wasOn = resoOn(params)
      const wasSoften = softenOn(params)
      params[name] = value
      if (name === 'resoAmount' || name === 'guard') {
        resoNode?.port.postMessage({ type: 'params', params: resoKernelParams(params) })
      }
      if (name === 'soften' || name === 'levelOffset') {
        softenNode?.port.postMessage({ type: 'params', params: softenStageKernelParams(params) })
      }
      if (name === 'soften') {
        // Crossing 0 puts the Soften stage in or takes it out of the chain.
        if (softenOn(params) !== wasSoften) {
          ensureSoften()
          rewire()
        }
        return
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

    /** The Reso stage's reduction, positive dB; 0 while it is out. */
    getReso() {
      return resoOn(params) && resoNode ? resoDb : 0
    },

    /** The Soften stage's deepest onset cut, positive dB; 0 while it is out. */
    getSoften() {
      return softenOn(params) && softenNode ? softenDb : 0
    },

    /** Air lamp (0–1), from the last meter post. */
    getLamps() {
      return { air: airLamp }
    },

    /** The activity scope's ring — see deEsserScope.js. Read, do not retain. */
    getScope() {
      return scope.view()
    },

    /** Freeze (or release) the scope's history — see `scopeHeld`. */
    holdScope(on) {
      scopeHeld = !!on
    },

    /** Drop the scope's history, e.g. after a seek made it describe other audio. */
    clearScope() {
      scope.clear()
    },

    /** The input's spectrum tap, created on first call. */
    getInputSpectrum() {
      if (!spectrumTap && !destroyed) spectrumTap = createSpectrumTap(audioContext, inputMonitor)
      return spectrumTap
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
      softenNode?.disconnect()
      postDelay.disconnect()
      invert.disconnect()
      preOutput.disconnect()
      output.disconnect()
      inputMonitor.disconnect()
      outputMonitor.disconnect()
      inputTap.destroy()
      outputTap.destroy()
      spectrumTap?.destroy()
    },
  }
}

export const hfSoftenerEffect = {
  id: 'hf-softener',
  name: 'De-Esser',
  createNodes(audioContext) {
    return createHFSoftener(audioContext)
  },
}
