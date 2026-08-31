/**
 * Load the Inflator worklet module into an AudioContext or OfflineAudioContext,
 * once per context. See airBandWorkletLoader.js for why these go through
 * `?worker&url` rather than a raw asset URL.
 */
import workletUrl from './inflatorProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensureInflatorWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
