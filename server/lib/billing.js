/**
 * Stripe billing: checkout, the customer portal, and keeping `subscriptions`
 * in step with Stripe.
 *
 * ONE WAY IN FOR SUBSCRIPTION STATE. Every path that learns about a
 * subscription — a webhook, the browser coming back from Checkout — calls
 * `syncSubscription(id)`, which RE-FETCHES it from Stripe and upserts the row.
 * Webhooks arrive out of order and more than once; a handler that applied each
 * event's payload would let a late `customer.subscription.updated` overwrite a
 * newer `deleted`. Reading the current object makes every delivery idempotent
 * and order-free: the last write is always Stripe's present state.
 *
 * WHO OWNS A SUBSCRIPTION is fixed at Checkout: the session carries the user
 * id as `client_reference_id` and in `subscription_data.metadata.user_id`, and
 * the Stripe customer is created once per user (profiles.stripe_customer_id).
 * The metadata is read first; the customer id is the fallback for a
 * subscription created some other way (in the Stripe dashboard, say).
 *
 * The plan a price grants comes from configuration (`prices`), never from the
 * Stripe object: a price this server does not know is stored as 'unknown',
 * which `resolvePlan` ignores — a misconfigured product grants nothing.
 */

import { ENTITLED_STATUSES, PAID_PLANS } from './plans.js'

export const UNKNOWN_PLAN = 'unknown'

/** Webhook events that mean "a subscription may have changed". */
export const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
])

/**
 * Billing settings from the environment. Prices are named per plan and
 * interval, so adding a tier is new variables and a PLAN_ORDER entry:
 *
 *   STRIPE_PRICE_PRO_MONTHLY=price_…
 *   STRIPE_PRICE_PRO_YEARLY=price_…
 */
export function readBillingConfig(env = process.env) {
  const prices = []
  for (const plan of PAID_PLANS) {
    for (const interval of ['monthly', 'yearly']) {
      const id = (env[`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`] ?? '').trim()
      if (id) prices.push({ id, plan, interval })
    }
  }
  return {
    secretKey: (env.STRIPE_SECRET_KEY ?? '').trim() || null,
    webhookSecret: (env.STRIPE_WEBHOOK_SECRET ?? '').trim() || null,
    prices,
  }
}

/** Epoch seconds → ISO string, or null. */
function isoOrNull(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null
}

/**
 * The `subscriptions` row for a Stripe subscription object.
 *
 * ⚠ `current_period_end` lives on the subscription ITEMS since the 2025 API
 * versions (a subscription can mix billing periods); the top-level field is
 * read only as a fallback for older payloads. A cancellation scheduled from the
 * portal may arrive as `cancel_at` rather than `cancel_at_period_end`; both
 * mean "ends at a known date".
 */
export function subscriptionRow(sub, userId, priceToPlan) {
  const item = sub.items?.data?.[0] ?? null
  const priceId = item?.price?.id ?? null
  return {
    id: sub.id,
    user_id: userId,
    plan: priceToPlan.get(priceId) ?? UNKNOWN_PLAN,
    status: sub.status,
    stripe_price_id: priceId,
    current_period_end: isoOrNull(item?.current_period_end ?? sub.current_period_end),
    cancel_at_period_end: !!sub.cancel_at_period_end || sub.cancel_at != null,
  }
}

export class BillingError extends Error {
  constructor(message, status = 400, code = 'billing_error') {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * @param {object}   deps
 * @param {object}   deps.stripe          a Stripe client
 * @param {object}   deps.admin           Supabase service-key client
 * @param {Array}    deps.prices          [{ id, plan, interval }]
 * @param {Function} [deps.onPlanChanged] (userId) => void — drop cached plans
 */
export function createBilling({ stripe, admin, prices, onPlanChanged = () => {} }) {
  const priceToPlan = new Map(prices.map(p => [p.id, p.plan]))

  async function customerIdFor(userId) {
    const { data, error } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .maybeSingle()
    if (error) throw error
    return data?.stripe_customer_id ?? null
  }

  /**
   * The user's Stripe customer, created on first need.
   *
   * ⚠ Two concurrent first checkouts must not make two customers. The create
   * carries an idempotency key per user (Stripe returns the same customer for
   * 24 h), and the profile write is conditional (`stripe_customer_id is null`)
   * so that past that window only one id sticks; a loser deletes its stray.
   */
  async function ensureCustomer(user) {
    const existing = await customerIdFor(user.id)
    if (existing) return existing

    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { user_id: user.id },
    }, { idempotencyKey: `customer-for-${user.id}` })

    const { data, error } = await admin
      .from('profiles')
      .update({ stripe_customer_id: customer.id })
      .eq('id', user.id)
      .is('stripe_customer_id', null)
      .select('stripe_customer_id')
    if (error) throw error
    if (data?.length) return customer.id

    const winner = await customerIdFor(user.id)
    if (winner && winner !== customer.id) {
      await stripe.customers.del(customer.id).catch(() => {})
      return winner
    }
    if (!winner) throw new BillingError('No profile for this account', 409, 'no_profile')
    return winner
  }

