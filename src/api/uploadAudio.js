/**
 * Audio for a server request goes up as a resumable upload first
 * (src/api/upload.js → /api/uploads), then the request names it by id. Every
 * request body stays small, so files far over Cloudflare's 100 MB cap get
 * through, and a dropped connection resumes instead of restarting.
 */

import { uploadBlob } from './upload.js'
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
 * POST a JSON body naming an upload to a processing route; throws
 * serverError's Error on refusal. Resolves with the Response.
 */
export async function postWithUpload(path, body, fallback) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await serverError(res, fallback)
  return res
}
