/**
 * One plugin's preset menu, as reactive state.
 *
 * The plugin supplies two functions and nothing else: `read()` returns its
 * current params, `write(params)` puts a set into effect. Everything about
 * which presets exist, what is stored and what "modified" means lives here and
 * in the store, so adding a menu to a fourth plugin is those two functions
 * plus a component tag.
 *
 * ⚠ NOT A SINGLETON, unlike the plugin composables around it. Those hold the
 * plugin's live state and must be shared between the sidebar trigger and the
 * panel; this holds a menu's open/closed state and a name being typed, which
 * are per-panel. What IS shared is the store underneath, and it notifies.
 */

import { computed, onUnmounted, ref } from 'vue'
import {
  listPresets, presetParams, matchPreset, saveUserPreset, deleteUserPreset,
  isFactoryPreset, onPresetsChanged,
} from '../audio/pluginPresets/index.js'

export function usePluginPresets(pluginId, { read, write }) {
  /**
   * Bumped whenever the user's collection changes, so the computed list
   * re-runs. The store is deliberately plain — it is imported by tests that
   * have no Vue — so reactivity is bolted on here rather than baked in.
   */
  const revision = ref(0)
  const stopListening = onPresetsChanged(() => { revision.value++ })
  onUnmounted(stopListening)

  /**
   * The preset last SELECTED, or null.
   *
   * Held separately from `matchPreset` because the two answer different
   * questions and the menu needs both: this one is "which name did the user
   * press", `matchPreset` is "do the knobs still say that". Without the first,
   * two presets with identical settings would be indistinguishable in the
   * menu; without the second, a knob move would leave a stale name lit.
   */
  const selectedId = ref(null)

  const presets = computed(() => {
    revision.value // eslint-disable-line no-unused-expressions
    return listPresets(pluginId)
  })

  /**
   * The preset the current settings ARE, or null.
   *
   * `read()` dereferences the plugin's own refs, so this computed tracks them
   * and re-measures on any knob move with no watcher and no change
   * notification from the panel. That matters most where the plugin moves a
   * knob by itself: auto makeup writes into the Gain ref asynchronously, and a
   * panel-driven invalidation would miss it.
   */
  const matchedId = computed(() => {
    revision.value // re-measure when the user's collection changes
    return matchPreset(pluginId, read())
  })

  /**
   * True when a preset is selected and the knobs have since moved off it.
   *
   * With nothing selected there is nothing to be dirty against, so the menu
   * reads "Presets" rather than "Modified" — a file opened and never given a
   * preset has not been modified, it has never been set.
   */
  const dirty = computed(() =>
    !!selectedId.value && matchedId.value !== selectedId.value
  )

  const activePreset = computed(() => {
    const id = selectedId.value ?? matchedId.value
    return presets.value.find(p => p.id === id) ?? null
  })

  const label = computed(() => {
    if (!activePreset.value) return 'Presets'
    return dirty.value ? `${activePreset.value.name} *` : activePreset.value.name
  })

  /** Put a preset into effect. Returns false if it has gone (a deleted id in a stale menu). */
  function select(presetId) {
    const params = presetParams(pluginId, presetId)
    if (!params) return false
    write(params)
    selectedId.value = presetId
    return true
  }

  /**
   * Save the current settings under a name.
   *
   * The saved preset becomes the selected one — otherwise the menu would go on
   * reading "Modified" immediately after a save, which says the opposite of
   * what just happened.
   */
  function save(name) {
    const saved = saveUserPreset(pluginId, name, read())
    selectedId.value = saved.id
    return saved
  }

  function remove(presetId) {
    if (isFactoryPreset(pluginId, presetId)) return false
    const removed = deleteUserPreset(pluginId, presetId)
    // The knobs stay exactly where they are: deleting a name is not an edit to
    // the sound, and reverting the audio underneath someone who tidied their
    // menu would be a surprise with no undo.
    if (removed && selectedId.value === presetId) selectedId.value = null
    return removed
  }

  /** Reload the selected preset, discarding changes made since. */
  function revert() {
    if (!selectedId.value) return false
    return select(selectedId.value)
  }

  function canSaveAs(name) {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) return false
    return !presets.value.some(
      p => p.source === 'factory' && p.name.toLowerCase() === trimmed.toLowerCase()
    )
  }

  return {
    presets,
    selectedId,
    activePreset,
    matchedId,
    dirty,
    label,
    select,
    save,
    remove,
    revert,
    canSaveAs,
    isFactory: (id) => isFactoryPreset(pluginId, id),
  }
}
