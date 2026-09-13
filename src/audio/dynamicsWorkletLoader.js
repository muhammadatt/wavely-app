/**
 * Load the vocal chain's dynamics worklet into an AudioContext or
 * OfflineAudioContext, once per context.
 *
 * `?worker&url` makes Vite bundle dynamicsProcessor.js together with everything
 * it imports — three compressor kernels, the Pultec curves, the biquad and
 * oversampling toolkit — into one self-contained chunk, then hand back its URL.
 * A raw asset URL would be copied verbatim without following those imports,
 * which resolves in dev and 404s in a production build.
 *
 * That bundling is also why softClipperProcessor.js, fet1176Processor.js and
 * la2aProcessor.js each guard their own `registerProcessor` call: this chunk
 * contains a copy of all three, and more than one such chunk can end up in one
 * AudioContext.
 */
import workletUrl from './dynamicsProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensureDynamicsWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
