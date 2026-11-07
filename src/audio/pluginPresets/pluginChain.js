/**
 * Saved Plugin Chains.
 *
 * A saved chain is the rack as it stands: its slots in processing order, each
 * with its plugin, whether it was on, and that slot's settings — the same
 * settings its own preset menu would store (composables/pluginSettings.js), so
 * nothing measured on one file travels to the next.
 *
 * Kept in the plugin preset store under its own id, so it is saved where the
 * user's plugin presets are (their account, or this browser with accounts off)
 * and gets the same menu. No factory chains ship yet.
 *
 * `normalize` only checks the SHAPE. Each slot's settings are checked by its
 * own plugin's preset whitelist when the chain is loaded (writePluginSettings),
 * which is where that plugin's rules live; a plugin this build does not know
 * is skipped at load with a note, not dropped here, so a chain saved in a build
 * with a dev-only plugin keeps it.
 */

import { definePluginPresets } from './store.js'

export const PLUGIN_CHAIN_PRESET_PLUGIN = 'plugin-chain'

export const PLUGIN_CHAIN_PARAM_KEYS = ['slots']

/** More than any rack anyone builds by hand; keeps a corrupt row bounded. */
export const PLUGIN_CHAIN_MAX_SLOTS = 32

function normalizeSlot(slot) {
  if (!slot || typeof slot !== 'object') return null
  const plugin = typeof slot.plugin === 'string' ? slot.plugin.trim() : ''
  if (!plugin) return null
  const settings = slot.settings && typeof slot.settings === 'object' && !Array.isArray(slot.settings)
    ? slot.settings
    : null
  return { plugin, active: slot.active !== false, settings }
}

function normalize(p) {
  const slots = Array.isArray(p.slots) ? p.slots : []
  return {
    slots: slots.map(normalizeSlot).filter(Boolean).slice(0, PLUGIN_CHAIN_MAX_SLOTS),
  }
}

export function registerPluginChainPresets() {
  return definePluginPresets({
    pluginId: PLUGIN_CHAIN_PRESET_PLUGIN,
    paramKeys: PLUGIN_CHAIN_PARAM_KEYS,
    factory: [],
    normalize,
  })
}

registerPluginChainPresets()
