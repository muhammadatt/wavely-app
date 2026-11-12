/**
 * Load the Plosive Tamer worklet module into an AudioContext or
 * OfflineAudioContext, once per context.
 *
 * `?worker&url` bundles plosiveProcessor.js with what it imports from ./dsp/
 * into one self-contained chunk — see hfLimiterWorkletLoader.js for why a raw
 * asset URL will not do.
 */
import workletUrl from './plosiveProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensurePlosiveWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
