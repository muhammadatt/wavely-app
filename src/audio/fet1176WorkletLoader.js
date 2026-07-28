/**
 * Load the FET Punch worklet module into an AudioContext or
 * OfflineAudioContext, once per context. fet1176Processor.js is referenced as
 * a raw asset URL (it is deliberately dependency-free so it works unbundled in
 * the worklet scope).
 */
const loadPromises = new WeakMap()

export function ensureFET1176Worklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(
      new URL('./fet1176Processor.js', import.meta.url)
    )
    loadPromises.set(context, promise)
  }
  return promise
}
