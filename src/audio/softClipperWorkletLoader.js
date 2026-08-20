/**
 * Load the Soft Clipper worklet module into an AudioContext or
 * OfflineAudioContext, once per context. See la2aWorkletLoader.js for why
 * these go through `?worker&url` rather than a raw asset URL.
 */
import workletUrl from './softClipperProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensureSoftClipperWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
