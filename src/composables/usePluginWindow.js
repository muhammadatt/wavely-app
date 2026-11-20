import { computed, onMounted } from 'vue'
import { useEditorState } from './useEditorState.js'
import { currentPluginCopy } from './pluginCopies.js'
import { requestTogglePlayback } from '../ui/transportBus.js'

/**
 * What every plugin window does around its faceplate: switch the plugin on
 * when the window opens, Play / Stop for its Preview button, and close or
 * apply-then-close. These were pasted into ~20 panels; a panel now only draws
 * its controls (see docs/plugin-panel-audit.md).
 *
 * PREVIEW IS TRANSPORT PLAYBACK. The plugin's node is already in the signal
 * path while it is on, so what makes it "live" is that audio is running while
 * the knobs move; its Preview button asks the transport to play or stop
 * (transportBus.js) rather than having a play path of its own.
 *
 * The decisions are plain functions (`shouldEngageOnOpen`,
 * `pluginWindowActions`) so they can be tested without a component;
 * `usePluginWindow` wires them to the window's lifecycle.
 */

/**
 * Whether opening the window should switch the plugin on: only its SOLO copy,
 * and only when it is off. A chain copy keeps its ON/BYPASS — opening its
 * editor from the chain must not un-bypass its slot.
 */
export function shouldEngageOnOpen(engaged, copy) {
  return !engaged && copy === 'solo'
}

/**
 * The window's close and apply actions over the plugin's own `apply`,
 * `teardown` and `closeModal`.
 *
 * A window stays open when nothing was committed, so a refused or failed
 * apply (no selection, the plan, a tab switch mid-render, an error) leaves the
 * user where they were. The live plugins' apply resolves `false` for that and
 * `true` on a commit; anything else is read as a commit, so an apply that does
 * not report keeps closing as it always did. Closing stops the preview and
 * meters first (`teardown`).
 *
 * `closeOnlyOnSuccess` is the OFFLINE plugins' stricter rule (Auto Leveler,
 * Noise Reduction): only an apply that resolved truthy closes the window.
 */
export function pluginWindowActions({ apply, teardown, closeModal, closeOnlyOnSuccess = false }) {
  function close() {
    teardown?.()
  }
  async function applyAndClose() {
    const committed = await apply()
    if (closeOnlyOnSuccess) {
      if (committed) closeModal()
      return committed
    }
    if (committed === false) return false
    teardown?.()
    closeModal()
    return committed
  }
  return { close, applyAndClose, togglePlayback: requestTogglePlayback }
}

/**
 * Call from a plugin window's setup.
 *
 * @param {object} o
 * @param {import('vue').Ref<boolean>} [o.engaged]  the plugin's ON/BYPASS; omit for a window that does not engage on open
 * @param {() => void} [o.toggle]    switches it (the composable's `togglePreview`)
 * @param {() => void} [o.onOpen]    runs when the window opens, before the plugin is switched on
 * @param {() => Promise<unknown>} o.apply
 * @param {() => void} [o.teardown]
 * @param {() => void} o.closeModal
 * @param {boolean} [o.closeOnlyOnSuccess]
 */
export function usePluginWindow({ engaged, toggle, onOpen, apply, teardown, closeModal, closeOnlyOnSuccess }) {
  const { state } = useEditorState()
  // Read now: the copy is injected, and inject() only works during setup.
  const copy = currentPluginCopy()

  onMounted(() => {
    onOpen?.()
    if (engaged && toggle && shouldEngageOnOpen(engaged.value, copy)) toggle()
  })

  return {
    /** Whether the transport is playing: the Preview button's lit state. */
    isPlaying: computed(() => state.isPlaying),
    ...pluginWindowActions({ apply, teardown, closeModal, closeOnlyOnSuccess }),
  }
}
