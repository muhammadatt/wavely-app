import { ref, computed, effectScope, watch } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { useWindows, isSoloPluginWindow } from './useWindows.js'
import { idForCopy, baseId, chainCopy, chainCopyNumber, copyOfId, isChainCopyId } from './pluginCopies.js'
import { getEffectChain, getEffectChainIfExists, onEffectChainCreated } from '../audio/effectChain.js'
import { replaceRegionWithBuffer } from '../audio/operations.js'
import { computePeakCache } from '../audio/processing.js'
import { useEntitlements } from './useEntitlements.js'
import { settingsKeyOf } from './chainSettingsKey.js'

export { settingsKeyOf }

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

// ── CALIBRATION ─────────────────────────────────────────────────────────────
/**
 * ⚠ A SLOT'S PREVIEW MUST MEASURE WHAT THE SLOT WILL HEAR. Apply has always
 * measured each slot on the running result of the slots before it (see
 * `render` above), which is what makes a chain Apply equal to applying the
 * plugins one at a time. Preview measured the UNPROCESSED file, so a slot after
 * anything that moves level heard one thing in preview and rendered another:
 * an LA Vintage 2A slot after VoxPressor (whose makeups lift the voice
 * 2.4–4.8 dB) was aligned 2.8 dB low on the owner's clip — 3.6 dB of average
 * reduction in preview against 2.6 on Apply.
 *
 * CALIBRATION IS THE APPLY LOOP WITHOUT THE COMMIT: every live slot but the
 * last renders the preview region (the selection, or the whole file) through
 * its own `render`, exactly as Apply runs it, and each slot keeps the segments
 * it was handed. A slot's preview measurements then read those
 * (`chainMeasureInput`), so preview and Apply agree by construction.
 *
 * ⚠ IT COSTS AN APPLY OF THE UPSTREAM CHAIN, which on a long file with no
 * selection is minutes — so it is on demand (the chain window's CALIBRATE) or,
 * for those who want it, AUTO: re-run, debounced, whenever something upstream
 * of a calibrated slot changes. Owner's call, October 2026.
 *
 * WHAT "UPSTREAM CHANGED" MEANS: the document revision, the preview region,
 * which slots are live and in what order, and each upstream slot's
 * `settingsKey()` — its USER settings, never its measured ones. ⚠ That
 * exclusion is what keeps AUTO from looping: calibrating re-measures every
 * slot's makeup, ceiling and alignment, and if those counted as changes each
 * calibration would trigger the next.
 */
const CALIBRATION_MODE_KEY = 'wavely:chain-calibration'
const CALIBRATION_DEBOUNCE_MS = 700

function loadCalibrationMode() {
  try { return localStorage.getItem(CALIBRATION_MODE_KEY) === 'auto' ? 'auto' : 'manual' } catch { return 'manual' }
}

const calibrationMode = ref(loadCalibrationMode())
const calibrationRunning = ref(false)
const calibrationProgress = ref(0)
const calibrationError = ref('')
/** Bumped when a calibration lands: the slots' preview measurements re-run on it. */
const calibrationRevision = ref(0)
/** id → { segments, fingerprint } — the input each slot was handed. Not reactive: read through the revision. */
let calibrationInputs = new Map()
let calibrationSeq = 0
const liveSlotList = computed(() => slots.value.filter(s => s.active))

/** The region preview measures and calibration renders: the selection, or the whole file. */
function previewRegion(editor) {
  const { state, totalDuration } = editor
  if (state.selection) return { start: state.selection.start, end: state.selection.end }
  const end = totalDuration.value
  return end > 0 ? { start: 0, end } : null
}

/**
 * What `id` hears, as keys: `base` the document revision and the region (what
 * its stored input is spliced into), `full` that plus which slots are live
 * upstream and their user settings. Null when it is not a live slot or nothing
 * live is upstream of it (it hears the file, which needs no calibration).
 */
function upstreamFingerprint(id, editor) {
  if (bypassed.value) return null
  const live = liveSlotList.value
  const at = live.findIndex(s => s.id === id)
  if (at <= 0) return null
  const region = previewRegion(editor)
  if (!region || !editor.state.currentFile) return null
  const base = `${editor.appState.activeDocumentId}:${editor.state.revision}|${region.start}|${region.end}`
  const parts = [base]
  for (let i = 0; i < at; i++) {
    const def = plugins.get(live[i].id)
    parts.push(`${live[i].id}=${def?.settingsKey ? def.settingsKey() : '?'}`)
  }
  return { base, full: parts.join('|') }
}

/**
 * The segments a chain slot's PREVIEW measurements should read, or null to use
 * the document's own (a solo copy, the first live slot, a bypassed chain, or a
 * slot never calibrated for this document revision and region).
 *
 * ⚠ A SLOT WHOSE UPSTREAM SETTINGS MOVED SINCE ITS CALIBRATION KEEPS ITS LAST
 * CALIBRATED INPUT (the chain window shows it STALE). In MANUAL mode that is
 * the point: what the upstream chain produced a knob-turn ago is far closer to
 * what the slot will hear than the unprocessed file it fell back to before.
 * A different revision or region is another matter — the stored segments are
 * spliced over a span that no longer applies — so those fall back to the file.
 * Reactive on the calibration revision.
 */
