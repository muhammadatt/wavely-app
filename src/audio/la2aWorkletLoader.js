/**
 * Load the LA-2A worklet module into an AudioContext or OfflineAudioContext,
 * once per context. la2aProcessor.js is referenced as a raw asset URL (it is
 * deliberately dependency-free so it works unbundled in the worklet scope).
 */
const loadPromises = new WeakMap()

export function ensureLA2AWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(
      new URL('./la2aProcessor.js', import.meta.url)
    )
    loadPromises.set(context, promise)
  }
  return promise
}
