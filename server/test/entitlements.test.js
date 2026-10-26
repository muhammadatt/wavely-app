import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEntitlementGate, createPlanResolver } from '../lib/entitlements.js'
import { FREE_PREVIEW_SECONDS, hasFeature, blockerFor, FEATURES, requiredPlan } from '../../src/auth/plans.js'

const PLANS = { 'tok-free': 'free', 'tok-pro': 'pro' }
const verify = async (token) => {
  if (!PLANS[token]) throw new Error('bad token')
  return { id: token }
}
const planFor = async (userId) => PLANS[userId]

async function tempUpload() {
  const path = join(tmpdir(), `gate-${Math.random().toString(36).slice(2)}.wav`)
  await writeFile(path, 'x')
  return path
}

const exists = (p) => access(p).then(() => true, () => false)

function req(token, filePath) {
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  return { headers, get: (k) => headers[k.toLowerCase()], file: filePath ? { path: filePath } : undefined }
}

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
  }
}

async function run(gate, feature, r) {
  const response = res()
  let passed = false
  await gate(() => feature)(r, response, () => { passed = true })
  return { passed, response, entitlement: r.entitlement }
}

test('the shared table: ladder, inheritance, blockers', () => {
  assert.equal(hasFeature(null, 'savePresets'), false)
  assert.equal(hasFeature('free', 'savePresets'), true)
  assert.equal(hasFeature('pro', 'savePresets'), true)
  assert.equal(hasFeature('free', 'pluginChainApply'), false)
  assert.equal(hasFeature('pro', 'pluginChainApply'), true)
  assert.equal(hasFeature('platinum', 'savePresets'), false, 'an unknown plan is not a plan')
  assert.equal(blockerFor(null, 'savePresets'), 'signIn')
  assert.equal(blockerFor(null, 'autoLevel'), 'upgrade')
  assert.equal(blockerFor('free', 'autoLevel'), 'upgrade')
  assert.equal(blockerFor('pro', 'autoLevel'), null)
  assert.throws(() => requiredPlan('autolevel'), /Unknown feature/)
  for (const [id, f] of Object.entries(FEATURES)) {
    if (f.preview) assert.equal(f.server, true, `${id}: only server features have a preview`)
    if (f.preview) assert.ok(['account', 'anyone'].includes(f.preview), `${id}: preview is 'account' or 'anyone'`)
  }
})

test('pro passes in full; a free account gets a preview on a short clip; signed out gets 401', async () => {
  const short = async () => FREE_PREVIEW_SECONDS
  const gate = createEntitlementGate({ verify, planFor, probeDuration: short })

  const pro = await run(gate, 'autoLevel', req('tok-pro', await tempUpload()))
  assert.equal(pro.passed, true)
  assert.deepEqual(pro.entitlement, { plan: 'pro', mode: 'full' })

  const free = await run(gate, 'autoLevel', req('tok-free', await tempUpload()))
  assert.equal(free.passed, true)
  assert.equal(free.entitlement.mode, 'preview')

  for (const token of [null, 'tok-garbage']) {
    const file = await tempUpload()
    const r = await run(gate, 'autoLevel', req(token, file))
    assert.equal(r.passed, false, String(token))
    assert.equal(r.response.statusCode, 401)
    assert.deepEqual(r.response.body, { error: 'Sign in to use Auto Leveler.', code: 'sign_in_required', feature: 'autoLevel' })
    assert.equal(await exists(file), false, 'the upload is deleted')
  }

  // Mastering's preview stays open to signed-out visitors.
  const mastering = await run(gate, 'mastering', req(null, await tempUpload()))
  assert.equal(mastering.passed, true)
  assert.deepEqual(mastering.entitlement, { plan: null, mode: 'preview' })
})

test('gate.signIn refuses a signed-out caller BEFORE the upload, only where nothing is open to them', async () => {
  const gate = createEntitlementGate({ verify, planFor, probeDuration: async () => 10 })
  const before = async (feature, token) => {
    const r = req(token)
    const response = res()
    let passed = false
    await gate.signIn(() => feature)(r, response, () => { passed = true })
    return { passed, response, user: r.user }
  }

  for (const feature of ['autoLevel', 'sibilanceEditor', 'spotEffects']) {
    for (const token of [null, 'tok-garbage']) {
      const r = await before(feature, token)
      assert.equal(r.passed, false, `${feature} ${token}`)
      assert.equal(r.response.statusCode, 401)
      assert.equal(r.response.body.code, 'sign_in_required')
    }
    const free = await before(feature, 'tok-free')
    assert.equal(free.passed, true)
    assert.deepEqual(free.user, { id: 'tok-free' }, 'the user is left for the gate to reuse')
  }

  assert.equal((await before('mastering', null)).passed, true, "mastering's preview is open to anyone")
  assert.equal((await before(null, null)).passed, true, 'no feature: the route decides')

  const off = createEntitlementGate({ verify: null, planFor: null })
  const r = req(null)
  let passed = false
  await off.signIn(() => 'autoLevel')(r, res(), () => { passed = true })
  assert.equal(passed, true, 'accounts off: no gating')
})

