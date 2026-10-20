import { ref, computed, effectScope, watch } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows, isSoloPluginWindow } from './useWindows.js'
import { idForCopy, baseId, chainCopy, chainCopyNumber, copyOfId, isChainCopyId } from './pluginCopies.js'
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
 * A slot is a CHAIN COPY of its plugin (pluginCopies.js): its own settings,
 * its own node and its own window, `<id>@chain-<n>` — so one plugin can take
 * several slots, the way a DAW inserts it twice. Removing a slot DISPOSES its
 * copy, and adding the plugin again starts from its defaults. Opening a plugin from the rail or
 * the palette opens its SOLO copy, which is never in the chain: it is
 * auditioned on its own until its window closes, with an Apply of its own —
 * whether or not the same plugin also has a slot. So "which plugins are in the
 * chain" has one answer, the list, rather than depending on which windows
 * happened to be opened. The window manager keeps the two apart: the chain and
 * its copies' windows open together, and a solo plugin opens alone
 * (useWindows.js). A chain copy has no Apply of its own — the chain's Apply is
 * the only one.
 *
 * Each copy of a plugin registers a `ChainPlugin` (below) the first time it is
 * used — the solo copy too, so its window closing can switch its audition off. The registration is how the chain reaches a plugin's own state —
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
 * @property {() => void} [dispose]      end this copy of the plugin (its slot was removed)
 */

const plugins = new Map()
const slots = ref([])
const bypassed = ref(false)
// A plugin outside the chain is being auditioned, so the chain is out of the
// signal path until its window closes — see EffectChain.
const suspended = ref(false)
// A chain Apply is rendering. The chain and its copies' windows are frozen
// meanwhile (FloatingWindow), and every edit to the rack is refused: a slot
// removed or a knob turned mid-render would change, or dispose, what is being
// rendered — or cancel a measurement the render is waiting on.
const applying = ref(false)

/** Whether a chain Apply is rendering right now (read-only). */
export const chainApplying = computed(() => applying.value)
// Chain copies asked to join the chain before they had registered (a copy's
// composable first runs in its window's setup); finished when the window mounts.
const pendingAdds = new Set()

function defForWindow(windowId) {
  for (const def of plugins.values()) if (def.windowId === windowId) return def
  return null
}

function isMember(id) {
  return slots.value.some(s => s.id === id)
}

/** Turn a chain copy on and give it a slot at the end of the chain. */
function addDef(def) {
  // On first: that is what builds its chain entry, which addToChain needs.
  if (!def.isActive()) def.setActive(true)
  const chain = getEffectChainIfExists()
  chain?.addToChain(def.id)
  // Adding is asking to hear it — the chain is bypassed after every Apply.
  if (chain?.bypassed) chain.setBypassed(false)
}

// Each slot's ON as last seen, to notice one being switched on (see sync).
let lastEnabled = new Map()

function sync(chain) {
  // A slot switched ON while the chain is bypassed is someone asking to hear
  // it — from its own window as much as from the rack — so it lifts the
  // master bypass. (The rack's lamp already did; the plugin's own lamp did
  // not, and after an Apply turned a plugin "on" into silence.) A slot just
  // added has no previous state and is handled by addDef.
  const members = chain.members()
  const switchedOn = members.some(e => e.enabled && lastEnabled.get(e.id) === false)
  lastEnabled = new Map(members.map(e => [e.id, e.enabled]))
  if (switchedOn && chain.bypassed) {
    chain.setBypassed(false) // re-enters sync with the new state
    return
  }

  bypassed.value = chain.bypassed
  suspended.value = chain.suspended
  // A plugin with more than one slot numbers them, by copy rather than by
  // position, so a slot keeps its name when the chain is reordered.
  const perPlugin = new Map()
  for (const e of members) perPlugin.set(baseId(e.id), (perPlugin.get(baseId(e.id)) ?? 0) + 1)
  slots.value = members.map((e) => {
    const name = plugins.get(e.id)?.label ?? e.name ?? e.id
    const number = chainCopyNumber(copyOfId(e.id))
    return {
      id: e.id,
      active: e.enabled,
      label: perPlugin.get(baseId(e.id)) > 1 && number ? `${name} ${number}` : name,
      windowId: plugins.get(e.id)?.windowId ?? null,
    }
  })
}

/**
 * Take a chain copy out of existence: its node out of the EffectChain, its
 * registration forgotten, and the copy's own timers, watchers and in-flight
 * measurements ended (`dispose`, pluginCopies.js). Its window must already be
 * closing — what is left of it on unmount finds no registration to touch.
 */
function disposeCopy(def) {
  plugins.delete(def.id)
  getEffectChainIfExists()?.removeEffect(def.id)
  def.dispose?.()
}

// Whether a plugin window outside the chain is open — the chain is suspended
// while one is (EffectChain.suspended). Watched for the app's lifetime, in a
// scope of its own: no component owns this.
//
// Opening one also sets the MASTER BYPASS, so the chain stays off after the
// plugin closes until the user turns it back on. Coming back by itself on
// close put the chain under audio the user had just changed with the solo
// plugin, without being asked. The suspension still covers the time the
// window is open, so nothing else can bring the chain back underneath it.
const { windows } = useWindows()
const soloOpen = computed(() => windows.some(isSoloPluginWindow))
effectScope(true).run(() => {
  watch(soloOpen, (open) => {
    const chain = getEffectChainIfExists()
    if (!chain) return
    chain.setSoloOpen(open)
    if (open && !chain.bypassed && chain.members().length) chain.setBypassed(true)
  })
})

