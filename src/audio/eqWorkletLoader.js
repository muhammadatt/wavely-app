/**
 * Load the manual EQ worklet module into an AudioContext or OfflineAudioContext,
 * once per context.
 *
 * `?worker&url` makes Vite bundle eqProcessor.js together with everything it
 * imports from ./dsp/ and ./eqBands.js into one self-contained chunk, then hand
 * back its URL. That is what lets kernels share the DSP toolkit at all: a raw
 * asset URL (`new URL(..., import.meta.url)`) is copied verbatim without
 * following its imports, so the dependency 404s in a production build even
 * though it resolves in dev.
 */
import workletUrl from './eqProcessor.js?worker&url'

const loadPromises = new WeakMap()

export function ensureManualEqWorklet(context) {
  let promise = loadPromises.get(context)
  if (!promise) {
    promise = context.audioWorklet.addModule(workletUrl)
    loadPromises.set(context, promise)
  }
  return promise
}
