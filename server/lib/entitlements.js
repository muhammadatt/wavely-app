/**
 * Server-side enforcement of the shared feature table (src/auth/plans.js).
 *
 * Only `server: true` features are enforced, and only here: these are the ones
 * that spend server time, which is the resource gating exists to protect.
 *
 * A request that is not entitled is still served when the feature allows a
 * PREVIEW and the uploaded audio is short (≤ FREE_PREVIEW_SECONDS) — so anyone
 * can hear the result on a clip before paying, while a whole chapter's worth of
 * analysis stays Pro. The duration is DECODED from the upload, never taken
 * from the client.
 *
 * With accounts not configured on this server the gate is a pass-through:
 * exactly the pre-accounts behaviour, matching a frontend built without them.
 */

import { unlink } from 'fs/promises'
import { hasFeature, allowsPreview, requiredPlan, FEATURES, FREE_PREVIEW_SECONDS } from '../../src/auth/plans.js'
import { probeFile } from './ffmpeg.js'
import { resolvePlan, FREE_PLAN } from './plans.js'

/** Slack on the preview limit: encoders pad, and 30.02 s is not a whole file. */
const PREVIEW_TOLERANCE_S = 0.5

/** Decoded duration in seconds, or null if it cannot be read. */
export async function probeDurationS(filePath) {
  try {
    const info = await probeFile(filePath)
    const candidates = [
      Number(info?.format?.duration),
      ...(info?.streams ?? []).filter(s => s.codec_type === 'audio').map(s => Number(s.duration)),
    ].filter(Number.isFinite)
    return candidates.length ? Math.max(...candidates) : null
  } catch {
    return null
  }
}

/**
 * userId -> plan, cached briefly. A gated route is hit in bursts (analyse,
 * tweak, analyse again), and one subscriptions read per burst is plenty.
 * Billing drops a user's entry (`planFor.invalidate`) whenever it syncs their
 * subscription, so an upgrade or cancellation lands at once; `ttlMs` only
 * bounds a change made behind the server's back (a hand-edited row).
 */
export function createPlanResolver(admin, { ttlMs = 60_000, now = Date.now } = {}) {
  const cache = new Map()
  async function planFor(userId) {
    const hit = cache.get(userId)
    if (hit && now() - hit.at < ttlMs) return hit.plan
    const { data, error } = await admin
      .from('subscriptions')
      .select('plan, status')
      .eq('user_id', userId)
    if (error) throw new Error(`plan lookup failed: ${error.message}`)
    const { plan } = resolvePlan(data ?? [])
    cache.set(userId, { plan, at: now() })
    if (cache.size > 10_000) cache.delete(cache.keys().next().value)
    return plan
  }
  /** Forget a user's cached plan — billing calls this when a subscription changes. */
  planFor.invalidate = (userId) => cache.delete(userId)
  return planFor
}

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get?.('authorization') ?? req.headers?.authorization ?? '')
  return match ? match[1].trim() : null
}

/**
 * Build the gate factory. `gate(featureOf)` returns middleware that must run
 * AFTER multer (it reads `req.file`). `featureOf(req)` names the feature, or
 * null to let the route deal with the request (an unknown kind, say).
 *
 * On refusal the upload is deleted here, since the route's own cleanup never
 * runs, and the response is a body the client can act on:
 *   402 { error, code: 'upgrade_required', feature, requires, previewSeconds }
 *   401 { error, code: 'sign_in_required', feature, requires }  — a feature
 *       any account unlocks, refused to a signed-out caller
 */
export function createEntitlementGate({ verify, planFor, probeDuration = probeDurationS }) {
  const enabled = !!(verify && planFor)

  return function gate(featureOf) {
    return async (req, res, next) => {
      if (!enabled) return next()
      const featureId = featureOf(req)
      if (!featureId) return next()

      let plan = null
      const token = bearerToken(req)
      if (token) {
        try {
          const user = await verify(token)
          plan = await planFor(user.id).catch(err => {
            // A database hiccup must not lock a paying user out of a preview,
            // nor hand them the full feature: treat as free, which still
            // leaves the preview path open.
            console.error('[entitlements]', err.message)
            return FREE_PLAN
          })
        } catch {
          plan = null // invalid or expired token: as signed out
        }
      }

      if (hasFeature(plan, featureId)) {
        req.entitlement = { plan, mode: 'full' }
        return next()
      }

      if (allowsPreview(featureId) && req.file?.path) {
        const duration = await probeDuration(req.file.path)
        if (duration != null && duration <= FREE_PREVIEW_SECONDS + PREVIEW_TOLERANCE_S) {
          req.entitlement = { plan, mode: 'preview' }
          return next()
        }
      }

      if (req.file?.path) await unlink(req.file.path).catch(() => {})
      const requires = requiredPlan(featureId)
      // Any account unlocks it, so the caller is signed out: the answer is a
      // sign-in, not a plan. 401 rather than 402, so the client opens the
      // sign-in dialog instead of the upgrade prompt.
      if (requires === 'free') {
        return res.status(401).json({
          error: `Sign in to use ${FEATURES[featureId].label.toLowerCase()} — any free account will do.`,
          code: 'sign_in_required',
          feature: featureId,
          requires,
        })
      }
      res.status(402).json({
        error: allowsPreview(featureId)
          ? `${FEATURES[featureId].label} on more than ${FREE_PREVIEW_SECONDS} seconds of audio needs a ${requires === 'pro' ? 'Pro' : requires} plan.`
          : `${FEATURES[featureId].label} needs a ${requires === 'pro' ? 'Pro' : requires} plan.`,
        code: 'upgrade_required',
        feature: featureId,
        requires,
        previewSeconds: allowsPreview(featureId) ? FREE_PREVIEW_SECONDS : null,
      })
    }
  }
}

/** The no-accounts gate: lets everything through. */
export const openGate = () => (_req, _res, next) => next()
