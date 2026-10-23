/**
 * Billing routes (Stripe). See lib/billing.js for how subscription state is
 * kept in step.
 *
 *   GET  /api/billing/prices             public: { enabled, prices: [{ plan, interval, amount, currency }] }
 *   POST /api/billing/checkout           { plan?, interval, returnUrl } → { url }
 *   POST /api/billing/checkout/complete  { sessionId } → { plan }   (after Checkout returns)
 *   POST /api/billing/portal             { returnUrl } → { url }
 *   POST /api/billing/webhook            Stripe → us; raw body, signature-verified
 *
 * RETURN URLS ARE CHECKED AGAINST THE CORS ALLOWLIST. Checkout and the portal
 * redirect the browser to whatever URL we hand them, so an unchecked one is an
 * open redirect wearing our Stripe account's branding.
 *
 * ⚠ THE WEBHOOK ROUTER MUST BE MOUNTED BEFORE `express.json()`: signature
 * verification needs the exact bytes Stripe sent, and a parsed-then-
 * re-serialised body never matches.
 */

import express, { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import { BillingError } from '../lib/billing.js'

function sendError(res, err, label) {
  if (err instanceof BillingError) {
    return res.status(err.status).json({ error: err.message, code: err.code })
  }
  console.error(`[billing] ${label} failed:`, err?.message ?? err)
  res.status(502).json({ error: 'Billing is unavailable right now — try again shortly' })
}

/**
 * @param {object}        deps
 * @param {Function|null} deps.verify            token verifier (null: accounts off)
 * @param {object|null}   deps.billing           createBilling() result (null: billing off)
 * @param {Function}      deps.isAllowedOrigin   (origin) => boolean — the CORS allowlist
 */
export function createBillingRoutes({ verify, billing, isAllowedOrigin }) {
  const router = Router()

  function offline(res) {
    return res.status(503).json({ error: 'Billing is not configured on this server', code: 'billing_off' })
  }

  function checkedReturnUrl(raw) {
    let url
    try {
      url = new URL(String(raw ?? ''))
    } catch {
      return null
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return isAllowedOrigin(url.origin) ? `${url.origin}${url.pathname}` : null
  }

  router.get('/billing/prices', async (_req, res) => {
    if (!billing) return res.json({ enabled: false, prices: [] })
    try {
      res.set('Cache-Control', 'public, max-age=300')
      res.json({ enabled: true, prices: await billing.listPrices() })
    } catch (err) {
      sendError(res, err, 'prices')
    }
  })

  router.post('/billing/checkout', requireAuth(verify), async (req, res) => {
    if (!billing) return offline(res)
    const returnUrl = checkedReturnUrl(req.body?.returnUrl)
    if (!returnUrl) return res.status(400).json({ error: 'returnUrl is missing or not an allowed origin' })
    const interval = req.body?.interval
    if (interval !== 'monthly' && interval !== 'yearly') {
      return res.status(400).json({ error: 'interval must be monthly or yearly' })
    }
    try {
      const url = await billing.createCheckout(req.user, { plan: req.body?.plan ?? 'pro', interval, returnUrl })
      res.json({ url })
    } catch (err) {
      sendError(res, err, 'checkout')
    }
  })

  router.post('/billing/checkout/complete', requireAuth(verify), async (req, res) => {
    if (!billing) return offline(res)
    const sessionId = req.body?.sessionId
    if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
      return res.status(400).json({ error: 'sessionId is required' })
    }
    try {
      const row = await billing.completeCheckout(req.user, sessionId)
      res.json({ plan: row?.plan ?? null, status: row?.status ?? null })
    } catch (err) {
      sendError(res, err, 'checkout/complete')
    }
  })

  router.post('/billing/portal', requireAuth(verify), async (req, res) => {
    if (!billing) return offline(res)
    const returnUrl = checkedReturnUrl(req.body?.returnUrl)
    if (!returnUrl) return res.status(400).json({ error: 'returnUrl is missing or not an allowed origin' })
    try {
      res.json({ url: await billing.createPortal(req.user, { returnUrl }) })
    } catch (err) {
      sendError(res, err, 'portal')
    }
  })

  return router
}

/**
 * The Stripe webhook, on its own router with a raw body parser.
 *
 * Answers 400 to a bad signature (not Stripe, or the wrong secret), 500 when
 * handling fails (Stripe retries with backoff for three days), 200 otherwise —
 * including events we do not act on, so they are not retried forever.
 *
 * @param {object}      deps
 * @param {object|null} deps.stripe
 * @param {object|null} deps.billing
 * @param {string|null} deps.webhookSecret
 */
export function createBillingWebhook({ stripe, billing, webhookSecret }) {
  const router = Router()
  router.post('/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    if (!stripe || !billing || !webhookSecret) {
      return res.status(503).json({ error: 'Billing webhook is not configured' })
    }
    let event
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature') ?? '', webhookSecret)
    } catch (err) {
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` })
    }
    try {
      await billing.handleEvent(event)
      res.json({ received: true })
    } catch (err) {
      console.error(`[billing] webhook ${event.type} (${event.id}) failed:`, err?.message ?? err)
      res.status(500).json({ error: 'Webhook handling failed' })
    }
  })
  return router
}
