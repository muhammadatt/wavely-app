import { effectScope, watch } from 'vue'
import { useEditorState } from './useEditorState.js'
import { PLUGIN_SETTINGS, pluginSettingsIO } from './pluginSettings.js'
import { usePluginChain, chainApplying } from './usePluginChain.js'
import { baseId, copyOfId } from './pluginCopies.js'

/**
 * PER-FILE PLUGIN SETTINGS AND CHAINS.
 *
 * Plugin settings are tuned to a recording, so each open file keeps its own.
 * A tab switch saves, for the file being left:
 * - every standalone (solo) plugin's settings;
 * - the whole Plugin Chain: which plugins sit in which slots, each slot's
 *   ON/BYPASS and settings, and the master bypass.
 * It then puts back what the file being entered had when it was last active.
 *
 * ⚠ A FILE WITH NOTHING SAVED INHERITS THE LAST-USED SETTINGS AND CHAIN
 * (owner, November 2026), not the defaults. That supports the narrator who
 * does want the same settings on every chapter: open the next file and it is
 * already set up. From then on the file has its own copy.
 *
 * ⚠ HAND-SET FILE VALUES ARE KEPT PER FILE TOO (`fileIo` in pluginSettings.js
 * — the compressors' manual INPUT trim). Presets and saved chains leave them
 * out because they describe a recording, which is exactly why they belong in
 * that recording's per-file settings (owner: a manual pre-gain is a setting
 * like any other). But they are NOT inherited: a file with nothing saved starts
 * the trim on AUTO, which re-measures it (owner, November 2026).
 *
 * WHY SAVE AND RESTORE RATHER THAN LIVE INSTANCES PER FILE. Only the active
 * file plays, so one live node per plugin copy is enough. A copy per file
 * would keep an AudioWorklet per plugin per open file. The settings read/write
 * in pluginSettings.js is already what saved chains use, and leaves measured
 * values out (alignment, auto makeup, ceilings, voice levels). Those are keyed
 * on the document and its revision and re-measure for the file entered.
 *
 * Restoring a chain:
 * - Same plugins in the same order as the rack already holds: each slot's
 *   settings and ON/BYPASS are written in place, so open slot windows stay
 *   open.
 * - Otherwise: the rack is rebuilt the way loading a saved chain does it
 *   (clear, then add each slot with its settings written before it joins),
 *   which closes the slot windows that were open.
 * - A switch during a chain Apply (which the switch cancels) waits for the
 *   Apply to finish unwinding, since the rack refuses edits meanwhile.
 *
 * Not covered: plugins with no settings read/write (Auto Leveler, Noise
 * Reduction, Loudness / Peak Normalize). They keep one set of settings for
 * every file, as before.
 */

/**
 * docId → {
 *   solo: Map(pluginId → { settings, file }),
 *   chain: { bypassed, slots: [{ plugin, active, settings, file }] },
 * }
 */
const saved = new Map()

const plain = v => JSON.parse(JSON.stringify(v ?? null))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function readCopy(pluginId, copy) {
  const entry = PLUGIN_SETTINGS[pluginId]
  const api = entry.use(copy)
  return {
    settings: plain(entry.io(api).read()),
    file: entry.fileIo ? plain(entry.fileIo(api).read()) : null,
  }
}

/** Put saved settings into a copy; skip what already matches (no re-measure). */
function writeCopy(pluginId, copy, { settings, file }) {
  const entry = PLUGIN_SETTINGS[pluginId]
  if (!entry) return
  const api = entry.use(copy)
  const io = entry.io(api)
  if (settings && !same(plain(io.read()), settings)) io.write(plain(settings))
  // Always written, even when it reads the same: a manual trim is bound to the
  // document it was dialled on, and writing it again binds it to this one.
  if (file && entry.fileIo) entry.fileIo(api).write(plain(file))
}

/** Every plugin's solo copy that has been built, without building any. */
function* builtSoloCopies() {
  for (const [pluginId, entry] of Object.entries(PLUGIN_SETTINGS)) {
    if (entry.use.builtCopies?.().includes('solo')) yield pluginId
  }
}

function rackSlots() {
  return usePluginChain().slots.value
    .filter(s => s.windowId && PLUGIN_SETTINGS[baseId(s.windowId)])
    .map(s => ({ ...s, plugin: baseId(s.windowId), copy: copyOfId(s.windowId) }))
}

