import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

import { createAnalyzeRoute } from '../routes/analyze.js'
import { createSpotRoute } from '../routes/spot.js'
import { createEntitlementGate } from '../lib/entitlements.js'
import { createJobQueue, holdSlot, readRequestLimitConfig } from '../lib/jobQueue.js'
import { neverEndingUpload } from './helpers/neverEndingUpload.js'
const PLANS = { 'tok-free': 'free', 'tok-pro': 'pro' }
const verify = async (token) => {
  if (!PLANS[token]) throw new Error('bad token')
  return { id: token }
}
const planFor = async (userId) => PLANS[userId]
const gate = createEntitlementGate({ verify, planFor, probeDuration: async () => 300 })

async function withServer(router, fn) {
  const app = express()
  app.use('/api', router)
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function post(url, token) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(64)]), 'clip.wav')
  return fetch(url, { method: 'POST', body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

test('analyze and spot: signed out is 401 before the upload, even for a preview-length clip', async () => {
  const short = createEntitlementGate({ verify, planFor, probeDuration: async () => 5 })
  await withServer(createAnalyzeRoute({ gate: short }), async (base) => {
    for (const kind of ['vad', 'sibilance']) {
      const res = await neverEndingUpload(`${base}/api/analyze/${kind}`)
      assert.equal(res.status, 401, kind)
      assert.equal(res.body.code, 'sign_in_required')
    }
    assert.equal((await neverEndingUpload(`${base}/api/analyze/vad`, 'tok-garbage')).status, 401)
  })
  await withServer(createSpotRoute({ gate: short }), async (base) => {
    assert.equal((await neverEndingUpload(`${base}/api/spot/vocal_saturation`)).status, 401)
  })
})

test('a free account still gets the plan check after the upload, and a refusal frees its slot', async () => {
  const limit = holdSlot(createJobQueue({ concurrency: 1, maxQueued: 0, maxPerClient: 1 }))
  await withServer(createAnalyzeRoute({ gate, limit }), async (base) => {
    for (let i = 0; i < 3; i++) {
      const res = await post(`${base}/api/analyze/vad`, 'tok-free')
      assert.equal(res.status, 402, `attempt ${i + 1}: refused by plan, not by a leaked slot`)
      assert.equal((await res.json()).code, 'upgrade_required')
    }
  })
})

test('at the shared limit spot and analyze refuse before the upload', async () => {
  const queue = createJobQueue({ ...readRequestLimitConfig(), concurrency: 1, maxPerClient: 1 })
  queue.submit('user:tok-pro', () => new Promise(() => {}))  // one long analysis running
  const limit = holdSlot(queue)

  const app = express.Router()
  app.use(createAnalyzeRoute({ gate, limit }))
  app.use(createSpotRoute({ gate, limit }))
  await withServer(app, async (base) => {
    const mine = await neverEndingUpload(`${base}/api/analyze/vad`, 'tok-pro')
    assert.equal(mine.status, 429)
    assert.match(mine.body.error, /server analysis running/)

    const other = await neverEndingUpload(`${base}/api/spot/vocal_saturation`, 'tok-free')
    assert.equal(other.status, 503)
    assert.equal(other.headers['retry-after'], '60')
  })
})
