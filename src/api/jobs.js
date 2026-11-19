/**
 * Status and download for a server job by id (GET /api/jobs/:jobId and
 * /download) — what a resumed job needs once the request that started it is
 * gone (src/composables/useServerJobs.js).
 *
 * Errors carry `status` (the HTTP status) so a caller can tell a job the
 * server no longer has (404: expired, or lost in a restart) and a result
 * already downloaded (410) from anything else.
 */
import { serverError } from './serverError.js'

const API_BASE = import.meta.env?.VITE_API_BASE_URL ?? ''

export async function fetchJobStatus(jobId, fallback = 'Status check failed') {
  const res = await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}`)
  if (!res.ok) throw await serverError(res, fallback)
  return res.json()
}

export async function downloadJob(jobId, fallback = 'Download failed') {
  const res = await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/download`)
  if (!res.ok) throw await serverError(res, fallback)
  return res.blob()
}