/** Remember every solo plugin's settings and the whole chain as `docId`'s. */
export function savePluginSettingsFor(docId) {
  if (docId == null) return
  const solo = new Map()
  for (const pluginId of builtSoloCopies()) solo.set(pluginId, readCopy(pluginId, 'solo'))
  const chain = {
    bypassed: usePluginChain().bypassed.value,
    slots: rackSlots().map(s => ({ plugin: s.plugin, active: s.active, ...readCopy(s.plugin, s.copy) })),
  }
  saved.set(docId, { solo, chain })
}

/**
 * Entering a file with nothing saved: settings and chain stay as they are
 * (inherited), but hand-set FILE values go back to AUTO (owner, November 2026:
 * a new file starts the INPUT trim on AUTO, everything else inherited). The
 * trim describes the recording it was dialled on; AUTO re-measures this one.
 */
const AUTO_FILE_SETTINGS = { inputAuto: true }

function inheritInto() {
  for (const pluginId of builtSoloCopies()) {
    if (PLUGIN_SETTINGS[pluginId].fileIo) writeCopy(pluginId, 'solo', { settings: null, file: AUTO_FILE_SETTINGS })
  }
  for (const s of rackSlots()) {
    if (PLUGIN_SETTINGS[s.plugin].fileIo) writeCopy(s.plugin, s.copy, { settings: null, file: AUTO_FILE_SETTINGS })
  }
}

function restoreChain(saved) {
  const chain = usePluginChain()
  const current = rackSlots()
  if (same(current.map(s => s.plugin), saved.slots.map(s => s.plugin))) {
    // Same layout: edit the slots in place.
    current.forEach((s, i) => {
      writeCopy(s.plugin, s.copy, saved.slots[i])
      if (s.active !== saved.slots[i].active) chain.setSlotActive(s.id, saved.slots[i].active)
    })
  } else {
    chain.clear()
    for (const slot of saved.slots) {
      const id = chain.add(slot.plugin, {
        open: false,
        // Builds the copy and writes its settings before it joins, so it starts
        // playing with them rather than with the defaults.
        prepare: (copy) => {
          pluginSettingsIO(slot.plugin, copy)
          writeCopy(slot.plugin, copy, slot)
        },
      })
      if (id && slot.active === false) chain.setSlotActive(id, false)
    }
  }
  // Last: adding a slot lifts the master bypass.
  if (chain.bypassed.value !== saved.bypassed) chain.setBypassed(saved.bypassed)
}

let chainRestorePending = false

/** Put `docId`'s saved settings and chain back, or inherit when it has none. */
export function restorePluginSettingsFor(docId) {
  const store = saved.get(docId)
  if (!store) {
    inheritInto()
    return
  }
  for (const pluginId of builtSoloCopies()) {
    const hit = store.solo.get(pluginId)
    if (hit) writeCopy(pluginId, 'solo', hit)
  }
  if (chainApplying.value) chainRestorePending = true
  else restoreChain(store.chain)
}

/** Drop what is saved for files that are no longer open. */
export function forgetClosedDocuments(openIds) {
  const open = new Set(openIds)
  for (const id of saved.keys()) if (!open.has(id)) saved.delete(id)
}

/** For tests. */
export function resetPerFilePluginSettings() {
  saved.clear()
  chainRestorePending = false
}

/**
 * The tab-switch hook. SYNC flush, so the file being left is read before any
 * other watcher on the active document (each plugin's re-measure) reacts to
 * the switch, and the file being entered has its settings before they do.
 */
export function onActiveDocumentChanged(nextId, prevId, openIds) {
  // A file closed out from under the switch has nothing left to save.
  if (prevId != null && openIds.includes(prevId)) savePluginSettingsFor(prevId)
  forgetClosedDocuments(openIds)
  if (nextId != null) restorePluginSettingsFor(nextId)
}

let installed = false

/** Start keeping plugin settings per file. Idempotent; the editor calls it once. */
export function installPerFilePluginSettings() {
  if (installed) return
  installed = true
  const { appState } = useEditorState()
  effectScope(true).run(() => {
    watch(
      () => appState.activeDocumentId,
      (next, prev) => onActiveDocumentChanged(next, prev, appState.documents.map(d => d.id)),
      { flush: 'sync' },
    )
    // A switch cancelled a chain Apply: the rack was frozen, so its restore
    // waited. The Apply has unwound now; restore the file that is active.
    watch(chainApplying, (busy) => {
      if (busy || !chainRestorePending) return
      chainRestorePending = false
      const store = saved.get(appState.activeDocumentId)
      if (store) restoreChain(store.chain)
    })
  })
}
