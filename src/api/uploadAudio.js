/**
 * Audio for a server request goes up as a resumable upload first
 * (src/api/upload.js → /api/uploads), then the request names it by id. Every
 * request body stays small, so files far over Cloudflare's 100 MB cap get
 * through, and a dropped connection resumes instead of restarting.
 */

import { uploadBlob, discardUpload } from './upload.js'
import { authHeaders, serverError } from './serverError.js'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

/**
 * Upload `blob`; resolves with its upload id.
 * @param {Blob} blob
 * @param {{ filename?: string, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal }} [opts]
 */
export function uploadAudio(blob, { filename = 'audio.wav', onProgress, signal } = {}) {
  return uploadBlob(blob, {
    endpoint: `${API_BASE}/api/uploads`, filename, headers: authHeaders, onProgress, signal,
  })
}

/**
 * Delete an upload that will not be used (cancelled, or its request refused).
 * Best effort; never throws.
 */
export function discardAudioUpload(uploadId) {
  if (!uploadId) return Promise.resolve()
  return discardUpload(`${API_BASE}/api/uploads/${encodeURIComponent(uploadId)}`, { headers: authHeaders })
}

/**
 * POST a JSON body naming an upload to a processing route; throws
 * serverError's Error on refusal. Resolves with the Response.
 *
 * A refusal deletes the upload: most (429 / 503 admission, sign-in, plan) come
 * before the route takes it, and left in the store it would count against the
 * caller's upload quota for an hour, so a few refused retries would lock them
 * out. Where the route had already taken it the delete is a harmless 404.
 */
export async function postWithUpload(path, body, fallback) {
  let res
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    })
  } catch (err) {
    await discardAudioUpload(body?.uploadId)
    throw err
  }
  if (!res.ok) {
    const err = await serverError(res, fallback)
    await discardAudioUpload(body?.uploadId)
    throw err
  }
  return res
}
