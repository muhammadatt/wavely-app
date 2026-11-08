import { effectScope, watch } from 'vue'
import { usePluginChain } from './usePluginChain.js'
import { usePluginPresets } from './usePluginPresets.js'
import { useEditorState } from './useEditorState.js'
import { baseId, copyOfId } from './pluginCopies.js'
import { PLUGIN_SETTINGS, pluginSettingsIO, writePluginSettings, chainSettingsOf } from './pluginSettings.js'
import { chainPlugins, getOperation } from '../ui/registry.js'
import { PLUGIN_CHAIN_PRESET_PLUGIN } from '../audio/pluginPresets/index.js'

/**
 * Saved Plugin Chains — the chain window's preset menu.
 *
 * The same menu every plugin has (usePluginPresets), over the whole rack: a
 * saved chain is its slots in order, each with its plugin, its ON/BYPASS and
 * its settings as that plugin's own preset menu would store them
 * (pluginSettings.js). Loading one REPLACES the rack, as loading a plugin
 * preset replaces its knobs.
 *
 * ⚠ THE MENU READS EVERY SLOT'S SETTINGS INSIDE A COMPUTED (the "modified"
 * check), so the read must not BUILD anything: asking a plugin composable for a
 * copy re-registers it with the chain, which rewrites `slots`, which the same
 * computed reads. Each slot's settings reader is therefore resolved once, when
 * the slot appears, by a synchronous watcher outside any computed, and the read
 * only dereferences it. Sync, not the default pre-flush: a slot removed and
 * re-added under the same id in one tick (Load does exactly that) is a NEW copy
 * of the plugin, and a batched watcher would never see the old one go.
 */

// Slot id → its settings reader. App-lifetime state, like the chain itself.
const readers = new Map()

effectScope(true).run(() => {
  const { slots } = usePluginChain()
  watch(slots, (list) => {
    const live = new Set(list.map(s => s.id))
    for (const id of readers.keys()) if (!live.has(id)) readers.delete(id)
    for (const s of list) {
      if (readers.has(s.id) || !s.windowId) continue
      // Set before resolving: resolving re-registers the copy and re-enters
      // this watcher, which must find the slot already handled.
      readers.set(s.id, null)
      readers.set(s.id, pluginSettingsIO(baseId(s.windowId), copyOfId(s.windowId)))
    }
  }, { flush: 'sync', immediate: true })
})

/** The rack as a saved chain's params. Reactive on every slot's settings. */
export function captureChain(slots) {
  return {
    slots: slots.map((s) => {
      const plugin = baseId(s.windowId ?? s.id)
      const io = readers.get(s.id)
      const settings = io ? chainSettingsOf(plugin, JSON.parse(JSON.stringify(io.read() ?? null))) : null
      return { plugin, active: s.active, settings }
    }),
  }
}

export function useChainPresets() {
  const chain = usePluginChain()
  const { showToast } = useEditorState()

  /**
   * Replace the rack with a saved chain. A plugin this build cannot put in the
   * chain (a dev-only one in production, or one since removed) is skipped and
   * named, rather than failing the whole load.
   */
  function load(params) {
    const allowed = new Set(chainPlugins().map(op => op.id))
    chain.clear()
    const skipped = []
    for (const slot of params.slots ?? []) {
      if (!allowed.has(slot.plugin) || !PLUGIN_SETTINGS[slot.plugin]) {
        skipped.push(getOperation(slot.plugin)?.label ?? slot.plugin)
        continue
      }
      const id = chain.add(slot.plugin, {
        open: false,
        // Builds the copy and writes its settings before it joins, so it
        // starts playing with them rather than with the defaults.
        prepare: (copy) => {
          if (!writePluginSettings(slot.plugin, copy, slot.settings)) {
            pluginSettingsIO(slot.plugin, copy)
          }
        },
      })
      if (id && slot.active === false) chain.setSlotActive(id, false)
    }
    if (skipped.length) {
      showToast(`Chain loaded without ${skipped.join(', ')} — not available in this version`)
    }
  }

  return usePluginPresets(PLUGIN_CHAIN_PRESET_PLUGIN, {
    read: () => captureChain(chain.slots.value),
    write: load,
  })
}
