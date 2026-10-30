/**
 * A user-settings key for a chain slot's `settingsKey()` (usePluginChain.js):
 * the params minus the ones the plugin MEASURES, keys sorted, as JSON — so a
 * knob move is a change and a re-measure (or a different key order) is not.
 * Its own module so it can be tested without the worklets the chain imports.
 */
export function settingsKeyOf(params, measured = []) {
  const out = {}
  for (const k of Object.keys(params).sort()) if (!measured.includes(k)) out[k] = params[k]
  return JSON.stringify(out)
}
