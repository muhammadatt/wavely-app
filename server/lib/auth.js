/**
 * Supabase access-token verification and the Express middleware built on it.
 *
 * The browser signs in with Supabase Auth and sends its access token as
 * `Authorization: Bearer <jwt>`. A header rather than a cookie because the
 * pre-production frontend (Vercel) and API (Linux box) live on different
 * domains, where a cookie would need SameSite=None and CSRF handling; a bearer
 * token works the same on one domain or two.
 *
 * Verification is LOCAL — no round trip to Supabase per request. Two key types
 * exist in Supabase projects and the token's own `alg` picks between them:
 *
 *   ES256 / RS256  the project's asymmetric signing keys, fetched once from its
 *                  JWKS endpoint and cached by jose (re-fetched on an unknown
 *                  `kid`, so key rotation needs no restart).
 *   HS256          the legacy shared JWT secret. Only accepted when
 *                  SUPABASE_JWT_SECRET is set; never guessed.
 *
 * Reading the alg from the header is safe because each branch pins its own
 * algorithm list — a token cannot ask to be checked against the wrong key.
 */

import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose'

const ASYMMETRIC_ALGS = ['ES256', 'RS256', 'EdDSA']

/** Server-side Supabase settings, read from the environment once. */
export function readAuthConfig(env = process.env) {
  const supabaseUrl = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  return {
    supabaseUrl: supabaseUrl || null,
    // New projects call it the secret key (sb_secret_…); older ones the
    // service_role key. Either works with supabase-js.
    serviceKey: (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim() || null,
    jwtSecret: (env.SUPABASE_JWT_SECRET ?? '').trim() || null,
  }
}

/**
 * Build a verifier: `(token) => Promise<user>` that throws on anything invalid.
 *
 * `jwks` is injectable so tests can sign with a local key; production leaves it
 * unset and gets the project's remote key set.
 */
export function createTokenVerifier({ supabaseUrl, jwtSecret = null, jwks = null }) {
  if (!supabaseUrl) throw new Error('createTokenVerifier: supabaseUrl is required')

  const issuer = `${supabaseUrl}/auth/v1`
  const keySet = jwks ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))
  const secret = jwtSecret ? new TextEncoder().encode(jwtSecret) : null
  const common = { issuer, audience: 'authenticated' }

  return async function verifyAccessToken(token) {
    if (typeof token !== 'string' || token.length === 0) throw new AuthError('Missing token')

    let alg
    try {
      alg = decodeProtectedHeader(token).alg
    } catch {
      throw new AuthError('Malformed token')
    }

    let payload
    try {
      if (alg === 'HS256') {
        if (!secret) throw new AuthError('HS256 tokens are not accepted (SUPABASE_JWT_SECRET unset)')
        ;({ payload } = await jwtVerify(token, secret, { ...common, algorithms: ['HS256'] }))
      } else {
        ;({ payload } = await jwtVerify(token, keySet, { ...common, algorithms: ASYMMETRIC_ALGS }))
      }
    } catch (err) {
      if (err instanceof AuthError) throw err
      throw new AuthError(err?.code === 'ERR_JWT_EXPIRED' ? 'Token expired' : 'Invalid token')
    }

    // Supabase can mint tokens for anonymous sign-ins; those are not accounts.
    if (payload.role !== 'authenticated' || payload.is_anonymous === true || !payload.sub) {
      throw new AuthError('Not a signed-in user')
    }

    return { id: payload.sub, email: payload.email ?? null, claims: payload }
  }
}

export class AuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthError'
  }
}

function bearerToken(req) {
  const header = req.get?.('authorization') ?? req.headers?.authorization
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : ''
}

/**
 * Attach `req.user` when a valid token is present; carry on anonymously
 * otherwise. For routes that work for everyone and do more for accounts.
 *
 * ⚠ An INVALID token is treated as anonymous, not rejected: everything that
 * works signed-out today must keep working, and a stale token in a tab left
 * open overnight is not a reason to fail an export.
 */
export function optionalAuth(verify) {
  return async (req, _res, next) => {
    req.user = null
    const token = bearerToken(req)
    if (verify && token) {
      try {
        req.user = await verify(token)
      } catch {
        req.user = null
      }
    }
    next()
  }
}

/** Reject with 401 unless a valid token is present. 503 when accounts are off. */
export function requireAuth(verify) {
  return async (req, res, next) => {
    if (!verify) {
      return res.status(503).json({ error: 'Accounts are not configured on this server' })
    }
    const token = bearerToken(req)
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer')
      return res.status(401).json({ error: 'Sign in required' })
    }
    try {
      req.user = await verify(token)
    } catch (err) {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"')
      return res.status(401).json({ error: err instanceof AuthError ? err.message : 'Invalid token' })
    }
    next()
  }
}
