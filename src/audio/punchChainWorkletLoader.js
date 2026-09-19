/**
 * Load the Punch Chain worklet module into an AudioContext or
 * OfflineAudioContext, once per context.
 *
 * `?worker&url` makes Vite bundle punchChainProcessor.js together with
 * everything it imports — BOTH compressor kernels, the oversampling toolkit,
 * the makeup reference and the density metrics — into one self-contained chunk,
 * then hand back its URL. A raw asset URL would be copied verbatim without
 * following those imports, which resolves in dev and 404s in a production
 * build.
 *
 * That bundling is also why both fet1176Processor.js and la2aProcessor.js guard
 * their own registerProcessor calls: this chunk contains a second copy of each,
 * and this worklet can share an AudioContext with either plugin's own.
 */
import workletUrl from './punchChainProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensurePunchChainWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