  async function userIdForSubscription(sub) {
    const fromMetadata = sub.metadata?.user_id
    if (fromMetadata) return fromMetadata
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
    if (!customerId) return null
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle()
    if (error) throw error
    return data?.id ?? null
  }

  /**
   * Re-fetch a subscription from Stripe and upsert its row. Returns the row,
   * or null when the subscription belongs to no known user (logged, ignored —
   * retrying it would never succeed).
   */
  async function syncSubscription(subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId)
    const userId = await userIdForSubscription(sub)
    if (!userId) {
      console.warn(`[billing] subscription ${sub.id} has no matching user; ignored`)
      return null
    }
    const row = subscriptionRow(sub, userId, priceToPlan)
    const { error } = await admin.from('subscriptions').upsert(row, { onConflict: 'id' })
    if (error) throw error
    onPlanChanged(userId)
    return row
  }

  /** A verified webhook event → sync whatever subscription it is about. */
  async function handleEvent(event) {
    const obj = event.data?.object ?? {}
    if (SUBSCRIPTION_EVENTS.has(event.type)) {
      return syncSubscription(obj.id)
    }
    if (event.type === 'checkout.session.completed' && obj.mode === 'subscription' && obj.subscription) {
      return syncSubscription(typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id)
    }
    return null // not ours to act on; acknowledged so Stripe stops retrying
  }

  /** Does this user already have a subscription that grants a plan? */
  async function hasEntitledSubscription(userId) {
    const { data, error } = await admin
      .from('subscriptions')
      .select('status, plan')
      .eq('user_id', userId)
    if (error) throw error
    return (data ?? []).some(s => ENTITLED_STATUSES.has(s.status) && s.plan !== UNKNOWN_PLAN)
  }

  /**
   * A Checkout session for `plan` billed `interval`; resolves its URL.
   * `returnUrl` must already be validated by the caller (an allowed origin).
   */
  async function createCheckout(user, { plan = 'pro', interval, returnUrl }) {
    const price = prices.find(p => p.plan === plan && p.interval === interval)
    if (!price) throw new BillingError(`No ${interval} price is configured for ${plan}`, 400, 'unknown_price')
    // A second subscription would bill twice; send them to the portal instead.
    if (await hasEntitledSubscription(user.id)) {
      throw new BillingError('You already have an active subscription — manage it from the billing portal', 409, 'already_subscribed')
    }
    const customer = await ensureCustomer(user)
    const session = await stripe.checkout.sessions.create({
      // The Checkout Studio parameters (SDK >= 21 names the hosted page `hosted_page`)
      ui_mode: 'hosted_page',
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: false },
      automatic_tax: { enabled: false },
      allow_promotion_codes: false,
      payment_method_collection: 'always',
      submit_type: 'auto',
      integration_identifier: 'hosted_web_0001',
      origin_context: 'web',
      mode: 'subscription',
      customer,
      client_reference_id: user.id,
      line_items: [{ price: price.id, quantity: 1 }],
      subscription_data: { metadata: { user_id: user.id } },
      success_url: withParams(returnUrl, { checkout: 'success', session_id: '{CHECKOUT_SESSION_ID}' }),
      cancel_url: withParams(returnUrl, { checkout: 'cancel' }),
    })
    return session.url
  }

  /**
   * After the browser returns from Checkout: sync the session's subscription
   * NOW rather than waiting on the webhook, so the plan is right on the first
   * /api/me. The session must belong to the caller.
   */
  async function completeCheckout(user, sessionId) {
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    if (session.client_reference_id !== user.id) {
      throw new BillingError('That checkout belongs to another account', 403, 'forbidden')
    }
    if (!session.subscription) return null
    return syncSubscription(typeof session.subscription === 'string' ? session.subscription : session.subscription.id)
  }

  /** A Billing Portal session (change card, switch interval, cancel); resolves its URL. */
  async function createPortal(user, { returnUrl }) {
    const customer = await customerIdFor(user.id)
    if (!customer) throw new BillingError('No billing account yet — subscribe first', 404, 'no_customer')
    // The marker tells the returning tab to refresh the account and close itself.
    const session = await stripe.billingPortal.sessions.create({
      customer, return_url: withParams(returnUrl, { billing: 'portal' }),
    })
    return session.url
  }

  /** Public price list for the upgrade prompt, read from Stripe and cached. */
  let priceCache = null
  async function listPrices({ ttlMs = 10 * 60_000, now = Date.now } = {}) {
    if (priceCache && now() - priceCache.at < ttlMs) return priceCache.list
    const list = await Promise.all(prices.map(async ({ id, plan, interval }) => {
      const p = await stripe.prices.retrieve(id)
      return { plan, interval, amount: p.unit_amount, currency: p.currency }
    }))
    priceCache = { list, at: now() }
    return list
  }

  return {
    ensureCustomer, syncSubscription, handleEvent,
    createCheckout, completeCheckout, createPortal, listPrices,
  }
}

/** Append query params, leaving `{CHECKOUT_SESSION_ID}` unescaped for Stripe to fill. */
export function withParams(url, params) {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString().replace(encodeURIComponent('{CHECKOUT_SESSION_ID}'), '{CHECKOUT_SESSION_ID}')
}
