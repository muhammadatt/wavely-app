import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useEntitlements } from './useEntitlements.js'
import { CHAIN_WINDOW_ID } from './useWindows.js'
import {
  chainWindowMounted, chainWindowUnmounted, chainStatusFor, chainApplying,
} from './usePluginChain.js'
import { isChainCopyId } from './pluginCopies.js'
import { isOffline } from '../auth/plans.js'
import { applyGate } from '../ui/applyGate.js'

export { applyGate }

/**
 * What every plugin window's FRAME decides, as opposed to draws: whether Apply
 * may run and why not, the window's place in the Plugin Chain, and what opening
 * and closing it does to the chain and the selection. FloatingWindow.vue draws
 * it; another shell (a phone layout) would call the same thing.
 */


/**
 * Call from the window's setup.
 *
 * @param {object} o
 * @param {string} o.windowId     the window this frame IS (its copy's id)
 * @param {() => object} o.props  the frame's props, read live: applyDisabled,
 *   applyDisabledHint, requiresSelection, applyFeature
 * @param {import('vue').Ref<boolean>} o.hasFooter  whether it can preview or apply
 */
export function useWindowFrame({ windowId, props, hasFooter }) {
  const { state, hasSelection, selectAll } = useEditorState()
  const entitlements = useEntitlements()

  /**
   * Its slot in the Plugin Chain, or null. A plugin with a slot says so (a
   * chain badge with its slot number) and has NO APPLY of its own: the chain's
   * Apply writes it, in order with the rest.
   */
  const inChain = computed(() => {
    const status = chainStatusFor(windowId)
    return status?.member ? status : null
  })

  /**
   * While the chain applies, the chain and its copies' windows take no input:
   * a knob turned or a slot removed mid-render would change what is rendered.
   */
  const frozen = computed(() => chainApplying.value && (windowId === CHAIN_WINDOW_ID || isChainCopyId(windowId)))

  const busy = computed(() => !!state.isProcessing)
  const applyLocked = computed(() => !!props().applyFeature && !entitlements.can(props().applyFeature))
  const gate = computed(() => {
    const p = props()
    return applyGate({
      inChain: !!inChain.value,
      busy: busy.value,
      applyDisabled: p.applyDisabled,
      applyDisabledHint: p.applyDisabledHint,
      requiresSelection: p.requiresSelection,
      hasSelection: hasSelection.value,
      locked: applyLocked.value,
      lockedHint: applyLocked.value ? entitlements.hint(p.applyFeature) : '',
      offline: !!p.applyFeature && isOffline(p.applyFeature),
    })
  })

  /** Apply was clicked: ask for the plan if it is locked, else run `apply`. */
  function requestApply(apply) {
    const feature = props().applyFeature
    if (feature && !entitlements.request(feature)) return
    apply()
  }

  onMounted(() => {
    // A plugin keeps playing in the chain while its window is closed, with its
    // meters stopped; reopening the window brings them back.
    chainWindowMounted(windowId)
    // A plugin that can preview or apply opens on the whole file when nothing
    // is selected, so Preview works at once. An existing selection is kept.
    if (hasFooter.value && !hasSelection.value) selectAll()
  })
  // However the window closed — ×, Escape, or replaced by another plugin.
  onBeforeUnmount(() => chainWindowUnmounted(windowId))

  return {
    inChain,
    frozen,
    busy,
    applyLocked,
    applyBlocked: computed(() => gate.value.blocked),
    applyTitle: computed(() => gate.value.title),
    requestApply,
  }
}
