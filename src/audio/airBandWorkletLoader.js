/**
 * Load the Air Band worklet module into an AudioContext or OfflineAudioContext,
 * once per context.
 *
 * `?worker&url` makes Vite bundle airBandProcessor.js together with everything
 * it imports from ./dsp/ into one self-contained chunk, then hand back its URL.
 * That is what lets kernels share the DSP toolkit at all: a raw asset URL
 * (`new URL(..., import.meta.url)`) is copied verbatim without following its
 * imports, so the dependency 404s in a production build even though it resolves
 * in dev.
 */
import workletUrl from './airBandProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensureAirBandWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
