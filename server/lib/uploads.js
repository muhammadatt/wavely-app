/**
 * Resumable uploads — the tus 1.0 core protocol plus its creation, termination
 * and expiration extensions, enough for any tus client (our own is
 * src/api/upload.js).
 *
 * WHY: Cloudflare refuses request bodies over 100 MB on Free and Pro, and an
 * hour of narration is 635 MB of mono float WAV (1.27 GB stereo). A file sent
 * in ≤ 20 MB PATCHes passes through Cloudflare whole, keeps the origin hidden
 * behind it, and survives a dropped connection: the client asks the offset
 * (HEAD) and carries on instead of starting over. See docs/cloudflare.md.
 *
 *   POST   /api/uploads        Upload-Length, Upload-Metadata → 201 Location
 *   HEAD   /api/uploads/:id    → Upload-Offset, Upload-Length
 *   PATCH  /api/uploads/:id    Upload-Offset, application/offset+octet-stream
 *   DELETE /api/uploads/:id    → 204
 *
 * A finished upload is then named by its id in a processing request
 * (`{ uploadId }` in a JSON body); `useUpload` hands it to the route as
 * `req.file`, so the plan gate, the request log and the handlers see what they
 * saw with multer. An upload is single-use: taking it moves the file out of
 * the store.
 *
 * ⚠ OWNERSHIP: an upload belongs to whoever created it — the account when
 * signed in, else the IP (`clientOf`) — and every other request on it, from
 * anyone else, is a 404. Ids are random UUIDs as well, but the owner check is
 * what stops one account processing another's audio.
 *
 * LIMITS, all checked at creation, before a byte is stored:
 *   maxBytes            one upload (60 min of stereo float WAV fits)
 *   maxSignedOutBytes   one upload by a signed-out caller — mastering's 30 s
 *                       preview is the only thing they may run, so anything
 *                       bigger is refused here instead of after it is stored
 *   maxActivePerClient  uploads one caller may have unfinished or untaken
 *   maxBytesPerClient   bytes those may add up to
 *   maxTotalBytes       bytes all uploads may add up to — a disk guard (503)
 * and an upload idle for `ttlMs` (no PATCH, not taken) is deleted.
 *
 * In memory, like the job store: a restart forgets every upload, so the
 * directory is emptied at start.
 *
 * Environment (readUploadConfig):
 *   UPLOAD_MAX_BYTES              default 1.5 GB
 *   UPLOAD_MAX_SIGNED_OUT_BYTES   default 32 MB
 *   UPLOAD_MAX_ACTIVE_PER_CLIENT  default 3
 *   UPLOAD_MAX_BYTES_PER_CLIENT   default 3 GB
 *   UPLOAD_MAX_TOTAL_BYTES        default 20 GB
 *   UPLOAD_TTL_MS                 default 60 min
 */

