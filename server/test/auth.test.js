import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose'

import { createTokenVerifier, readAuthConfig, optionalAuth, requireAuth } from '../lib/auth.js'
import { resolvePlan } from '../lib/plans.js'
import { meRoute, buildMeResponse } from '../routes/me.js'

const SUPABASE_URL = 'https://example.supabase.co'
const ISSUER = `${SUPABASE_URL}/auth/v1`
const USER_ID = '7d1f0c5e-0000-4000-8000-000000000001'

async function keyFixture() {
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) }
}

function sign(key, alg, claims = {}, { kid = 'k1', expiresIn = '1h', issuer = ISSUER, audience = 'authenticated' } = {}) {
  return new SignJWT({ role: 'authenticated', email: 'narrator@example.com', ...claims })
    .setProtectedHeader(alg === 'HS256' ? { alg } : { alg, kid })
    .setSubject(USER_ID)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key)
}

test('readAuthConfig trims, strips a trailing slash and accepts either service-key name', () => {
  assert.deepEqual(readAuthConfig({}), { supabaseUrl: null, serviceKey: null, jwtSecret: null })
  const cfg = readAuthConfig({ SUPABASE_URL: ' https://x.supabase.co/ ', SUPABASE_SERVICE_ROLE_KEY: 'legacy' })
  assert.equal(cfg.supabaseUrl, 'https://x.supabase.co')
  assert.equal(cfg.serviceKey, 'legacy')
  assert.equal(readAuthConfig({ SUPABASE_SECRET_KEY: 'new', SUPABASE_SERVICE_ROLE_KEY: 'old' }).serviceKey, 'new')
})

test('an asymmetric token signed by the project key verifies to the user', async () => {
  const { privateKey, jwks } = await keyFixture()
  const verify = createTokenVerifier({ supabaseUrl: SUPABASE_URL, jwks })
  const user = await verify(await sign(privateKey, 'ES256'))
  assert.equal(user.id, USER_ID)
  assert.equal(user.email, 'narrator@example.com')
})

test('wrong key, wrong issuer, wrong audience, expired and anonymous tokens are all rejected', async () => {
  const fx = await keyFixture()
  const { privateKey: otherKey } = await keyFixture()
  const v = createTokenVerifier({ supabaseUrl: SUPABASE_URL, jwks: fx.jwks })
  await assert.rejects(v(await sign(otherKey, 'ES256')), /Invalid token/)
  await assert.rejects(v(await sign(fx.privateKey, 'ES256', {}, { issuer: 'https://evil.example/auth/v1' })), /Invalid token/)
  await assert.rejects(v(await sign(fx.privateKey, 'ES256', {}, { audience: 'service_role' })), /Invalid token/)
  await assert.rejects(v(await sign(fx.privateKey, 'ES256', {}, { expiresIn: '-1m' })), /Token expired/)
  await assert.rejects(v(await sign(fx.privateKey, 'ES256', { is_anonymous: true })), /Not a signed-in user/)
  await assert.rejects(v(await sign(fx.privateKey, 'ES256', { role: 'anon' })), /Not a signed-in user/)
  await assert.rejects(v('not.a.jwt'), /Malformed token/)
  await assert.rejects(v(''), /Missing token/)
})

test('HS256 tokens verify only when the legacy secret is configured', async () => {
  const secret = 'super-secret-jwt-token-with-at-least-32-characters'
  const key = new TextEncoder().encode(secret)
  const token = await sign(key, 'HS256')
  const { jwks } = await keyFixture()

  const withSecret = createTokenVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: secret, jwks })
  assert.equal((await withSecret(token)).id, USER_ID)

  const withoutSecret = createTokenVerifier({ supabaseUrl: SUPABASE_URL, jwks })
  await assert.rejects(withoutSecret(token), /HS256 tokens are not accepted/)

  const wrongSecret = createTokenVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: 'x'.repeat(40), jwks })
  await assert.rejects(wrongSecret(token), /Invalid token/)
})

// ── Middleware ────────────────────────────────────────────────────────────────

function fakeReq(authorization) {
  return { headers: authorization ? { authorization } : {}, get(name) { return this.headers[name.toLowerCase()] } }
}

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    set(k, v) { this.headers[k] = v; return this },
  }
}

const okVerify = async (token) => {
  if (token !== 'good') throw new Error('bad')
  return { id: USER_ID, email: null }
}

