/**
 * Load the HF Softener worklet module into an AudioContext or
 * OfflineAudioContext, once per context. `?worker&url` bundles the kernel with
 * what it imports from ./dsp/ — see airBandWorkletLoader.js for why.
 */
import workletUrl from './hfSoftenerProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensureHFSoftenerWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
