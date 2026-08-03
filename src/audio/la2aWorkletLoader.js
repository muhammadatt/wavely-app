/**
 * Load the LA-2A worklet module into an AudioContext or OfflineAudioContext,
 * once per context.
 *
 * `?worker&url` bundles la2aProcessor.js and any of its imports into one
 * self-contained chunk. This kernel happens to be dependency-free, but the
 * loaders are kept uniform: the raw-asset form (`new URL(..., import.meta.url)`)
 * silently stops working the moment a kernel imports anything, and it fails only
 * in production builds — dev resolves the import fine. Going through the
 * bundler also minifies the kernel, which the raw-asset path does not.
 */
import workletUrl from './la2aProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensureLA2AWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
