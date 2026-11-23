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
import { useServerJobs } from './useServerJobs.js'

export const SAVE_DELAY_MS = 1500
/** A buffer file no manifest names is deleted once it is this old (another tab may be mid-write). */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000
const BASE_SAMPLES_PER_PX = 256
/** After start, how often and how many times to look again for work a closing tab still held. */
const PENDING_RECHECK_MS = 2000
const PENDING_RECHECKS = 15

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
/** Buffers that could not be stored this visit: skipped, so they never block the rest. */
const unwritable = new Set()
let timer = null
let running = null
let again = false

export function useSessionAutosave() {
  const editor = useEditorState()
  const { appState } = editor

  // A file a server job is working on is kept too, edits or not, so the
  // result has its file to land on after a reload (useServerJobs.js).
  const { pendingDocIds } = useServerJobs()
  const keep = d => hasUnsavedEdits(d) || pendingDocIds.value.has(d.id)

  const signature = computed(() =>
    appState.documents.map(d => `${d.id}:${d.revision}:${d.savedRevision}:${d.name}:${keep(d)}`).join('|'))

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
      else recheckPending()
    })
    // A tab that has just closed can still hold its lock for a moment — an
    // installed phone app relaunched straight after Back closed it is the
    // common case — and its work would read as another open tab's and never
    // be offered. Look again for a while, until its lock is let go.
    let tries = 0
    const poll = setInterval(async () => {
      if (++tries >= PENDING_RECHECKS || !(await recheckPending())) clearInterval(poll)
    }, PENDING_RECHECK_MS)
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
        const needed = [...bufferIdsOf(appState.documents.filter(keep))].filter(id => !stored.has(id))
        if (needed.length === 0) break
        let wrote = false
        for (const id of needed) {
          if (unwritable.has(id)) continue
          const meta = await storeBuffer(id)
          if (!meta) continue
          stored.set(id, meta)
          wrote = true
          if (stored.size === 1) navigator.storage.persist?.().catch(() => {})
        }
        if (!wrote) break
      }
      const manifest = buildManifest({
        sessionId: store.sessionId,
        documents: appState.documents.filter(d => bufferIdsOfDoc(d).every(id => stored.has(id))),
        describe: id => stored.get(id),
        keep,
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

  /**
   * Write one buffer: the opened file's own bytes when there are any, else the
   * decoded samples. A source file that can no longer be read — replaced by a
   * Save, moved or deleted on disk, or a restored file whose stored copy the
   * clean-up removed — is forgotten and the samples stored instead. A buffer
   * that cannot be stored at all is skipped for this visit, so it never holds
   * up the other files' recovery point. A full disk still stops autosave.
   * Resolves the buffer's description, or null when it was skipped.
   */
  async function storeBuffer(id) {
    const buffer = editor.bufferPool.get(id)
    if (!buffer) return null
    const file = editor.getBufferSourceFile(id)
    if (file) {
      try {
        return await store.writeSourceFile(id, file)
      } catch (err) {
        if (err?.name === 'QuotaExceededError') throw err
        console.warn(`Couldn't read the original of buffer ${id}; storing its samples instead:`, err)
        editor.forgetBufferSourceFile(id)
      }
    }
    try {
      return await store.writePcm(id, buffer)
    } catch (err) {
      if (err?.name === 'QuotaExceededError') throw err
      console.warn(`Couldn't back up buffer ${id}:`, err)
      unwritable.add(id)
      return null
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

  /**
   * Refresh what is on offer, unless a restore or discard is using it.
   * Resolves whether any other tab's work is still held by a live lock.
   */
  async function recheckPending() {
    if (!store || autosave.restoring) return false
    try {
      return await refreshPending()
    } catch (err) {
      console.warn('Session autosave: could not look for unsaved work:', err)
      return false
    }
  }

  /**
   * Find work left by tabs that are gone. Unreadable or empty leftovers are
   * removed. Resolves whether any manifest belongs to a tab still holding its lock.
   */
  async function refreshPending() {
    const others = await store.otherManifests()
    let anyAlive = false
    pendingManifests.clear()
    const pending = []
    for (const o of others) {
      if (o.alive) { anyAlive = true; continue }
      if (!isRestorableManifest(o.manifest) || o.manifest.docs.length === 0) {
        await store.deleteManifests(o.sessionId)
        continue
      }
      pendingManifests.set(o.sessionId, o.manifest)
      pending.push({ sessionId: o.sessionId, savedAt: o.manifest.savedAt, files: o.manifest.docs.map(d => d.name) })
    }
    autosave.pending = pending.sort((a, b) => b.savedAt - a.savedAt)
    return anyAlive
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
    /** sessionId → the snapshots still to restore (what failed or did not fit). */
    const leftover = new Map()
    let restored = 0
    let failed = 0
    let firstDocId = null
    let stoppedForMemory = false
    try {
      for (const [sessionId, manifest] of pendingManifests) {
        const left = []
        for (const snapshot of manifest.docs) {
          if (stoppedForMemory || (mobile && editor.poolBytes.value > budget * 0.9)) {
            stoppedForMemory = true
            left.push(snapshot)
            continue
          }
          try {
            const buffers = new Map()
            const sourceFiles = new Map()
            for (const id of bufferIdsOf([snapshot])) {
              if (!loaded.has(id)) loaded.set(id, await store.readBuffer(id, manifest.buffers[id], ctx))
              const r = loaded.get(id)
              buffers.set(id, r.buffer)
              if (r.sourceFile) sourceFiles.set(id, r.sourceFile)
            }
            const docId = editor.restoreDocument(snapshot, buffers, { sourceFiles })
            // Already on disk: this tab adopts its buffers rather than writing them again.
            for (const id of buffers.keys()) stored.set(id, manifest.buffers[id])
            firstDocId ??= docId
            restored++
            for (const [id, buffer] of buffers) {
              if (!editor.getPeakCache(id)) editor.setPeakCache(id, await computePeakCache(buffer, BASE_SAMPLES_PER_PX))
            }
          } catch (err) {
            // Kept on offer: this may be the only copy, and the failure may pass
            // (memory, a busy disk). Discard is how the user lets it go.
            console.warn(`Couldn't restore ${snapshot.name}:`, err)
            failed++
            left.push(snapshot)
          }
        }
        leftover.set(sessionId, left)
      }
      if (firstDocId) editor.setActiveDocument(firstDocId)
      // Name the restored buffers in this tab's manifest BEFORE the old
      // manifests change, so the clean-up never sees them unreferenced.
      await flushNow()
      for (const [sessionId, left] of leftover) {
        if (left.length === 0) {
          await store.deleteManifests(sessionId)
          continue
        }
        // Offer only what is still to restore, so the next Restore never opens
        // a file twice. Its buffers stay named, so the clean-up leaves them.
        const old = pendingManifests.get(sessionId)
        const buffers = {}
        for (const id of bufferIdsOf(left)) buffers[id] = old.buffers[id]
        await store.replaceManifest(sessionId, { ...old, savedAt: Date.now(), docs: left, buffers })
      }
      await refreshPending()
      if (stoppedForMemory) {
        editor.showToast('Some files were not restored: this device is low on memory. Close a file, then restore the rest.', 10000, { tone: 'warn' })
      } else if (failed > 0) {
        editor.showToast(
          `${failed === 1 ? '1 file' : `${failed} files`} couldn't be restored and ${failed === 1 ? 'is' : 'are'} still on offer. Try again, or discard ${failed === 1 ? 'it' : 'them'}.`,
          10000, { tone: 'warn' },
        )
      } else if (restored > 0) {
        editor.showToast(restored === 1 ? 'Restored 1 file' : `Restored ${restored} files`)
      }
    } finally {
      autosave.restoring = false
    }
  }

  /** Throw away the work left by tabs that are gone. */
  async function discard() {
    // Never while a restore is reading the files it would delete.
    if (!store || autosave.restoring) return
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
