/**
 * Load the De-Esser worklet module into an AudioContext or
 * OfflineAudioContext, once per context. `?worker&url` bundles the kernel with
 * what it imports from ./dsp/ — see airBandWorkletLoader.js for why.
 */
import workletUrl from './deEsserProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensureDeEsserWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
