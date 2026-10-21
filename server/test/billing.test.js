import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Stripe from 'stripe'

import {
  createBilling, subscriptionRow, readBillingConfig, withParams, UNKNOWN_PLAN, BillingError,
} from '../lib/billing.js'
import { createBillingRoutes, createBillingWebhook } from '../routes/billing.js'
import { resolvePlan } from '../lib/plans.js'

const USER = { id: 'user-1', email: 'n@example.com' }
const PRICES = [
  { id: 'price_month', plan: 'pro', interval: 'monthly' },
  { id: 'price_year', plan: 'pro', interval: 'yearly' },
]

/** An in-memory stand-in for the supabase-js query builder, for the chains billing uses. */
function fakeDb(tables = {}) {
  function query(rows) {
    const filters = []
    let op = 'select'
    let patch = null
    let returnRows = false
    const run = async () => {
      const hit = rows.filter(r => filters.every(f => f(r)))
      if (op === 'update') {
        hit.forEach(r => Object.assign(r, patch))
        return { data: returnRows ? hit.map(r => ({ ...r })) : null, error: null }
      }
      return { data: hit.map(r => ({ ...r })), error: null }
    }
    const b = {
      select() { if (op === 'update') returnRows = true; return b },
      eq(c, v) { filters.push(r => r[c] === v); return b },
      is(c, v) { filters.push(r => (r[c] ?? null) === v); return b },
      update(p) { op = 'update'; patch = p; return b },
      async upsert(row, { onConflict }) {
        const i = rows.findIndex(r => r[onConflict] === row[onConflict])
        if (i >= 0) rows[i] = { ...rows[i], ...row }
        else rows.push({ ...row })
        return { error: null }
      },
      maybeSingle: () => run().then(({ data }) => ({ data: data[0] ?? null, error: null })),
      then: (res, rej) => run().then(res, rej),
    }
    return b
  }
  return { tables, from: (name) => query(tables[name] ??= []) }
}

function stripeSub(overrides = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    metadata: { user_id: USER.id },
    cancel_at_period_end: false,
    cancel_at: null,
    items: { data: [{ price: { id: 'price_month' }, current_period_end: 1_800_000_000 }] },
    ...overrides,
  }
}

function fakeStripe({ subs = {}, sessions = {} } = {}) {
  const calls = []
  let customers = 0
  return {
    calls,
    subs,
    customers: {
      create: async (params, opts) => { calls.push(['customers.create', params, opts]); return { id: `cus_new${++customers}` } },
      del: async (id) => { calls.push(['customers.del', id]) },
    },
    subscriptions: { retrieve: async (id) => { if (!subs[id]) throw new Error('no such sub'); return subs[id] } },
    checkout: {
      sessions: {
        create: async (params) => { calls.push(['checkout.create', params]); return { url: 'https://checkout.stripe.com/c/x' } },
        retrieve: async (id) => sessions[id],
      },
    },
    billingPortal: {
      sessions: { create: async (params) => { calls.push(['portal.create', params]); return { url: 'https://billing.stripe.com/p/x' } } },
    },
    prices: { retrieve: async (id) => ({ id, unit_amount: id === 'price_year' ? 9000 : 900, currency: 'usd' }) },
  }
}

function setup({ profile = { id: USER.id, stripe_customer_id: null }, subscriptions = [], stripe = fakeStripe() } = {}) {
  const db = fakeDb({ profiles: [profile], subscriptions })
  const changed = []
  const billing = createBilling({ stripe, admin: db, prices: PRICES, onPlanChanged: (id) => changed.push(id) })
  return { db, stripe, billing, changed }
}

// ── Config and mapping ────────────────────────────────────────────────────────

test('readBillingConfig names prices per plan and interval', () => {
  const cfg = readBillingConfig({
    STRIPE_SECRET_KEY: ' sk_test_1 ', STRIPE_PRICE_PRO_MONTHLY: 'price_m', STRIPE_PRICE_PRO_YEARLY: '',
  })
  assert.equal(cfg.secretKey, 'sk_test_1')
  assert.equal(cfg.webhookSecret, null)
  assert.deepEqual(cfg.prices, [{ id: 'price_m', plan: 'pro', interval: 'monthly' }])
})

test('subscriptionRow reads the period end from the item and maps only known prices', () => {
  const map = new Map([['price_month', 'pro']])
  const row = subscriptionRow(stripeSub(), USER.id, map)
  assert.deepEqual(row, {
    id: 'sub_1', user_id: USER.id, plan: 'pro', status: 'active', stripe_price_id: 'price_month',
    current_period_end: new Date(1_800_000_000 * 1000).toISOString(), cancel_at_period_end: false,
  })
  const stranger = subscriptionRow(stripeSub({ items: { data: [{ price: { id: 'price_other' } }] } }), USER.id, map)
  assert.equal(stranger.plan, UNKNOWN_PLAN)
  assert.equal(resolvePlan([stranger]).plan, 'free', 'an unknown price grants nothing')
  assert.equal(subscriptionRow(stripeSub({ cancel_at: 1_900_000_000 }), USER.id, map).cancel_at_period_end, true)
})

