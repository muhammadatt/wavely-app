/**
 * Load the Scheps Parallel worklet module into an AudioContext or
 * OfflineAudioContext, once per context.
 *
 * `?worker&url` makes Vite bundle schepsProcessor.js together with everything it
 * imports — the LA-2A kernel, the Pultec curves, the biquad and oversampling
 * toolkit — into one self-contained chunk, then hand back its URL. A raw asset
 * URL would be copied verbatim without following those imports, which resolves
 * in dev and 404s in a production build.
 *
 * That bundling is also why la2aProcessor.js guards its own registerProcessor
 * call: this chunk contains a second copy of it, and both can end up in one
 * AudioContext.
 */
import workletUrl from './schepsProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensureSchepsWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