export function chainMeasureInput(id) {
  void calibrationRevision.value
  const editor = useEditorState()
  const fp = upstreamFingerprint(id, editor)
  if (fp === null) return null
  const hit = calibrationInputs.get(id)
  return hit && hit.base === fp.base ? hit.segments : null
}

/** 'none' (hears the file) | 'calibrated' | 'stale', for a slot. Reactive. */
export function chainCalibrationState(id) {
  void calibrationRevision.value
  const editor = useEditorState()
  const fp = upstreamFingerprint(id, editor)
  if (fp === null) return 'none'
  const hit = calibrationInputs.get(id)
  return hit && hit.full === fp.full ? 'calibrated' : 'stale'
}

/** The calibration revision, for the slots to re-measure on (reactive). */
export const chainCalibrationRevision = computed(() => calibrationRevision.value)

async function runCalibration() {
  if (applying.value) return false
  const editor = useEditorState()
  const { state, appState } = editor
  const live = liveSlotList.value
  if (bypassed.value || live.length < 2 || !state.currentFile) return false
  const region = previewRegion(editor)
  if (!region) return false
  const seq = ++calibrationSeq
  const docKey = `${appState.activeDocumentId}:${state.revision}`
  const fingerprints = live.map(s => upstreamFingerprint(s.id, editor))
  const defs = live.map(s => plugins.get(s.id))
  calibrationRunning.value = true
  calibrationProgress.value = 0
  calibrationError.value = ''
  const inputs = new Map()
  try {
    let segments = state.segments
    for (let i = 0; i < defs.length; i++) {
      if (i > 0) inputs.set(live[i].id, { segments, ...fingerprints[i] })
      if (i === defs.length - 1) break // the last slot only needs its input
      const def = defs[i]
      const why = !def ? `${live[i].label} can’t render in the chain` : def.unavailable?.()
      if (why) throw new Error(`${live[i].label}: ${why}`)
      const buffer = await def.render(segments, region.start, region.end)
      // Superseded (a newer calibration started) or the audio moved under it.
      if (seq !== calibrationSeq) return false
      if (`${appState.activeDocumentId}:${state.revision}` !== docKey) return false
      segments = replaceRegionWithBuffer(segments, region.start, region.end, buffer, `chain-calibrate-${i}`)
      calibrationProgress.value = (i + 1) / (defs.length - 1)
    }
    calibrationInputs = inputs
    calibrationRevision.value++
    return true
  } catch (err) {
    if (seq === calibrationSeq) {
      console.error('Chain calibration failed:', err)
      calibrationError.value = err?.message ?? 'Calibration failed'
    }
    return false
  } finally {
    if (seq === calibrationSeq) calibrationRunning.value = false
  }
}

/** Whether any live slot is measuring audio it will not hear (reactive). */
const calibrationNeeded = computed(() => liveSlotList.value.some(s => chainCalibrationState(s.id) === 'stale'))

// AUTO: re-calibrate, debounced, when a slot goes stale. Watched for the app's
// lifetime, as the chain itself is.
let calibrationTimer = null
effectScope(true).run(() => {
  // ⚠ `calibrationRunning` IS A SOURCE: a change made DURING a calibration
  // leaves `needed` true before and after it, so without this the run's end
  // would not re-trigger and AUTO would sit stale.
  watch([calibrationNeeded, calibrationMode, applying, calibrationRunning], ([needed, mode, busy, running]) => {
    clearTimeout(calibrationTimer)
    if (!needed || mode !== 'auto' || busy || running) return
    calibrationTimer = setTimeout(() => { if (calibrationNeeded.value) runCalibration() }, CALIBRATION_DEBOUNCE_MS)
  })
})

/** The chain window's calibration controls. */
export function useChainCalibration() {
  return {
    mode: computed(() => calibrationMode.value),
    setMode(mode) {
      calibrationMode.value = mode === 'auto' ? 'auto' : 'manual'
      try { localStorage.setItem(CALIBRATION_MODE_KEY, calibrationMode.value) } catch { /* private window */ }
    },
    running: computed(() => calibrationRunning.value),
    progress: computed(() => calibrationProgress.value),
    error: computed(() => calibrationError.value),
    needed: calibrationNeeded,
    /** Whether anything in the chain needs calibrating at all (two or more live slots). */
    applicable: computed(() => !bypassed.value && liveSlotList.value.length >= 2),
    calibrate: runCalibration,
    stateOf: chainCalibrationState,
  }
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
    pinActiveDocument,
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
    // Preview is free; writing the chain into the audio is Pro.
    if (!useEntitlements().request('pluginChainApply')) return false
    const { start, end } = state.selection
    const defs = liveSlots.value.map(s => plugins.get(s.id))
    const labels = liveSlots.value.map(s => s.label)
    // Pinned to the document the chain was applied to: a long render can
    // outlast a tab switch, and `state` follows the active tab.
    const pin = pinActiveDocument('The chain')
    const docId = pin.docId
    const names = labels.join(' → ')

    // The slots read the file's rate and channels from the ACTIVE document as
    // they render, so a tab switch part-way would render the rest against the
    // other file. Refused rather than repaired: nothing is committed — and
    // that includes a switch away and back (pinActiveDocument).
    const sameDocument = () => pin.check()

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
      showToast(err instanceof DocumentSwitchedError ? err.message : `Chain failed${err?.message ? `: ${err.message}` : ''}`)
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
