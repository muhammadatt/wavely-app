import { PLUGIN_SETTINGS } from './pluginSettings.js'

/**
 * What a shared link (audio/shareLink.js) offers, resolved against this build.
 * Kept apart from useSharedLink.js so it can be tested without the registry,
 * which imports every faceplate: the caller passes the registry's answers.
 */

/** The registry id of the plugin that owns a preset collection, or null. */
export function pluginForPresetCollection(collectionId) {
  for (const [opId, entry] of Object.entries(PLUGIN_SETTINGS)) {
    if (entry.presetPlugin === collectionId) return opId
  }
  return null
}

/**
 * The offer a payload makes, or null if nothing in it can load here.
 *   chainIds      ids of the plugins this build can put in the chain
 *   getOperation  the registry's lookup (released operations only)
 */
export function resolveOffer(payload, { chainIds, getOperation }) {
  if (!payload) return null
  if (payload.kind === 'preset') {
    const opId = pluginForPresetCollection(payload.preset)
    const op = opId ? getOperation(opId) : null
    if (!op) return null
    return { ...payload, opId, pluginLabel: op.label }
  }
  const allowed = new Set(chainIds)
  const plugins = payload.params.slots.map((s) => {
    const id = typeof s?.plugin === 'string' ? s.plugin : ''
    const available = allowed.has(id) && !!PLUGIN_SETTINGS[id]
    return { label: getOperation(id)?.label ?? (id || 'Unknown plugin'), available, active: s?.active !== false }
  })
  if (!plugins.some(p => p.available)) return null
  return { ...payload, plugins }
}