import { Router } from 'express'
import { randomUUID } from 'crypto'
import { createWriteStream } from 'fs'
import { mkdir, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import { clientOf } from './jobQueue.js'
import { optionalAuth } from './auth.js'

export const TUS_VERSION = '1.0.0'
const MB = 1024 * 1024

export class UploadRefusal extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function readBytes(name, fallback) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function readUploadConfig() {
  return {
    maxBytes:           readBytes('UPLOAD_MAX_BYTES', 1536 * MB),
    maxSignedOutBytes:  readBytes('UPLOAD_MAX_SIGNED_OUT_BYTES', 32 * MB),
    maxActivePerClient: readBytes('UPLOAD_MAX_ACTIVE_PER_CLIENT', 3),
    maxBytesPerClient:  readBytes('UPLOAD_MAX_BYTES_PER_CLIENT', 3072 * MB),
    maxTotalBytes:      readBytes('UPLOAD_MAX_TOTAL_BYTES', 20480 * MB),
    ttlMs:              readBytes('UPLOAD_TTL_MS', 60 * 60 * 1000),
  }
}

/** Upload-Metadata: comma-separated `key base64value` pairs (value optional). */
export function parseMetadata(header = '') {
  const out = {}
  for (const pair of String(header).split(',')) {
    const [key, value] = pair.trim().split(' ')
    if (!key) continue
    out[key] = value ? Buffer.from(value, 'base64').toString('utf8') : ''
  }
  return out
}

/**
 * A display name for logs and the extension check: no directories, no control
 * characters (a newline would forge a log line), bounded. Never a path on disk
 * — the stored file is named by the upload's id.
 */
function safeFilename(name) {
  const base = path.basename(String(name || 'audio.wav').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '_')
  return base.slice(-120) || 'audio.wav'
}

export function createUploadStore({
  dir,
  maxBytes = 1536 * MB,
  maxSignedOutBytes = 32 * MB,
  maxActivePerClient = 3,
  maxBytesPerClient = 3072 * MB,
  maxTotalBytes = 20480 * MB,
  ttlMs = 60 * 60 * 1000,
  now = Date.now,
  log = line => console.log(line),
} = {}) {
  /** @type {Map<string, { id, client, user, ip, length, offset, filename, path, touchedAt, busy }>} */
  const uploads = new Map()
  const ready = rm(dir, { recursive: true, force: true }).then(() => mkdir(dir, { recursive: true }))

  const event = (action, u, extra = {}) => log(JSON.stringify({
    evt: 'upload', t: new Date(now()).toISOString(), action,
    id: u.id, user: u.user, ip: u.ip, length: u.length, offset: u.offset, ...extra,
  }))

  function totals(client) {
    let all = 0, mine = 0, count = 0
    for (const u of uploads.values()) {
      all += u.length
      if (u.client === client) { mine += u.length; count++ }
    }
    return { all, mine, count }
  }

  /**
   * @param {{ client: string, signedOut: boolean, length: number,
   *           metadata?: object, user?: string|null, ip?: string|null }} opts
   */
  async function create({ client, signedOut, length, metadata = {}, user = null, ip = null }) {
    await ready
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new UploadRefusal(400, 'bad_length', 'Upload-Length must be a positive integer.')
    }
    const limit = signedOut ? Math.min(maxSignedOutBytes, maxBytes) : maxBytes
    if (length > limit) {
      throw signedOut
        ? new UploadRefusal(401, 'sign_in_required', 'Sign in to upload more than a short preview.')
        : new UploadRefusal(413, 'upload_too_large', `Uploads are limited to ${Math.round(maxBytes / MB)} MB.`)
    }
    const { all, mine, count } = totals(client)
    if (count >= maxActivePerClient || mine + length > maxBytesPerClient) {
      throw new UploadRefusal(429, 'too_many_uploads', 'You have too many uploads in progress — wait for them to finish.')
    }
    if (all + length > maxTotalBytes) {
      throw new UploadRefusal(503, 'server_busy', 'The server is busy — please try again in a few minutes.')
    }

    const id = randomUUID()
    const u = {
      id, client, user, ip, length, offset: 0,
      filename: safeFilename(metadata.filename),
      path: path.join(dir, id),
      touchedAt: now(),
      busy: false,
    }
    await writeFile(u.path, '')
    uploads.set(id, u)
    event('created', u, { filename: u.filename })
    return u
  }

  /** The caller's upload, or null — someone else's reads as missing. */
  function get(id, client) {
    const u = uploads.get(id)
    return u && u.client === client ? u : null
  }

  /**
   * Append `stream` at `offset`. Returns the new offset — fewer bytes than sent
   * if the client hung up mid-chunk; tus clients resume from HEAD's answer.
   */
  async function append(u, offset, stream) {
    if (u.busy) throw new UploadRefusal(423, 'upload_busy', 'This upload is already receiving data.')
    if (offset !== u.offset) {
      throw new UploadRefusal(409, 'offset_mismatch', `Upload-Offset ${offset} does not match ${u.offset}.`)
    }
    u.busy = true
    try {
      const room = u.length - u.offset
      let seen = 0
      const guard = new Transform({
        transform(chunk, _enc, done) {
          seen += chunk.length
          if (seen > room) return done(new UploadRefusal(413, 'upload_too_large', 'More data than Upload-Length.'))
          done(null, chunk)
        },
      })
      let failure = null
      try {
        await pipeline(stream, guard, createWriteStream(u.path, { flags: 'a' }))
      } catch (err) {
        failure = err
      }
      // What reached the disk is the truth, whatever the stream said. The
      // guard never passes the chunk that would overrun, so size ≤ length.
      const { size } = await stat(u.path)
      u.offset = size
      u.touchedAt = now()
      if (u.offset === u.length) event('completed', u)
      if (failure instanceof UploadRefusal) throw failure
      return u.offset
    } finally {
      u.busy = false
    }
  }

  /**
   * Hand a finished upload over: move its file to `destDir` and forget it.
   * Throws an UploadRefusal (404 missing / not yours, 409 unfinished).
   */
  async function take(id, client, destDir) {
    const u = get(id, client)
    if (!u) throw new UploadRefusal(404, 'upload_not_found', 'Upload not found or expired — please try again.')
    if (u.busy || u.offset !== u.length) {
      throw new UploadRefusal(409, 'upload_incomplete', 'The upload has not finished.')
    }
    uploads.delete(id)
    const dest = path.join(destDir, `upload-${id}`)
    await mkdir(destDir, { recursive: true })
    await rename(u.path, dest)
    event('taken', u)
    return { path: dest, size: u.length, originalname: u.filename }
  }

  async function remove(u, reason = 'deleted') {
    if (uploads.get(u.id) !== u) return
    uploads.delete(u.id)
    await unlink(u.path).catch(() => {})
    event(reason, u)
  }

  /** Delete uploads idle past the TTL. Returns how many went. */
  async function sweep() {
    const cutoff = now() - ttlMs
    const stale = [...uploads.values()].filter(u => !u.busy && u.touchedAt < cutoff)
    for (const u of stale) await remove(u, 'expired')
    return stale.length
  }

  function startSweeping(everyMs = 60_000) {
    const timer = setInterval(() => { sweep().catch(() => {}) }, everyMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  const expiresAt = u => new Date(u.touchedAt + ttlMs).toUTCString()

  return {
    create, get, append, take, remove, sweep, startSweeping, expiresAt, ready,
    limits: { maxBytes, maxSignedOutBytes },
    stats: () => ({ count: uploads.size, bytes: totals(null).all }),
  }
}

/**
 * The tus endpoint. Mount under /api: `app.use('/api', createUploadRoutes(…))`.
 *
 * @param {object} deps
 * @param {object}   deps.store       createUploadStore(…)
 * @param {Function} [deps.verify]    access-token verifier; null = accounts
 *                                    off, and nobody counts as signed out
 * @param {Function} [deps.isBlocked] lib/usage.js — a blocked account may not
 *                                    upload
 */
export function createUploadRoutes({ store, verify = null, isBlocked = null }) {
  const router = Router()

  const tusHeaders = (res) => {
    res.set('Tus-Resumable', TUS_VERSION)
    res.set('Cache-Control', 'no-store')
  }

  const refuse = (res, err) => {
    if (!(err instanceof UploadRefusal)) throw err
    tusHeaders(res)
    if (err.status === 503) res.set('Retry-After', '60')
    return res.status(err.status).json({ error: err.message, code: err.code })
  }

  // Every request identifies its caller: the owner check needs it, and so do
  // the sign-in and block rules at creation.
  router.use('/uploads', optionalAuth(verify))

  router.options(['/uploads', '/uploads/:id'], (_req, res) => {
    tusHeaders(res)
    res.set('Tus-Version', TUS_VERSION)
    res.set('Tus-Extension', 'creation,termination,expiration')
    res.set('Tus-Max-Size', String(store.limits.maxBytes))
    res.status(204).end()
  })

  router.post('/uploads', async (req, res) => {
    try {
      if (req.get('Tus-Resumable') !== TUS_VERSION) {
        throw new UploadRefusal(412, 'tus_version', `Tus-Resumable ${TUS_VERSION} required.`)
      }
      if (req.user && isBlocked && await isBlocked(req.user.id)) {
        throw new UploadRefusal(403, 'account_blocked',
          'This account has been suspended from server processing. Contact support if you think this is a mistake.')
      }
      const u = await store.create({
        client: clientOf(req),
        // With accounts off everyone is anonymous; the signed-out cap would
        // then refuse every real file.
        signedOut: !!verify && !req.user,
        length: Number(req.get('Upload-Length')),
        metadata: parseMetadata(req.get('Upload-Metadata')),
        user: req.user?.id ?? null,
        ip: req.ip ?? null,
      })
      tusHeaders(res)
      res.set('Location', `${req.baseUrl}/uploads/${u.id}`)
      res.set('Upload-Expires', store.expiresAt(u))
      res.status(201).end()
    } catch (err) {
      return refuse(res, err)
    }
  })

  router.head('/uploads/:id', (req, res) => {
    const u = store.get(req.params.id, clientOf(req))
    tusHeaders(res)
    if (!u) return res.status(404).end()
    res.set('Upload-Offset', String(u.offset))
    res.set('Upload-Length', String(u.length))
    res.set('Upload-Expires', store.expiresAt(u))
    res.status(200).end()
  })

  router.patch('/uploads/:id', async (req, res) => {
    try {
      if (req.get('Tus-Resumable') !== TUS_VERSION) {
        throw new UploadRefusal(412, 'tus_version', `Tus-Resumable ${TUS_VERSION} required.`)
      }
      if (req.get('Content-Type') !== 'application/offset+octet-stream') {
        throw new UploadRefusal(415, 'bad_content_type', 'Content-Type must be application/offset+octet-stream.')
      }
      const u = store.get(req.params.id, clientOf(req))
      if (!u) throw new UploadRefusal(404, 'upload_not_found', 'Upload not found or expired.')
      const offset = await store.append(u, Number(req.get('Upload-Offset')), req)
      tusHeaders(res)
      res.set('Upload-Offset', String(offset))
      res.set('Upload-Expires', store.expiresAt(u))
      res.status(204).end()
    } catch (err) {
      // The body may still be arriving; read the rest away so the reply lands.
      req.resume()
      return refuse(res, err)
    }
  })

  router.delete('/uploads/:id', async (req, res) => {
    const u = store.get(req.params.id, clientOf(req))
    tusHeaders(res)
    if (!u) return res.status(404).end()
    if (u.busy) return res.status(423).json({ error: 'This upload is receiving data.', code: 'upload_busy' })
    await store.remove(u)
    res.status(204).end()
  })

  return router
}

/**
 * Route middleware, after multer: when the body names a finished upload
 * (`uploadId`) instead of carrying a file, take it and present it as
 * `req.file`. Refuses 404 / 409 with the store's code. A multipart request
 * passes through untouched.
 */
export function useUpload(store, destDir) {
  return async (req, res, next) => {
    const id = req.body?.uploadId
    if (req.file || typeof id !== 'string' || !id) return next()
    try {
      req.file = await store.take(id, clientOf(req), destDir)
      next()
    } catch (err) {
      if (!(err instanceof UploadRefusal)) return next(err)
      res.status(err.status).json({ error: err.message, code: err.code })
    }
  }
}