test('withParams keeps the session placeholder literal for Stripe to fill', () => {
  assert.equal(
    withParams('https://app.example/editor', { checkout: 'success', session_id: '{CHECKOUT_SESSION_ID}' }),
    'https://app.example/editor?checkout=success&session_id={CHECKOUT_SESSION_ID}',
  )
})

// ── Sync ──────────────────────────────────────────────────────────────────────

test('syncSubscription re-fetches from Stripe, upserts the row and drops the cached plan', async () => {
  const { db, stripe, billing, changed } = setup({ stripe: fakeStripe({ subs: { sub_1: stripeSub() } }) })
  await billing.syncSubscription('sub_1')
  assert.equal(db.tables.subscriptions[0].plan, 'pro')
  assert.deepEqual(changed, [USER.id])

  // A late "updated" webhook after cancellation still writes Stripe's PRESENT state.
  stripe.subs.sub_1 = stripeSub({ status: 'canceled' })
  await billing.handleEvent({ type: 'customer.subscription.updated', data: { object: stripeSub({ status: 'active' }) } })
  assert.equal(db.tables.subscriptions.length, 1)
  assert.equal(db.tables.subscriptions[0].status, 'canceled')
})

test('a subscription without metadata is matched by its customer; an orphan is ignored', async () => {
  const subs = { sub_1: stripeSub({ metadata: {}, customer: 'cus_9' }), sub_2: stripeSub({ id: 'sub_2', metadata: {}, customer: 'cus_x' }) }
  const { db, billing } = setup({ profile: { id: USER.id, stripe_customer_id: 'cus_9' }, stripe: fakeStripe({ subs }) })
  assert.equal((await billing.syncSubscription('sub_1')).user_id, USER.id)
  const origWarn = console.warn
  console.warn = () => {}
  try {
    assert.equal(await billing.syncSubscription('sub_2'), null)
  } finally {
    console.warn = origWarn
  }
  assert.equal(db.tables.subscriptions.length, 1)
})

test('handleEvent syncs subscription events and completed checkouts, ignores the rest', async () => {
  const { db, billing } = setup({ stripe: fakeStripe({ subs: { sub_1: stripeSub() } }) })
  assert.equal(await billing.handleEvent({ type: 'invoice.paid', data: { object: {} } }), null)
  assert.equal(db.tables.subscriptions.length, 0)
  await billing.handleEvent({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1' } } })
  assert.equal(db.tables.subscriptions.length, 1)
})

// ── Customer, checkout, portal ────────────────────────────────────────────────

test('ensureCustomer creates once, idempotently, and reuses the stored id', async () => {
  const { db, stripe, billing } = setup()
  const id = await billing.ensureCustomer(USER)
  assert.equal(db.tables.profiles[0].stripe_customer_id, id)
  assert.equal(await billing.ensureCustomer(USER), id)
  const creates = stripe.calls.filter(c => c[0] === 'customers.create')
  assert.equal(creates.length, 1)
  assert.deepEqual(creates[0][1].metadata, { user_id: USER.id })
  assert.equal(creates[0][2].idempotencyKey, `customer-for-${USER.id}`)
})

test('ensureCustomer losing a race keeps the winner and deletes its own customer', async () => {
  const { db, stripe, billing } = setup()
  // Another request stores its customer between our read and our conditional write.
  const realCreate = stripe.customers.create
  stripe.customers.create = async (...args) => {
    const c = await realCreate(...args)
    db.tables.profiles[0].stripe_customer_id = 'cus_winner'
    return c
  }
  assert.equal(await billing.ensureCustomer(USER), 'cus_winner')
  assert.ok(stripe.calls.some(c => c[0] === 'customers.del'))
})

test('createCheckout: the right price, owner metadata and return URLs; refuses a second subscription', async () => {
  const { stripe, billing } = setup()
  const url = await billing.createCheckout(USER, { interval: 'yearly', returnUrl: 'https://app.example/' })
  assert.match(url, /^https:\/\/checkout\.stripe\.com/)
  const [, params] = stripe.calls.find(c => c[0] === 'checkout.create')
  assert.equal(params.mode, 'subscription')
  assert.deepEqual(params.line_items, [{ price: 'price_year', quantity: 1 }])
  assert.equal(params.client_reference_id, USER.id)
  assert.deepEqual(params.subscription_data.metadata, { user_id: USER.id })
  assert.equal(params.success_url, 'https://app.example/?checkout=success&session_id={CHECKOUT_SESSION_ID}')
  assert.equal(params.cancel_url, 'https://app.example/?checkout=cancel')

  await assert.rejects(billing.createCheckout(USER, { interval: 'weekly', returnUrl: 'https://app.example/' }),
    e => e instanceof BillingError && e.code === 'unknown_price')

  const subscribed = setup({ subscriptions: [{ user_id: USER.id, status: 'active', plan: 'pro' }] })
  await assert.rejects(subscribed.billing.createCheckout(USER, { interval: 'monthly', returnUrl: 'https://app.example/' }),
    e => e.status === 409 && e.code === 'already_subscribed')

  // A lapsed subscription does not block a new one.
  const lapsed = setup({ subscriptions: [{ user_id: USER.id, status: 'canceled', plan: 'pro' }] })
  assert.ok(await lapsed.billing.createCheckout(USER, { interval: 'monthly', returnUrl: 'https://app.example/' }))
})

test('completeCheckout syncs at once, but only for the session’s own user', async () => {
  const stripe = fakeStripe({
    subs: { sub_1: stripeSub() },
    sessions: { cs_1: { client_reference_id: USER.id, subscription: 'sub_1' }, cs_2: { client_reference_id: 'someone-else', subscription: 'sub_1' } },
  })
  const { db, billing } = setup({ stripe })
  await assert.rejects(billing.completeCheckout(USER, 'cs_2'), e => e.status === 403)
  assert.equal(db.tables.subscriptions.length, 0)
  assert.equal((await billing.completeCheckout(USER, 'cs_1')).plan, 'pro')
})

test('createPortal needs a customer', async () => {
  await assert.rejects(setup().billing.createPortal(USER, { returnUrl: 'https://app.example/' }), e => e.code === 'no_customer')
  const { billing, stripe } = setup({ profile: { id: USER.id, stripe_customer_id: 'cus_1' } })
  assert.match(await billing.createPortal(USER, { returnUrl: 'https://app.example/' }), /billing\.stripe\.com/)
  assert.deepEqual(stripe.calls.at(-1)[1], { customer: 'cus_1', return_url: 'https://app.example/?billing=portal' })
})

// ── Routes ────────────────────────────────────────────────────────────────────

async function withServer(build, fn) {
  const app = express()
  build(app)
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)) })
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

