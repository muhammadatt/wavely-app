import { ref, computed } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows, setChainSlotPredicate } from './useWindows.js'
import { getEffectChain, getEffectChainIfExists, onEffectChainCreated } from '../audio/effectChain.js'
import { replaceRegionWithBuffer } from '../audio/operations.js'
import { computePeakCache } from '../audio/processing.js'

/**
 * The plugin chain — a formal rack over the live EffectChain.
 *
 * What it replaces: plugins ran in series in the order their windows were
 * first opened, with no way to reorder them; closing a window took its plugin
 * out of the chain; and committing the chain meant pressing each window's
 * Apply in turn, one undo step per plugin.
 *
 * Now a plugin joins the chain only through the Plugin Chain window's Add
 * picker, and its SLOT outlives its window.
 * The Plugin Chain window lists the slots in processing order and can reorder,
 * bypass, remove and re-open them, bypass the whole chain at once, and apply
 * it: every live slot rendered in order over the selection, committed as ONE
 * undo step.
 *
 * Opening a plugin from the rail or the palette does NOT add it: it is
 * auditioned on its own, after the chain, until its window closes — so
 * "which plugins are in the chain" has one answer, the list, rather than
 * depending on which windows happened to be opened. The window manager keeps
 * the two apart: the chain and its plugins' windows open together, and a
 * plugin outside the chain opens alone (useWindows.js). A plugin in the chain
 * has no Apply of its own — the chain's Apply is the only one.
 *
 * Each plugin composable registers a `ChainPlugin` (below) the first time it
 * is used. The registration is how the chain reaches a plugin's own state —
 * its ON/BYPASS (which stays the source of truth for whether the slot is live,
 * so the plugin's window and the chain can never disagree) and its apply path.
 *
 * @typedef {object} ChainPlugin
 * @property {string} id         the EffectChain entry id
 * @property {string} windowId   the registry/window id that edits it
 * @property {string} label      display name
 * @property {() => boolean} isActive       the plugin's ON/BYPASS
 * @property {(on: boolean) => void} setActive  turn it on/off through the plugin
 * @property {(segments: Array, start: number, end: number) => Promise<AudioBuffer>} render
 *   Measure and render [start, end) of `segments` with the plugin's current
 *   settings, WITHOUT committing. The segments are the chain's running result,
 *   so slot N renders what slot N−1 produced — and its pre-apply measurements
 *   (alignment, auto makeup, file level, ceilings) must be taken on those
 *   segments too, or the chain would not equal applying the plugins one at a
 *   time. Measured that way it is bit-identical to doing so.
 * @property {() => void} [resume]       restart the panel's meters (window reopened)
 * @property {() => void} [suspend]      the window closed: stop meters, clear monitoring states
 * @property {() => void} [afterApply]   the audio changed under the plugin (e.g. drop a stale analysis)
 * @property {() => string} [unavailable] a reason it cannot render right now, or ''
 */

const plugins = new Map()
const slots = ref([])
const bypassed = ref(false)
// Windows asked to join the chain before their plugin had registered (its
// composable runs in the window's setup); finished when the window mounts.
const pendingAdds = new Set()

// The chain group, for the window manager: a plugin with a slot, or one on its
// way to one, opens beside the chain rather than replacing it.
setChainSlotPredicate(windowId => pendingAdds.has(windowId) || hasChainSlot(windowId))

function defForWindow(windowId) {
  for (const def of plugins.values()) if (def.windowId === windowId) return def
  return null
}

function isMember(id) {
  return slots.value.some(s => s.id === id)
}

/** Turn a plugin on and give it a slot at the end of the chain. */
function addDef(def) {
  // On first: that is what builds its chain entry, which addToChain needs.
  if (!def.isActive()) def.setActive(true)
  getEffectChainIfExists()?.addToChain(def.id)
}

function sync(chain) {
  bypassed.value = chain.bypassed
  slots.value = chain.members().map(e => ({
    id: e.id,
    active: e.enabled,
    label: plugins.get(e.id)?.label ?? e.name ?? e.id,
    windowId: plugins.get(e.id)?.windowId ?? null,
  }))
}

onEffectChainCreated((chain) => {
  chain.onChange(() => sync(chain))
  sync(chain)
})

/** Register (or refresh) a plugin's chain hooks. Idempotent. */
export function registerChainPlugin(def) {
  plugins.set(def.id, def)
  const chain = getEffectChainIfExists()
  if (chain) sync(chain)
}

/** Whether the plugin edited in `windowId` has a slot in the chain (live or bypassed). */
export function hasChainSlot(windowId) {
  return slots.value.some(s => s.windowId === windowId)
}

/**
 * The chain status a plugin window shows: null for a window whose plugin cannot
 * join the chain, otherwise whether it has a slot and where. Reactive on the
 * slots; the registration it also reads is made in the window's own setup.
 */
export function chainStatusFor(windowId) {
  const def = defForWindow(windowId)
  if (!def) return null
  const index = slots.value.findIndex(s => s.id === def.id)
  return { member: index !== -1, position: index + 1 }
}