onEffectChainCreated((chain) => {
  chain.onChange(() => sync(chain))
  chain.setSoloOpen(soloOpen.value)
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
  return { member: index !== -1, position: index + 1, chainBypassed: bypassed.value }
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
  // A chain copy that never got its slot (its window closed before the add
  // finished) has nothing to come back to.
  if (isChainCopyId(def.id) && !isMember(def.id)) disposeCopy(def)
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
    if (applying.value) return
    const def = plugins.get(id)
    if (def) def.setActive(on)
    else chain().setEnabled(id, on)
    // Engaging a slot is asking to hear it: lift the master bypass too.
    if (on && chain().bypassed) chain().setBypassed(false)
  }

  /**
   * Add the plugin whose (solo) window is `pluginId` to the chain — a new chain
   * copy of it, starting from its default settings, numbered with the lowest
   * number its other slots leave free — and open it to tune. At the end, or
   * straight after the slot `after`.
   *
   * `prepare(copy)` runs first, to set the new copy up before it joins (VoiceRx
   * handing its bands to an EQ); it builds the copy, so the slot is added at
   * once rather than when its window mounts.
   */
  function add(pluginId, { after = null, prepare = null } = {}) {
    if (applying.value) return
    const taken = new Set([...slots.value.map(s => s.windowId), ...pendingAdds])
    let n = 1
    while (taken.has(idForCopy(pluginId, chainCopy(n)))) n++
    const windowId = idForCopy(pluginId, chainCopy(n))
    prepare?.(chainCopy(n))
    const def = defForWindow(windowId)
    if (def) {
      addDef(def)
      const at = after === null ? -1 : slots.value.findIndex(s => s.id === after)
      if (at !== -1) chain().moveEffect(def.id, at + 1)
    } else {
      pendingAdds.add(windowId)
    }
    openWindow(windowId)
  }

  function remove(id) {
    if (applying.value) return
    const def = plugins.get(id)
    def?.setActive(false)
    def?.suspend?.()
    chain().removeFromChain(id)
    if (def) {
      // Out of the chain its window would have nothing to edit.
      closeWindow(def.windowId)
      disposeCopy(def)
    } else {
      chain().removeEffect(id)
    }
  }

  function clear() {
    if (applying.value) return
    for (const s of [...slots.value]) remove(s.id)
    // An empty chain starts over, not bypassed.
    chain().setBypassed(false)
  }

  function move(id, toIndex) {
    if (applying.value) return
    chain().moveEffect(id, toIndex)
  }

  function setBypassed(on) {
    if (applying.value) return
    chain().setBypassed(on)
  }

  function openEditor(id) {
    const windowId = plugins.get(id)?.windowId
    if (windowId) openWindow(windowId)
  }

  /** Why the chain can't be applied right now, or ''. */
  function applyBlocker() {
    if (!state.selection) return 'Make a selection on the waveform first'
    // What Apply writes must be what is heard: a bypassed chain previews the
    // dry audio, so it cannot apply its slots. (It is bypassed after every Apply.)
    if (bypassed.value) return 'Turn the chain on to apply it'
    if (liveSlots.value.length === 0) return 'Turn on at least one plugin in the chain'
    for (const s of liveSlots.value) {
      const def = plugins.get(s.id)
      if (!def) return `${s.label} can’t be applied from the chain`
      const why = def.unavailable?.()
      if (why) return `${s.label}: ${why}`
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
   * Afterwards the WHOLE CHAIN is bypassed (the master bypass), not each slot:
   * the processing is now in the audio and leaving the chain live would play it
   * twice, but which slots were on is the user's setup and is kept — turning the
   * chain back on is one switch, ready for the next selection.
   */
  async function apply() {
    if (applying.value) return false
    const blocker = applyBlocker()
    if (blocker) {
      showToast(blocker)
      return false
    }
    const { start, end } = state.selection
    const defs = liveSlots.value.map(s => plugins.get(s.id))
    const labels = liveSlots.value.map(s => s.label)
    // Pinned to the document the chain was applied to: a long render can
    // outlast a tab switch, and `state` follows the active tab.
    const docId = appState.activeDocumentId
    const names = labels.join(' → ')

    // The slots read the file's rate and channels from the ACTIVE document as
    // they render, so a tab switch part-way would render the rest against the
    // other file. Refused rather than repaired: nothing is committed.
    const sameDocument = () => {
      if (appState.activeDocumentId !== docId) {
        throw new Error('switched files during the chain — nothing was applied')
      }
    }

    applying.value = true
    startProcessing(`Applying chain (${defs.length} plugin${defs.length === 1 ? '' : 's'})...`, docId)
    try {
      let segments = state.segments
      let buffer = null
      for (let i = 0; i < defs.length; i++) {
        sameDocument()
        updateProcessingStage(`${i + 1}/${defs.length} · ${labels[i]}`, docId)
        updateProcessingProgress(i / defs.length, docId)
        buffer = await defs[i].render(segments, start, end)
        sameDocument()
        segments = replaceRegionWithBuffer(segments, start, end, buffer, `chain-scratch-${i}`)
      }
      const bufferId = replaceRegion(start, end, buffer, `Chain: ${names}`, docId)
      setPeakCache(bufferId, await computePeakCache(buffer, 256))
      chain().setBypassed(true)
      for (const def of defs) def.afterApply?.()
      showToast(`Chain applied — ${names}`)
      return true
    } catch (err) {
      console.error('Plugin chain failed:', err)
      showToast(`Chain failed${err?.message ? `: ${err.message}` : ''}`)
      return false
    } finally {
      applying.value = false
      endProcessing(docId)
    }
  }

  return {
    slots,
    liveSlots,
    add,
    bypassed,
    suspended,
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
