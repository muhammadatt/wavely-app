import { effectScope, watch } from 'vue'
import { useEditorState } from './useEditorState.js'
import { PLUGIN_SETTINGS } from './pluginSettings.js'

/**
 * PER-FILE PLUGIN SETTINGS.
 *
 * Plugin settings are tuned to a recording, so each open file keeps its own:
 * switching tabs saves the settings every plugin copy has on the file being
 * left, and puts back the ones the file being entered had when it was last
 * active.
 *
 * ⚠ A FILE THE PLUGIN HAS NOT BEEN USED ON INHERITS THE LAST-USED SETTINGS
 * (owner, November 2026), not the defaults. That supports the narrator who
 * does want the same settings on every chapter: open the next file and the
 * plugin is already set. In code that means nothing is written for a file
 * with no saved settings: whatever the plugin was last set to stays.
 *
 * WHY SAVE AND RESTORE RATHER THAN ONE INSTANCE PER FILE. Only the active file
 * plays, so there is only ever one live node per plugin copy to drive. A full
 * copy per file would keep an AudioWorklet per plugin per open file. The
 * settings read/write in pluginSettings.js is already what saved chains use,
 * and it already leaves measured values out (alignment, auto makeup,
 * ceilings, voice levels). Those are keyed on the document and its revision,
 * so they re-measure for the file entered by themselves.
 *
 * Scope:
 * - Every built copy is covered, solo and chain. The rack's LAYOUT (which
 *   plugins sit in which slots) stays shared; each slot's settings are per
 *   file.
 * - A chain copy removed and added again is a new build (`copySerial`). Its
 *   old per-file settings are dropped rather than restored onto a slot that
 *   may hold the same plugin by coincidence.
 * - Not covered: plugins with no settings read/write (Auto Leveler, Noise
 *   Reduction, Loudness / Peak Normalize). They keep one set of settings for
 *   every file, as before.
 */

/** docId → Map(`${pluginId}|${copy}` → { serial, settings }) */
const saved = new Map()

const keyOf = (pluginId, copy) => `${pluginId}|${copy}`
const plain = v => JSON.parse(JSON.stringify(v ?? null))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Every built copy of every plugin with a settings read/write. */
function* builtCopies() {
  for (const [pluginId, entry] of Object.entries(PLUGIN_SETTINGS)) {
    for (const copy of entry.use.builtCopies?.() ?? []) yield { pluginId, entry, copy }
  }
}

/** Remember the settings every built copy has now, as `docId`'s. */
export function savePluginSettingsFor(docId) {
  if (docId == null) return
  const store = new Map()
  for (const { pluginId, entry, copy } of builtCopies()) {
    const settings = entry.io(entry.use(copy)).read()
    store.set(keyOf(pluginId, copy), { serial: entry.use.copySerial(copy), settings: plain(settings) })
  }
  saved.set(docId, store)
}

/**
 * Put `docId`'s saved settings back. Copies it has nothing saved for keep what
 * they have: the last-used settings. Writing is skipped where nothing changed,
 * so a switch between two files on the same settings re-measures nothing.
 */
export function restorePluginSettingsFor(docId) {
  const store = saved.get(docId)
  if (!store) return
  for (const { pluginId, entry, copy } of builtCopies()) {
    const hit = store.get(keyOf(pluginId, copy))
    if (!hit || hit.serial !== entry.use.copySerial(copy)) continue
    const io = entry.io(entry.use(copy))
    if (same(plain(io.read()), hit.settings)) continue
    io.write(plain(hit.settings))
  }
}

/** Drop what is saved for files that are no longer open. */
export function forgetClosedDocuments(openIds) {
  const open = new Set(openIds)
  for (const id of saved.keys()) if (!open.has(id)) saved.delete(id)
}

/** For tests. */
export function resetPerFilePluginSettings() {
  saved.clear()
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
  })
}
