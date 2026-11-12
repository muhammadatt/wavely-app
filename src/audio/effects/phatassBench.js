/**
 * PHAT*SS bench — whether the TAPE curve / order choices are offered at all.
 *
 * ⚠ OFF IN A PRODUCTION BUILD: CUBIC and FIRST ship, and TANH / ALGEBRAIC /
 * LAST are kept only to A/B against them (owner, October 2026). On in dev, and
 * openable on a deployed build with `localStorage['wavely:phatass-bench'] = '1'`,
 * the same contract as the FET Punch bench (`fet1176Tuning.js`).
 *
 * Guarded: Node has neither `localStorage` nor `import.meta.env`.
 */
export function isPhatassBenchVisible() {
  try {
    if (globalThis.localStorage?.getItem('wavely:phatass-bench') === '1') return true
  } catch {
    // Storage access throws outright in some privacy modes; fall through.
  }
  return import.meta.env?.DEV === true
}
