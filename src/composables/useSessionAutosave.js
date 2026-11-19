/**
 * Session autosave: keeps a recovery copy of every file with unsaved edits, so
 * a crash, a reload, a closed tab or iOS killing a backgrounded tab does not
 * lose the work — and offers it back the next time the editor opens.
 *
 * What is kept and why: `audio/sessionSnapshot.js`. Where: `platform/sessionStore.js`.
 *
 * Timing. A change to any document's revision, saved revision or name
 * schedules a write SAVE_DELAY_MS later; hiding the page or leaving it writes
 * at once (best effort — a tab can die mid-write). Buffers are written FIRST
 * and the manifest LAST, and the manifest only ever names buffers already
 * complete, so a write cut short leaves the previous recovery point intact.
 * Each buffer is written once: buffers never change.
 *
 * Off when the browser lacks OPFS, a worker or Web Locks; and for the rest of
 * the visit when storage is full (one toast says so).
 */
import { computed, reactive, watch } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { useEditorState } from './useEditorState.js'
import { openSessionStore } from '../platform/sessionStore.js'
import {
  buildManifest, bufferIdsOf, hasUnsavedEdits, isRestorableManifest, orphanedBufferIds,
} from '../audio/sessionSnapshot.js'
import { computePeakCache } from '../audio/processing.js'
import { isMobileDevice, memoryBudget } from '../platform/memoryBudget.js'

export const SAVE_DELAY_MS = 1500
/** A buffer file no manifest names is deleted once it is this old (another tab may be mid-write). */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000
const BASE_SAMPLES_PER_PX = 256

const autosave = reactive({
  /** The browser can autosave and the store opened. */
  available: false,
  /** Work from tabs that are gone: [{ sessionId, savedAt, files: [name] }]. */
  pending: [],
  restoring: false,
  /** Set when autosave stopped for this visit (e.g. 'quota'). */
  stopped: null,
})

let store = null
let started = false
/** bufferId → how it is stored, for buffers this tab wrote or adopted on restore. */
const stored = new Map()
/** Manifests of dead tabs awaiting Restore / Discard, by session id. */
const pendingManifests = new Map()
let wroteManifest = false
let timer = null
let running = null
let again = false

