/**
 * Plosive Tamer — real-time effect chain wrapper.
 *
 * The DSP lives in ../plosiveProcessor.js (a POP stage — a dynamic high-pass on
 * the low-frequency thump of a P or B — and a BURST stage — a dynamic low-pass
 * on the T, K and P release out of a stop's silence) and runs in an
 * AudioWorklet. The offline apply path renders through the same worklet in an
 * OfflineAudioContext, so preview and apply share one code path.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensurePlosiveWorklet } from '../plosiveWorkletLoader.js'
import { createLevelTap } from './levelTap.js'
import { createScopeRing } from '../deEsserScope.js'
import { PLOSIVE_DEFAULTS, toKernelParams } from '../plosiveParams.js'

export { PLOSIVE_DEFAULTS, toKernelParams } from '../plosiveParams.js'

export function createPlosive(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...PLOSIVE_DEFAULTS }
  let worklet = null
  let destroyed = false
  let popDb = 0
  let burstDb = 0
  // The kernel's running event counts, and where they stood when last reset.
  let pops = 0
  let bursts = 0
  let popsBase = 0
  let burstsBase = 0
  // Activity scope: the De-Esser's ring and drawing, one point per quantum —
  // a POP cut shades in the accent, a BURST cut in the plosive colour.
  const scope = createScopeRing(audioContext.sampleRate)
  // Held while the transport is stopped, so the worklet's idle silence does not
  // scroll what just played off the scope (the De-Esser's `scopeHeld`).
  let scopeHeld = false
  // Monitor tap, kept out of `params` on purpose: parameters are what the
  // apply path renders with, and a monitor mode must never be one of them.
  let listen = 'off'

  input.connect(preOutput)
  preOutput.connect(output)

  ensurePlosiveWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'plosive-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      worklet.port.onmessage = (e) => {
        if (e.data?.type !== 'meters') return
        popDb = e.data.popDb
        burstDb = e.data.burstDb
        pops = e.data.pops
        bursts = e.data.bursts
        if (!scopeHeld) scope.push(e.data.scope)
      }
      worklet.port.postMessage({ type: 'listen', mode: listen })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Plosive Tamer worklet failed to load, running bypassed:', err)
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
      if (!(name in params)) return
      params[name] = value
      worklet?.port.postMessage({ type: 'params', params: toKernelParams(params) })
    },

    getParam(name) {
      return params[name]
    },

    /** Deepest POP and BURST cuts since the last meter post, positive dB. */
    getReduction() {
      return { pop: popDb, burst: burstDb }
    },

    /** Events caught since the last resetCounts(). */
    getCounts() {
      return { pops: pops - popsBase, bursts: bursts - burstsBase }
    },

    resetCounts() {
      popsBase = pops
      burstsBase = bursts
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

    setListen(mode) {
      listen = mode
      worklet?.port.postMessage({ type: 'listen', mode })
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

export const plosiveEffect = {
  id: 'plosive',
  name: 'Plosive Tamer',
  createNodes(audioContext) {
    return createPlosive(audioContext)
  },
}