test('optionalAuth attaches the user when valid and stays anonymous otherwise', async () => {
  for (const [header, expected] of [['Bearer good', USER_ID], ['Bearer bad', null], [undefined, null], ['Basic abc', null]]) {
    const req = fakeReq(header)
    let called = false
    await optionalAuth(okVerify)(req, fakeRes(), () => { called = true })
    assert.equal(called, true)
    assert.equal(req.user?.id ?? null, expected, String(header))
  }
  // Accounts off: still anonymous, still passes through.
  const req = fakeReq('Bearer good')
  let called = false
  await optionalAuth(null)(req, fakeRes(), () => { called = true })
  assert.equal(called && req.user === null, true)
})

test('requireAuth answers 401 without a valid token and 503 when accounts are off', async () => {
  const cases = [[undefined, 401], ['Bearer bad', 401], ['Bearer good', 200]]
  for (const [header, status] of cases) {
    const req = fakeReq(header)
    const res = fakeRes()
    let called = false
    await requireAuth(okVerify)(req, res, () => { called = true })
    assert.equal(called ? 200 : res.statusCode, status, String(header))
  }
  const res = fakeRes()
  await requireAuth(null)(fakeReq('Bearer good'), res, () => assert.fail('must not pass'))
  assert.equal(res.statusCode, 503)
})

// ── Plans ─────────────────────────────────────────────────────────────────────

test('resolvePlan grants only entitled statuses and known plans', () => {
  assert.equal(resolvePlan([]).plan, 'free')
  assert.equal(resolvePlan(undefined).plan, 'free')
  for (const status of ['active', 'trialing', 'past_due']) {
    assert.equal(resolvePlan([{ plan: 'pro', status }]).plan, 'pro', status)
  }
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
    assert.equal(resolvePlan([{ plan: 'pro', status }]).plan, 'free', status)
  }
  assert.equal(resolvePlan([{ plan: 'platinum', status: 'active' }]).plan, 'free')
  const pro = { id: 'sub_2', plan: 'pro', status: 'active' }
  assert.equal(resolvePlan([{ id: 'sub_1', plan: 'pro', status: 'canceled' }, pro]).subscription, pro)
})

// ── /api/me ───────────────────────────────────────────────────────────────────

test('buildMeResponse prefers the profile and exposes only the granting subscription', () => {
  const body = buildMeResponse({ id: USER_ID, email: 'token@example.com' }, {
    profile: { email: 'profile@example.com', display_name: 'Ann', created_at: '2026-10-20T00:00:00Z' },
    subscriptions: [{ id: 'sub_1', plan: 'pro', status: 'active', current_period_end: '2026-11-20T00:00:00Z', cancel_at_period_end: false }],
  })
  assert.deepEqual(body, {
    user: { id: USER_ID, email: 'profile@example.com', displayName: 'Ann', createdAt: '2026-10-20T00:00:00Z' },
    plan: 'pro',
    subscription: { plan: 'pro', status: 'active', currentPeriodEnd: '2026-11-20T00:00:00Z', cancelAtPeriodEnd: false },
  })
})

async function withServer(router, fn) {
  const app = express()
  app.use('/api', router)
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)) })
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('GET /api/me end to end: 401, 200, 503 and 500', async () => {
  const load = async (_admin, user) => ({
    profile: { email: 'n@example.com', display_name: null, created_at: null },
    subscriptions: user.id === USER_ID ? [] : [{ plan: 'pro', status: 'active' }],
  })

  await withServer(meRoute({ verify: okVerify, admin: {}, load }), async (base) => {
    assert.equal((await fetch(`${base}/api/me`)).status, 401)
    assert.equal((await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer bad' } })).status, 401)
    const res = await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer good' } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const body = await res.json()
    assert.equal(body.user.id, USER_ID)
    assert.equal(body.plan, 'free')
  })

  await withServer(meRoute({ verify: null, admin: null }), async (base) => {
    assert.equal((await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer good' } })).status, 503)
  })

  await withServer(meRoute({ verify: okVerify, admin: null }), async (base) => {
    assert.equal((await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer good' } })).status, 503)
  })

  const failing = async () => { throw new Error('db down') }
  const origError = console.error
  console.error = () => {}
  try {
    await withServer(meRoute({ verify: okVerify, admin: {}, load: failing }), async (base) => {
      assert.equal((await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer good' } })).status, 500)
    })
  } finally {
    console.error = origError
  }
})