/** A plugin window mounted: finish a pending add, or bring a live plugin's meters back. */
export function chainWindowMounted(windowId) {
  const def = defForWindow(windowId)
  if (!def) return
  if (pendingAdds.delete(windowId)) addDef(def)
  else if (def.isActive()) def.resume?.()
}

/**
 * A plugin window unmounted, however it closed (× , Escape, or replaced by
 * another plugin). A slot keeps playing with its meters stopped; a plugin that
 * was only being auditioned goes off with its window.
 */
export function chainWindowUnmounted(windowId) {
  pendingAdds.delete(windowId)
  const def = defForWindow(windowId)
  if (!def) return
  def.suspend?.()
  if (def.isActive() && !isMember(def.id)) def.setActive(false)
}

export function usePluginChain() {
  const editor = useEditorState()
  const {
    state, appState, replaceRegion, setPeakCache,
    startProcessing, updateProcessingStage, updateProcessingProgress, endProcessing, showToast,
  } = editor
  const { openWindow, closeWindow } = useWindows()

  const chain = () => getEffectChain(editor.getAudioContext())
  const liveSlots = computed(() => slots.value.filter(s => s.active))

  function setSlotActive(id, on) {
    const def = plugins.get(id)
    if (def) def.setActive(on)
    else chain().setEnabled(id, on)
    // Engaging a slot is asking to hear it: lift the master bypass too.
    if (on && chain().bypassed) chain().setBypassed(false)
  }

  /** Add the plugin edited in `windowId` to the end of the chain and open it to tune. */
  function add(windowId) {
    const def = defForWindow(windowId)
    if (def) addDef(def)
    else pendingAdds.add(windowId)
    openWindow(windowId)
  }

  function remove(id) {
    const def = plugins.get(id)
    def?.setActive(false)
    chain().removeFromChain(id)
    // Out of the chain, its window would be a solo plugin open beside the
    // chain — exactly what the window groups forbid.
    if (def) closeWindow(def.windowId)
  }

  function clear() {
    for (const s of [...slots.value]) remove(s.id)
  }

  function move(id, toIndex) {
    chain().moveEffect(id, toIndex)
  }

  function setBypassed(on) {
    chain().setBypassed(on)
  }

  function openEditor(id) {
    const windowId = plugins.get(id)?.windowId
    if (windowId) openWindow(windowId)
  }

  /** Why the chain can't be applied right now, or ''. */
  function applyBlocker() {
    if (!state.selection) return 'Make a selection on the waveform first'
    if (liveSlots.value.length === 0) return 'Turn on at least one plugin in the chain'
    for (const s of liveSlots.value) {
      const def = plugins.get(s.id)
      if (!def) return `${s.label} can’t be applied from the chain`
      const why = def.unavailable?.()
      if (why) return `${def.label}: ${why}`
    }
    return ''
  }

  /**
   * Render every live slot, in order, over the selection, and commit the
   * result as one edit.
   *
   * Each slot renders the PREVIOUS slot's output: the running result is
   * spliced into a scratch copy of the segment list (never the document's),
   * which is exactly what the next plugin's apply path reads — its pre-roll
   * still comes from the real audio before the selection, as it does when the
   * plugins are applied one at a time.
   *
   * Afterwards every applied slot is bypassed, as a single plugin's Apply
   * turns its own preview off: the processing is now in the audio, and leaving
   * the chain live would play it twice. The chain itself stays built, ready
   * for the next selection.
   */
  async function apply() {
    const blocker = applyBlocker()
    if (blocker) {
      showToast(blocker)
      return false
    }
    const { start, end } = state.selection
    const defs = liveSlots.value.map(s => plugins.get(s.id))
    // Pinned to the document the chain was applied to: a long render can
    // outlast a tab switch, and `state` follows the active tab.
    const docId = appState.activeDocumentId
    const names = defs.map(d => d.label).join(' → ')

    startProcessing(`Applying chain (${defs.length} plugin${defs.length === 1 ? '' : 's'})...`, docId)
    try {
      let segments = state.segments
      let buffer = null
      for (let i = 0; i < defs.length; i++) {
        updateProcessingStage(`${i + 1}/${defs.length} · ${defs[i].label}`, docId)
        updateProcessingProgress(i / defs.length, docId)
        buffer = await defs[i].render(segments, start, end)
        segments = replaceRegionWithBuffer(segments, start, end, buffer, `chain-scratch-${i}`)
      }
      const bufferId = replaceRegion(start, end, buffer, `Chain: ${names}`, docId)
      setPeakCache(bufferId, await computePeakCache(buffer, 256))
      for (const def of defs) {
        def.setActive(false)
        def.afterApply?.()
      }
      showToast(`Chain applied — ${names}`)
      return true
    } catch (err) {
      console.error('Plugin chain failed:', err)
      showToast(`Chain failed${err?.message ? `: ${err.message}` : ''}`)
      return false
    } finally {
      endProcessing(docId)
    }
  }

  return {
    slots,
    liveSlots,
    add,
    bypassed,
    setSlotActive,
    remove,
    clear,
    move,
    setBypassed,
    openEditor,
    applyBlocker,
    apply,
  }
}
