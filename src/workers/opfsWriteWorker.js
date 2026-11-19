/**
 * Writes files into the origin private file system (OPFS) for session autosave.
 *
 * In a worker because the one write API every browser with OPFS has —
 * `createSyncAccessHandle` (Safari 15.2+, Chrome 102+, Firefox 111+) — exists
 * only in workers; the main thread's `createWritable` is missing from older
 * Safari. A file arrives in chunks (the caller never copies a whole decoded
 * buffer at once), each written at its offset:
 *
 *   { id, op: 'write', path: ['dir', …, 'name'], at, bytes, first, last }
 *     first → create / open and truncate; last → flush and close.
 *   { id, op: 'abort', path }  → close without keeping the half-written file.
 *
 * Every message is answered `{ id, ok: true }` or `{ id, ok: false, name, message }`
 * (a full disk is `QuotaExceededError`).
 */

const open = new Map() // path key → FileSystemSyncAccessHandle

async function fileHandle(path, create) {
  let dir = await navigator.storage.getDirectory()
  for (const part of path.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create })
  return { dir, file: await dir.getFileHandle(path[path.length - 1], { create }) }
}

async function write({ path, at, bytes, first, last }) {
  const key = path.join('/')
  let access = open.get(key)
  if (first || !access) {
    if (access) access.close()
    const { file } = await fileHandle(path, true)
    access = await file.createSyncAccessHandle()
    access.truncate(0)
    open.set(key, access)
  }
  if (bytes && bytes.byteLength) access.write(new Uint8Array(bytes), { at })
  if (last) {
    access.flush()
    access.close()
    open.delete(key)
  }
}

async function abort({ path }) {
  const key = path.join('/')
  const access = open.get(key)
  if (access) {
    access.close()
    open.delete(key)
  }
  try {
    const { dir } = await fileHandle(path, false)
    await dir.removeEntry(path[path.length - 1])
  } catch { /* nothing to remove */ }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.op === 'write') await write(data)
    else if (data.op === 'abort') await abort(data)
    else throw new Error(`unknown op ${data.op}`)
    self.postMessage({ id: data.id, ok: true })
  } catch (err) {
    self.postMessage({ id: data.id, ok: false, name: err?.name ?? 'Error', message: String(err?.message ?? err) })
  }
}
