/**
 * VoxPressor bench — whether the A/B choices (Body lookahead, the Parallel
 * compressor, its de-esser and cut, the 1176's sibilance detector) and the
 * measured-values line are offered at all. They sit in a collapsed BENCH
 * section under the faceplate, never on it (owner, November 2026).
 *
 * On in dev, and openable on a deployed build with
 * `localStorage['wavely:voxpressor-bench'] = '1'`, the PHAT*SS bench's contract
 * (`phatassBench.js`). The shipping values stay in effect when it is hidden.
 *
 * Guarded: Node has neither `localStorage` nor `import.meta.env`.
 */
export function isVoxPressorBenchVisible() {
  try {
    if (globalThis.localStorage?.getItem('wavely:voxpressor-bench') === '1') return true
  } catch {
    // Storage access throws outright in some privacy modes; fall through.
  }
  return import.meta.env?.DEV === true
}
