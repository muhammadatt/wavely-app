/**
 * Load the VoxPressor worklet module into an AudioContext or
 * OfflineAudioContext, once per context.
 *
 * `?worker&url` makes Vite bundle voxPressorProcessor.js together with the
 * 1176 and LA-2A kernels it holds into one self-contained chunk — see
 * schepsWorkletLoader.js for why a raw asset URL would 404 in production, and
 * why both kernels guard their own `registerProcessor` call.
 */
import workletUrl from './voxPressorProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensureVoxPressorWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