export function useSessionAutosave() {
  const editor = useEditorState()
  const { appState } = editor

  const signature = computed(() =>
    appState.documents.map(d => `${d.id}:${d.revision}:${d.savedRevision}:${d.name}`).join('|'))

  async function start() {
    if (started) return
    started = true
    try {
      store = await openSessionStore({ sessionId: uuidv4() })
    } catch (err) {
      console.warn('Session autosave unavailable:', err)
      store = null
    }
    if (!store) return
    autosave.available = true
    await refreshPending()
    watch(signature, schedule)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushNow()
    })
    window.addEventListener('pagehide', flushNow)
  }

  function schedule() {
    if (!store || autosave.stopped) return
    clearTimeout(timer)
    timer = setTimeout(flushNow, SAVE_DELAY_MS)
  }

  /** Write now; if a write is already running, run once more after it. */
  function flushNow() {
    if (!store || autosave.stopped) return Promise.resolve()
    clearTimeout(timer)
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        await writeOnce()
      } while (again)
    })().finally(() => { running = null })
    return running
  }

  async function writeOnce() {
    try {
      // Store every buffer an unsaved timeline plays, then name them. Edits can
      // land while a buffer is being written, so check again until nothing new.
      for (let pass = 0; pass < 5; pass++) {
        const needed = [...bufferIdsOf(appState.documents.filter(hasUnsavedEdits))].filter(id => !stored.has(id))
        if (needed.length === 0) break
        for (const id of needed) {
          const buffer = editor.bufferPool.get(id)
          if (!buffer) continue
          const file = editor.getBufferSourceFile(id)
          stored.set(id, file ? await store.writeSourceFile(id, file) : await store.writePcm(id, buffer))
          if (stored.size === 1) navigator.storage.persist?.().catch(() => {})
        }
      }
      const manifest = buildManifest({
        sessionId: store.sessionId,
        documents: appState.documents.filter(d => bufferIdsOfDoc(d).every(id => stored.has(id))),
        describe: id => stored.get(id),
      })
      if (manifest.docs.length > 0) {
        await store.writeManifest(manifest)
        wroteManifest = true
      } else if (wroteManifest) {
        await store.deleteManifests(store.sessionId)
        wroteManifest = false
      }
      await collectGarbage(manifest)
    } catch (err) {
      if (err?.name === 'QuotaExceededError') {
        autosave.stopped = 'quota'
        editor.showToast('Browser storage is full, so unsaved work is no longer backed up. Save your files to keep them.', 10000, { tone: 'warn' })
      } else {
        console.warn('Session autosave failed:', err)
      }
    }
  }

  function bufferIdsOfDoc(doc) {
    return [...bufferIdsOf([doc])]
  }

  /**
   * Delete buffer files no manifest names. This tab's own are deleted at once;
   * anyone else's only once old, since another open tab may be writing one it
   * has not named in its manifest yet.
   */
  async function collectGarbage(ownManifest) {
    const others = await store.otherManifests()
    const files = await store.storedBuffers()
    const orphans = orphanedBufferIds(files.keys(), [ownManifest, ...others.map(o => o.manifest)])
    const now = Date.now()
    for (const id of orphans) {
      if (stored.has(id)) {
        stored.delete(id)
        await store.deleteBuffer(id)
      } else if (now - (files.get(id) ?? now) > ORPHAN_GRACE_MS) {
        await store.deleteBuffer(id)
      }
    }
  }

  /** Find work left by tabs that are gone. Unreadable or empty leftovers are removed. */
  async function refreshPending() {
    const others = await store.otherManifests()
    pendingManifests.clear()
    const pending = []
    for (const o of others) {
      if (o.alive) continue
      if (!isRestorableManifest(o.manifest) || o.manifest.docs.length === 0) {
        await store.deleteManifests(o.sessionId)
        continue
      }
      pendingManifests.set(o.sessionId, o.manifest)
      pending.push({ sessionId: o.sessionId, savedAt: o.manifest.savedAt, files: o.manifest.docs.map(d => d.name) })
    }
    autosave.pending = pending.sort((a, b) => b.savedAt - a.savedAt)
  }

  /**
   * Re-open every file left by tabs that are gone. Call from a click: decoding
   * needs the AudioContext, which may only start on a gesture. On a phone,
   * stops before the memory budget runs out and leaves the rest on offer.
   */
  async function restore() {
    if (!store || autosave.restoring) return
    autosave.restoring = true
    const ctx = editor.getAudioContext()
    const budget = memoryBudget()
    const mobile = isMobileDevice()
    const loaded = new Map()
    const done = []
    let restored = 0
    let firstDocId = null
    let stoppedForMemory = false
    try {
      for (const [sessionId, manifest] of pendingManifests) {
        let complete = true
        for (const snapshot of manifest.docs) {
          if (mobile && editor.poolBytes.value > budget * 0.9) {
            stoppedForMemory = true
            complete = false
            break
          }
          try {
            const buffers = new Map()
            const sourceFiles = new Map()
            for (const id of bufferIdsOf([snapshot])) {
              if (!loaded.has(id)) loaded.set(id, await store.readBuffer(id, manifest.buffers[id], ctx))
              const r = loaded.get(id)
              buffers.set(id, r.buffer)
              if (r.sourceFile) sourceFiles.set(id, r.sourceFile)
              // Already on disk: this tab adopts it rather than writing it again.
              stored.set(id, manifest.buffers[id])
            }
            const docId = editor.restoreDocument(snapshot, buffers, { sourceFiles })
            firstDocId ??= docId
            restored++
            for (const [id, buffer] of buffers) {
              if (!editor.getPeakCache(id)) editor.setPeakCache(id, await computePeakCache(buffer, BASE_SAMPLES_PER_PX))
            }
          } catch (err) {
            console.warn(`Couldn't restore ${snapshot.name}:`, err)
            editor.showToast(`Couldn't restore ${snapshot.name}`, 6000, { tone: 'warn' })
          }
        }
        if (complete) done.push(sessionId)
      }
      if (firstDocId) editor.setActiveDocument(firstDocId)
      // Name the restored buffers in this tab's manifest BEFORE dropping the old
      // ones, so the clean-up never sees them unreferenced.
      await flushNow()
      for (const sessionId of done) await store.deleteManifests(sessionId)
      await refreshPending()
      if (stoppedForMemory) {
        editor.showToast('Some files were not restored: this device is low on memory. Close a file, then restore the rest.', 10000, { tone: 'warn' })
      } else if (restored > 0) {
        editor.showToast(restored === 1 ? 'Restored 1 file' : `Restored ${restored} files`)
      }
    } finally {
      autosave.restoring = false
    }
  }

  /** Throw away the work left by tabs that are gone. */
  async function discard() {
    if (!store) return
    // Their buffers belong to tabs that are gone, so nobody can be mid-write on
    // them: delete the ones no remaining manifest names now, not after the grace.
    const dropped = new Set()
    for (const [sessionId, manifest] of pendingManifests) {
      for (const id of Object.keys(manifest.buffers ?? {})) dropped.add(id)
      await store.deleteManifests(sessionId)
    }
    await refreshPending()
    await flushNow()
    const remaining = (await store.otherManifests()).map(o => o.manifest)
    const ownIds = new Set(stored.keys())
    for (const id of orphanedBufferIds(dropped, remaining)) {
      if (!ownIds.has(id)) await store.deleteBuffer(id)
    }
  }

  return { autosave, start, restore, discard, flushNow }
}
