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
  }
})

test('pro passes in full; free and signed-out get a preview on a short clip', async () => {
  const short = async () => FREE_PREVIEW_SECONDS
  const gate = createEntitlementGate({ verify, planFor, probeDuration: short })

  const pro = await run(gate, 'noiseReduction', req('tok-pro', await tempUpload()))
  assert.equal(pro.passed, true)
  assert.deepEqual(pro.entitlement, { plan: 'pro', mode: 'full' })

  for (const token of ['tok-free', null, 'tok-garbage']) {
    const r = await run(gate, 'noiseReduction', req(token, await tempUpload()))
    assert.equal(r.passed, true, String(token))
    assert.equal(r.entitlement.mode, 'preview')
  }
})

test('a long clip without Pro is refused with 402 and its upload deleted', async () => {
  const long = async () => FREE_PREVIEW_SECONDS + 5
  const gate = createEntitlementGate({ verify, planFor, probeDuration: long })
  const file = await tempUpload()
  const r = await run(gate, 'noiseReduction', req('tok-free', file))
  assert.equal(r.passed, false)
  assert.equal(r.response.statusCode, 402)
  assert.equal(r.response.body.code, 'upgrade_required')
  assert.equal(r.response.body.feature, 'noiseReduction')
  assert.equal(r.response.body.requires, 'pro')
  assert.equal(r.response.body.previewSeconds, FREE_PREVIEW_SECONDS)
  assert.equal(await exists(file), false)

  // Pro is not limited by duration.
  const pro = await run(gate, 'noiseReduction', req('tok-pro', await tempUpload()))
  assert.equal(pro.passed, true)
})

test('an unreadable duration fails closed; a tiny overshoot is tolerated', async () => {
  const unknown = createEntitlementGate({ verify, planFor, probeDuration: async () => null })
  assert.equal((await run(unknown, 'noiseReduction', req(null, await tempUpload()))).passed, false)

  const padded = createEntitlementGate({ verify, planFor, probeDuration: async () => FREE_PREVIEW_SECONDS + 0.3 })
  assert.equal((await run(padded, 'noiseReduction', req(null, await tempUpload()))).passed, true)
})

test('accounts off, or a route with no feature, passes straight through', async () => {
  let probed = false
  const off = createEntitlementGate({ verify: null, planFor: null, probeDuration: async () => { probed = true; return 999 } })
  assert.equal((await run(off, 'noiseReduction', req(null, await tempUpload()))).passed, true)
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
    const r = await run(gate, 'noiseReduction', req('tok-pro', await tempUpload()))
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
