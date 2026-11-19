/**
 * Session autosave's storage: the origin private file system (OPFS), plus a
 * Web Lock per tab.
 *
 * Layout under `wavely-autosave/`:
 *   sessions/<sessionId>.a.json, .b.json   a tab's manifest, written to the two
 *                                          files in turn: a write cut short
 *                                          leaves the other one whole
 *   buffers/<bufferId>.bin                 an opened file's own bytes
 *   buffers/<bufferId>.f32                 an apply's output: float32, one
 *                                          channel after another
 *
 * LIVE OR DEAD. Each tab holds the lock `wavely-autosave:<sessionId>` for as
 * long as it lives; the browser drops it when the tab closes, crashes or is
 * killed. A manifest whose lock nobody holds belongs to a tab that is gone,
 * and its files are offered back; one whose lock is held belongs to another
 * open tab and is left alone.
 *
 * Writes go through `opfsWriteWorker.js` in chunks of CHUNK_BYTES, so a long
 * file is never copied whole. Reads happen here (`getFile()` works on the main
 * thread everywhere).
 */

export const ROOT_DIR = 'wavely-autosave'
export const CHUNK_BYTES = 8 * 1024 * 1024
const LOCK_PREFIX = 'wavely-autosave:'

/** Whether this browser can autosave at all: OPFS, a worker to write it, and Web Locks. */
export function sessionStoreSupported(nav = globalThis.navigator) {
  return !!(nav?.storage?.getDirectory && nav?.locks?.request && typeof Worker !== 'undefined')
}

/**
 * Open the store and claim this tab's lock. Resolves null where autosave is
 * not supported.
 */
export async function openSessionStore({ sessionId, nav = globalThis.navigator } = {}) {
  if (!sessionStoreSupported(nav)) return null
  const root = await (await nav.storage.getDirectory()).getDirectoryHandle(ROOT_DIR, { create: true })
  const sessionsDir = await root.getDirectoryHandle('sessions', { create: true })
  const buffersDir = await root.getDirectoryHandle('buffers', { create: true })

  // Hold our lock for the tab's whole life. The callback's promise never
  // settles, so the lock is released only by the browser, when the tab goes.
  await new Promise((resolve) => {
    nav.locks.request(LOCK_PREFIX + sessionId, () => {
      resolve()
      return new Promise(() => {})
    })
  })

  const worker = new Worker(new URL('../workers/opfsWriteWorker.js', import.meta.url), { type: 'module' })
  let seq = 0
  const waiting = new Map()
  worker.onmessage = ({ data }) => {
    const w = waiting.get(data.id)
    if (!w) return
    waiting.delete(data.id)
    if (data.ok) w.resolve()
    else {
      const err = new Error(data.message)
      err.name = data.name
      w.reject(err)
    }
  }
  const send = (msg, transfer = []) => new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    worker.postMessage({ ...msg, id }, transfer)
  })

  /** Write `chunks` (an async iterable of ArrayBuffers) to `path`, all or nothing. */
  async function writeChunks(path, chunks) {
    let at = 0
    let first = true
    try {
      for await (const bytes of chunks) {
        await send({ op: 'write', path, at, bytes, first, last: false }, [bytes])
        at += bytes.byteLength
        first = false
      }
      await send({ op: 'write', path, at, bytes: null, first, last: true })
    } catch (err) {
      await send({ op: 'abort', path }).catch(() => {})
      throw err
    }
  }

  const bufferPath = (id, kind) => [ROOT_DIR, 'buffers', `${id}.${kind === 'file' ? 'bin' : 'f32'}`]
  let manifestSlot = 0

  return {
    sessionId,

    /** Copy an opened file's bytes, a chunk at a time. */
    async writeSourceFile(id, file) {
      async function* chunks() {
        for (let at = 0; at < file.size; at += CHUNK_BYTES) {
          yield await file.slice(at, at + CHUNK_BYTES).arrayBuffer()
        }
      }
      await writeChunks(bufferPath(id, 'file'), chunks())
      return { kind: 'file', name: file.name, type: file.type || '', size: file.size }
    },

    /** Store a decoded buffer as float32, channel after channel. */
    async writePcm(id, buffer) {
      const per = CHUNK_BYTES / 4
      async function* chunks() {
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const data = buffer.getChannelData(c)
          for (let i = 0; i < data.length; i += per) yield data.slice(i, i + per).buffer
        }
      }
      await writeChunks(bufferPath(id, 'pcm'), chunks())
      return { kind: 'pcm', sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, length: buffer.length }
    },

    /** Write this tab's manifest to the slot the last write did not use. */
    async writeManifest(manifest) {
      const slot = manifestSlot === 0 ? 'a' : 'b'
      manifestSlot = 1 - manifestSlot
      const bytes = new TextEncoder().encode(JSON.stringify(manifest)).buffer
      async function* one() { yield bytes }
      await writeChunks([ROOT_DIR, 'sessions', `${sessionId}.${slot}.json`], one())
    },

    /** Every manifest on disk except this tab's, newest slot of each, with whether its tab is still open. */
    async otherManifests() {
      const held = new Set(((await nav.locks.query()).held ?? []).map(l => l.name))
      const bySession = new Map()
      for await (const [name, handle] of sessionsDir.entries()) {
        const m = /^(.+)\.(a|b)\.json$/.exec(name)
        if (!m || m[1] === sessionId || handle.kind !== 'file') continue
        let manifest = null
        try { manifest = JSON.parse(await (await handle.getFile()).text()) } catch { continue }
        const prev = bySession.get(m[1])
        if (!prev || (manifest.savedAt ?? 0) > (prev.manifest.savedAt ?? 0)) {
          bySession.set(m[1], { sessionId: m[1], manifest, alive: held.has(LOCK_PREFIX + m[1]) })
        }
      }
      return [...bySession.values()]
    },

    /** Every stored buffer file, complete or not: id → when it was last written (ms). */
    async storedBuffers() {
      const out = new Map()
      for await (const [name, handle] of buffersDir.entries()) {
        const m = /^(.+)\.(bin|f32)$/.exec(name)
        if (!m || handle.kind !== 'file') continue
        const file = await handle.getFile().catch(() => null)
        out.set(m[1], file?.lastModified ?? 0)
      }
      return out
    },

    /**
     * Load a stored buffer as an AudioBuffer: a file's bytes are decoded
     * again; float32 samples are read a channel at a time.
     */
    async readBuffer(id, meta, ctx) {
      const handle = await buffersDir.getFileHandle(`${id}.${meta.kind === 'file' ? 'bin' : 'f32'}`)
      const file = await handle.getFile()
      if (meta.kind === 'file') {
        const decoded = await ctx.decodeAudioData(await file.arrayBuffer())
        // The stored bytes stand in for the original file from now on.
        return { buffer: decoded, sourceFile: new File([file], meta.name, { type: meta.type }) }
      }
      const out = ctx.createBuffer(meta.channels, meta.length, meta.sampleRate)
      const bytesPer = meta.length * 4
      for (let c = 0; c < meta.channels; c++) {
        const ab = await file.slice(c * bytesPer, (c + 1) * bytesPer).arrayBuffer()
        out.copyToChannel(new Float32Array(ab), c)
      }
      return { buffer: out, sourceFile: null }
    },

    async deleteManifests(otherSessionId) {
      for (const slot of ['a', 'b']) {
        await sessionsDir.removeEntry(`${otherSessionId}.${slot}.json`).catch(() => {})
      }
    },

    async deleteBuffer(id) {
      for (const ext of ['bin', 'f32']) await buffersDir.removeEntry(`${id}.${ext}`).catch(() => {})
    },
  }
}
