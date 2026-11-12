import { shallowRef, computed, markRaw } from 'vue'

/**
 * The working folder: one directory the user grants the app, so Save can say
 * where a file is going ("Ch Audiobook › Raw takes") and write straight into
 * it with no system dialog.
 *
 * ⚠ IT IS THE ONLY WAY A PAGE LEARNS ANYTHING ABOUT PATHS. A file handle gives
 * its name and nothing else — no folder, no path; browsers withhold them on
 * purpose, since a full path usually carries the user's account name. A
 * directory handle gives ITS name, and `resolve()` gives the path of any
 * handle inside it relative to it. So locations are shown relative to the
 * folder, never absolute, and a file opened from outside it still reads
 * "Same folder as the original".
 *
 * The handle is kept in IndexedDB so the folder survives a reload. Permission
 * does not: Chrome asks again on the first write of each visit, which the Save
 * click provides the gesture for (`ensureFolderPermission`).
 */

const DB_NAME = 'wavely-fs'
const STORE = 'handles'
const KEY = 'workingFolder'

// App-wide: every document's Save dialog shares the one folder.
const folder = shallowRef(null)

function supported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idb(mode, op) {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = op(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

// Restore once per page. Anything that is not a live directory handle (a
// browser that cannot clone them, an old record) is ignored, never trusted.
if (supported() && typeof indexedDB !== 'undefined') {
  idb('readonly', s => s.get(KEY))
    .then(h => {
      if (!folder.value && h?.kind === 'directory' && typeof h.resolve === 'function') folder.value = markRaw(h)
    })
    .catch(err => console.warn('Could not restore the working folder:', err))
}

/**
 * The path of `handle` inside `root`, as directory names, or null when it is
 * not inside it. `resolve()` returns the full path including the entry itself;
 * the last element (the file's own name) is dropped.
 */
export async function directoryPathIn(root, handle) {
  if (!root || !handle || typeof root.resolve !== 'function') return null
  try {
    const parts = await root.resolve(handle)
    return parts ? parts.slice(0, -1) : null
  } catch {
    return null
  }
}

export function useWorkingFolder() {
  const folderName = computed(() => folder.value?.name ?? null)

  /**
   * Ask for a folder. `startIn` (a file handle) opens the picker in that file's
   * folder — usually the one the user wants.
   * @returns {Promise<boolean>} false when cancelled
   */
  async function chooseFolder(startIn = null) {
    const options = { mode: 'readwrite', id: 'wavely-working-folder' }
    if (startIn) options.startIn = startIn
    let handle
    try {
      handle = await window.showDirectoryPicker(options)
    } catch (err) {
      if (err?.name === 'AbortError') return false
      throw err
    }
    folder.value = markRaw(handle)
    idb('readwrite', s => s.put(handle, KEY)).catch(err => console.warn('Could not remember the working folder:', err))
    return true
  }

  function clearFolder() {
    folder.value = null
    idb('readwrite', s => s.delete(KEY)).catch(() => {})
  }

  /** Read-write permission on the folder; asks if needed (needs a user gesture). */
  async function ensureFolderPermission() {
    const h = folder.value
    if (!h) return false
    if (typeof h.queryPermission !== 'function') return true
    const opts = { mode: 'readwrite' }
    if (await h.queryPermission(opts) === 'granted') return true
    if (typeof h.requestPermission !== 'function') return true
    return await h.requestPermission(opts) === 'granted'
  }

  /** Walk down from the folder to a subdirectory given as names. */
  async function directoryAt(segments) {
    let dir = folder.value
    for (const name of segments) dir = await dir.getDirectoryHandle(name)
    return dir
  }

  /** The handle for `name` in `dir` if a file of that name exists, else null. */
  async function existingFile(dir, name) {
    try {
      return await dir.getFileHandle(name)
    } catch {
      return null
    }
  }

  return {
    folder, folderName, supported: supported(),
    chooseFolder, clearFolder, ensureFolderPermission, directoryAt, existingFile,
    locate: handle => directoryPathIn(folder.value, handle),
  }
}