test('a long clip without Pro is refused with 402 and its upload deleted', async () => {
  const long = async () => FREE_PREVIEW_SECONDS + 5
  const gate = createEntitlementGate({ verify, planFor, probeDuration: long })
  const file = await tempUpload()
  const r = await run(gate, 'sibilanceEditor', req('tok-free', file))
  assert.equal(r.passed, false)
  assert.equal(r.response.statusCode, 402)
  assert.equal(r.response.body.code, 'upgrade_required')
  assert.equal(r.response.body.feature, 'sibilanceEditor')
  assert.equal(r.response.body.requires, 'pro')
  assert.equal(r.response.body.previewSeconds, FREE_PREVIEW_SECONDS)
  assert.equal(await exists(file), false)

  // Pro is not limited by duration.
  const pro = await run(gate, 'sibilanceEditor', req('tok-pro', await tempUpload()))
  assert.equal(pro.passed, true)
})

test('an unreadable duration fails closed; a tiny overshoot is tolerated', async () => {
  const unknown = createEntitlementGate({ verify, planFor, probeDuration: async () => null })
  assert.equal((await run(unknown, 'autoLevel', req('tok-free', await tempUpload()))).passed, false)

  const padded = createEntitlementGate({ verify, planFor, probeDuration: async () => FREE_PREVIEW_SECONDS + 0.3 })
  assert.equal((await run(padded, 'autoLevel', req('tok-free', await tempUpload()))).passed, true)
})

test('accounts off, or a route with no feature, passes straight through', async () => {
  let probed = false
  const off = createEntitlementGate({ verify: null, planFor: null, probeDuration: async () => { probed = true; return 999 } })
  assert.equal((await run(off, 'autoLevel', req(null, await tempUpload()))).passed, true)
  assert.equal(probed, false)

  const on = createEntitlementGate({ verify, planFor, probeDuration: async () => 999 })
  assert.equal((await run(on, null, req(null, await tempUpload()))).passed, true)
})

test('a plan lookup failure degrades to free, which keeps the preview open', async () => {
  const origError = console.error
  console.error = () => {}
  try {
    const gate = createEntitlementGate({
      verify, planFor: async () => { throw new Error('db down') }, probeDuration: async () => 10,
    })
    const r = await run(gate, 'autoLevel', req('tok-pro', await tempUpload()))
    assert.equal(r.passed, true)
    assert.deepEqual(r.entitlement, { plan: 'free', mode: 'preview' })
  } finally {
    console.error = origError
  }
})

test('the plan resolver caches per user for its TTL', async () => {
  let reads = 0
  let clock = 0
  const admin = {
    from: () => ({
      select: () => ({
        eq: async (_col, userId) => {
          reads++
          return { data: userId === 'u-pro' ? [{ plan: 'pro', status: 'active' }] : [], error: null }
        },
      }),
    }),
  }
  const planFor = createPlanResolver(admin, { ttlMs: 1000, now: () => clock })
  assert.equal(await planFor('u-pro'), 'pro')
  assert.equal(await planFor('u-pro'), 'pro')
  assert.equal(await planFor('u-free'), 'free')
  assert.equal(reads, 2)
  clock = 1500
  await planFor('u-pro')
  assert.equal(reads, 3)
})

test('invalidate drops one user’s cached plan so an upgrade lands at once', async () => {
  let plan = 'free'
  let reads = 0
  const admin = {
    from: () => ({ select: () => ({ eq: async () => { reads++; return { data: plan === 'pro' ? [{ plan: 'pro', status: 'active' }] : [], error: null } } }) }),
  }
  const planFor = createPlanResolver(admin, { ttlMs: 60_000, now: () => 0 })
  assert.equal(await planFor('u1'), 'free')
  plan = 'pro'
  assert.equal(await planFor('u1'), 'free', 'cached')
  planFor.invalidate('u1')
  assert.equal(await planFor('u1'), 'pro')
  assert.equal(reads, 2)
})
