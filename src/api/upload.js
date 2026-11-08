/**
 * Resumable upload client — the tus 1.0 core protocol against
 * server/lib/uploads.js (any tus server would do).
 *
 * Audio goes up in `chunkSize` PATCHes, each well under Cloudflare's 100 MB
 * request cap, so an hour of stereo reaches the server through the proxy. A
 * chunk that fails on the network or with a 5xx is retried after asking the
 * server how much it has (HEAD), so a dropped connection costs one chunk, not
 * the file. Free of browser-only imports so it runs under node --test.
 */

export const TUS_VERSION = '1.0.0'
export const DEFAULT_CHUNK_SIZE = 20 * 1024 * 1024
const DEFAULT_RETRY_DELAYS = [1000, 3000, 5000, 10000, 20000]

/** Statuses worth retrying: the server is momentarily unable, not refusing. */
const RETRYABLE = new Set([408, 409, 423, 429, 500, 502, 503, 504])

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? abortError())
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? abortError()) }, { once: true })
})

function abortError() {
  const err = new Error('Upload cancelled')
  err.name = 'AbortError'
  return err
}

/** UTF-8 → base64, as Upload-Metadata wants it (btoa alone takes Latin-1). */
function base64(text) {
  let bin = ''
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

function encodeMetadata(meta) {
  return Object.entries(meta)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k} ${base64(String(v))}`)
    .join(',')
}

/** The upload's URL from the creation response's Location. */
function resolveLocation(endpoint, location) {
  if (/^https?:\/\//i.test(location)) return location
  const origin = /^https?:\/\/[^/]+/i.exec(endpoint)?.[0] ?? ''
  return location.startsWith('/') ? origin + location : `${endpoint.replace(/\/$/, '')}/${location}`
}

/**
 * The Error for a refused upload request, shaped like serverError's so
 * entitlements.handleServerRefusal opens the sign-in prompt for a 401.
 */
async function refusal(res, fallback) {
  const body = await res.json().catch(() => ({}))
  const err = new Error(body.error || `${fallback}: ${res.status}`)
  err.status = res.status
  err.code = body.code
  if (res.status === 401 && body.code === 'sign_in_required') err.signIn = body
  return err
}

/**
 * Upload `blob` and resolve with the upload's id, to name in a processing
 * request as `uploadId`.
 *
 * @param {Blob} blob
 * @param {object} opts
 * @param {string}   opts.endpoint       e.g. `${API_BASE}/api/uploads`
 * @param {string}   [opts.filename]
 * @param {Function} [opts.headers]      async () => extra headers, asked afresh
 *                                       per request so a long upload outlives
 *                                       an access token's refresh
 * @param {Function} [opts.onProgress]   (sentBytes, totalBytes)
 * @param {AbortSignal} [opts.signal]
 * @param {number}   [opts.chunkSize]
 * @param {number[]} [opts.retryDelays]  per consecutive failure; exhausted = give up
 * @param {Function} [opts.fetch]
 * @param {Function} [opts.wait]         (ms, signal) => Promise — tests skip the delays
 */
export async function uploadBlob(blob, {
  endpoint, filename = 'audio.wav', headers = async () => ({}), onProgress,
  signal, chunkSize = DEFAULT_CHUNK_SIZE, retryDelays = DEFAULT_RETRY_DELAYS,
  fetch: fetchImpl = globalThis.fetch, wait = sleep,
}) {
  const total = blob.size
  const request = async (url, init) => fetchImpl(url, {
    ...init,
    signal,
    headers: { 'Tus-Resumable': TUS_VERSION, ...(await headers()), ...init.headers },
  })

  // ── Create ──────────────────────────────────────────────────────────────────
  const created = await request(endpoint, {
    method: 'POST',
    headers: {
      'Upload-Length': String(total),
      'Upload-Metadata': encodeMetadata({ filename, filetype: blob.type || 'audio/wav' }),
    },
  })
  if (created.status !== 201) throw await refusal(created, 'Upload failed')
  const url = resolveLocation(endpoint, created.headers.get('Location') ?? '')
  const id = url.split('/').pop()

  // ── Send ────────────────────────────────────────────────────────────────────
  // Any failure or cancel from here on DELETEs the upload: an abandoned one
  // would hold one of the caller's in-flight slots and its declared size
  // against their quota until it expires (an hour), so a few failed attempts
  // could lock them out of uploading at all.
  try {
    await send(url)
  } catch (err) {
    await discardUpload(url, { headers, fetch: fetchImpl, wait })
    throw err
  }
  return id

  async function send(url) {
    let offset = 0
    let failures = 0
    onProgress?.(0, total)
    while (offset < total) {
      let res = null
      let stalled = false
      try {
        res = await request(url, {
          method: 'PATCH',
          headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
          body: blob.slice(offset, Math.min(offset + chunkSize, total)),
        })
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err
        res = null   // network failure: retry below
      }

      if (res?.status === 204) {
        const next = Number(res.headers.get('Upload-Offset'))
        // Only progress resets the retry budget. A 204 that did not move the
        // offset (or reports one past the end) is a failed chunk, not a
        // success, or the same chunk could be resent forever.
        if (Number.isFinite(next) && next > offset && next <= total) {
          offset = next
          failures = 0
          onProgress?.(offset, total)
          continue
        }
        res = null
        stalled = true
      }
      if (res && !RETRYABLE.has(res.status)) throw await refusal(res, 'Upload failed')
      if (failures >= retryDelays.length) {
        if (res) throw await refusal(res, 'Upload failed')
        throw new Error(stalled
          ? 'Upload failed: the server stopped accepting data'
          : 'Upload failed: the connection kept dropping')
      }

      await wait(retryDelays[failures++], signal)
      // Ask where the server got to; part of the failed chunk may have landed.
      try {
        const probe = await request(url, { method: 'HEAD' })
        if (probe.status === 404) throw Object.assign(new Error('The upload expired — please try again'), { status: 404 })
        if (probe.ok) {
          const at = Number(probe.headers.get('Upload-Offset'))
          if (Number.isFinite(at) && at >= 0 && at <= total) offset = at
        }
      } catch (err) {
        if (err?.status === 404 || err?.name === 'AbortError' || signal?.aborted) throw err
        // Still offline: the next PATCH attempt fails and counts another try.
      }
    }
  }
}

/**
 * Delete an upload that will not be used, best effort: never throws, and runs
 * without the caller's (possibly aborted) signal. A 423 means a PATCH the
 * client gave up on is still landing; it is retried briefly. Whatever this
 * cannot delete, the server's idle expiry does.
 *
 * @param {string} url  the upload's URL
 * @param {object} [opts]
 * @param {Function} [opts.headers]  async () => extra headers (auth)
 * @param {Function} [opts.fetch]
 * @param {Function} [opts.wait]     (ms) => Promise
 * @param {number[]} [opts.busyDelays]
 */
export async function discardUpload(url, {
  headers = async () => ({}), fetch: fetchImpl = globalThis.fetch, wait = sleep,
  busyDelays = [500, 1000, 2000],
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'DELETE',
        headers: { 'Tus-Resumable': TUS_VERSION, ...(await headers()) },
      })
      if (res.status !== 423 || attempt >= busyDelays.length) return
    } catch {
      return
    }
    try { await wait(busyDelays[attempt]) } catch { return }
  }
}