const verify = async (token) => { if (token !== 'good') throw new Error('bad'); return USER }
const post = (base, path, body, token = 'good') => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
})

test('routes: return URLs must be an allowed origin; billing off answers 503; prices are public', async () => {
  const { billing } = setup()
  const isAllowedOrigin = (o) => o === 'https://app.example'
  await withServer(app => {
    app.use(express.json())
    app.use('/api', createBillingRoutes({ verify, billing, isAllowedOrigin }))
  }, async (base) => {
    assert.equal((await post(base, '/api/billing/checkout', { interval: 'monthly', returnUrl: 'https://evil.example/' })).status, 400)
    assert.equal((await post(base, '/api/billing/checkout', { interval: 'monthly', returnUrl: 'javascript:alert(1)' })).status, 400)
    assert.equal((await post(base, '/api/billing/checkout', { interval: 'daily', returnUrl: 'https://app.example/' })).status, 400)
    assert.equal((await post(base, '/api/billing/checkout', { interval: 'monthly', returnUrl: 'https://app.example/' }, null)).status, 401)
    const ok = await post(base, '/api/billing/checkout', { interval: 'monthly', returnUrl: 'https://app.example/x?y=1#z' })
    assert.equal(ok.status, 200)
    assert.match((await ok.json()).url, /checkout\.stripe\.com/)
    assert.equal((await post(base, '/api/billing/checkout/complete', { sessionId: 'nope' })).status, 400)

    const prices = await (await fetch(`${base}/api/billing/prices`)).json()
    assert.equal(prices.enabled, true)
    assert.deepEqual(prices.prices.map(p => [p.interval, p.amount]), [['monthly', 900], ['yearly', 9000]])
  })

  await withServer(app => {
    app.use(express.json())
    app.use('/api', createBillingRoutes({ verify, billing: null, isAllowedOrigin }))
  }, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/billing/prices`)).json(), { enabled: false, prices: [] })
    assert.equal((await post(base, '/api/billing/portal', { returnUrl: 'https://app.example/' })).status, 503)
  })
})

test('webhook: verifies Stripe’s signature over the raw body, then syncs', async () => {
  const secret = 'whsec_test_secret'
  const realStripe = new Stripe('sk_test_dummy')
  const stripe = fakeStripe({ subs: { sub_1: stripeSub() } })
  stripe.webhooks = realStripe.webhooks // the real verifier
  const { db, billing } = setup({ stripe })

  await withServer(app => {
    app.use('/api', createBillingWebhook({ stripe, billing, webhookSecret: secret }))
    app.use(express.json()) // after, as in index.js
  }, async (base) => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.created', data: { object: { id: 'sub_1' } } })
    const send = (body, header) => fetch(`${base}/api/billing/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body,
    })

    assert.equal((await send(payload, 't=1,v1=forged')).status, 400)
    assert.equal(db.tables.subscriptions.length, 0)

    const header = realStripe.webhooks.generateTestHeaderString({ payload, secret })
    const res = await send(payload, header)
    assert.equal(res.status, 200)
    assert.equal(db.tables.subscriptions[0].plan, 'pro')

    // A body that differs by one byte from what was signed is refused.
    assert.equal((await send(payload + ' ', header)).status, 400)

    // A handler failure answers 500 so Stripe retries.
    const bad = JSON.stringify({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_missing' } } })
    const origError = console.error
    console.error = () => {}
    try {
      assert.equal((await send(bad, realStripe.webhooks.generateTestHeaderString({ payload: bad, secret }))).status, 500)
    } finally {
      console.error = origError
    }
  })
})
