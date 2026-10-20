/**
 * GET /api/me — the signed-in user's account: who they are and what plan
 * they are on.
 *
 * The client calls this after sign-in and on every page load with a session.
 * The plan comes from here, never from the token or the browser, so revoking a
 * subscription takes effect on the next call rather than when a token expires.
 *
 * Responses:
 *   200 { user: { id, email, displayName, createdAt }, plan, subscription }
 *   401 no token / invalid token
 *   503 accounts not configured on this server
 */

import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import { loadAccount } from '../lib/supabaseAdmin.js'
import { resolvePlan } from '../lib/plans.js'

/** Shape the response from a loaded account. Exported for tests. */
export function buildMeResponse(user, { profile, subscriptions }) {
  const { plan, subscription } = resolvePlan(subscriptions)
  return {
    user: {
      id: user.id,
      email: profile?.email ?? user.email ?? null,
      displayName: profile?.display_name ?? null,
      createdAt: profile?.created_at ?? null,
    },
    plan,
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end ?? null,
          cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
        }
      : null,
  }
}

/**
 * @param {object} deps
 * @param {Function|null} deps.verify   token verifier, null when auth is off
 * @param {object|null}   deps.admin    Supabase admin client, null when unset
 * @param {Function}      [deps.load]   account loader (injectable for tests)
 */
export function meRoute({ verify, admin, load = loadAccount }) {
  const router = Router()

  router.get('/me', requireAuth(verify), async (req, res) => {
    if (!admin) {
      return res.status(503).json({ error: 'Accounts are not configured on this server' })
    }
    try {
      const account = await load(admin, req.user)
      res.set('Cache-Control', 'no-store')
      res.json(buildMeResponse(req.user, account))
    } catch (err) {
      console.error('[me] failed to load account:', err?.message ?? err)
      res.status(500).json({ error: 'Could not load account' })
    }
  })

  return router
}
