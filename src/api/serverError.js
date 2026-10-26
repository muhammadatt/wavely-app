import { useAuth } from '../composables/useAuth.js'

/**
 * `Authorization` header for calls to our API, or {} when signed out or
 * accounts are off. Server-processing routes read it to decide between the
 * full feature and the free preview.
 */
export async function authHeaders() {
  const token = await useAuth().getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * The Error to throw for a failed API response. A 402 carries the server's
 * `upgrade_required` body on `err.upgrade`, and a 401 its `sign_in_required`
 * body on `err.signIn`, so the caller can open the right prompt instead of
 * showing a raw failure.
 */
export async function serverError(res, fallback) {
  const body = await res.json().catch(() => ({}))
  const err = new Error(body.error || `${fallback}: ${res.status}`)
  err.status = res.status
  if (res.status === 402 && body.code === 'upgrade_required') err.upgrade = body
  if (res.status === 401 && body.code === 'sign_in_required') err.signIn = body
  return err
}
